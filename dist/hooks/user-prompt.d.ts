/**
 * UserPromptSubmit Hook for claude-jev.
 *
 * Captures bounded user prompt into session storage for use by subsequent PreToolUse gates.
 * Returns no stdout to Claude Code. Never fails with non-zero exit code.
 */
export interface UserPromptPayload {
    session_id?: string;
    prompt?: string;
    agent_id?: string;
    scratchpad_dir?: string;
    [key: string]: unknown;
}
/**
 * Handles UserPromptSubmit payload.
 */
export declare function runUserPrompt(payload?: unknown): Promise<void>;
