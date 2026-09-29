/**
 * Retention cleanup for per-session state files and judgment cache directories.
 */
export declare const DEFAULT_RETENTION_DAYS = 7;
export declare const PRUNE_INTERVAL_MS: number;
export declare const MAX_PRUNE_DELETIONS = 500;
export interface PruneOptions {
    roots: string[];
    maxAgeMs: number;
    now?: number;
    keepNames?: string[];
    maxDeletions?: number;
}
export interface PruneResult {
    removedFiles: number;
    removedDirs: number;
}
/**
 * Removes session state and cache data older than maxAgeMs. Never throws.
 */
export declare function pruneStaleSessionData(options: PruneOptions): Promise<PruneResult>;
/**
 * Runs pruneStaleSessionData at most once per PRUNE_INTERVAL_MS. Never throws.
 */
export declare function maybePruneSessionData(options: {
    roots: string[];
    retentionDays: number;
    now?: number;
    keepNames?: string[];
}): Promise<void>;
