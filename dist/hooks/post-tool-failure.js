/**
 * PostToolUseFailure Hook for claude-jev.
 *
 * Implements:
 * - Safe Claude stdin parsing
 * - Normalization of failed top-level error payloads via src/output.ts
 * - Config and session state loading
 * - Skipping disabled/unconfigured/missing-key paths
 * - Duplicate tool_use_id judging prevention
 * - Exactly one batched Jev request per new normalized output
 * - Storing last output verdict
 * - Returning valid Claude hook JSON:
 *   - additionalContext for deterministic high-confidence failure advice
 *   - systemMessage and context warning when secret leak is flagged
 *   - NEVER claims or includes output replacement (PostToolUseFailure has no replacement field)
 * - Fail-open with rate-limited diagnostics on infrastructure/parse errors
 * - Never echoing error text or detected secrets in diagnostics
 */
import { pathToFileURL } from "node:url";
import { readHookInput, sessionStore } from "../hook-io.js";
import { loadConfig } from "../config.js";
import { askJev, redact, DEFAULT_MODEL } from "../client.js";
import { getOrCreateCached } from "../cache.js";
import { buildOutputState } from "../state.js";
import { normalizeToolOutput, outputJudgmentKey, evaluateOutput, OUTPUT_QUESTIONS, } from "../output.js";
export function normalizeToolName(raw) {
    if (typeof raw !== "string")
        return undefined;
    const trimmed = raw.trim();
    const lower = trimmed.toLowerCase();
    if (lower === "bash")
        return "Bash";
    if (lower === "write")
        return "Write";
    if (lower === "edit")
        return "Edit";
    return trimmed;
}
const RATE_LIMIT_WINDOW_MS = 60000;
let fallbackDiagnosticTime = 0;
async function emitRateLimitedDiagnostic(rawMessage, store) {
    const now = Date.now();
    if (store) {
        try {
            const lastDiag = (await store.getCacheMetadata("last_diagnostic_time"));
            if (typeof lastDiag === "number" && now - lastDiag < RATE_LIMIT_WINDOW_MS) {
                return null;
            }
            await store.setCacheMetadata("last_diagnostic_time", now);
        }
        catch {
            // ignore metadata store error
        }
    }
    else {
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
export async function runPostToolFailure(rawPayload, options) {
    let payload;
    // 1. Read / validate input payload
    try {
        if (rawPayload !== undefined && rawPayload !== null && typeof rawPayload === "object") {
            payload = rawPayload;
        }
        else if (rawPayload !== undefined) {
            return await emitRateLimitedDiagnostic("claude-jev: malformed hook payload; expected JSON object", null);
        }
        else {
            payload = await readHookInput(process.stdin);
        }
    }
    catch (err) {
        return await emitRateLimitedDiagnostic(`claude-jev: payload read error: ${err.message}`, null);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return await emitRateLimitedDiagnostic("claude-jev: malformed hook payload; expected JSON object", null);
    }
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;
    const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
    const eventName = typeof payload.hook_event_name === "string" ? payload.hook_event_name : undefined;
    const agentId = typeof payload.agent_id === "string" ? payload.agent_id : undefined;
    const scratchpadDir = typeof payload.scratchpad_dir === "string" ? payload.scratchpad_dir : undefined;
    if (!sessionId || !cwd || eventName !== "PostToolUseFailure") {
        return null;
    }
    const store = sessionStore({
        sessionId,
        agentId,
        scratchpadDir,
    });
    try {
        // 2. Load configuration and session overrides
        const config = options?.config ?? loadConfig(cwd);
        const overrides = await store.getOverrides();
        const isEnabled = overrides.enabled ?? config.output.enabled;
        if (!isEnabled) {
            return null; // Output judge disabled, return no stdout
        }
        // 3. Tool name check
        const rawToolName = (payload.tool_name ?? payload.tool ?? "Bash");
        const toolName = normalizeToolName(rawToolName);
        const configuredTools = (config.output.tools ?? ["Bash"]).map((t) => normalizeToolName(t) ?? t);
        if (!toolName || !configuredTools.includes(toolName)) {
            return null; // Tool not configured for output judging
        }
        // 4. Missing API key check
        if (!config.apiKey || config.apiKey.trim().length === 0) {
            return await emitRateLimitedDiagnostic("claude-jev: TYPESAFE_API_KEY is not configured; post-tool-failure output judge skipped", store);
        }
        // 5. Prevent duplicate tool_use_id judging
        const toolUseId = typeof payload.tool_use_id === "string" ? payload.tool_use_id : undefined;
        if (toolUseId && (await store.hasSeenToolUseId(toolUseId))) {
            return null;
        }
        // 6. Judge output via getOrCreateCached (normalizes top-level error, exactly one batched request, stores last verdict)
        const failurePayload = {
            ...payload,
            hook_event_name: "PostToolUseFailure",
        };
        const normalized = normalizeToolOutput(failurePayload);
        const cacheKey = outputJudgmentKey(normalized, {
            model: config.model ?? DEFAULT_MODEL,
            questions: OUTPUT_QUESTIONS,
        });
        const ttlMs = 120 * 1000;
        const askFn = options?.askJevFn ??
            (options?.fetch
                ? (call) => askJev({ ...call, fetch: options?.fetch })
                : askJev);
        const verdict = await getOrCreateCached(cacheKey, ttlMs, async () => {
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
            const response = await askFn({
                model: config.model ?? DEFAULT_MODEL,
                state: boundedState,
                questions: OUTPUT_QUESTIONS,
                apiKey: config.apiKey,
                endpoint: config.endpoint,
                timeoutMs: config.timeoutMs,
                retries: config.retries,
            });
            return evaluateOutput(response, config);
        }, {
            scratchpadDir,
            sessionId,
            agentId,
        });
        if (toolUseId) {
            await store.recordToolUseId(toolUseId);
        }
        await store.setLastVerdict("output", verdict);
        // 7. Format Claude hook JSON (PostToolUseFailure has NO output replacement field)
        const hasAdvice = typeof verdict.additionalContext === "string";
        if (verdict.leaksSecret) {
            const userWarning = "claude-jev: Bash failure output may contain a secret; do not reproduce the value.";
            const leakAdvice = "claude-jev warning: Bash failure output may contain a secret; do not reproduce or expose the value.";
            const additionalContext = hasAdvice
                ? `${verdict.additionalContext}\n${leakAdvice}`
                : leakAdvice;
            return {
                systemMessage: userWarning,
                hookSpecificOutput: {
                    hookEventName: "PostToolUseFailure",
                    additionalContext,
                },
            };
        }
        if (hasAdvice) {
            return {
                hookSpecificOutput: {
                    hookEventName: "PostToolUseFailure",
                    additionalContext: verdict.additionalContext,
                },
            };
        }
        // Clear verdict: safe output emits nothing
        return null;
    }
    catch (err) {
        return await emitRateLimitedDiagnostic(`claude-jev: infrastructure error: ${err.message}`, store);
    }
}
// Auto-run when invoked directly by Node
if (process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href) {
    runPostToolFailure()
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
