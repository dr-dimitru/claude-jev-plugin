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
 * Creates a session store instance for a given session_id and optional agent_id.
 * Safe against path traversal and concurrent corruption through atomic writes.
 */
export function sessionStore(options) {
    const { sessionId, agentId, scratchpadDir, homeDir } = options;
    const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_SESSION_RECORD_BYTES;
    // Determine safe base directory
    let baseDir;
    if (scratchpadDir && scratchpadDir.trim().length > 0) {
        baseDir = path.resolve(scratchpadDir.trim());
    }
    else {
        const userHome = homeDir ?? process.env.HOME ?? os.homedir();
        baseDir = path.join(userHome, ".cache", "claude-jev");
    }
    // Hash session identifier to prevent path traversal and ensure privacy
    const rawIdentifier = agentId ? `${sessionId}:${agentId}` : sessionId;
    const hashedName = crypto
        .createHash("sha256")
        .update(rawIdentifier, "utf-8")
        .digest("hex");
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
    async function write(data) {
        ensureDir();
        const existing = (await read()) ?? {
            sessionIdHash: hashedName,
            updatedAt: Date.now(),
        };
        const record = {
            ...existing,
            ...data,
            sessionIdHash: hashedName,
            updatedAt: Date.now(),
        };
        // Keep bounded: prune seenToolUseIds if too many
        if (record.seenToolUseIds && record.seenToolUseIds.length > 100) {
            record.seenToolUseIds = record.seenToolUseIds.slice(-100);
        }
        let serialized = JSON.stringify(record, null, 2);
        if (Buffer.byteLength(serialized, "utf-8") > maxRecordBytes) {
            // Bound cache metadata and prompt if oversized
            if (record.cacheMetadata) {
                record.cacheMetadata = {};
            }
            if (record.seenToolUseIds && record.seenToolUseIds.length > 20) {
                record.seenToolUseIds = record.seenToolUseIds.slice(-20);
            }
            serialized = JSON.stringify(record, null, 2);
        }
        // Atomic write via temp file + rename
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
    }
    async function update(updater) {
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
        await write(merged);
        return merged;
    }
    async function getPrompt() {
        const record = await read();
        return record?.prompt;
    }
    async function setPrompt(prompt) {
        const codePoints = Array.from(prompt);
        const bounded = codePoints.length > MAX_STORED_PROMPT_CHARS
            ? codePoints.slice(-MAX_STORED_PROMPT_CHARS).join("")
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
    async function recordToolUseId(toolUseId) {
        await update((current) => {
            const existing = current.seenToolUseIds ?? [];
            if (existing.includes(toolUseId)) {
                return current;
            }
            return {
                ...current,
                seenToolUseIds: [...existing, toolUseId],
            };
        });
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
        recordToolUseId,
        getCacheMetadata,
        setCacheMetadata,
    };
}
