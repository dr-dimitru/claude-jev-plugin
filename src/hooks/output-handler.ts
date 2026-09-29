import { sessionStore } from "../hook-io.ts";
import { loadConfig, type LoadedConfig } from "../config.ts";
import { askTypeSafe, DEFAULT_TYPESAFE_MODEL } from "../client.ts";
import { getOrCreateCached } from "../cache.ts";
import { buildOutputState } from "../state.ts";
import {
  normalizeToolOutput,
  outputJudgmentKey,
  evaluateOutput,
  OUTPUT_QUESTIONS,
  type OutputVerdict,
} from "../output.ts";
import {
  emitDiagnostic,
  normalizeToolName,
  readHookPayload,
} from "./common.ts";

export type OutputHookEvent = "PostToolUse" | "PostToolUseFailure";

export interface OutputHookOptions {
  fetch?: typeof fetch;
  askJevFn?: typeof askTypeSafe;
  config?: LoadedConfig;
}

export type OutputHookResult =
  | { kind: "skip" }
  | { kind: "diagnostic"; output: { systemMessage?: string } | null }
  | {
      kind: "judged";
      payload: Record<string, unknown>;
      toolName: string;
      verdict: OutputVerdict;
    };

export async function runOutputHook(
  eventName: OutputHookEvent,
  rawPayload?: unknown,
  options?: OutputHookOptions
): Promise<OutputHookResult> {
  let payload: Record<string, unknown>;
  try {
    payload = await readHookPayload(rawPayload);
  } catch {
    return {
      kind: "diagnostic",
      output: await emitDiagnostic("MALFORMED_PAYLOAD", null),
    };
  }

  const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;
  const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
  const actualEvent = typeof payload.hook_event_name === "string"
    ? payload.hook_event_name
    : undefined;
  const agentId = typeof payload.agent_id === "string" ? payload.agent_id : undefined;
  const scratchpadDir = typeof payload.scratchpad_dir === "string"
    ? payload.scratchpad_dir
    : undefined;
  if (!sessionId || !cwd || actualEvent !== eventName) return { kind: "skip" };

  const store = sessionStore({ sessionId, agentId, scratchpadDir });
  let claimedToolUseId: string | undefined;
  try {
    const config = options?.config ?? loadConfig(cwd);
    const overrides = await store.getOverrides();
    if (!(overrides.enabled ?? config.output.enabled)) return { kind: "skip" };

    const rawToolName = payload.tool_name ?? payload.tool ?? "Bash";
    const toolName = normalizeToolName(rawToolName);
    const configuredTools = (config.output.tools ?? ["Bash"]).map(
      tool => normalizeToolName(tool) ?? tool
    );
    if (!toolName || !configuredTools.includes(toolName)) return { kind: "skip" };

    if (!config.apiKey?.trim()) {
      return {
        kind: "diagnostic",
        output: await emitDiagnostic("MISSING_KEY", store),
      };
    }

    const toolUseId = typeof payload.tool_use_id === "string"
      ? payload.tool_use_id
      : undefined;
    if (toolUseId) {
      if (!(await store.claimToolUseId(toolUseId))) return { kind: "skip" };
      claimedToolUseId = toolUseId;
    }

    const normalized = normalizeToolOutput(payload);
    const boundedState = buildOutputState({
      tool: normalized.tool,
      cwd: normalized.cwd,
      tool_input: normalized.toolInput,
      output: normalized.output,
      is_error: normalized.isError,
      config: {
        argumentChars: config.gate?.argumentChars ?? 400,
        output: { outputChars: config.output.outputChars },
        maxStateChars: config.maxStateChars ?? 8000,
      },
    });
    const cacheKey = outputJudgmentKey(boundedState, {
      model: config.model ?? DEFAULT_TYPESAFE_MODEL,
      questions: OUTPUT_QUESTIONS,
      thresholds: {
        leakThreshold: config.output.leakThreshold ?? 0.9,
        minConfidence: config.output.minConfidence ?? 0.6,
      },
    });
    const askFn = options?.askJevFn ?? (
      options?.fetch
        ? (call: Parameters<typeof askTypeSafe>[0]) => askTypeSafe({ ...call, fetch: options.fetch })
        : askTypeSafe
    );
    const verdict = await getOrCreateCached<OutputVerdict>(
      cacheKey,
      120_000,
      async () => {
        const response = await askFn({
          model: config.model ?? DEFAULT_TYPESAFE_MODEL,
          state: boundedState,
          questions: OUTPUT_QUESTIONS,
          apiKey: config.apiKey,
          endpoint: config.endpoint,
          timeoutMs: config.timeoutMs,
          retries: config.retries,
        });
        return evaluateOutput(response, config);
      },
      {
        scratchpadDir,
        sessionId,
        agentId,
        lockTimeoutMs: 16_000,
        staleLockMs: 30_000,
      }
    );

    await store.setLastVerdict("output", verdict);
    return { kind: "judged", payload, toolName, verdict };
  } catch {
    if (claimedToolUseId) {
      await store.releaseToolUseId(claimedToolUseId).catch(() => {});
    }
    return {
      kind: "diagnostic",
      output: await emitDiagnostic("REQUEST_FAILED", store),
    };
  }
}
