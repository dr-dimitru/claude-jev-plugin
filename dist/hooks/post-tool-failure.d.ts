/**
 * PostToolUseFailure Hook for claude-jev.
 *
 * Implements:
 * - Safe Claude stdin parsing
 * - Normalization of failed top-level error payloads via src/output.ts
 * - Config and session state loading
 * - Skipping disabled/unconfigured/missing-key paths
 * - Duplicate tool_use_id judging prevention
 * - Exactly one batched Jev request per new normalized output
 * - Storing last output verdict
 * - Returning valid Claude hook JSON:
 *   - additionalContext for deterministic high-confidence failure advice
 *   - systemMessage and context warning when secret leak is flagged
 *   - NEVER claims or includes output replacement (PostToolUseFailure has no replacement field)
 * - Fail-open with rate-limited diagnostics on infrastructure/parse errors
 * - Never echoing error text or detected secrets in diagnostics
 */
import { type LoadedConfig } from "../config.ts";
import { askJev } from "../client.ts";
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
    askJevFn?: typeof askJev;
    config?: LoadedConfig;
}
export declare function normalizeToolName(raw?: unknown): string | undefined;
export declare function runPostToolFailure(rawPayload?: unknown, options?: PostToolFailureOptions): Promise<PostToolFailureOutput | null>;
