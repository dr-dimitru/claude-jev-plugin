import { askJev } from "../client.ts";
import type { LoadedConfig } from "../config.ts";
export interface PostToolHookSpecificOutput {
    hookEventName: "PostToolUse";
    additionalContext?: string;
    updatedToolOutput?: unknown;
}
export interface PostToolOutput {
    systemMessage?: string;
    hookSpecificOutput?: PostToolHookSpecificOutput;
}
export interface PostToolOptions {
    fetch?: typeof fetch;
    askJevFn?: typeof askJev;
    config?: LoadedConfig;
}
export declare function runPostTool(rawPayload?: unknown, options?: PostToolOptions): Promise<PostToolOutput | null>;
