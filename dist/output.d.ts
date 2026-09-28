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
import { askTypeSafe, type TypeSafeResponse } from "./client.ts";
import type { LoadedConfig, OutputConfig } from "./config.ts";
import { type OutputInput } from "./state.ts";
import type { SessionStore } from "./hook-io.ts";
export declare const DEFAULT_LEAK_THRESHOLD = 0.9;
export declare const DEFAULT_CLASS_MIN_CONFIDENCE = 0.6;
export declare const WITHHELD_OUTPUT_TEXT = "[claude-jev] Output withheld because Jev flagged it as containing a secret. Do not reproduce the value.";
export declare const LEAK_SYSTEM_MESSAGE = "claude-jev: Bash output may contain a secret; output was withheld from Claude.";
export declare const OUTPUT_QUESTIONS: {
    readonly leaks_secret: {
        readonly type: "noul";
        readonly instructions: "Does `output` contain a secret or credential that must not be written to a session transcript?";
        readonly criteria: {
            readonly true: "A key, token, password, or private key appears in the text";
            readonly false: "Only ordinary program output";
        };
    };
    readonly failure_class: {
        readonly type: "choice";
        readonly instructions: "What kind of failure is `output` reporting?";
        readonly criteria: {
            readonly transient: "A network or resource hiccup that may succeed on a retry";
            readonly environment: "A missing dependency, port, or tool in the local setup";
            readonly code_bug: "The code or types are wrong";
            readonly permission: "Access was denied by the OS or a server";
            readonly user_error: "The command itself was invoked wrongly";
            readonly no_failure: "Output reports success or nothing wrong";
        };
    };
};
export type FailureClass = "transient" | "environment" | "code_bug" | "permission" | "user_error" | "no_failure";
export declare const CLASS_ADVICE: Record<FailureClass, string | null>;
export interface BashToolResponse {
    stdout?: string;
    stderr?: string;
    interrupted?: boolean;
    isImage?: boolean;
    [key: string]: unknown;
}
export interface PostToolUsePayload {
    session_id?: string;
    transcript_path?: string;
    cwd?: string;
    tool_name?: string;
    tool?: string;
    tool_input?: unknown;
    tool_use_id?: string;
    hook_event_name?: string;
    tool_response?: BashToolResponse | string | unknown;
    is_error?: boolean;
    [key: string]: unknown;
}
export interface PostToolUseFailurePayload {
    session_id?: string;
    transcript_path?: string;
    cwd?: string;
    tool_name?: string;
    tool?: string;
    tool_input?: unknown;
    tool_use_id?: string;
    hook_event_name?: string;
    error?: string | unknown;
    is_interrupt?: boolean;
    [key: string]: unknown;
}
export type RawOutputPayload = PostToolUsePayload | PostToolUseFailurePayload | Record<string, unknown>;
export interface NormalizedOutput {
    tool: string;
    cwd: string;
    toolUseId?: string;
    isError: boolean;
    toolInput: unknown;
    output: string;
    toolResponse?: unknown;
}
/**
 * Normalizes successful PostToolUse payloads and failed PostToolUseFailure top-level error payloads.
 */
export declare function normalizeToolOutput(payload: RawOutputPayload): NormalizedOutput;
export declare function isRecognizedBashResponse(toolResponse: unknown): boolean;
export declare function redactBashOutput(toolResponse: unknown): unknown;
export declare function outputJudgmentKey(input: NormalizedOutput | OutputInput | Record<string, unknown>, options?: {
    model?: string;
    questions?: unknown;
    thresholds?: {
        leakThreshold: number;
        minConfidence: number;
    };
}): string;
export declare const outputKey: typeof outputJudgmentKey;
export interface OutputVerdict {
    flagged: boolean;
    leaksSecret: boolean;
    leakScore: number;
    failureClass: FailureClass;
    failureConfidence: number;
    advice: string | null;
    systemMessage?: string;
    additionalContext?: string;
    updatedToolOutput?: unknown;
}
export interface OutputThresholds {
    leakThreshold?: number;
    minConfidence?: number;
}
export type EvaluateOutputConfig = LoadedConfig | OutputConfig | OutputThresholds | {
    leakThreshold?: number;
    minConfidence?: number;
    output?: OutputThresholds | OutputConfig;
    [key: string]: unknown;
};
export declare function evaluateOutput(response: TypeSafeResponse, config?: EvaluateOutputConfig): OutputVerdict;
export interface JudgeOutputOptions {
    config?: LoadedConfig | EvaluateOutputConfig;
    sessionStore?: SessionStore;
    askJevFn?: typeof askTypeSafe;
    signal?: AbortSignal;
}
export declare function judgeOutput(payload: RawOutputPayload, options?: JudgeOutputOptions): Promise<OutputVerdict>;
