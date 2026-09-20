import type { SessionStore } from "../hook-io.ts";
import { readHookInput } from "../hook-io.ts";

export type DiagnosticCode =
  | "MALFORMED_PAYLOAD"
  | "MISSING_KEY"
  | "REQUEST_FAILED"
  | "STATE_FAILED";

const DIAGNOSTIC_MESSAGES: Record<DiagnosticCode, string> = {
  MALFORMED_PAYLOAD: "claude-jev: malformed hook payload; judgment skipped",
  MISSING_KEY: "claude-jev: TYPESAFE_API_KEY is not configured; judgment skipped",
  REQUEST_FAILED: "claude-jev: TypeSafe judgment unavailable; hook failed open",
  STATE_FAILED: "claude-jev: local hook state unavailable; hook failed open",
};

const RATE_LIMIT_WINDOW_MS = 60_000;
let fallbackDiagnosticTime = 0;

export async function readHookPayload(rawPayload?: unknown): Promise<Record<string, unknown>> {
  if (rawPayload !== undefined) {
    if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
      throw new Error("MALFORMED_PAYLOAD");
    }
    return rawPayload as Record<string, unknown>;
  }

  try {
    return await readHookInput(process.stdin);
  } catch {
    throw new Error("MALFORMED_PAYLOAD");
  }
}

export function normalizeToolName(raw?: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "bash") return "Bash";
  if (lower === "write") return "Write";
  if (lower === "edit") return "Edit";
  return trimmed || undefined;
}

export async function emitDiagnostic<T extends { systemMessage?: string }>(
  code: DiagnosticCode,
  store?: SessionStore | null
): Promise<T | null> {
  const now = Date.now();
  if (store) {
    try {
      const last = await store.getCacheMetadata("last_diagnostic_time");
      if (typeof last === "number" && now - last < RATE_LIMIT_WINDOW_MS) return null;
      await store.setCacheMetadata("last_diagnostic_time", now);
    } catch {
      return null;
    }
  } else {
    if (now - fallbackDiagnosticTime < RATE_LIMIT_WINDOW_MS) return null;
    fallbackDiagnosticTime = now;
  }
  return { systemMessage: DIAGNOSTIC_MESSAGES[code] } as T;
}

export async function writeHookOutput(output: unknown): Promise<void> {
  if (output === null || output === undefined) return;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(output)}\n`, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}
