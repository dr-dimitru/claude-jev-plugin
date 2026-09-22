/**
 * TypeSafe Jev client for claude-jev.
 *
 * Directly posts typed questions to TypeSafe System One API over HTTPS.
 * Pure TypeScript implementation using Node built-in fetch and AbortController.
 */
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
export interface JevNoulQuestion {
    type: "noul";
    instructions: string;
    criteria?: {
        true?: string;
        false?: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}
export interface JevScoreQuestion {
    type: "score";
    instructions: string;
    criteria: string[];
    [key: string]: unknown;
}
export interface JevChoiceQuestion {
    type: "choice";
    instructions: string;
    criteria: Record<string, string | null>;
    [key: string]: unknown;
}
export type JevQuestion = JevNoulQuestion | JevScoreQuestion | JevChoiceQuestion;
export interface JevNoulAnswer {
    type: "noul";
    noul: number;
}
export interface JevChoiceAnswer {
    type: "choice";
    choice: string;
    probabilities: Record<string, number>;
    confidence: number;
}
export interface JevScoreAnswer {
    type: "score";
    score: number;
    legend: Record<string, string>;
    probabilities: Record<string, number>;
    confidence: number;
}
export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;
export interface JevUsage {
    input_tokens: number;
    output_tokens: number;
    [key: string]: unknown;
}
export interface JevResponse {
    model?: string;
    answers: Record<string, JevAnswer>;
    usage?: JevUsage;
    [key: string]: unknown;
}
export interface JevCall {
    model?: string;
    state: unknown;
    questions: Record<string, JevQuestion>;
    apiKey?: string;
    endpoint?: string;
    timeoutMs?: number;
    retries?: number;
    retryDelayMs?: number;
    signal?: AbortSignal;
    fetch?: typeof fetch;
}
export declare class JevError extends Error {
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
export declare const PROBABILITY_SUM_TOLERANCE = 0.05;
/**
 * Strictly validates the wire response shape from TypeSafe Jev.
 */
export declare function validateJevResponse(raw: unknown, expectedQuestions?: Record<string, JevQuestion>): JevResponse;
export declare function parseRetryAfter(value: string | null | undefined, now?: number): number | undefined;
/**
 * Directly posts a request to TypeSafe System One and returns the validated response.
 */
export declare function askJev(call: JevCall): Promise<JevResponse>;
