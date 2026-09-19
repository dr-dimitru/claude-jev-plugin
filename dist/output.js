/**
 * Pure Output Judge for claude-jev.
 *
 * Implements:
 * - Current TypeSafe answer fields: Noul uses .noul, Choice uses .choice, .probabilities, .confidence.
 * - OUTPUT_QUESTIONS with leaks_secret Noul and failure_class Choice (6 architecture classes).
 * - CLASS_ADVICE defined locally without Jev prose generation.
 * - Normalized output input types for successful tool_response and failed top-level error.
 * - Bounded output state via src/state.ts.
 * - Stable output judgment keys from normalized input.
 * - evaluateOutput with leak threshold 0.90 and class confidence 0.60.
 * - Redaction of known Bash output on secret leak.
 * - Batched Jev query with duplicate tool_use_id suppression.
 *
 * Leak and advice notices must never include output text or detected values.
 */
import * as crypto from "node:crypto";
import { askJev, DEFAULT_MODEL, } from "./client.js";
import { buildOutputState } from "./state.js";
export const DEFAULT_LEAK_THRESHOLD = 0.90;
export const DEFAULT_CLASS_MIN_CONFIDENCE = 0.60;
export const WITHHELD_OUTPUT_TEXT = "[claude-jev] Output withheld because Jev flagged it as containing a secret. Do not reproduce the value.";
export const LEAK_SYSTEM_MESSAGE = "claude-jev: Bash output may contain a secret; output was withheld from Claude.";
// --- Question Definitions ---
export const OUTPUT_QUESTIONS = {
    leaks_secret: {
        type: "noul",
        instructions: "Does `output` contain a secret or credential that must not be written to a session transcript?",
        criteria: {
            true: "A key, token, password, or private key appears in the text",
            false: "Only ordinary program output",
        },
    },
    failure_class: {
        type: "choice",
        instructions: "What kind of failure is `output` reporting?",
        criteria: {
            transient: "A network or resource hiccup that may succeed on a retry",
            environment: "A missing dependency, port, or tool in the local setup",
            code_bug: "The code or types are wrong",
            permission: "Access was denied by the OS or a server",
            user_error: "The command itself was invoked wrongly",
            no_failure: "Output reports success or nothing wrong",
        },
    },
};
export const CLASS_ADVICE = {
    transient: "Retrying the same command unchanged is reasonable.",
    environment: "Fix the environment before retrying.",
    code_bug: "Fix the code or types; retrying unchanged will not help.",
    permission: "Access was denied; change what is accessed or ask the user.",
    user_error: "Fix the command invocation or input.",
    no_failure: null,
};
/**
 * Normalizes successful PostToolUse payloads and failed PostToolUseFailure top-level error payloads.
 */
export function normalizeToolOutput(payload) {
    const tool = (payload.tool_name ?? payload.tool ?? "Bash");
    const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    const toolUseId = typeof payload.tool_use_id === "string"
        ? payload.tool_use_id
        : typeof payload.toolUseId === "string"
            ? payload.toolUseId
            : undefined;
    let isError = false;
    if (payload.hook_event_name === "PostToolUseFailure" ||
        payload.is_error === true ||
        payload.isError === true ||
        payload.error !== undefined) {
        isError = true;
    }
    let output = "";
    let toolResponse = undefined;
    if ("tool_response" in payload && payload.tool_response !== undefined) {
        toolResponse = payload.tool_response;
        if (typeof payload.tool_response === "string") {
            output = payload.tool_response;
        }
        else if (payload.tool_response !== null &&
            typeof payload.tool_response === "object" &&
            !Array.isArray(payload.tool_response)) {
            const respObj = payload.tool_response;
            if ("stdout" in respObj || "stderr" in respObj) {
                const stdout = typeof respObj.stdout === "string" ? respObj.stdout : "";
                const stderr = typeof respObj.stderr === "string" ? respObj.stderr : "";
                if (stdout && stderr) {
                    output = `${stdout}\n${stderr}`;
                }
                else {
                    output = stdout || stderr;
                }
            }
            else if (typeof respObj.output === "string") {
                output = respObj.output;
            }
            else if (typeof respObj.error === "string") {
                output = respObj.error;
            }
            else {
                output = JSON.stringify(payload.tool_response);
            }
        }
        else {
            output = String(payload.tool_response);
        }
    }
    else if (payload.error !== undefined) {
        output = typeof payload.error === "string" ? payload.error : JSON.stringify(payload.error);
    }
    else if ("output" in payload && payload.output !== undefined) {
        const rawOut = payload.output;
        output = typeof rawOut === "string" ? rawOut : JSON.stringify(rawOut);
    }
    return {
        tool,
        cwd,
        toolUseId,
        isError,
        toolInput: payload.tool_input ?? payload.toolInput ?? {},
        output,
        toolResponse,
    };
}
// --- Bash Output Redaction ---
export function isRecognizedBashResponse(toolResponse) {
    if (!toolResponse || typeof toolResponse !== "object" || Array.isArray(toolResponse)) {
        return false;
    }
    const obj = toolResponse;
    return "stdout" in obj || "stderr" in obj;
}
export function redactBashOutput(toolResponse) {
    if (!isRecognizedBashResponse(toolResponse)) {
        return toolResponse;
    }
    const obj = toolResponse;
    return {
        ...obj,
        stdout: WITHHELD_OUTPUT_TEXT,
        stderr: "",
        interrupted: typeof obj.interrupted === "boolean" ? obj.interrupted : false,
        isImage: typeof obj.isImage === "boolean" ? obj.isImage : false,
    };
}
// --- Stable Output Key Generation ---
function canonicalize(val) {
    if (val === null || typeof val !== "object") {
        return val;
    }
    if (Array.isArray(val)) {
        return val.map(canonicalize);
    }
    const obj = val;
    const sortedKeys = Object.keys(obj).sort();
    const res = {};
    for (const k of sortedKeys) {
        res[k] = canonicalize(obj[k]);
    }
    return res;
}
export function outputJudgmentKey(input, options) {
    const isNorm = "toolInput" in input;
    const state = buildOutputState({
        tool: input.tool,
        cwd: input.cwd,
        tool_input: isNorm ? input.toolInput : input.tool_input,
        output: input.output,
        is_error: isNorm ? input.isError : input.is_error,
        config: !isNorm ? input.config : undefined,
    });
    const canonical = canonicalize({
        tool: state.tool,
        tool_input: state.tool_input,
        is_error: state.is_error,
        output: state.output,
        model: options?.model ?? DEFAULT_MODEL,
        questions: options?.questions ?? OUTPUT_QUESTIONS,
    });
    return crypto
        .createHash("sha256")
        .update(JSON.stringify(canonical), "utf-8")
        .digest("hex");
}
export const outputKey = outputJudgmentKey;
export function evaluateOutput(response, config) {
    const cfg = config;
    const outputObj = cfg?.output;
    const leakThreshold = typeof outputObj?.leakThreshold === "number"
        ? outputObj.leakThreshold
        : typeof cfg?.leakThreshold === "number"
            ? cfg.leakThreshold
            : DEFAULT_LEAK_THRESHOLD;
    const minConfidence = typeof outputObj?.minConfidence === "number"
        ? outputObj.minConfidence
        : typeof cfg?.minConfidence === "number"
            ? cfg.minConfidence
            : DEFAULT_CLASS_MIN_CONFIDENCE;
    const leaksAnswer = response.answers?.leaks_secret;
    const failureAnswer = response.answers?.failure_class;
    const leakScore = typeof leaksAnswer?.noul === "number" ? leaksAnswer.noul : 0;
    const leaksSecret = leakScore >= leakThreshold;
    const rawChoice = failureAnswer?.choice;
    const failureClass = rawChoice && rawChoice in CLASS_ADVICE ? rawChoice : "no_failure";
    const failureConfidence = typeof failureAnswer?.confidence === "number" ? failureAnswer.confidence : 0;
    // Failure advice is only given if confidence >= minConfidence and failureClass !== "no_failure"
    let advice = null;
    if (failureClass !== "no_failure" && failureConfidence >= minConfidence) {
        advice = CLASS_ADVICE[failureClass] ?? null;
    }
    const flagged = leaksSecret || advice !== null;
    let systemMessage = undefined;
    if (leaksSecret) {
        systemMessage = LEAK_SYSTEM_MESSAGE;
    }
    let additionalContext = undefined;
    if (advice) {
        additionalContext = `claude-jev: this Bash result reads as a ${failureClass} failure; ${advice}`;
    }
    return {
        flagged,
        leaksSecret,
        leakScore,
        failureClass,
        failureConfidence,
        advice,
        systemMessage,
        additionalContext,
    };
}
export async function judgeOutput(payload, options) {
    const normalized = normalizeToolOutput(payload);
    const store = options?.sessionStore;
    // Duplicate tool_use_id suppression
    if (store && normalized.toolUseId) {
        const seen = await store.hasSeenToolUseId(normalized.toolUseId);
        if (seen) {
            const last = await store.getLastVerdict("output");
            if (last && typeof last === "object") {
                return last;
            }
        }
    }
    const askFn = options?.askJevFn ?? askJev;
    const config = options?.config;
    // Build bounded output state via src/state.ts
    const boundedState = buildOutputState({
        tool: normalized.tool,
        cwd: normalized.cwd,
        tool_input: normalized.toolInput,
        output: normalized.output,
        is_error: normalized.isError,
        config: config
            ? {
                argumentChars: config.gate.argumentChars,
                output: { outputChars: config.output.outputChars },
                maxStateChars: config.maxStateChars,
            }
            : undefined,
    });
    const response = await askFn({
        model: config?.model ?? DEFAULT_MODEL,
        state: boundedState,
        questions: OUTPUT_QUESTIONS,
        apiKey: config?.apiKey,
        endpoint: config?.endpoint,
        timeoutMs: config?.timeoutMs,
        retries: config?.retries,
        signal: options?.signal,
    });
    const verdict = evaluateOutput(response, config);
    if (verdict.leaksSecret && normalized.toolResponse) {
        verdict.updatedToolOutput = redactBashOutput(normalized.toolResponse);
    }
    if (store) {
        if (normalized.toolUseId) {
            await store.recordToolUseId(normalized.toolUseId);
        }
        await store.setLastVerdict("output", verdict);
    }
    return verdict;
}
