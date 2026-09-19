/**
 * PostToolUse Hook for claude-jev.
 *
 * Implements:
 * - Safe Claude stdin parsing
 * - Normalization of successful tool_response via src/output.ts
 * - Config and session state loading
 * - Skipping disabled/unconfigured/missing-key paths
 * - Duplicate tool_use_id judging prevention
 * - Exactly one batched Jev request per new normalized output
 * - Storing last output verdict
 * - Returning valid Claude hook JSON:
 *   - systemMessage for a leak
 *   - additionalContext for deterministic high-confidence failure advice
 *   - hookSpecificOutput.updatedToolOutput replacing Bash output when leak threshold is crossed
 *   - preserving interrupted and isImage fields
 * - Fail-open with rate-limited diagnostics on infrastructure/parse errors
 * - Never echoing output text or detected secrets in diagnostics
 */
import { type LoadedConfig } from "../config.ts";
import { askJev } from "../client.ts";
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
export declare function normalizeToolName(raw?: unknown): string | undefined;
export declare function runPostTool(rawPayload?: unknown, options?: PostToolOptions): Promise<PostToolOutput | null>;
