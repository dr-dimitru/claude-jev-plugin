/**
 * Bounded state builders for TypeSafe Jev gate and output evaluation.
 *
 * Implements recursive string leaf bounding, Unicode-safe ellipsis markers,
 * field preservation (tool, cwd, error), and final serialized maxStateChars cap enforcement
 * without producing invalid JSON.
 */
export interface GateInput {
    tool?: string;
    tool_name?: string;
    cwd?: string;
    tool_input?: unknown;
    user_request?: string;
    platform?: string;
    config?: {
        argumentChars?: number;
        userRequestChars?: number;
        maxStateChars?: number;
        gate?: {
            argumentChars?: number;
            [key: string]: unknown;
        };
        [key: string]: unknown;
    };
}
export interface OutputInput {
    tool?: string;
    tool_name?: string;
    cwd?: string;
    tool_input?: unknown;
    output?: string;
    is_error?: boolean;
    error?: string;
    config?: {
        argumentChars?: number;
        outputChars?: number;
        maxStateChars?: number;
        output?: {
            outputChars?: number;
            [key: string]: unknown;
        };
        [key: string]: unknown;
    };
}
export declare const DEFAULT_USER_REQUEST_CHARS = 1200;
export declare const DEFAULT_ARGUMENT_CHARS = 400;
export declare const DEFAULT_OUTPUT_CHARS = 2000;
export declare const DEFAULT_MAX_STATE_CHARS = 8000;
/**
 * Bounds text using Unicode code points and appends the marker …[N chars elided].
 */
export declare function boundTextLeaves(val: unknown, maxChars: number): unknown;
/**
 * Enforces the final serialized maxStateChars cap without producing invalid JSON.
 * Follows spec:
 * 1. Optional user-request text is reduced or removed first.
 * 2. String leaves are reduced.
 * 3. Oversized optional fields are reduced or replaced by bounded markers/prefixes.
 * Never cuts a JSON string in the middle of a JSON document.
 * Never returns a value over maxStateChars.
 */
export declare function enforceMaxStateChars<T extends Record<string, unknown>>(rawState: T, maxStateChars: number): T;
/**
 * Builds the bounded gate state to send to TypeSafe Jev.
 * Includes only: cwd, tool, tool_input, user_request, and platform (if provided).
 * Strips session_id, transcript_path, etc.
 */
export declare function buildGateState(input: GateInput): Record<string, unknown>;
/**
 * Builds the bounded output state to send to TypeSafe Jev.
 * Includes only: cwd, tool, is_error, tool_input, output.
 */
export declare function buildOutputState(input: OutputInput): Record<string, unknown>;
