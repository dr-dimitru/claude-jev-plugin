/**
 * UserPromptSubmit Hook for claude-jev.
 *
 * Captures bounded user prompt into session storage for use by subsequent PreToolUse gates.
 * Returns no stdout to Claude Code. Never fails with non-zero exit code.
 */

import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { hashSessionIdentity, resolveSessionBaseDir, sessionStore } from "../hook-io.ts";
import { resolveCacheBase } from "../cache.ts";
import { maybePruneSessionData } from "../retention.ts";
import { readHookPayload } from "./common.ts";
import { canCallTypeSafe, loadConfig } from "../config.ts";

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
    const input = await readHookPayload(payload);

    const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
    const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
    const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
    const eventName = typeof input.hook_event_name === "string"
      ? input.hook_event_name
      : undefined;
    const agentId = typeof input.agent_id === "string" ? input.agent_id : undefined;
    const scratchpadDir =
      typeof input.scratchpad_dir === "string" ? input.scratchpad_dir : undefined;

    if (
      sessionId &&
      cwd &&
      eventName === "UserPromptSubmit" &&
      prompt !== undefined
    ) {
      const config = loadConfig(cwd);
      const store = sessionStore({
        sessionId,
        agentId,
        scratchpadDir,
      });
      const overrides = await store.getOverrides();
      if ((overrides.enabled ?? config.gate.enabled) && canCallTypeSafe(config)) {
        await store.setPrompt(prompt);
      }
      // Retention sweep runs regardless of gate state; throttled to once a day.
      const roots = [
        ...new Set([
          resolveSessionBaseDir({ scratchpadDir }),
          resolveCacheBase({ scratchpadDir }),
          // Legacy roots: older versions kept caches in the home fallback and
          // session state under CLAUDE_PLUGIN_DATA. Both age out via retention.
          path.join(process.env.HOME ?? os.homedir(), ".cache", "claude-jev"),
          ...(process.env.CLAUDE_PLUGIN_DATA?.trim()
            ? [path.join(path.resolve(process.env.CLAUDE_PLUGIN_DATA.trim()), "sessions")]
            : []),
        ]),
      ];
      await maybePruneSessionData({
        roots,
        retentionDays: config.retentionDays,
        keepNames: [hashSessionIdentity(sessionId, agentId)],
      });
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
