/**
 * TypeSafe System One client for claude-jev.
 *
 * Directly posts typed questions to TypeSafe System One API over HTTPS.
 * Model-neutral: Jev is the default model; any TypeSafe model ID is accepted.
 * Pure TypeScript implementation using Node built-in fetch and AbortController.
 */
export const DEFAULT_TYPESAFE_MODEL = "jev-latest";
/** @deprecated Use DEFAULT_TYPESAFE_MODEL. */
export const DEFAULT_MODEL = DEFAULT_TYPESAFE_MODEL;
export const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_RETRIES = 2;
// --- Registered API Keys & Redaction ---
const registeredKeys = new Set();
/**
 * Register an API key in memory so it will be scrubbed from errors and diagnostics.
 */
export function registerApiKey(key) {
    if (typeof key === "string") {
        const trimmed = key.trim();
        if (trimmed.length > 0) {
            registeredKeys.add(trimmed);
        }
    }
}
/**
 * Clear all registered API keys in memory (useful for testing).
 */
export function clearRegisteredApiKeys() {
    registeredKeys.clear();
}
/**
 * Redacts registered API keys and process.env.TYPESAFE_API_KEY from text.
 */
export function redact(text) {
    if (typeof text !== "string") {
        return "";
    }
    let result = text;
    const envKey = process.env.TYPESAFE_API_KEY?.trim();
    if (envKey && envKey.length > 0 && result.includes(envKey)) {
        result = result.split(envKey).join("[REDACTED]");
    }
    for (const key of registeredKeys) {
        if (key.length > 0 && result.includes(key)) {
            result = result.split(key).join("[REDACTED]");
        }
    }
    return result;
}
/**
 * Bounds text to a maximum character count, appending the marker …[N chars elided] if truncated.
 */
export function boundText(text, maxChars = 500) {
    if (text.length <= maxChars) {
        return text;
    }
    const elided = text.length - maxChars;
    return text.slice(0, maxChars) + `…[${elided} chars elided]`;
}
// --- Error Handling ---
export class TypeSafeError extends Error {
    status;
    retryable;
    code;
    constructor(message, options) {
        super(redact(message));
        this.name = "TypeSafeError";
        this.status = options?.status;
        this.retryable = options?.retryable ?? false;
        this.code = options?.code;
        if (options?.cause !== undefined) {
            this.cause = options.cause;
        }
        Object.setPrototypeOf(this, TypeSafeError.prototype);
    }
}
/**
 * Returns true if an HTTP status code represents a retryable transient failure (429, 529, 5xx).
 */
export function isRetryableStatus(status) {
    return status === 429 || status === 529 || (status >= 500 && status <= 599);
}
/**
 * Validates a TypeSafe endpoint before an Authorization header is constructed.
 */
export function validateEndpoint(endpoint) {
    let parsed;
    try {
        parsed = new URL(endpoint);
    }
    catch {
        throw new TypeSafeError("Invalid TypeSafe endpoint URL", {
            code: "INVALID_ENDPOINT",
            retryable: false,
        });
    }
    const allowedProtocol = parsed.protocol === "https:" ||
        (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname));
    if (!allowedProtocol || parsed.username || parsed.password) {
        throw new TypeSafeError("TypeSafe endpoint must use HTTPS, or HTTP on a loopback host, without embedded credentials", { code: "INVALID_ENDPOINT", retryable: false });
    }
    return parsed.href;
}
function isLoopbackHost(hostname) {
    const host = hostname.toLowerCase();
    return (host === "localhost" ||
        host === "[::1]" ||
        /^127(\.\d{1,3}){3}$/.test(host));
}
/**
 * Returns true when an endpoint points at a System One server on this
 * machine, such as a local Kev or Laya server. Local endpoints may use plain
 * HTTP and do not require an API key. The TypeSafe key from
 * TYPESAFE_API_KEY is never sent to them.
 */
export function isLocalEndpoint(endpoint) {
    if (endpoint === undefined)
        return false;
    try {
        return isLoopbackHost(new URL(endpoint).hostname);
    }
    catch {
        return false;
    }
}
// --- Response Validation ---
export const PROBABILITY_SUM_TOLERANCE = 0.05;
/** Maximum rounding error of one probability reported to two decimals. */
export const PROBABILITY_ROUNDING_STEP = 0.005;
/**
 * Allowed deviation of a probability sum from 1 for a distribution over
 * `count` categories. Two-decimal rounding can drift by up to 0.005 per
 * category, so wide criteria need more than the fixed base tolerance.
 */
export function probabilityTolerance(count) {
    return Math.max(PROBABILITY_SUM_TOLERANCE, count * PROBABILITY_ROUNDING_STEP + 1e-9);
}
/** Bounds a server-supplied string before it appears in an error message. */
function quoteServerValue(value) {
    return JSON.stringify(boundText(value, 40));
}
function validateProbabilities(probs, qName, expectedKeys) {
    if (!probs || typeof probs !== "object" || Array.isArray(probs)) {
        throw new TypeSafeError(`Malformed answer for question '${qName}': probabilities must be an object`, { code: "MALFORMED_RESPONSE", retryable: false });
    }
    const obj = probs;
    const keys = Object.keys(obj);
    const actual = [...keys].sort();
    const expected = [...expectedKeys].sort();
    if (keys.length === 0 ||
        actual.length !== expected.length ||
        actual.some((key, index) => key !== expected[index])) {
        throw new TypeSafeError(`Malformed answer for question '${qName}': probability keys must match declared criteria`, { code: "MALFORMED_RESPONSE", retryable: false });
    }
    let total = 0;
    for (const [k, v] of Object.entries(obj)) {
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
            throw new TypeSafeError(`Malformed answer for question '${qName}': probability for '${k}' must be a finite number between 0 and 1`, { code: "MALFORMED_RESPONSE", retryable: false });
        }
        total += v;
    }
    // TypeSafe rounds each probability to two decimals, so a six-way
    // distribution legitimately sums to 0.97..1.03. Accept that drift and
    // renormalize; anything wider is a malformed distribution.
    if (Math.abs(total - 1) > probabilityTolerance(keys.length)) {
        throw new TypeSafeError(`Malformed answer for question '${qName}': probabilities must sum to 1`, { code: "MALFORMED_RESPONSE", retryable: false });
    }
    if (total === 1)
        return obj;
    const normalized = {};
    for (const [k, v] of Object.entries(obj)) {
        normalized[k] = v / total;
    }
    return normalized;
}
function validateAnswer(rawAnswer, qName, expectedQuestion) {
    if (!rawAnswer || typeof rawAnswer !== "object" || Array.isArray(rawAnswer)) {
        throw new TypeSafeError(`Malformed answer for question '${qName}': expected object`, { code: "MALFORMED_RESPONSE", retryable: false });
    }
    const ans = rawAnswer;
    // Some local servers, such as Laya, omit `type`. When the question is
    // known, its declared type decides how the answer is validated.
    const ansType = ans.type === undefined && expectedQuestion !== undefined
        ? expectedQuestion.type
        : ans.type;
    if (typeof ansType !== "string") {
        throw new TypeSafeError(`Malformed answer for question '${qName}': missing answer type`, { code: "MALFORMED_RESPONSE", retryable: false });
    }
    if (expectedQuestion !== undefined && ansType !== expectedQuestion.type) {
        throw new TypeSafeError(`Malformed answer for question '${qName}': answer type ${quoteServerValue(ansType)} does not match question type '${expectedQuestion.type}'`, { code: "MALFORMED_RESPONSE", retryable: false });
    }
    if (ansType === "noul") {
        if (typeof ans.noul !== "number" ||
            !Number.isFinite(ans.noul) ||
            ans.noul < 0 ||
            ans.noul > 1) {
            throw new TypeSafeError(`Malformed answer for question '${qName}': noul must be a finite number between 0 and 1`, { code: "MALFORMED_RESPONSE", retryable: false });
        }
        return {
            type: "noul",
            noul: ans.noul,
        };
    }
    if (ansType === "choice") {
        if (typeof ans.choice !== "string") {
            throw new TypeSafeError(`Malformed answer for question '${qName}': choice must be a string`, { code: "MALFORMED_RESPONSE", retryable: false });
        }
        const expectedKeys = expectedQuestion?.type === "choice"
            ? Object.keys(expectedQuestion.criteria)
            : Object.keys(ans.probabilities ?? {});
        if (!expectedKeys.includes(ans.choice)) {
            throw new TypeSafeError(`Malformed answer for question '${qName}': choice must match declared criteria`, { code: "MALFORMED_RESPONSE", retryable: false });
        }
        const probs = validateProbabilities(ans.probabilities, qName, expectedKeys);
        if (typeof ans.confidence !== "number" ||
            !Number.isFinite(ans.confidence) ||
            ans.confidence < 0 ||
            ans.confidence > 1) {
            throw new TypeSafeError(`Malformed answer for question '${qName}': confidence must be a finite number between 0 and 1`, { code: "MALFORMED_RESPONSE", retryable: false });
        }
        return {
            type: "choice",
            choice: ans.choice,
            probabilities: probs,
            confidence: ans.confidence,
        };
    }
    if (ansType === "score") {
        if (typeof ans.score !== "number" || !Number.isFinite(ans.score)) {
            throw new TypeSafeError(`Malformed answer for question '${qName}': score must be a finite number`, { code: "MALFORMED_RESPONSE", retryable: false });
        }
        if (!ans.legend || typeof ans.legend !== "object" || Array.isArray(ans.legend)) {
            throw new TypeSafeError(`Malformed answer for question '${qName}': legend must be an object`, { code: "MALFORMED_RESPONSE", retryable: false });
        }
        const legendObj = ans.legend;
        for (const [k, v] of Object.entries(legendObj)) {
            if (typeof v !== "string") {
                throw new TypeSafeError(`Malformed answer for question '${qName}': legend value for '${k}' must be a string`, { code: "MALFORMED_RESPONSE", retryable: false });
            }
        }
        const expectedCriteria = expectedQuestion?.type === "score"
            ? expectedQuestion.criteria
            : Object.values(legendObj);
        const expectedKeys = expectedCriteria.map((_, index) => String(index));
        if (ans.score < 0 ||
            ans.score > expectedCriteria.length - 1 ||
            Object.keys(legendObj).length !== expectedKeys.length ||
            expectedKeys.some((key, index) => legendObj[key] !== expectedCriteria[index])) {
            throw new TypeSafeError(`Malformed answer for question '${qName}': score legend must match declared criteria`, { code: "MALFORMED_RESPONSE", retryable: false });
        }
        const probs = validateProbabilities(ans.probabilities, qName, expectedKeys);
        if (typeof ans.confidence !== "number" ||
            !Number.isFinite(ans.confidence) ||
            ans.confidence < 0 ||
            ans.confidence > 1) {
            throw new TypeSafeError(`Malformed answer for question '${qName}': confidence must be a finite number between 0 and 1`, { code: "MALFORMED_RESPONSE", retryable: false });
        }
        return {
            type: "score",
            score: ans.score,
            legend: legendObj,
            probabilities: probs,
            confidence: ans.confidence,
        };
    }
    throw new TypeSafeError(`Malformed answer for question '${qName}': unknown answer type ${quoteServerValue(ansType)}`, { code: "MALFORMED_RESPONSE", retryable: false });
}
/**
 * Returns the family of a System One model ID: the lowercase text before the
 * first "-", ignoring any "org/" prefix. TypeSafe answers an alias such as
 * "jev-latest" with the versioned ID that ran, such as "jev-1.13.0"; both
 * belong to family "jev". A local Kev server loaded as "jaredpalmer/kev-4b"
 * may answer "kev-latest"; both belong to family "kev".
 */
export function modelFamily(modelId) {
    const lowered = modelId.trim().toLowerCase();
    const trimmed = lowered.slice(lowered.lastIndexOf("/") + 1);
    const dash = trimmed.indexOf("-");
    return dash === -1 ? trimmed : trimmed.slice(0, dash);
}
/**
 * Strictly validates the wire response shape from TypeSafe System One.
 *
 * Returns only `model`, validated `answers`, and `usage` token counts.
 * Unrequested top-level fields, extra answers, and extra usage fields are
 * dropped. When `expectedModel` is given, the response model must belong to
 * the same family, so a server-side substitution such as jev to kev fails.
 */
export function validateTypeSafeResponse(raw, expectedQuestions, expectedModel) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new TypeSafeError("Malformed response: expected JSON object", {
            code: "MALFORMED_RESPONSE",
            retryable: false,
        });
    }
    const rawObj = raw;
    const rawAnswers = rawObj.answers;
    if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
        throw new TypeSafeError("Malformed response: missing answers object", {
            code: "MALFORMED_RESPONSE",
            retryable: false,
        });
    }
    const answersObj = rawAnswers;
    const validatedAnswers = {};
    if (expectedQuestions) {
        for (const [qName, qDef] of Object.entries(expectedQuestions)) {
            if (!Object.hasOwn(answersObj, qName)) {
                throw new TypeSafeError(`Malformed response: missing answer for question '${qName}'`, { code: "MALFORMED_RESPONSE", retryable: false });
            }
            validatedAnswers[qName] = validateAnswer(answersObj[qName], qName, qDef);
        }
    }
    else {
        for (const [qName, rawAns] of Object.entries(answersObj)) {
            validatedAnswers[qName] = validateAnswer(rawAns, qName);
        }
    }
    if (typeof rawObj.model !== "string" || rawObj.model.trim().length === 0) {
        throw new TypeSafeError("Malformed response: model must be a non-empty string", {
            code: "MALFORMED_RESPONSE",
            retryable: false,
        });
    }
    const model = rawObj.model.trim();
    if (expectedModel !== undefined && modelFamily(model) !== modelFamily(expectedModel)) {
        throw new TypeSafeError(`Model mismatch: requested ${quoteServerValue(expectedModel)} but TypeSafe answered with ${quoteServerValue(model)}`, { code: "MODEL_MISMATCH", retryable: false });
    }
    if (!rawObj.usage || typeof rawObj.usage !== "object" || Array.isArray(rawObj.usage)) {
        throw new TypeSafeError(rawObj.usage === undefined
            ? "Malformed response: missing usage object"
            : "Malformed response: usage must be an object", { code: "MALFORMED_RESPONSE", retryable: false });
    }
    const u = rawObj.usage;
    if (typeof u.input_tokens !== "number" ||
        !Number.isFinite(u.input_tokens) ||
        typeof u.output_tokens !== "number" ||
        !Number.isFinite(u.output_tokens)) {
        throw new TypeSafeError("Malformed response: usage input_tokens and output_tokens must be finite numbers", { code: "MALFORMED_RESPONSE", retryable: false });
    }
    return {
        model,
        answers: validatedAnswers,
        usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens },
    };
}
export function parseRetryAfter(value, now = Date.now()) {
    if (!value)
        return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.round(seconds * 1000);
    }
    const date = Date.parse(value);
    if (!Number.isFinite(date))
        return undefined;
    return Math.max(0, date - now);
}
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        let timer;
        const onAbort = () => {
            if (timer)
                clearTimeout(timer);
            reject(signal?.reason ?? new Error("Aborted"));
        };
        if (signal?.aborted) {
            onAbort();
            return;
        }
        timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
// --- Direct TypeSafe Invocation ---
/**
 * Directly posts a request to TypeSafe System One and returns the validated response.
 */
export async function askTypeSafe(call) {
    if (call.apiKey)
        registerApiKey(call.apiKey);
    const envKey = process.env.TYPESAFE_API_KEY?.trim();
    if (envKey)
        registerApiKey(envKey);
    const endpoint = validateEndpoint(call.endpoint ?? DEFAULT_ENDPOINT);
    const local = isLocalEndpoint(endpoint);
    // Never fall back to the TypeSafe key for a local server; it may be any
    // process listening on that port. Local servers need a key only when their
    // operator set one, and it must be passed explicitly.
    const apiKey = call.apiKey?.trim() || (local ? undefined : envKey);
    if (!apiKey && !local) {
        throw new TypeSafeError("Missing TypeSafe API key. Set TYPESAFE_API_KEY or provide apiKey in the call.", { code: "MISSING_KEY", retryable: false });
    }
    const model = call.model ?? DEFAULT_MODEL;
    const timeoutMs = call.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = call.retries ?? DEFAULT_RETRIES;
    const fetchFn = call.fetch ?? fetch;
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("Timeout"));
    }, timeoutMs);
    const onCallerAbort = () => controller.abort(call.signal?.reason);
    if (call.signal) {
        if (call.signal.aborted) {
            clearTimeout(timeoutId);
            throw new TypeSafeError("Request aborted by caller", {
                code: "ABORTED",
                retryable: false,
                cause: call.signal.reason,
            });
        }
        call.signal.addEventListener("abort", onCallerAbort, { once: true });
    }
    const requestBody = JSON.stringify({
        model,
        state: call.state,
        questions: call.questions,
    });
    const abortError = () => {
        if (call.signal?.aborted) {
            return new TypeSafeError("Request aborted by caller", {
                code: "ABORTED",
                retryable: false,
                cause: call.signal.reason,
            });
        }
        return new TypeSafeError(`Request timed out after ${timeoutMs}ms`, {
            code: "TIMEOUT",
            retryable: true,
            cause: controller.signal.reason,
        });
    };
    const retryDelay = (attempt, response) => {
        const headerDelay = parseRetryAfter(response?.headers?.get("Retry-After"));
        if (headerDelay !== undefined)
            return headerDelay;
        if (call.retryDelayMs !== undefined)
            return call.retryDelayMs;
        const base = Math.min(2000, 250 * 2 ** attempt);
        return Math.round(base * (0.75 + Math.random() * 0.5));
    };
    try {
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (controller.signal.aborted || Date.now() >= deadline) {
                throw abortError();
            }
            try {
                const res = await fetchFn(endpoint, {
                    method: "POST",
                    headers: apiKey
                        ? { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` }
                        : { "Content-Type": "application/json" },
                    body: requestBody,
                    signal: controller.signal,
                });
                if (res.ok) {
                    let json;
                    try {
                        json = await res.json();
                    }
                    catch (parseErr) {
                        if (controller.signal.aborted)
                            throw abortError();
                        throw new TypeSafeError(`Malformed JSON response from TypeSafe API: ${parseErr.message}`, { code: "MALFORMED_JSON", retryable: false, cause: parseErr });
                    }
                    return validateTypeSafeResponse(json, call.questions, model);
                }
                const status = res.status;
                const retryable = isRetryableStatus(status);
                const rawBody = await res.text().catch((error) => {
                    if (controller.signal.aborted)
                        throw abortError();
                    throw error;
                });
                const boundedBody = redact(boundText(rawBody, 500));
                if (retryable && attempt < retries) {
                    const delay = retryDelay(attempt, res);
                    const remaining = deadline - Date.now();
                    if (delay >= remaining) {
                        await sleep(Math.max(0, remaining), controller.signal);
                        throw abortError();
                    }
                    if (delay > 0)
                        await sleep(delay, controller.signal);
                    continue;
                }
                throw new TypeSafeError(`TypeSafe API error (HTTP ${status}): ${boundedBody || res.statusText || "Unknown error"}`, { status, retryable, code: `HTTP_${status}` });
            }
            catch (err) {
                if (controller.signal.aborted || timedOut || Date.now() >= deadline) {
                    throw abortError();
                }
                if (err instanceof TypeSafeError)
                    throw err;
                const name = err?.name;
                const isNetwork = name === "AbortError" || name === "TimeoutError" || name === "TypeError";
                if (isNetwork && attempt < retries) {
                    const delay = retryDelay(attempt);
                    const remaining = deadline - Date.now();
                    if (delay >= remaining) {
                        await sleep(Math.max(0, remaining), controller.signal);
                        throw abortError();
                    }
                    if (delay > 0)
                        await sleep(delay, controller.signal);
                    continue;
                }
                throw new TypeSafeError(`Network error: ${err.message}`, {
                    code: "NETWORK_ERROR",
                    retryable: true,
                    cause: err,
                });
            }
        }
        throw new TypeSafeError("Request failed: maximum retries exhausted", {
            code: "RETRIES_EXHAUSTED",
            retryable: true,
        });
    }
    finally {
        clearTimeout(timeoutId);
        call.signal?.removeEventListener("abort", onCallerAbort);
    }
}
/** @deprecated Use TypeSafeError. Same constructor, so instanceof works with either name. */
export const JevError = TypeSafeError;
/** @deprecated Use validateTypeSafeResponse. */
export const validateJevResponse = validateTypeSafeResponse;
/** @deprecated Use askTypeSafe. */
export const askJev = askTypeSafe;
