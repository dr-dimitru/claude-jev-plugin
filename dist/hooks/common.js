import { readHookInput } from "../hook-io.js";
const DIAGNOSTIC_MESSAGES = {
    MALFORMED_PAYLOAD: "claude-jev: malformed hook payload; judgment skipped",
    MISSING_KEY: "claude-jev: TYPESAFE_API_KEY is not configured; judgment skipped",
    REQUEST_FAILED: "claude-jev: TypeSafe judgment unavailable; hook failed open",
    STATE_FAILED: "claude-jev: local hook state unavailable; hook failed open",
};
const RATE_LIMIT_WINDOW_MS = 60_000;
let fallbackDiagnosticTime = 0;
export async function readHookPayload(rawPayload) {
    if (rawPayload !== undefined) {
        if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
            throw new Error("MALFORMED_PAYLOAD");
        }
        return rawPayload;
    }
    try {
        return await readHookInput(process.stdin);
    }
    catch {
        throw new Error("MALFORMED_PAYLOAD");
    }
}
export function normalizeToolName(raw) {
    if (typeof raw !== "string")
        return undefined;
    const trimmed = raw.trim();
    const lower = trimmed.toLowerCase();
    if (lower === "bash")
        return "Bash";
    if (lower === "write")
        return "Write";
    if (lower === "edit")
        return "Edit";
    return trimmed || undefined;
}
export async function emitDiagnostic(code, store) {
    const now = Date.now();
    if (store) {
        try {
            const last = await store.getCacheMetadata("last_diagnostic_time");
            if (typeof last === "number" && now - last < RATE_LIMIT_WINDOW_MS)
                return null;
            await store.setCacheMetadata("last_diagnostic_time", now);
        }
        catch {
            return null;
        }
    }
    else {
        if (now - fallbackDiagnosticTime < RATE_LIMIT_WINDOW_MS)
            return null;
        fallbackDiagnosticTime = now;
    }
    return { systemMessage: DIAGNOSTIC_MESSAGES[code] };
}
export async function writeHookOutput(output) {
    if (output === null || output === undefined)
        return;
    await new Promise((resolve, reject) => {
        process.stdout.write(`${JSON.stringify(output)}\n`, error => {
            if (error)
                reject(error);
            else
                resolve();
        });
    });
}
