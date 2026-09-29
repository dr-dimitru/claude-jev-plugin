import type { TypeSafeQuestion } from "./client.ts";
/** Maximum raw request size in UTF-8 bytes. */
export declare const MAX_DECISION_INPUT_BYTES: number;
/** Maximum number of questions per request. */
export declare const MAX_DECISION_QUESTIONS = 32;
/** TypeSafe Score accepts at least two levels, up to 10. */
export declare const MIN_SCORE_CRITERIA = 2;
export declare const MAX_SCORE_CRITERIA = 10;
/**
 * Plugin cap for Choice categories. The API allows 255, but two-decimal
 * probability rounding drift grows 0.005 per category, so a lower cap keeps
 * the response sum check meaningful.
 */
export declare const MIN_CHOICE_CRITERIA = 2;
export declare const MAX_CHOICE_CRITERIA = 20;
export declare const MAX_INSTRUCTIONS_CHARS = 2000;
export declare const MAX_CRITERION_CHARS = 500;
export declare const QUESTION_NAME_PATTERN: RegExp;
/** Validated custom question request. */
export interface DecisionRequest {
    state: unknown;
    questions: Record<string, TypeSafeQuestion>;
}
/** Input validation failure. Messages never include submitted content. */
export declare class DecisionInputError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
/**
 * Parses and validates one `{ state, questions }` request.
 * Throws DecisionInputError with fixed messages that never echo submitted content.
 */
export declare function parseDecisionRequest(input: string, maxStateChars: number): DecisionRequest;
