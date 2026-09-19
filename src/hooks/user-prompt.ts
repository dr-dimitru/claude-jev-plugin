/**
 * UserPromptSubmit Hook for claude-jev.
 *
 * Captures bounded user prompt into session storage for use by subsequent PreToolUse gates.
 * Returns no stdout to Claude Code. Never fails with non-zero exit code.
 */

import { pathToFileURL } from "node:url";
import { readHookInput, sessionStore } from "../hook-io.ts";

export interface UserPromptPayload {
  session_id?: string;
  prompt?: string;
  agent_id?: string;
  scratchpad_dir?: string;
  [key: string]: unknown;
}

/**
 * Handles UserPromptSubmit payload.
 */
export async function runUserPrompt(payload?: unknown): Promise<void> {
  try {
    let input: Record<string, unknown>;
    if (payload !== undefined && payload !== null && typeof payload === "object") {
      input = payload as Record<string, unknown>;
    } else {
      input = await readHookInput(process.stdin);
    }

    const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
    const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
    const agentId = typeof input.agent_id === "string" ? input.agent_id : undefined;
    const scratchpadDir =
      typeof input.scratchpad_dir === "string" ? input.scratchpad_dir : undefined;

    if (sessionId && prompt !== undefined) {
      const store = sessionStore({
        sessionId,
        agentId,
        scratchpadDir,
      });
      await store.setPrompt(prompt);
    }
  } catch {
    // Fail-open: write nothing to stdout
  }
}

// Auto-run when invoked directly by Node
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runUserPrompt().catch(() => {});
}
