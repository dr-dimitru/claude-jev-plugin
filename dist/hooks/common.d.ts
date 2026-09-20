import type { SessionStore } from "../hook-io.ts";
export type DiagnosticCode = "MALFORMED_PAYLOAD" | "MISSING_KEY" | "REQUEST_FAILED" | "STATE_FAILED";
export declare function readHookPayload(rawPayload?: unknown): Promise<Record<string, unknown>>;
export declare function normalizeToolName(raw?: unknown): string | undefined;
export declare function emitDiagnostic<T extends {
    systemMessage?: string;
}>(code: DiagnosticCode, store?: SessionStore | null): Promise<T | null>;
export declare function writeHookOutput(output: unknown): Promise<void>;
