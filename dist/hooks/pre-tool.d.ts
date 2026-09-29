/**
 * PreToolUse Hook for claude-jev.
 *
 * Minimal vertical slice for Bash:
 * - Validates hook payload
 * - Loads config and session overrides
 * - Skips disabled, non-Bash, and missing-key paths
 * - Calls askTypeSafe once with all four gate questions
 * - Stores last gate verdict in sessionStore
 * - Clear verdicts return no stdout
 * - Shadow flagged verdicts return concise systemMessage
 * - Enforce flagged verdicts return PreToolUse ask output (never allow)
 * - Catches all infrastructure/config/parse errors and returns rate-limited systemMessage
 */
export interface HookSpecificOutput {
    hookEventName: "PreToolUse";
    permissionDecision: "ask" | "deny";
    permissionDecisionReason: string;
}
export interface PreToolOutput {
    systemMessage?: string;
    hookSpecificOutput?: HookSpecificOutput;
}
export interface PreToolOptions {
    fetch?: typeof fetch;
}
export interface PreToolPayload {
    session_id: string;
    transcript_path?: string;
    cwd: string;
    permission_mode?: string;
    hook_event_name?: string;
    tool_name?: string;
    tool?: string;
    tool_input?: unknown;
    tool_use_id?: string;
    scratchpad_dir?: string;
    agent_id?: string;
    [key: string]: unknown;
}
export declare function isPromptHostAvailable(payload: Record<string, unknown>): false | undefined;
export declare function runPreTool(rawPayload?: unknown, options?: PreToolOptions): Promise<PreToolOutput | null>;
