/**
 * TypeSafe System One client for claude-jev.
 *
 * Directly posts typed questions to TypeSafe System One API over HTTPS.
 * Pure TypeScript implementation using Node built-in fetch and AbortController.
 */
export declare const DEFAULT_TYPESAFE_MODEL = "jev-latest";
/** @deprecated Use DEFAULT_TYPESAFE_MODEL. */
export { DEFAULT_TYPESAFE_MODEL as DEFAULT_MODEL };
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
/** @deprecated Use TypeSafeError. */
export { TypeSafeError as JevError };
/**
 * Returns true if an HTTP status code represents a retryable transient failure (429, 529, 5xx).
 */
export declare function isRetryableStatus(status: number): boolean;
/**
 * Validates a TypeSafe endpoint before an Authorization header is constructed.
 */
export declare function validateEndpoint(endpoint: string): string;
export declare const PROBABILITY_SUM_TOLERANCE = 0.05;
/**
 * Strictly validates the wire response shape from TypeSafe System One.
 */
export declare function validateTypeSafeResponse(raw: unknown, expectedQuestions?: Record<string, TypeSafeQuestion>): TypeSafeResponse;
/** @deprecated Use validateTypeSafeResponse. */
export { validateTypeSafeResponse as validateJevResponse };
export declare function parseRetryAfter(value: string | null | undefined, now?: number): number | undefined;
/**
 * Directly posts a request to TypeSafe System One and returns the validated response.
 */
export declare function askTypeSafe(call: TypeSafeCall): Promise<TypeSafeResponse>;
/** @deprecated Use askTypeSafe. */
export { askTypeSafe as askJev };
