import { pathToFileURL } from "node:url";
import { askTypeSafe } from "../client.ts";
import type { LoadedConfig } from "../config.ts";
import {
  isRecognizedBashResponse,
  redactBashOutput,
  LEAK_SYSTEM_MESSAGE,
} from "../output.ts";
import { writeHookOutput } from "./common.ts";
import { runOutputHook } from "./output-handler.ts";

export interface PostToolHookSpecificOutput {
  hookEventName: "PostToolUse";
  additionalContext?: string;
  updatedToolOutput?: unknown;
}

export interface PostToolOutput {
  systemMessage?: string;
  hookSpecificOutput?: PostToolHookSpecificOutput;
}

export interface PostToolOptions {
  fetch?: typeof fetch;
  askJevFn?: typeof askTypeSafe;
  config?: LoadedConfig;
}

export async function runPostTool(
  rawPayload?: unknown,
  options?: PostToolOptions
): Promise<PostToolOutput | null> {
  const result = await runOutputHook("PostToolUse", rawPayload, options);
  if (result.kind === "skip") return null;
  if (result.kind === "diagnostic") return result.output;

  const { payload, toolName, verdict } = result;
  const hasAdvice = typeof verdict.additionalContext === "string";
  if (verdict.leaksSecret) {
    const leakInstruction =
      "claude-jev: Bash output may contain a secret; do not reproduce the value.";
    const additionalContext = hasAdvice
      ? `${verdict.additionalContext}\n${leakInstruction}`
      : leakInstruction;
    return {
      systemMessage: LEAK_SYSTEM_MESSAGE,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext,
        ...(toolName === "Bash" && isRecognizedBashResponse(payload.tool_response)
          ? { updatedToolOutput: redactBashOutput(payload.tool_response) }
          : {}),
      },
    };
  }

  if (hasAdvice) {
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
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
  runPostTool()
    .then(writeHookOutput)
    .catch(() => {})
    .finally(() => {
      process.exitCode = 0;
    });
}
