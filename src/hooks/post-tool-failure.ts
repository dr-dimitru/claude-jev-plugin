import { pathToFileURL } from "node:url";
import { askTypeSafe } from "../client.ts";
import type { LoadedConfig } from "../config.ts";
import { writeHookOutput } from "./common.ts";
import { runOutputHook } from "./output-handler.ts";

export interface PostToolFailureHookSpecificOutput {
  hookEventName: "PostToolUseFailure";
  additionalContext?: string;
}

export interface PostToolFailureOutput {
  systemMessage?: string;
  hookSpecificOutput?: PostToolFailureHookSpecificOutput;
}

export interface PostToolFailureOptions {
  fetch?: typeof fetch;
  askJevFn?: typeof askTypeSafe;
  config?: LoadedConfig;
}

export async function runPostToolFailure(
  rawPayload?: unknown,
  options?: PostToolFailureOptions
): Promise<PostToolFailureOutput | null> {
  const result = await runOutputHook("PostToolUseFailure", rawPayload, options);
  if (result.kind === "skip") return null;
  if (result.kind === "diagnostic") return result.output;

  const { verdict } = result;
  const hasAdvice = typeof verdict.additionalContext === "string";
  if (verdict.leaksSecret) {
    const userWarning =
      "claude-jev: Bash failure output may contain a secret; do not reproduce the value.";
    const leakAdvice =
      "claude-jev warning: Bash failure output may contain a secret; do not reproduce or expose the value.";
    return {
      systemMessage: userWarning,
      hookSpecificOutput: {
        hookEventName: "PostToolUseFailure",
        additionalContext: hasAdvice
          ? `${verdict.additionalContext}\n${leakAdvice}`
          : leakAdvice,
      },
    };
  }

  if (hasAdvice) {
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUseFailure",
        additionalContext: verdict.additionalContext,
      },
    };
  }
  return null;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runPostToolFailure()
    .then(writeHookOutput)
    .catch(() => {})
    .finally(() => {
      process.exitCode = 0;
    });
}
