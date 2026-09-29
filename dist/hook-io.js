/**
 * Hook I/O and Session Storage for claude-jev.
 *
 * Implements bounded stdin JSON payload parsing and atomic session storage.
 * Strictly avoids leaking session_id or transcript_path to external services.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
export const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024; // 1MB
export const DEFAULT_MAX_SESSION_RECORD_BYTES = 64 * 1024; // 64KB
export const MAX_STORED_PROMPT_CHARS = 1200;
/**
 * Reads and parses one bounded JSON object from a readable stream (e.g. process.stdin).
 * Rejects invalid JSON, arrays, primitives, empty input, and oversized input.
 */
export async function readHookInput(stream = process.stdin, options) {
    const maxBytes = options?.maxBytes ?? DEFAULT_MAX_INPUT_BYTES;
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalBytes = 0;
        let settled = false;
        const onData = (chunk) => {
            if (settled)
                return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += buf.length;
            if (totalBytes > maxBytes) {
                settled = true;
                cleanup();
                reject(new Error(`Payload too large: input exceeded maximum limit of ${maxBytes} bytes`));
                return;
            }
            chunks.push(buf);
        };
        const onEnd = () => {
            if (settled)
                return;
            settled = true;
            cleanup();
            const raw = Buffer.concat(chunks).toString("utf-8").trim();
            if (raw.length === 0) {
                reject(new Error("Empty input payload: no JSON received"));
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(raw);
            }
            catch (err) {
                reject(new Error(`Malformed hook payload: invalid JSON (${err.message})`));
                return;
            }
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                reject(new Error("Invalid payload: expected top-level JSON object, got " +
                    (Array.isArray(parsed) ? "array" : typeof parsed)));
                return;
            }
            resolve(parsed);
        };
        const onError = (err) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(err);
        };
        const cleanup = () => {
            stream.removeListener("data", onData);
            stream.removeListener("end", onEnd);
            stream.removeListener("error", onError);
        };
        stream.on("data", onData);
        stream.on("end", onEnd);
        stream.on("error", onError);
    });
}
/**
 * Returns the directory that holds session state files for the given inputs.
 */
export function resolveSessionBaseDir(options) {
    const env = options.env ?? process.env;
    if (options.scratchpadDir && options.scratchpadDir.trim().length > 0) {
        return path.resolve(options.scratchpadDir.trim());
    }
    if (env.CLAUDE_PLUGIN_DATA?.trim()) {
        return path.join(path.resolve(env.CLAUDE_PLUGIN_DATA.trim()), "sessions");
    }
    const userHome = options.homeDir ?? env.HOME ?? os.homedir();
    return path.join(userHome, ".cache", "claude-jev");
}
/**
 * Returns the sha256 hex name used for a session (and optional agent) identity.
 */
export function hashSessionIdentity(sessionId, agentId) {
    const raw = agentId ? `${sessionId}:${agentId}` : sessionId;
    return crypto.createHash("sha256").update(raw, "utf-8").digest("hex");
}
/**
 * Creates a session store instance for a given session_id and optional agent_id.
 * Safe against path traversal and concurrent corruption through atomic writes.
 */
export function sessionStore(options) {
    const { sessionId, agentId, scratchpadDir, homeDir } = options;
    const env = options.env ?? process.env;
    const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_SESSION_RECORD_BYTES;
    const lockTimeoutMs = options.lockTimeoutMs ?? 2000;
    const staleLockMs = options.staleLockMs ?? 5000;
    const pollIntervalMs = options.pollIntervalMs ?? 10;
    const baseDir = resolveSessionBaseDir({ scratchpadDir, homeDir, env });
    // Hash session identifier to prevent path traversal and ensure privacy
    const hashedName = hashSessionIdentity(sessionId, agentId);
    const filePath = path.join(baseDir, `${hashedName}.json`);
    // Path traversal guard
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(baseDir))) {
        throw new Error("Path traversal detected in session storage directory resolution");
    }
    function ensureDir() {
        if (!fs.existsSync(baseDir)) {
            fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
        }
    }
    async function read() {
        try {
            if (!fs.existsSync(filePath)) {
                return null;
            }
            const stat = await fs.promises.stat(filePath);
            if (stat.size > maxRecordBytes) {
                return null;
            }
            const raw = await fs.promises.readFile(filePath, "utf-8");
            if (Buffer.byteLength(raw, "utf-8") > maxRecordBytes) {
                return null;
            }
            const data = JSON.parse(raw);
            if (data && typeof data === "object" && !Array.isArray(data)) {
                return data;
            }
            return null;
        }
        catch {
            return null;
        }
    }
    const lockPath = `${filePath}.lock`;
    function prepareRecord(record) {
        if (record.seenToolUseIds && record.seenToolUseIds.length > 100) {
            record.seenToolUseIds = record.seenToolUseIds.slice(-100);
        }
        let serialized = JSON.stringify(record, null, 2);
        if (Buffer.byteLength(serialized, "utf-8") > maxRecordBytes) {
            if (record.cacheMetadata)
                record.cacheMetadata = {};
            if (record.seenToolUseIds && record.seenToolUseIds.length > 20) {
                record.seenToolUseIds = record.seenToolUseIds.slice(-20);
            }
            serialized = JSON.stringify(record, null, 2);
        }
        if (Buffer.byteLength(serialized, "utf-8") > maxRecordBytes) {
            throw new Error("Session record exceeds maximum size");
        }
        return serialized;
    }
    async function writeRecord(record) {
        ensureDir();
        const serialized = prepareRecord(record);
        const randomSuffix = crypto.randomBytes(6).toString("hex");
        const tempFile = `${filePath}.${Date.now()}.${randomSuffix}.tmp`;
        try {
            await fs.promises.writeFile(tempFile, serialized, {
                encoding: "utf-8",
                mode: 0o600,
            });
            await fs.promises.rename(tempFile, filePath);
        }
        catch (err) {
            await fs.promises.unlink(tempFile).catch(() => { });
            throw err;
        }
    }
    function isProcessAlive(pid) {
        if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
            return false;
        try {
            process.kill(pid, 0);
            return true;
        }
        catch (error) {
            return error?.code === "EPERM";
        }
    }
    async function withMutationLock(operation) {
        ensureDir();
        const startedAt = Date.now();
        const ownerToken = crypto.randomBytes(16).toString("hex");
        while (true) {
            let handle;
            try {
                handle = await fs.promises.open(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
                await handle.writeFile(JSON.stringify({ ownerToken, pid: process.pid, createdAt: Date.now() }), "utf-8");
                await handle.close();
                handle = undefined;
                break;
            }
            catch (error) {
                if (handle)
                    await handle.close().catch(() => { });
                if (error?.code !== "EEXIST")
                    throw error;
                try {
                    const stat = await fs.promises.stat(lockPath);
                    if (Date.now() - stat.mtimeMs > staleLockMs) {
                        let metadata = {};
                        try {
                            metadata = JSON.parse(await fs.promises.readFile(lockPath, "utf-8"));
                        }
                        catch {
                            // Unparseable stale lock has no live owner evidence.
                        }
                        if (!isProcessAlive(metadata.pid)) {
                            const current = await fs.promises.readFile(lockPath, "utf-8").catch(() => "");
                            let currentToken;
                            try {
                                currentToken = JSON.parse(current)?.ownerToken;
                            }
                            catch {
                                currentToken = undefined;
                            }
                            if (currentToken === metadata.ownerToken) {
                                await fs.promises.unlink(lockPath).catch(() => { });
                                continue;
                            }
                        }
                    }
                }
                catch {
                    continue;
                }
                if (Date.now() - startedAt >= lockTimeoutMs) {
                    throw new Error("Session state lock timeout");
                }
                await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            }
        }
        try {
            return await operation();
        }
        finally {
            try {
                const metadata = JSON.parse(await fs.promises.readFile(lockPath, "utf-8"));
                if (metadata?.ownerToken === ownerToken) {
                    await fs.promises.unlink(lockPath).catch(() => { });
                }
            }
            catch {
                // A missing or replaced lock is not ours to remove.
            }
        }
    }
    async function write(data) {
        await withMutationLock(async () => {
            const existing = (await read()) ?? {
                sessionIdHash: hashedName,
                updatedAt: Date.now(),
            };
            await writeRecord({
                ...existing,
                ...data,
                sessionIdHash: hashedName,
                updatedAt: Date.now(),
            });
        });
    }
    async function update(updater) {
        return withMutationLock(async () => {
            const current = (await read()) ?? {
                sessionIdHash: hashedName,
                updatedAt: Date.now(),
            };
            const updated = updater(current);
            const merged = {
                ...current,
                ...updated,
                sessionIdHash: hashedName,
                updatedAt: Date.now(),
            };
            await writeRecord(merged);
            return merged;
        });
    }
    async function getPrompt() {
        const record = await read();
        return record?.prompt;
    }
    async function setPrompt(prompt) {
        const codePoints = Array.from(prompt);
        const bounded = codePoints.length > MAX_STORED_PROMPT_CHARS
            ? codePoints.slice(0, MAX_STORED_PROMPT_CHARS).join("")
            : prompt;
        await update((current) => ({
            ...current,
            prompt: bounded,
        }));
    }
    async function getOverrides() {
        const record = await read();
        return record?.overrides ?? {};
    }
    async function setOverrides(overrides) {
        await update((current) => ({
            ...current,
            overrides: {
                ...(current.overrides ?? {}),
                ...overrides,
            },
        }));
    }
    async function getLastVerdict(type = "gate") {
        const record = await read();
        if (!record)
            return undefined;
        return type === "gate" ? record.lastGateVerdict : record.lastOutputVerdict;
    }
    async function setLastVerdict(type, verdict) {
        await update((current) => {
            if (type === "gate") {
                return { ...current, lastGateVerdict: verdict };
            }
            else {
                return { ...current, lastOutputVerdict: verdict };
            }
        });
    }
    async function hasSeenToolUseId(toolUseId) {
        const record = await read();
        return record?.seenToolUseIds?.includes(toolUseId) ?? false;
    }
    async function claimToolUseId(toolUseId) {
        return withMutationLock(async () => {
            const current = (await read()) ?? {
                sessionIdHash: hashedName,
                updatedAt: Date.now(),
            };
            const existing = current.seenToolUseIds ?? [];
            if (existing.includes(toolUseId))
                return false;
            await writeRecord({
                ...current,
                seenToolUseIds: [...existing, toolUseId].slice(-100),
                sessionIdHash: hashedName,
                updatedAt: Date.now(),
            });
            return true;
        });
    }
    async function releaseToolUseId(toolUseId) {
        await update((current) => ({
            ...current,
            seenToolUseIds: (current.seenToolUseIds ?? []).filter(id => id !== toolUseId),
        }));
    }
    async function recordToolUseId(toolUseId) {
        await claimToolUseId(toolUseId);
    }
    async function getCacheMetadata(key) {
        const record = await read();
        return record?.cacheMetadata?.[key];
    }
    async function setCacheMetadata(key, value) {
        await update((current) => ({
            ...current,
            cacheMetadata: {
                ...(current.cacheMetadata ?? {}),
                [key]: value,
            },
        }));
    }
    return {
        getSessionPath: () => filePath,
        read,
        write,
        update,
        getPrompt,
        setPrompt,
        getOverrides,
        setOverrides,
        getLastVerdict,
        setLastVerdict,
        hasSeenToolUseId,
        claimToolUseId,
        releaseToolUseId,
        recordToolUseId,
        getCacheMetadata,
        setCacheMetadata,
    };
}
