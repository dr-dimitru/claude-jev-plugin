import { type LoadedConfig } from "../config.ts";
import { askTypeSafe } from "../client.ts";
import { type OutputVerdict } from "../output.ts";
export type OutputHookEvent = "PostToolUse" | "PostToolUseFailure";
export interface OutputHookOptions {
    fetch?: typeof fetch;
    askJevFn?: typeof askTypeSafe;
    config?: LoadedConfig;
}
export type OutputHookResult = {
    kind: "skip";
} | {
    kind: "diagnostic";
    output: {
        systemMessage?: string;
    } | null;
} | {
    kind: "judged";
    payload: Record<string, unknown>;
    toolName: string;
    verdict: OutputVerdict;
};
export declare function runOutputHook(eventName: OutputHookEvent, rawPayload?: unknown, options?: OutputHookOptions): Promise<OutputHookResult>;
