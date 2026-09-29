import { askTypeSafe } from "../client.ts";
import type { LoadedConfig } from "../config.ts";
export interface PostToolFailureHookSpecificOutput {
    hookEventName: "PostToolUseFailure";
    additionalContext?: string;
}
export interface PostToolFailureOutput {
    systemMessage?: string;
    hookSpecificOutput?: PostToolFailureHookSpecificOutput;
}
export interface PostToolFailureOptions {
    fetch?: typeof fetch;
    askJevFn?: typeof askTypeSafe;
    config?: LoadedConfig;
}
export declare function runPostToolFailure(rawPayload?: unknown, options?: PostToolFailureOptions): Promise<PostToolFailureOutput | null>;
