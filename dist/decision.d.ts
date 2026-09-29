import type { TypeSafeQuestion } from "./client.ts";
export declare const MAX_DECISION_INPUT_BYTES: number;
export declare const MAX_DECISION_QUESTIONS = 32;
export interface DecisionRequest {
    state: unknown;
    questions: Record<string, TypeSafeQuestion>;
}
export declare class DecisionInputError extends Error {
    constructor(message: string);
}
export declare function parseDecisionRequest(input: string, maxStateChars: number): DecisionRequest;
