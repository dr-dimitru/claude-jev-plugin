/**
 * TypeSafe System One client for claude-jev.
 *
 * Directly posts typed questions to TypeSafe System One API over HTTPS.
 * Pure TypeScript implementation using Node built-in fetch and AbortController.
 */

export const DEFAULT_TYPESAFE_MODEL = "jev-latest";
/** @deprecated Use DEFAULT_TYPESAFE_MODEL. */
export { DEFAULT_TYPESAFE_MODEL as DEFAULT_MODEL };
export const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_RETRIES = 2;

// --- Registered API Keys & Redaction ---

const registeredKeys = new Set<string>();

/**
 * Register an API key in memory so it will be scrubbed from errors and diagnostics.
 */
export function registerApiKey(key?: string | null): void {
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
export function clearRegisteredApiKeys(): void {
  registeredKeys.clear();
}

/**
 * Redacts registered API keys and process.env.TYPESAFE_API_KEY from text.
 */
export function redact(text: string): string {
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
export function boundText(text: string, maxChars: number = 500): string {
  if (text.length <= maxChars) {
    return text;
  }
  const elided = text.length - maxChars;
  return text.slice(0, maxChars) + `…[${elided} chars elided]`;
}

// --- Wire Types ---

export interface TypeSafeNoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: {
    true?: string;
    false?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface TypeSafeScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
  [key: string]: unknown;
}

export interface TypeSafeChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
  [key: string]: unknown;
}

export type TypeSafeQuestion = TypeSafeNoulQuestion | TypeSafeScoreQuestion | TypeSafeChoiceQuestion;

export interface TypeSafeNoulAnswer {
  type: "noul";
  noul: number;
}

export interface TypeSafeChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface TypeSafeScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type TypeSafeAnswer = TypeSafeNoulAnswer | TypeSafeChoiceAnswer | TypeSafeScoreAnswer;

export interface TypeSafeUsage {
  input_tokens: number;
  output_tokens: number;
  [key: string]: unknown;
}

export interface TypeSafeResponse {
  model?: string;
  answers: Record<string, TypeSafeAnswer>;
  usage?: TypeSafeUsage;
  [key: string]: unknown;
}

export interface TypeSafeCall {
  model?: string;
  state: unknown;
  questions: Record<string, TypeSafeQuestion>;
  apiKey?: string;
  endpoint?: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/** @deprecated Use TypeSafeNoulQuestion. */
export type JevNoulQuestion = TypeSafeNoulQuestion;
/** @deprecated Use TypeSafeScoreQuestion. */
export type JevScoreQuestion = TypeSafeScoreQuestion;
/** @deprecated Use TypeSafeChoiceQuestion. */
export type JevChoiceQuestion = TypeSafeChoiceQuestion;
/** @deprecated Use TypeSafeQuestion. */
export type JevQuestion = TypeSafeQuestion;
/** @deprecated Use TypeSafeNoulAnswer. */
export type JevNoulAnswer = TypeSafeNoulAnswer;
/** @deprecated Use TypeSafeScoreAnswer. */
export type JevScoreAnswer = TypeSafeScoreAnswer;
/** @deprecated Use TypeSafeChoiceAnswer. */
export type JevChoiceAnswer = TypeSafeChoiceAnswer;
/** @deprecated Use TypeSafeAnswer. */
export type JevAnswer = TypeSafeAnswer;
/** @deprecated Use TypeSafeUsage. */
export type JevUsage = TypeSafeUsage;
/** @deprecated Use TypeSafeResponse. */
export type JevResponse = TypeSafeResponse;
/** @deprecated Use TypeSafeCall. */
export type JevCall = TypeSafeCall;

// --- Error Handling ---

export class TypeSafeError extends Error {
  public readonly status?: number;
  public readonly retryable: boolean;
  public readonly code?: string;

  constructor(
    message: string,
    options?: {
      status?: number;
      retryable?: boolean;
      code?: string;
      cause?: unknown;
    }
  ) {
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

/** @deprecated Use TypeSafeError. */
export { TypeSafeError as JevError };

/**
 * Returns true if an HTTP status code represents a retryable transient failure (429, 529, 5xx).
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 529 || (status >= 500 && status <= 599);
}

/**
 * Validates a TypeSafe endpoint before an Authorization header is constructed.
 */
export function validateEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new TypeSafeError("Invalid TypeSafe endpoint URL", {
      code: "INVALID_ENDPOINT",
      retryable: false,
    });
  }

  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new TypeSafeError(
      "TypeSafe endpoint must use HTTPS without embedded credentials",
      { code: "INVALID_ENDPOINT", retryable: false }
    );
  }

  return parsed.href;
}

// --- Response Validation ---

export const PROBABILITY_SUM_TOLERANCE = 0.05;

function validateProbabilities(
  probs: unknown,
  qName: string,
  expectedKeys: string[]
): Record<string, number> {
  if (!probs || typeof probs !== "object" || Array.isArray(probs)) {
    throw new TypeSafeError(
      `Malformed answer for question '${qName}': probabilities must be an object`,
      { code: "MALFORMED_RESPONSE", retryable: false }
    );
  }
  const obj = probs as Record<string, unknown>;
  const keys = Object.keys(obj);
  const actual = [...keys].sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length === 0 ||
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeSafeError(
      `Malformed answer for question '${qName}': probability keys must match declared criteria`,
      { code: "MALFORMED_RESPONSE", retryable: false }
    );
  }

  let total = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new TypeSafeError(
        `Malformed answer for question '${qName}': probability for '${k}' must be a finite number between 0 and 1`,
        { code: "MALFORMED_RESPONSE", retryable: false }
      );
    }
    total += v;
  }
  // TypeSafe rounds each probability to two decimals, so a six-way
  // distribution legitimately sums to 0.97..1.03. Accept that drift and
  // renormalize; anything wider is a malformed distribution.
  if (Math.abs(total - 1) > PROBABILITY_SUM_TOLERANCE) {
    throw new TypeSafeError(
      `Malformed answer for question '${qName}': probabilities must sum to 1`,
      { code: "MALFORMED_RESPONSE", retryable: false }
    );
  }
  if (total === 1) return obj as Record<string, number>;
  const normalized: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    normalized[k] = (v as number) / total;
  }
  return normalized;
}

function validateAnswer(
  rawAnswer: unknown,
  qName: string,
  expectedQuestion?: TypeSafeQuestion
): TypeSafeAnswer {
  if (!rawAnswer || typeof rawAnswer !== "object" || Array.isArray(rawAnswer)) {
    throw new TypeSafeError(
      `Malformed answer for question '${qName}': expected object`,
      { code: "MALFORMED_RESPONSE", retryable: false }
    );
  }

  const ans = rawAnswer as Record<string, unknown>;
  const ansType = ans.type;

  if (typeof ansType !== "string") {
    throw new TypeSafeError(
      `Malformed answer for question '${qName}': missing answer type`,
      { code: "MALFORMED_RESPONSE", retryable: false }
    );
  }

  if (expectedQuestion !== undefined && ansType !== expectedQuestion.type) {
    throw new TypeSafeError(
      `Malformed answer for question '${qName}': answer type '${ansType}' does not match question type '${expectedQuestion.type}'`,
      { code: "MALFORMED_RESPONSE", retryable: false }
    );
  }

  if (ansType === "noul") {
    if (
      typeof ans.noul !== "number" ||
      !Number.isFinite(ans.noul) ||
      ans.noul < 0 ||
      ans.noul > 1
    ) {
      throw new TypeSafeError(
        `Malformed answer for question '${qName}': noul must be a finite number between 0 and 1`,
        { code: "MALFORMED_RESPONSE", retryable: false }
      );
    }
    return {
      type: "noul",
      noul: ans.noul,
    };
  }

  if (ansType === "choice") {
    if (typeof ans.choice !== "string") {
      throw new TypeSafeError(
        `Malformed answer for question '${qName}': choice must be a string`,
        { code: "MALFORMED_RESPONSE", retryable: false }
      );
    }
    const expectedKeys =
      expectedQuestion?.type === "choice"
        ? Object.keys(expectedQuestion.criteria)
        : Object.keys((ans.probabilities as Record<string, unknown>) ?? {});
    if (!expectedKeys.includes(ans.choice)) {
      throw new TypeSafeError(
        `Malformed answer for question '${qName}': choice must match declared criteria`,
        { code: "MALFORMED_RESPONSE", retryable: false }
      );
    }
    const probs = validateProbabilities(ans.probabilities, qName, expectedKeys);
    if (
      typeof ans.confidence !== "number" ||
      !Number.isFinite(ans.confidence) ||
      ans.confidence < 0 ||
      ans.confidence > 1
    ) {
      throw new TypeSafeError(
        `Malformed answer for question '${qName}': confidence must be a finite number between 0 and 1`,
        { code: "MALFORMED_RESPONSE", retryable: false }
      );
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
      throw new TypeSafeError(
        `Malformed answer for question '${qName}': score must be a finite number`,
        { code: "MALFORMED_RESPONSE", retryable: false }
      );
    }
    if (!ans.legend || typeof ans.legend !== "object" || Array.isArray(ans.legend)) {
      throw new TypeSafeError(
        `Malformed answer for question '${qName}': legend must be an object`,
        { code: "MALFORMED_RESPONSE", retryable: false }
      );
    }
    const legendObj = ans.legend as Record<string, unknown>;
    for (const [k, v] of Object.entries(legendObj)) {
      if (typeof v !== "string") {
        throw new TypeSafeError(
          `Malformed answer for question '${qName}': legend value for '${k}' must be a string`,
          { code: "MALFORMED_RESPONSE", retryable: false }
        );
      }
    }
    const expectedCriteria =
      expectedQuestion?.type === "score"
        ? expectedQuestion.criteria
        : Object.values(legendObj);
    const expectedKeys = expectedCriteria.map((_, index) => String(index));
    if (
      ans.score < 0 ||
      ans.score > expectedCriteria.length - 1 ||
      Object.keys(legendObj).length !== expectedKeys.length ||
      expectedKeys.some((key, index) => legendObj[key] !== expectedCriteria[index])
    ) {
      throw new TypeSafeError(
        `Malformed answer for question '${qName}': score legend must match declared criteria`,
        { code: "MALFORMED_RESPONSE", retryable: false }
      );
    }
    const probs = validateProbabilities(ans.probabilities, qName, expectedKeys);
    if (
      typeof ans.confidence !== "number" ||
      !Number.isFinite(ans.confidence) ||
      ans.confidence < 0 ||
      ans.confidence > 1
    ) {
      throw new TypeSafeError(
        `Malformed answer for question '${qName}': confidence must be a finite number between 0 and 1`,
        { code: "MALFORMED_RESPONSE", retryable: false }
      );
    }
    return {
      type: "score",
      score: ans.score,
      legend: legendObj as Record<string, string>,
      probabilities: probs,
      confidence: ans.confidence,
    };
  }

  throw new TypeSafeError(
    `Malformed answer for question '${qName}': unknown answer type '${ansType}'`,
    { code: "MALFORMED_RESPONSE", retryable: false }
  );
}

/**
 * Strictly validates the wire response shape from TypeSafe System One.
 */
export function validateTypeSafeResponse(
  raw: unknown,
  expectedQuestions?: Record<string, TypeSafeQuestion>
): TypeSafeResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeSafeError("Malformed response: expected JSON object", {
      code: "MALFORMED_RESPONSE",
      retryable: false,
    });
  }

  const rawObj = raw as Record<string, unknown>;
  const rawAnswers = rawObj.answers;
  if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
    throw new TypeSafeError("Malformed response: missing answers object", {
      code: "MALFORMED_RESPONSE",
      retryable: false,
    });
  }

  const answersObj = rawAnswers as Record<string, unknown>;
  const validatedAnswers: Record<string, TypeSafeAnswer> = {};

  if (expectedQuestions) {
    for (const [qName, qDef] of Object.entries(expectedQuestions)) {
      if (!(qName in answersObj)) {
        throw new TypeSafeError(
          `Malformed response: missing answer for question '${qName}'`,
          { code: "MALFORMED_RESPONSE", retryable: false }
        );
      }
      validatedAnswers[qName] = validateAnswer(answersObj[qName], qName, qDef);
    }
  } else {
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

  let validatedUsage: TypeSafeUsage | undefined;
  if (rawObj.usage !== undefined) {
    if (!rawObj.usage || typeof rawObj.usage !== "object" || Array.isArray(rawObj.usage)) {
      throw new TypeSafeError("Malformed response: usage must be an object", {
        code: "MALFORMED_RESPONSE",
        retryable: false,
      });
    }
    const u = rawObj.usage as Record<string, unknown>;
    if (
      typeof u.input_tokens !== "number" ||
      !Number.isFinite(u.input_tokens) ||
      typeof u.output_tokens !== "number" ||
      !Number.isFinite(u.output_tokens)
    ) {
      throw new TypeSafeError(
        "Malformed response: usage input_tokens and output_tokens must be finite numbers",
        { code: "MALFORMED_RESPONSE", retryable: false }
      );
    }
    validatedUsage = {
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      ...u,
    };
  } else {
    throw new TypeSafeError("Malformed response: missing usage object", {
      code: "MALFORMED_RESPONSE",
      retryable: false,
    });
  }

  const result: TypeSafeResponse = {
    ...rawObj,
    answers: validatedAnswers,
  };
  if (validatedUsage) {
    result.usage = validatedUsage;
  }
  return result;
}

/** @deprecated Use validateTypeSafeResponse. */
export { validateTypeSafeResponse as validateJevResponse };

export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now()
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - now);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
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
export async function askTypeSafe(call: TypeSafeCall): Promise<TypeSafeResponse> {
  if (call.apiKey) registerApiKey(call.apiKey);
  const envKey = process.env.TYPESAFE_API_KEY?.trim();
  if (envKey) registerApiKey(envKey);

  const apiKey = call.apiKey?.trim() || envKey;
  if (!apiKey) {
    throw new TypeSafeError(
      "Missing TypeSafe API key. Set TYPESAFE_API_KEY or provide apiKey in TypeSafeCall.",
      { code: "MISSING_KEY", retryable: false }
    );
  }

  const model = call.model ?? DEFAULT_TYPESAFE_MODEL;
  const endpoint = validateEndpoint(call.endpoint ?? DEFAULT_ENDPOINT);
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

  const abortError = (): TypeSafeError => {
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

  const retryDelay = (attempt: number, response?: Response): number => {
    const headerDelay = parseRetryAfter(response?.headers?.get("Retry-After"));
    if (headerDelay !== undefined) return headerDelay;
    if (call.retryDelayMs !== undefined) return call.retryDelayMs;
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
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: requestBody,
          signal: controller.signal,
        });

        if (res.ok) {
          let json: unknown;
          try {
            json = await res.json();
          } catch (parseErr) {
            if (controller.signal.aborted) throw abortError();
            throw new TypeSafeError(
              `Malformed JSON response from TypeSafe API: ${(parseErr as Error).message}`,
              { code: "MALFORMED_JSON", retryable: false, cause: parseErr }
            );
          }
          return validateTypeSafeResponse(json, call.questions);
        }

        const status = res.status;
        const retryable = isRetryableStatus(status);
        const rawBody = await res.text().catch((error) => {
          if (controller.signal.aborted) throw abortError();
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
          if (delay > 0) await sleep(delay, controller.signal);
          continue;
        }

        throw new TypeSafeError(
          `TypeSafe API error (HTTP ${status}): ${boundedBody || res.statusText || "Unknown error"}`,
          { status, retryable, code: `HTTP_${status}` }
        );
      } catch (err: unknown) {
        if (controller.signal.aborted || timedOut || Date.now() >= deadline) {
          throw abortError();
        }
        if (err instanceof TypeSafeError) throw err;

        const name = (err as Error)?.name;
        const isNetwork = name === "AbortError" || name === "TimeoutError" || name === "TypeError";
        if (isNetwork && attempt < retries) {
          const delay = retryDelay(attempt);
          const remaining = deadline - Date.now();
          if (delay >= remaining) {
            await sleep(Math.max(0, remaining), controller.signal);
            throw abortError();
          }
          if (delay > 0) await sleep(delay, controller.signal);
          continue;
        }

        throw new TypeSafeError(`Network error: ${(err as Error).message}`, {
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
  } finally {
    clearTimeout(timeoutId);
    call.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** @deprecated Use askTypeSafe. */
export { askTypeSafe as askJev };
