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
    code;
    constructor(message, code = "COORDINATION_TIMEOUT") {
        super(message);
        this.name = "CacheCoordinationError";
        this.code = code;
        Object.setPrototypeOf(this, CacheCoordinationError.prototype);
    }
}
export const DEFAULT_LOCK_TIMEOUT_MS = 2500;
export const DEFAULT_STALE_LOCK_MS = 5000;
export const DEFAULT_POLL_INTERVAL_MS = 25;
export const DEFAULT_MAX_CACHE_ENTRIES = 100;
const memoryCache = new Map();
const inFlightPromises = new Map();
export function clearMemoryCache() {
    memoryCache.clear();
    inFlightPromises.clear();
}
/**
 * Recursively canonicalizes object keys for stable hashing.
 */
function canonicalize(val) {
    if (val === null || typeof val !== "object") {
        return val;
    }
    if (Array.isArray(val)) {
        return val.map(canonicalize);
    }
    const obj = val;
    const sortedObj = {};
    const keys = Object.keys(obj).sort();
    for (const k of keys) {
        sortedObj[k] = canonicalize(obj[k]);
    }
    return sortedObj;
}
/**
 * Produces a stable SHA-256 key from any input value with recursively sorted keys.
 */
export function normalizeKey(input) {
    const canonical = canonicalize(input);
    const serialized = JSON.stringify(canonical);
    return crypto.createHash("sha256").update(serialized, "utf-8").digest("hex");
}
function toSafeKey(key) {
    if (typeof key === "string" && /^[a-zA-Z0-9_.-]+$/.test(key)) {
        return key;
    }
    return normalizeKey(key);
}
function resolveCacheDir(options) {
    const sessionIdentity = options?.agentId
        ? `${options.sessionId ?? "default"}:${options.agentId}`
        : options?.sessionId ?? "default";
    const sessionPart = crypto
        .createHash("sha256")
        .update(sessionIdentity, "utf-8")
        .digest("hex");
    if (options?.cacheDir && options.cacheDir.trim().length > 0) {
        return path.resolve(options.cacheDir.trim());
    }
    if (options?.scratchpadDir && options.scratchpadDir.trim().length > 0) {
        return path.join(path.resolve(options.scratchpadDir.trim()), "cache", sessionPart);
    }
    const userHome = options?.homeDir ?? process.env.HOME ?? os.homedir();
    return path.join(userHome, ".cache", "claude-jev", "cache", sessionPart);
}
function ensureDirSync(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
}
async function readEntryFile(filePath, ttlMs) {
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
        const expiresAt = createdAt + ttlMs;
        if (Date.now() >= expiresAt) {
            return null;
        }
        return { value: value, expiresAt };
    }
    catch {
        return null;
    }
}
async function writeEntryFile(dir, key, value, ttlMs, maxEntries) {
    ensureDirSync(dir);
    const entryPath = path.join(dir, `${key}.json`);
    const payload = JSON.stringify({
        key,
        createdAt: Date.now(),
        ttlMs,
        value,
    }, null, 2);
    const tempFile = path.join(dir, `${key}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`);
    try {
        await fs.promises.writeFile(tempFile, payload, {
            encoding: "utf-8",
            mode: 0o600,
        });
        await fs.promises.rename(tempFile, entryPath);
    }
    catch (err) {
        try {
            if (fs.existsSync(tempFile)) {
                await fs.promises.unlink(tempFile);
            }
        }
        catch {
            // ignore unlink error
        }
        throw err;
    }
    // Bounded entries pruning
    try {
        const files = await fs.promises.readdir(dir);
        const jsonFiles = files.filter((f) => f.endsWith(".json"));
        if (jsonFiles.length > maxEntries) {
            const stats = await Promise.all(jsonFiles.map(async (f) => {
                const p = path.join(dir, f);
                try {
                    const raw = await fs.promises.readFile(p, "utf-8");
                    const parsed = JSON.parse(raw);
                    return { file: p, mtime: parsed?.createdAt ?? 0 };
                }
                catch {
                    return { file: p, mtime: 0 };
                }
            }));
            stats.sort((a, b) => a.mtime - b.mtime); // Oldest first
            const excessCount = stats.length - maxEntries;
            for (let i = 0; i < excessCount; i++) {
                await fs.promises.unlink(stats[i].file).catch(() => { });
            }
        }
    }
    catch {
        // Non-critical pruning failure
    }
}
async function readLockMetadata(lockPath) {
    try {
        const raw = await fs.promises.readFile(lockPath, "utf-8");
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : null;
    }
    catch {
        return null;
    }
}
async function getLockAge(lockPath) {
    try {
        const stat = await fs.promises.stat(lockPath);
        const meta = await readLockMetadata(lockPath);
        const timestamp = meta?.heartbeatAt ?? meta?.createdAt ?? stat.mtimeMs;
        return Date.now() - timestamp;
    }
    catch {
        return null;
    }
}
async function removeLockIfOwner(lockPath, ownerToken) {
    const current = await readLockMetadata(lockPath);
    if ((current?.ownerToken ?? undefined) !== ownerToken)
        return false;
    try {
        await fs.promises.unlink(lockPath);
        return true;
    }
    catch {
        return false;
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
export async function getOrCreateCached(key, ttlMs, producer, options) {
    const safeKey = toSafeKey(key);
    const lockTimeoutMs = options?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const staleLockMs = options?.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxEntries = options?.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    const cacheDir = resolveCacheDir(options);
    const memoryKey = `${cacheDir}:${safeKey}`;
    // 1. Check in-process memory cache first, scoped to this session cache directory.
    const memEntry = memoryCache.get(memoryKey);
    if (memEntry && Date.now() < memEntry.expiresAt) {
        return memEntry.value;
    }
    // 2. Check in-flight promise for in-process concurrent deduplication.
    if (inFlightPromises.has(memoryKey)) {
        return (await inFlightPromises.get(memoryKey));
    }
    ensureDirSync(cacheDir);
    const entryPath = path.join(cacheDir, `${safeKey}.json`);
    const lockPath = path.join(cacheDir, `${safeKey}.lock`);
    // 3. Check file entry
    const existingEntry = await readEntryFile(entryPath, ttlMs);
    if (existingEntry !== null) {
        memoryCache.set(memoryKey, existingEntry);
        return existingEntry.value;
    }
    // 4. Wrap execution in in-flight promise so same-process concurrent calls deduplicate
    const promise = (async () => {
        const startTime = Date.now();
        while (true) {
            let lockFd = null;
            try {
                lockFd = await fs.promises.open(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
            }
            catch (err) {
                if (err.code !== "EEXIST") {
                    // Unexpected filesystem error: fail-open by running producer directly
                    return await producer();
                }
                lockFd = null;
            }
            if (lockFd !== null) {
                const ownerToken = crypto.randomBytes(16).toString("hex");
                let heartbeat;
                try {
                    const freshEntry = await readEntryFile(entryPath, ttlMs);
                    if (freshEntry !== null) {
                        memoryCache.set(memoryKey, freshEntry);
                        return freshEntry.value;
                    }
                    const createdAt = Date.now();
                    const lockMeta = {
                        pid: process.pid,
                        ownerToken,
                        createdAt,
                        heartbeatAt: createdAt,
                    };
                    await lockFd.writeFile(JSON.stringify(lockMeta), "utf-8");
                    await lockFd.close();
                    lockFd = null;
                    const heartbeatIntervalMs = Math.max(25, Math.min(1000, Math.floor(staleLockMs / 3)));
                    heartbeat = setInterval(() => {
                        void (async () => {
                            const current = await readLockMetadata(lockPath);
                            if (current?.ownerToken !== ownerToken)
                                return;
                            await fs.promises.writeFile(lockPath, JSON.stringify({ ...lockMeta, heartbeatAt: Date.now() }), { encoding: "utf-8", mode: 0o600 }).catch(() => { });
                        })();
                    }, heartbeatIntervalMs);
                    heartbeat.unref?.();
                    const result = await producer();
                    await writeEntryFile(cacheDir, safeKey, result, ttlMs, maxEntries);
                    memoryCache.set(memoryKey, {
                        value: result,
                        expiresAt: Date.now() + ttlMs,
                    });
                    return result;
                }
                finally {
                    if (heartbeat)
                        clearInterval(heartbeat);
                    if (lockFd !== null) {
                        try {
                            await lockFd.close();
                        }
                        catch {
                            // ignore
                        }
                    }
                    await removeLockIfOwner(lockPath, ownerToken);
                }
            }
            // Lock was held by another process: check if cached entry appeared
            const entryAfterWait = await readEntryFile(entryPath, ttlMs);
            if (entryAfterWait !== null) {
                memoryCache.set(memoryKey, entryAfterWait);
                return entryAfterWait.value;
            }
            // Check if lock is stale
            const lockAge = await getLockAge(lockPath);
            if (lockAge !== null && lockAge > staleLockMs) {
                const staleMeta = await readLockMetadata(lockPath);
                if (await removeLockIfOwner(lockPath, staleMeta?.ownerToken)) {
                    continue;
                }
            }
            // Check if coordination wait timeout reached
            if (Date.now() - startTime >= lockTimeoutMs) {
                if (options?.onTimeout === "produce") {
                    return await producer();
                }
                throw new CacheCoordinationError(`Cache coordination timeout after ${lockTimeoutMs}ms for key ${safeKey}`, "COORDINATION_TIMEOUT");
            }
            // Wait and poll
            await new Promise((r) => setTimeout(r, pollIntervalMs));
        }
    })();
    inFlightPromises.set(memoryKey, promise);
    try {
        return await promise;
    }
    finally {
        inFlightPromises.delete(memoryKey);
    }
}
