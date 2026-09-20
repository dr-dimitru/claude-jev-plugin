/**
 * Hook I/O and Session Storage for claude-jev.
 *
 * Implements bounded stdin JSON payload parsing and atomic session storage.
 * Strictly avoids leaking session_id or transcript_path to external services.
 */
export interface ReadHookInputOptions {
    maxBytes?: number;
}
export declare const DEFAULT_MAX_INPUT_BYTES: number;
export declare const DEFAULT_MAX_SESSION_RECORD_BYTES: number;
export declare const MAX_STORED_PROMPT_CHARS = 1200;
/**
 * Reads and parses one bounded JSON object from a readable stream (e.g. process.stdin).
 * Rejects invalid JSON, arrays, primitives, empty input, and oversized input.
 */
export declare function readHookInput(stream?: NodeJS.ReadableStream, options?: ReadHookInputOptions): Promise<Record<string, unknown>>;
export interface SessionOverrides {
    enabled?: boolean;
    mode?: "shadow" | "enforce";
    [key: string]: unknown;
}
export interface SessionRecord {
    sessionIdHash: string;
    updatedAt: number;
    prompt?: string;
    overrides?: SessionOverrides;
    lastGateVerdict?: unknown;
    lastOutputVerdict?: unknown;
    seenToolUseIds?: string[];
    cacheMetadata?: Record<string, unknown>;
    [key: string]: unknown;
}
export interface SessionStoreOptions {
    sessionId: string;
    agentId?: string;
    scratchpadDir?: string;
    homeDir?: string;
    env?: Record<string, string | undefined>;
    maxRecordBytes?: number;
    lockTimeoutMs?: number;
    staleLockMs?: number;
    pollIntervalMs?: number;
}
export interface SessionStore {
    getSessionPath(): string;
    read(): Promise<SessionRecord | null>;
    write(data: Partial<SessionRecord>): Promise<void>;
    update(updater: (current: SessionRecord) => Partial<SessionRecord> | SessionRecord): Promise<SessionRecord>;
    getPrompt(): Promise<string | undefined>;
    setPrompt(prompt: string): Promise<void>;
    getOverrides(): Promise<SessionOverrides>;
    setOverrides(overrides: Partial<SessionOverrides>): Promise<void>;
    getLastVerdict(type?: "gate" | "output"): Promise<unknown>;
    setLastVerdict(type: "gate" | "output", verdict: unknown): Promise<void>;
    hasSeenToolUseId(toolUseId: string): Promise<boolean>;
    claimToolUseId(toolUseId: string): Promise<boolean>;
    releaseToolUseId(toolUseId: string): Promise<void>;
    recordToolUseId(toolUseId: string): Promise<void>;
    getCacheMetadata(key: string): Promise<unknown>;
    setCacheMetadata(key: string, value: unknown): Promise<void>;
}
/**
 * Creates a session store instance for a given session_id and optional agent_id.
 * Safe against path traversal and concurrent corruption through atomic writes.
 */
export declare function sessionStore(options: SessionStoreOptions): SessionStore;
