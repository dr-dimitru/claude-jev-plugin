/**
 * TypeSafe System One client for claude-jev.
 *
 * Directly posts typed questions to TypeSafe System One API over HTTPS.
 * Model-neutral: Jev is the default model; any TypeSafe model ID is accepted.
 * Pure TypeScript implementation using Node built-in fetch and AbortController.
 */
export declare const DEFAULT_TYPESAFE_MODEL = "jev-latest";
/** @deprecated Use DEFAULT_TYPESAFE_MODEL. */
export declare const DEFAULT_MODEL = "jev-latest";
export declare const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export declare const DEFAULT_TIMEOUT_MS = 15000;
export declare const DEFAULT_RETRIES = 2;
/**
 * Register an API key in memory so it will be scrubbed from errors and diagnostics.
 */
export declare function registerApiKey(key?: string | null): void;
/**
 * Clear all registered API keys in memory (useful for testing).
 */
export declare function clearRegisteredApiKeys(): void;
/**
 * Redacts registered API keys and process.env.TYPESAFE_API_KEY from text.
 */
export declare function redact(text: string): string;
/**
 * Bounds text to a maximum character count, appending the marker …[N chars elided] if truncated.
 */
export declare function boundText(text: string, maxChars?: number): string;
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
export declare class TypeSafeError extends Error {
    readonly status?: number;
    readonly retryable: boolean;
    readonly code?: string;
    constructor(message: string, options?: {
        status?: number;
        retryable?: boolean;
        code?: string;
        cause?: unknown;
    });
}
/**
 * Returns true if an HTTP status code represents a retryable transient failure (429, 529, 5xx).
 */
export declare function isRetryableStatus(status: number): boolean;
/**
 * Validates a TypeSafe endpoint before an Authorization header is constructed.
 */
export declare function validateEndpoint(endpoint: string): string;
/**
 * Returns true when an endpoint points at a System One server on this
 * machine, such as a local Kev or Laya server. Local endpoints may use plain
 * HTTP and do not require an API key. The TypeSafe key from
 * TYPESAFE_API_KEY is never sent to them.
 */
export declare function isLocalEndpoint(endpoint: string | undefined): boolean;
export declare const PROBABILITY_SUM_TOLERANCE = 0.05;
/** Maximum rounding error of one probability reported to two decimals. */
export declare const PROBABILITY_ROUNDING_STEP = 0.005;
/**
 * Allowed deviation of a probability sum from 1 for a distribution over
 * `count` categories. Two-decimal rounding can drift by up to 0.005 per
 * category, so wide criteria need more than the fixed base tolerance.
 */
export declare function probabilityTolerance(count: number): number;
/**
 * Returns the family of a System One model ID: the lowercase text before the
 * first "-", ignoring any "org/" prefix. TypeSafe answers an alias such as
 * "jev-latest" with the versioned ID that ran, such as "jev-1.13.0"; both
 * belong to family "jev". A local Kev server loaded as "jaredpalmer/kev-4b"
 * may answer "kev-latest"; both belong to family "kev".
 */
export declare function modelFamily(modelId: string): string;
/**
 * Strictly validates the wire response shape from TypeSafe System One.
 *
 * Returns only `model`, validated `answers`, and `usage` token counts.
 * Unrequested top-level fields, extra answers, and extra usage fields are
 * dropped. When `expectedModel` is given, the response model must belong to
 * the same family, so a server-side substitution such as jev to kev fails.
 */
export declare function validateTypeSafeResponse(raw: unknown, expectedQuestions?: Record<string, TypeSafeQuestion>, expectedModel?: string): TypeSafeResponse;
export declare function parseRetryAfter(value: string | null | undefined, now?: number): number | undefined;
/**
 * Directly posts a request to TypeSafe System One and returns the validated response.
 */
export declare function askTypeSafe(call: TypeSafeCall): Promise<TypeSafeResponse>;
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
/** @deprecated Use TypeSafeChoiceAnswer. */
export type JevChoiceAnswer = TypeSafeChoiceAnswer;
/** @deprecated Use TypeSafeScoreAnswer. */
export type JevScoreAnswer = TypeSafeScoreAnswer;
/** @deprecated Use TypeSafeAnswer. */
export type JevAnswer = TypeSafeAnswer;
/** @deprecated Use TypeSafeUsage. */
export type JevUsage = TypeSafeUsage;
/** @deprecated Use TypeSafeResponse. */
export type JevResponse = TypeSafeResponse;
/** @deprecated Use TypeSafeCall. */
export type JevCall = TypeSafeCall;
/** @deprecated Use TypeSafeError. Same constructor, so instanceof works with either name. */
export declare const JevError: typeof TypeSafeError;
/** @deprecated Use TypeSafeError. */
export type JevError = TypeSafeError;
/** @deprecated Use validateTypeSafeResponse. */
export declare const validateJevResponse: typeof validateTypeSafeResponse;
/** @deprecated Use askTypeSafe. */
export declare const askJev: typeof askTypeSafe;
