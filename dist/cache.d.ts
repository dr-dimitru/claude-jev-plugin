/**
 * Cache and Process Coordination for claude-jev.
 *
 * Implements session-local TTL caching and concurrent deduplication across hook processes
 * using file-backed exclusive locks with stale-lock recovery and bounded coordination wait.
 * Infrastructure failures are NEVER cached as safe verdicts.
 */
export declare class CacheCoordinationError extends Error {
    readonly code: string;
    constructor(message: string, code?: string);
}
export interface CacheOptions {
    cacheDir?: string;
    sessionId?: string;
    agentId?: string;
    scratchpadDir?: string;
    homeDir?: string;
    lockTimeoutMs?: number;
    staleLockMs?: number;
    pollIntervalMs?: number;
    maxEntries?: number;
    onTimeout?: "throw" | "produce";
}
export declare const DEFAULT_LOCK_TIMEOUT_MS = 2500;
export declare const DEFAULT_STALE_LOCK_MS = 5000;
export declare const DEFAULT_POLL_INTERVAL_MS = 25;
export declare const DEFAULT_MAX_CACHE_ENTRIES = 100;
export declare function clearMemoryCache(): void;
/**
 * Produces a stable SHA-256 key from any input value with recursively sorted keys.
 */
export declare function normalizeKey(input: unknown): string;
/**
 * Gets a cached value or coordinates concurrent execution of the producer.
 * Features:
 * - Session-local TTL cache
 * - Normalized keys
 * - File-backed exclusive locking across hook processes
 * - Stale-lock recovery
 * - Fail-open bounded coordination wait
 * - Never caches infrastructure failures
 */
export declare function getOrCreateCached<T>(key: unknown, ttlMs: number, producer: () => Promise<T>, options?: CacheOptions): Promise<T>;
