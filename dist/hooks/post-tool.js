/**
 * PostToolUse Hook for claude-jev.
 *
 * Implements:
 * - Safe Claude stdin parsing
 * - Normalization of successful tool_response via src/output.ts
 * - Config and session state loading
 * - Skipping disabled/unconfigured/missing-key paths
 * - Duplicate tool_use_id judging prevention
 * - Exactly one batched Jev request per new normalized output
 * - Storing last output verdict
 * - Returning valid Claude hook JSON:
 *   - systemMessage for a leak
 *   - additionalContext for deterministic high-confidence failure advice
 *   - hookSpecificOutput.updatedToolOutput replacing Bash output when leak threshold is crossed
 *   - preserving interrupted and isImage fields
 * - Fail-open with rate-limited diagnostics on infrastructure/parse errors
 * - Never echoing output text or detected secrets in diagnostics
 */
import { pathToFileURL } from "node:url";
import { readHookInput, sessionStore } from "../hook-io.js";
import { loadConfig } from "../config.js";
import { askJev, redact, DEFAULT_MODEL } from "../client.js";
import { getOrCreateCached } from "../cache.js";
import { buildOutputState } from "../state.js";
import { normalizeToolOutput, outputJudgmentKey, evaluateOutput, isRecognizedBashResponse, redactBashOutput, LEAK_SYSTEM_MESSAGE, OUTPUT_QUESTIONS, } from "../output.js";
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
export async function runPostTool(rawPayload, options) {
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
            return await emitRateLimitedDiagnostic("claude-jev: TYPESAFE_API_KEY is not configured; post-tool output judge skipped", store);
        }
        // 5. Prevent duplicate tool_use_id judging
        const toolUseId = typeof payload.tool_use_id === "string" ? payload.tool_use_id : undefined;
        if (toolUseId && (await store.hasSeenToolUseId(toolUseId))) {
            return null;
        }
        // 6. Normalize output and build cache key
        const normalized = normalizeToolOutput(payload);
        const cacheKey = outputJudgmentKey(normalized, {
            model: config.model ?? DEFAULT_MODEL,
            questions: OUTPUT_QUESTIONS,
        });
        const ttlMs = 120 * 1000;
        const askFn = options?.askJevFn ??
            (options?.fetch
                ? (call) => askJev({ ...call, fetch: options?.fetch })
                : askJev);
        // 7. Judge output via getOrCreateCached (session/scratchpad scope, 120s TTL)
        const verdict = await getOrCreateCached(cacheKey, ttlMs, async () => {
            const boundedState = buildOutputState({
                tool: normalized.tool,
                cwd: normalized.cwd,
                tool_input: normalized.toolInput,
                output: normalized.output,
                is_error: normalized.isError,
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
        // 8. Update session store with toolUseId and lastVerdict
        if (toolUseId) {
            await store.recordToolUseId(toolUseId);
        }
        await store.setLastVerdict("output", verdict);
        // 9. Format Claude hook JSON
        const isBashTool = toolName === "Bash";
        const isBashResponse = isRecognizedBashResponse(payload.tool_response);
        const hasAdvice = typeof verdict.additionalContext === "string";
        if (verdict.leaksSecret) {
            const leakInstruction = "claude-jev: Bash output may contain a secret; do not reproduce the value.";
            const additionalContext = hasAdvice
                ? `${verdict.additionalContext}\n${leakInstruction}`
                : leakInstruction;
            const hookSpecificOutput = {
                hookEventName: "PostToolUse",
                additionalContext,
                ...(isBashTool && isBashResponse
                    ? { updatedToolOutput: redactBashOutput(payload.tool_response) }
                    : {}),
            };
            return {
                systemMessage: LEAK_SYSTEM_MESSAGE,
                hookSpecificOutput,
            };
        }
        if (hasAdvice) {
            return {
                hookSpecificOutput: {
                    hookEventName: "PostToolUse",
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
    runPostTool()
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
