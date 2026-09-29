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
import { askTypeSafe, DEFAULT_TYPESAFE_MODEL, } from "./client.js";
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
/** Questions for successful output: only the leak check. */
export const SUCCESS_OUTPUT_QUESTIONS = {
    leaks_secret: OUTPUT_QUESTIONS.leaks_secret,
};
/**
 * Failure classification only makes sense for failed commands. Asking it
 * about successful output produced false advice, for example `code_bug` for
 * a command that printed an expected error message and exited 0.
 */
export function outputQuestionsFor(isError) {
    return isError ? OUTPUT_QUESTIONS : SUCCESS_OUTPUT_QUESTIONS;
}
// --- Local Secret Prefilter ---
/** Longest output prefix the local prefilter scans. */
export const PREFILTER_MAX_CHARS = 1_000_000;
const SENSITIVE_OUTPUT_PATTERNS = [
    // PEM and OpenSSH private keys
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
    // Cloud and SaaS tokens with fixed prefixes
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/,
    /\bgithub_pat_[A-Za-z0-9_]{30,}/,
    /\bglpat-[A-Za-z0-9_-]{20,}/,
    /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
    /\bsk-(?:ant-|proj-|live_|test_)?[A-Za-z0-9_-]{20,}/,
    /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/,
    /\bAIza[0-9A-Za-z_-]{35}\b/,
    /\bnpm_[A-Za-z0-9]{36}\b/,
    /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
    /\bhf_[A-Za-z0-9]{30,}/,
    // JSON Web Tokens
    /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    // Credentials embedded in a URL
    /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,100}:[^\s@/]{3,200}@/i,
    // Secret-like assignments: KEY=value, "password": "value", Authorization: Bearer value
    /(?:api[_-]?key|secret|token|passw(?:or)?d|passwd|credential|private[_-]?key|access[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_-]{0,20}["']?\s*[:=]\s*["']?[^\s"']{8,}/i,
    /\bauthorization\s*:\s*(?:bearer|basic|token)\s+\S{8,}/i,
];
// Mixed-case alphanumeric runs of 32+ characters. Lowercase hex, such as
// git SHAs and checksums, has no uppercase letter and does not match.
const HIGH_ENTROPY_TOKEN = /[A-Za-z0-9+/_-]{32,}/g;
function isMixedToken(token) {
    return /[a-z]/.test(token) && /[A-Z]/.test(token) && /[0-9]/.test(token);
}
// Commands whose output is likely to contain secrets in any format.
const SECRET_READING_COMMAND = /(?:^|[\s;&|(`$])(?:printenv|env|export\s+-p|set|declare\s+-x|gh\s+auth\s+token|security\s+find-(?:generic|internet)-password|kubectl\s+get\s+secrets?|aws\s+configure\s+(?:get|export-credentials)|op\s+(?:read|item\s+get)|vault\s+(?:kv\s+)?(?:read|get)|doppler\s+secrets|heroku\s+config|gcloud\s+auth\s+print-(?:access|identity)-token|az\s+account\s+get-access-token)(?=$|[\s;&|)`])|(?:\.env\b|\.npmrc|\.netrc|\.pgpass|credentials|id_(?:rsa|dsa|ecdsa|ed25519)\b|\.pem\b|\.p12\b|\.key\b|secrets?\.(?:json|ya?ml|toml))/i;
function commandText(toolInput) {
    if (typeof toolInput === "string")
        return toolInput;
    if (toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)) {
        const command = toolInput.command;
        if (typeof command === "string")
            return command;
    }
    return "";
}
/**
 * Local, offline check that decides whether successful output needs a
 * TypeSafe leak judgment. It favors recall: any credential-like text or a
 * command that reads secrets sends the output to TypeSafe. Output that
 * matches nothing is not sent. Set `output.successCheck: "always"` to send
 * every successful output.
 */
export function looksSensitive(output, toolInput) {
    const command = commandText(toolInput);
    if (command && SECRET_READING_COMMAND.test(command))
        return true;
    const text = output.length > PREFILTER_MAX_CHARS
        ? output.slice(0, PREFILTER_MAX_CHARS)
        : output;
    if (SENSITIVE_OUTPUT_PATTERNS.some((pattern) => pattern.test(text)))
        return true;
    for (const match of text.matchAll(HIGH_ENTROPY_TOKEN)) {
        if (isMixedToken(match[0]))
            return true;
    }
    return false;
}
/**
 * Returns true when output must be judged by TypeSafe. Failed output is
 * always judged. Successful output is judged when `successCheck` is
 * "always" or the local prefilter finds something sensitive.
 */
export function needsOutputJudgment(normalized, successCheck = "prefilter") {
    if (normalized.isError || successCheck === "always")
        return true;
    return looksSensitive(normalized.output, normalized.toolInput);
}
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
    if ("tool_response" in payload &&
        payload.tool_response !== undefined &&
        !(isError && payload.error !== undefined)) {
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
    let state;
    if ("toolInput" in input) {
        const normalized = input;
        state = buildOutputState({
            tool: normalized.tool,
            cwd: normalized.cwd,
            tool_input: normalized.toolInput,
            output: normalized.output,
            is_error: normalized.isError,
        });
    }
    else if ("config" in input) {
        const outputInput = input;
        state = buildOutputState({
            tool: outputInput.tool,
            cwd: outputInput.cwd,
            tool_input: outputInput.tool_input,
            output: outputInput.output,
            is_error: outputInput.is_error,
            config: outputInput.config,
        });
    }
    else {
        state = input;
    }
    const canonical = canonicalize({
        state,
        model: options?.model ?? DEFAULT_TYPESAFE_MODEL,
        questions: options?.questions ?? OUTPUT_QUESTIONS,
        thresholds: options?.thresholds ?? {
            leakThreshold: DEFAULT_LEAK_THRESHOLD,
            minConfidence: DEFAULT_CLASS_MIN_CONFIDENCE,
        },
    });
    return crypto
        .createHash("sha256")
        .update(JSON.stringify(canonical), "utf-8")
        .digest("hex");
}
export const outputKey = outputJudgmentKey;
export function evaluateOutput(response, config, options) {
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
    // Successful output never gets failure advice, even if an answer is present.
    const failureAnswer = options?.isError === false
        ? undefined
        : response.answers?.failure_class;
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
    let claimedToolUseId;
    if (store && normalized.toolUseId) {
        const claimed = await store.claimToolUseId(normalized.toolUseId);
        if (!claimed) {
            const last = await store.getLastVerdict("output");
            if (last && typeof last === "object")
                return last;
            throw new Error("Duplicate output judgment is already in progress");
        }
        claimedToolUseId = normalized.toolUseId;
    }
    const askFn = options?.askJevFn ?? askTypeSafe;
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
    let response;
    try {
        response = await askFn({
            model: config?.model ?? DEFAULT_TYPESAFE_MODEL,
            state: boundedState,
            questions: outputQuestionsFor(normalized.isError),
            apiKey: config?.apiKey,
            endpoint: config?.endpoint,
            timeoutMs: config?.timeoutMs,
            retries: config?.retries,
            signal: options?.signal,
        });
    }
    catch (error) {
        if (store && claimedToolUseId) {
            await store.releaseToolUseId(claimedToolUseId).catch(() => { });
        }
        throw error;
    }
    const verdict = evaluateOutput(response, config, { isError: normalized.isError });
    if (verdict.leaksSecret && normalized.toolResponse) {
        verdict.updatedToolOutput = redactBashOutput(normalized.toolResponse);
    }
    if (store) {
        await store.setLastVerdict("output", verdict);
    }
    return verdict;
}
