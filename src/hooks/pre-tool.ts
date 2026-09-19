/**
 * PreToolUse Hook for claude-jev.
 *
 * Minimal vertical slice for Bash:
 * - Validates hook payload
 * - Loads config and session overrides
 * - Skips disabled, non-Bash, and missing-key paths
 * - Calls askJev once with all four gate questions
 * - Stores last gate verdict in sessionStore
 * - Clear verdicts return no stdout
 * - Shadow flagged verdicts return concise systemMessage
 * - Enforce flagged verdicts return PreToolUse ask output (never allow)
 * - Catches all infrastructure/config/parse errors and returns rate-limited systemMessage
 */

import { pathToFileURL } from "node:url";
import { readHookInput, sessionStore, type SessionStore } from "../hook-io.ts";
import { loadConfig } from "../config.ts";
import { buildGateState } from "../state.ts";
import { GATE_QUESTIONS, evaluateGate, judgmentKey, type GateVerdict } from "../gate.ts";
import { getOrCreateCached } from "../cache.ts";
import { askJev, redact } from "../client.ts";

export interface HookSpecificOutput {
  hookEventName: "PreToolUse";
  permissionDecision: "ask" | "deny";
  permissionDecisionReason: string;
}

export interface PreToolOutput {
  systemMessage?: string;
  hookSpecificOutput?: HookSpecificOutput;
}

export interface PreToolOptions {
  fetch?: typeof fetch;
}

export interface PreToolPayload {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  permission_mode?: string;
  prompt_host?: boolean;
  has_ui?: boolean;
  has_prompt_host?: boolean;
  headless?: boolean;
  hook_event_name?: string;
  tool_name?: string;
  tool?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  scratchpad_dir?: string;
  agent_id?: string;
  [key: string]: unknown;
}

export function normalizeToolName(raw?: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "bash") return "Bash";
  if (lower === "write") return "Write";
  if (lower === "edit") return "Edit";
  return trimmed;
}

export function isPromptHostAvailable(payload: Record<string, unknown>): boolean {
  if (payload.prompt_host === false) return false;
  if (payload.has_ui === false) return false;
  if (payload.has_prompt_host === false) return false;
  if (payload.headless === true) return false;
  if (typeof payload.permission_mode === "string") {
    const mode = payload.permission_mode.trim().toLowerCase();
    if (mode === "headless" || mode === "dont_ask" || mode === "bypass" || mode === "non_interactive") {
      return false;
    }
  }
  return true;
}

const RATE_LIMIT_WINDOW_MS = 60000;
let fallbackDiagnosticTime = 0;

async function emitRateLimitedDiagnostic(
  rawMessage: string,
  store?: SessionStore | null
): Promise<PreToolOutput | null> {
  const now = Date.now();

  if (store) {
    try {
      const lastDiag = (await store.getCacheMetadata("last_diagnostic_time")) as number | undefined;
      if (typeof lastDiag === "number" && now - lastDiag < RATE_LIMIT_WINDOW_MS) {
        return null;
      }
      await store.setCacheMetadata("last_diagnostic_time", now);
    } catch {
      // ignore metadata store error
    }
  } else {
    if (now - fallbackDiagnosticTime < RATE_LIMIT_WINDOW_MS) {
      return null;
    }
    fallbackDiagnosticTime = now;
  }

  const message = redact(rawMessage);
  return {
    systemMessage: message,
  };
}

export async function runPreTool(
  rawPayload?: unknown,
  options?: PreToolOptions
): Promise<PreToolOutput | null> {
  let payload: Record<string, unknown>;

  // 1. Read / validate input payload
  try {
    if (rawPayload !== undefined && rawPayload !== null && typeof rawPayload === "object") {
      payload = rawPayload as Record<string, unknown>;
    } else if (rawPayload !== undefined) {
      return await emitRateLimitedDiagnostic("claude-jev: malformed hook payload; expected JSON object", null);
    } else {
      payload = await readHookInput(process.stdin);
    }
  } catch (err: any) {
    return await emitRateLimitedDiagnostic(`claude-jev: payload read error: ${err.message}`, null);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return await emitRateLimitedDiagnostic("claude-jev: malformed hook payload; expected JSON object", null);
  }

  const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const agentId = typeof payload.agent_id === "string" ? payload.agent_id : undefined;
  const scratchpadDir = typeof payload.scratchpad_dir === "string" ? payload.scratchpad_dir : undefined;

  if (!sessionId) {
    return await emitRateLimitedDiagnostic("claude-jev: missing required session_id in payload", null);
  }

  const store = sessionStore({
    sessionId,
    agentId,
    scratchpadDir,
  });

  try {
    // 2. Load configuration and session overrides
    const config = loadConfig(cwd);
    const overrides = await store.getOverrides();

    const isEnabled = overrides.enabled ?? config.gate.enabled;
    if (!isEnabled) {
      return null; // gate disabled, return no stdout
    }

    // 3. Tool name normalization and configured tools check
    const rawToolName = (payload.tool_name ?? payload.tool) as string | undefined;
    const toolName = normalizeToolName(rawToolName);
    const configuredTools = (config.gate.tools ?? ["Bash", "Write", "Edit"]).map(
      (t) => normalizeToolName(t) ?? t
    );

    if (!toolName || !configuredTools.includes(toolName)) {
      return null; // Tool not configured for gating
    }

    // 4. Missing API key check
    if (!config.apiKey || config.apiKey.trim().length === 0) {
      return await emitRateLimitedDiagnostic(
        "claude-jev: TYPESAFE_API_KEY is not configured; pre-tool gate skipped",
        store
      );
    }

    // 5. Build bounded gate state
    const prompt = await store.getPrompt();
    const gateState = buildGateState({
      tool: toolName,
      tool_name: toolName,
      tool_input: payload.tool_input,
      cwd,
      user_request: prompt,
      config: config as any,
    });

    const cacheKey = judgmentKey(gateState, GATE_QUESTIONS, config.model);
    const ttlMs = (config.gate.cacheSeconds ?? 120) * 1000;

    // 6. Call askJev / retrieve cached verdict
    const verdict = await getOrCreateCached<GateVerdict>(
      cacheKey,
      ttlMs,
      async () => {
        const response = await askJev({
          model: config.model,
          endpoint: config.endpoint,
          timeoutMs: config.timeoutMs,
          retries: config.retries,
          apiKey: config.apiKey,
          state: gateState,
          questions: GATE_QUESTIONS as any,
          fetch: options?.fetch,
        });

        return evaluateGate(response, config.gate);
      },
      {
        scratchpadDir,
        sessionId,
      }
    );

    // 7. Store last gate verdict in session storage
    await store.setLastVerdict("gate", verdict);

    // 8. Output handling
    if (!verdict.flagged) {
      return null; // Clear verdict: no stdout
    }

    const mode = overrides.mode ?? config.gate.mode ?? "shadow";
    const blockWithoutUI =
      typeof (overrides as any).blockWithoutUI === "boolean"
        ? (overrides as any).blockWithoutUI
        : (config.gate.blockWithoutUI ?? false);

    if (mode === "enforce") {
      const hasHost = isPromptHostAvailable(payload);
      if (!hasHost) {
        if (blockWithoutUI) {
          const reason = `claude-jev flagged ${toolName}: ${verdict.summary}`;
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: reason,
            },
          };
        }
        // Fail open when no prompt host is available
        return null;
      }

      const reason = `claude-jev flagged ${toolName}: ${verdict.summary}`;
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: reason,
        },
      };
    }

    // Shadow mode (default)
    return {
      systemMessage: `claude-jev shadow: ${toolName} flagged (${verdict.summary})`,
    };
  } catch (err: any) {
    // Catch all infrastructure/config/parse errors and fail open with rate-limited diagnostic
    return await emitRateLimitedDiagnostic(`claude-jev: infrastructure error: ${err.message}`, store);
  }
}

// Auto-run when invoked directly by Node
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runPreTool()
    .then((out) => {
      if (out) {
        process.stdout.write(JSON.stringify(out) + "\n");
      }
      process.exit(0);
    })
    .catch(() => {
      process.exit(0);
    });
}
