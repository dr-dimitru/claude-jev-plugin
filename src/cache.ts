/**
 * Cache and Process Coordination for claude-jev.
 *
 * Implements session-local TTL caching and concurrent deduplication across hook processes
 * using file-backed exclusive locks with stale-lock recovery and bounded coordination wait.
 * Infrastructure failures are NEVER cached as safe verdicts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

export class CacheCoordinationError extends Error {
  public readonly code: string;

  constructor(message: string, code: string = "COORDINATION_TIMEOUT") {
    super(message);
    this.name = "CacheCoordinationError";
    this.code = code;
    Object.setPrototypeOf(this, CacheCoordinationError.prototype);
  }
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

export const DEFAULT_LOCK_TIMEOUT_MS = 2500;
export const DEFAULT_STALE_LOCK_MS = 5000;
export const DEFAULT_POLL_INTERVAL_MS = 25;
export const DEFAULT_MAX_CACHE_ENTRIES = 100;

interface MemoryCacheEntry {
  value: unknown;
  expiresAt: number;
}

const memoryCache = new Map<string, MemoryCacheEntry>();
const inFlightPromises = new Map<string, Promise<unknown>>();

export function clearMemoryCache(): void {
  memoryCache.clear();
  inFlightPromises.clear();
}

/**
 * Recursively canonicalizes object keys for stable hashing.
 */
function canonicalize(val: unknown): unknown {
  if (val === null || typeof val !== "object") {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(canonicalize);
  }
  const obj = val as Record<string, unknown>;
  const sortedObj: Record<string, unknown> = {};
  const keys = Object.keys(obj).sort();
  for (const k of keys) {
    sortedObj[k] = canonicalize(obj[k]);
  }
  return sortedObj;
}

/**
 * Produces a stable SHA-256 key from any input value with recursively sorted keys.
 */
export function normalizeKey(input: unknown): string {
  const canonical = canonicalize(input);
  const serialized = JSON.stringify(canonical);
  return crypto.createHash("sha256").update(serialized, "utf-8").digest("hex");
}

function toSafeKey(key: unknown): string {
  if (typeof key === "string" && /^[a-zA-Z0-9_.-]+$/.test(key)) {
    return key;
  }
  return normalizeKey(key);
}

function resolveCacheDir(options?: CacheOptions): string {
  if (options?.cacheDir && options.cacheDir.trim().length > 0) {
    return path.resolve(options.cacheDir.trim());
  }

  if (options?.scratchpadDir && options.scratchpadDir.trim().length > 0) {
    return path.join(path.resolve(options.scratchpadDir.trim()), "cache");
  }

  const userHome = options?.homeDir ?? process.env.HOME ?? os.homedir();
  const sessionPart = options?.sessionId
    ? crypto.createHash("sha256").update(options.sessionId, "utf-8").digest("hex")
    : "default";

  return path.join(userHome, ".cache", "claude-jev", "cache", sessionPart);
}

function ensureDirSync(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

async function readEntryFile<T>(
  filePath: string,
  ttlMs: number
): Promise<T | null> {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = await fs.promises.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const { createdAt, value } = parsed;
    if (typeof createdAt !== "number") {
      return null;
    }
    if (Date.now() - createdAt > ttlMs) {
      // Expired entry
      return null;
    }
    return value as T;
  } catch {
    return null;
  }
}

async function writeEntryFile<T>(
  dir: string,
  key: string,
  value: T,
  ttlMs: number,
  maxEntries: number
): Promise<void> {
  ensureDirSync(dir);

  const entryPath = path.join(dir, `${key}.json`);
  const payload = JSON.stringify(
    {
      key,
      createdAt: Date.now(),
      ttlMs,
      value,
    },
    null,
    2
  );

  const tempFile = path.join(
    dir,
    `${key}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`
  );

  try {
    await fs.promises.writeFile(tempFile, payload, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fs.promises.rename(tempFile, entryPath);
  } catch (err) {
    try {
      if (fs.existsSync(tempFile)) {
        await fs.promises.unlink(tempFile);
      }
    } catch {
      // ignore unlink error
    }
    throw err;
  }

  // Bounded entries pruning
  try {
    const files = await fs.promises.readdir(dir);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    if (jsonFiles.length > maxEntries) {
      const stats = await Promise.all(
        jsonFiles.map(async (f) => {
          const p = path.join(dir, f);
          try {
            const raw = await fs.promises.readFile(p, "utf-8");
            const parsed = JSON.parse(raw);
            return { file: p, mtime: parsed?.createdAt ?? 0 };
          } catch {
            return { file: p, mtime: 0 };
          }
        })
      );

      stats.sort((a, b) => a.mtime - b.mtime); // Oldest first
      const excessCount = stats.length - maxEntries;
      for (let i = 0; i < excessCount; i++) {
        await fs.promises.unlink(stats[i].file).catch(() => {});
      }
    }
  } catch {
    // Non-critical pruning failure
  }
}

async function getLockAge(lockPath: string): Promise<number | null> {
  try {
    if (!fs.existsSync(lockPath)) {
      return null;
    }
    const stat = await fs.promises.stat(lockPath);
    try {
      const raw = await fs.promises.readFile(lockPath, "utf-8");
      const meta = JSON.parse(raw);
      if (typeof meta?.createdAt === "number") {
        return Date.now() - meta.createdAt;
      }
    } catch {
      // If content is empty or unparseable, fallback to stat mtime
    }
    return Date.now() - stat.mtimeMs;
  } catch {
    return null;
  }
}

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
export async function getOrCreateCached<T>(
  key: unknown,
  ttlMs: number,
  producer: () => Promise<T>,
  options?: CacheOptions
): Promise<T> {
  const safeKey = toSafeKey(key);

  const lockTimeoutMs = options?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleLockMs = options?.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES;

  // 1. Check in-process memory cache first
  const memEntry = memoryCache.get(safeKey);
  if (memEntry && Date.now() < memEntry.expiresAt) {
    return memEntry.value as T;
  }

  // 2. Check in-flight promise for in-process concurrent deduplication
  if (inFlightPromises.has(safeKey)) {
    return (await inFlightPromises.get(safeKey)) as T;
  }

  const cacheDir = resolveCacheDir(options);
  ensureDirSync(cacheDir);

  const entryPath = path.join(cacheDir, `${safeKey}.json`);
  const lockPath = path.join(cacheDir, `${safeKey}.lock`);

  // 3. Check file entry
  const existingEntry = await readEntryFile<T>(entryPath, ttlMs);
  if (existingEntry !== null) {
    memoryCache.set(safeKey, {
      value: existingEntry,
      expiresAt: Date.now() + ttlMs,
    });
    return existingEntry;
  }

  // 4. Wrap execution in in-flight promise so same-process concurrent calls deduplicate
  const promise = (async (): Promise<T> => {
    const startTime = Date.now();

    while (true) {
      let lockFd: fs.promises.FileHandle | null = null;
      try {
        lockFd = await fs.promises.open(
          lockPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
          0o600
        );
      } catch (err: any) {
        if (err.code !== "EEXIST") {
          // Unexpected filesystem error: fail-open by running producer directly
          return await producer();
        }
        lockFd = null;
      }

      if (lockFd !== null) {
        // We acquired the lock!
        try {
          // Double-check: did another process finish and write the file right before we got lock?
          const freshEntry = await readEntryFile<T>(entryPath, ttlMs);
          if (freshEntry !== null) {
            memoryCache.set(safeKey, {
              value: freshEntry,
              expiresAt: Date.now() + ttlMs,
            });
            return freshEntry;
          }

          const lockMeta = {
            pid: process.pid,
            createdAt: Date.now(),
          };
          await lockFd.writeFile(JSON.stringify(lockMeta), "utf-8");
          await lockFd.close();
          lockFd = null;

          // Execute producer: if it fails, error is thrown and NOT cached as safe verdict
          const result = await producer();

          await writeEntryFile(cacheDir, safeKey, result, ttlMs, maxEntries);
          memoryCache.set(safeKey, {
            value: result,
            expiresAt: Date.now() + ttlMs,
          });
          return result;
        } finally {
          if (lockFd !== null) {
            try {
              await lockFd.close();
            } catch {
              // ignore
            }
          }
          await fs.promises.unlink(lockPath).catch(() => {});
        }
      }

      // Lock was held by another process: check if cached entry appeared
      const entryAfterWait = await readEntryFile<T>(entryPath, ttlMs);
      if (entryAfterWait !== null) {
        memoryCache.set(safeKey, {
          value: entryAfterWait,
          expiresAt: Date.now() + ttlMs,
        });
        return entryAfterWait;
      }

      // Check if lock is stale
      const lockAge = await getLockAge(lockPath);
      if (lockAge !== null && lockAge > staleLockMs) {
        // Stale lock: recover and retry
        await fs.promises.unlink(lockPath).catch(() => {});
        continue;
      }

      // Check if coordination wait timeout reached
      if (Date.now() - startTime >= lockTimeoutMs) {
        if (options?.onTimeout === "produce") {
          return await producer();
        }
        throw new CacheCoordinationError(
          `Cache coordination timeout after ${lockTimeoutMs}ms for key ${safeKey}`,
          "COORDINATION_TIMEOUT"
        );
      }

      // Wait and poll
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  })();

  inFlightPromises.set(safeKey, promise);
  try {
    return await promise;
  } finally {
    inFlightPromises.delete(safeKey);
  }
}
