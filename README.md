# claude-jev

`claude-jev` adds TypeSafe Jev semantic judgments to Claude Code tool execution.

- `PreToolUse` judges Bash, Write, and Edit calls.
- `PostToolUse` judges successful Bash output.
- `PostToolUseFailure` judges failed Bash output.
- Requests go directly from local plugin code to TypeSafe's HTTPS API.
- Plugin has no MCP server.

This plugin is a semantic guardrail, not a security sandbox. TypeSafe can be unavailable or wrong. Claude Code permission rules remain the hard control.

License: `BSD-3-Clause`.

## Install and enable

Remote installation requires readable GitHub repositories for both marketplace and plugin.

```text
/plugin marketplace add dr-dimitru/claude-plugins-marketplace
/plugin install claude-jev@dr-dimitru-claude-tools --scope user
```

Plugin manifest sets `defaultEnabled` to `false`. Enabling it sends bounded data to an external service and may incur TypeSafe API cost. Review [Privacy and data flow](#privacy-and-data-flow), then set key outside project configuration:

```bash
export TYPESAFE_API_KEY="..."
```

Enable and reload:

```text
/plugin enable claude-jev@dr-dimitru-claude-tools
/reload-plugins
```

For local development:

```bash
claude --plugin-dir /path/to/claude-jev-plugin
```

API key is sent only as Bearer token to configured HTTPS TypeSafe endpoint. Do not commit it or place it in project configuration.

## Update, disable, and uninstall

```text
/plugin update claude-jev@dr-dimitru-claude-tools
/plugin disable claude-jev@dr-dimitru-claude-tools
/plugin uninstall claude-jev@dr-dimitru-claude-tools
```

Claude Code removes plugin data on uninstall unless `--keep-data` is passed. Legacy fallback state under `~/.cache/claude-jev` is outside Claude's plugin-data lifecycle and must be removed manually if no longer needed.

## How judgments work

Claude Code invokes one local command hook for each matching event. Hook reads bounded JSON from stdin, calls TypeSafe, and writes either no output or one valid Claude hook response.

```text
Claude Code
  -> command hook
  -> bounded local state
  -> HTTPS POST https://api.typesafe.ai/v1/systemone
  -> validated typed answers
  -> local threshold composition
  -> Claude Code hook response
```

Pre-tool gate sends four independent questions in one API request:

| Question | Type | Default threshold |
| --- | --- | ---: |
| Is action destructive? | Noul | `0.90` |
| Does action send local data or secrets off-machine? | Noul | `0.70` |
| Does action exceed requested scope? | Noul | `0.85` |
| How damaging would unwanted action be? | Score | `2.50`, confidence at least `0.50` |

Shadow mode is default. Flagged action produces short warning and continues. Enforce mode returns Claude Code's native `permissionDecision: "ask"`. Plugin never returns `allow` from TypeSafe confidence.

Successful and failed Bash results send two questions in one request:

- `leaks_secret`, Noul threshold `0.90`;
- `failure_class`, Choice confidence threshold `0.60`.

Failure advice is fixed local text for `transient`, `environment`, `code_bug`, `permission`, and `user_error`. TypeSafe does not generate advice.

## Failure behavior

Plugin fails open when no validated judgment is available. Missing key, invalid config, timeout, network failure, retry exhaustion, HTTP 429 or 529, malformed response, cache coordination timeout, state failure, and Claude hook timeout do not create permission denial.

No-verdict state is never cached as clear. Diagnostics use fixed local wording and do not include API response bodies, parser excerpts, prompts, commands, output, or credentials.

Client uses one 15-second total request deadline. Deadline includes connection, response-body read, JSON parsing, retry delays, and all attempts. Retries use bounded exponential backoff and honor `Retry-After` only when delay fits remaining budget. Claude hook timeout is 20 seconds.

Enforce mode asks when prompt-host availability is unknown. Claude hook payload does not expose universal headless or prompt-host field. Plugin recognizes documented `permission_mode` values `dontAsk` and `bypassPermissions` as non-interactive. For those modes, `gate.blockWithoutUI: false` fails open and `true` returns `deny`. Plugin makes no broader headless-detection claim.

## Privacy and data flow

Plugin never reads full transcript. `UserPromptSubmit` stores bounded prompt only when gate is enabled and key is configured.

Gate request contains:

```json
{
  "cwd": "/path/to/project",
  "tool": "Write",
  "tool_input": {
    "file_path": "/path/to/file",
    "content": "first 400 characters…[N chars elided]"
  },
  "user_request": "first 1200 characters…[N chars elided]"
}
```

Output request contains:

```json
{
  "cwd": "/path/to/project",
  "tool": "Bash",
  "is_error": false,
  "tool_input": {"command": "first 400 characters…[N chars elided]"},
  "output": "first 2000 characters…[N chars elided]"
}
```

Serialized state is capped at 8000 characters. Write/Edit content, user prompts, commands, and command output can leave machine. Secret detection requires sending bounded output to TypeSafe, and that output may itself contain a secret. Omitted text remains local.

Positive leak judgment replaces recognized successful Bash output before Claude sees it. Original output already existed in process and may already appear in telemetry. `PostToolUseFailure` cannot replace failed output, so failure hook can only warn and add context.

Plugin never includes session ID, transcript path, agent identity, API key, or raw cache record in TypeSafe state.

## Configuration

Global user configuration:

```text
~/.claude/claude-jev.json
```

Project judgment configuration:

```text
.claude/claude-jev.json
```

Precedence:

```text
defaults -> global config -> project judgment config -> environment key -> session override
```

Project configuration cannot set `model`, `endpoint`, `timeoutMs`, `retries`, `apiKey`, or `apiKeyFile`. This prevents repository-controlled credential redirection. These transport fields are accepted only from trusted global configuration; plaintext JSON `apiKey` is not accepted. Relative global `apiKeyFile` resolves under `~/.claude`.

Every endpoint must use HTTPS and cannot contain embedded credentials.

Example project configuration:

```json
{
  "maxStateChars": 8000,
  "gate": {
    "enabled": true,
    "mode": "shadow",
    "tools": ["Bash", "Write", "Edit"],
    "argumentChars": 400,
    "cacheSeconds": 120,
    "minConfidence": 0.5,
    "blockOn": {
      "destructive": 0.9,
      "exfiltration": 0.7,
      "beyondScope": 0.85,
      "impact": 2.5
    },
    "blockWithoutUI": false
  },
  "output": {
    "enabled": true,
    "tools": ["Bash"],
    "outputChars": 2000,
    "leakThreshold": 0.9,
    "minConfidence": 0.6
  }
}
```

Example trusted global transport configuration:

```json
{
  "model": "jev-latest",
  "endpoint": "https://api.typesafe.ai/v1/systemone",
  "timeoutMs": 15000,
  "retries": 2,
  "apiKeyFile": "typesafe.key"
}
```

## Cache and session state

Cache keys include exact bounded request state, current directory, model, questions, effective thresholds, and payload bounds. Session and optional subagent identities isolate cache directories. Concurrent processes coordinate with renewable lock files; waiters do not start duplicate requests on timeout.

State path precedence:

1. Claude `scratchpad_dir` when supplied;
2. `CLAUDE_PLUGIN_DATA/sessions`;
3. legacy fallback `~/.cache/claude-jev`.

Files use restrictive permissions. Scratchpad lifetime is owned by Claude Code. Plugin data persists across updates and is removed by standard uninstall unless `--keep-data` is used. Legacy fallback has no automatic retention sweep.

## CLI and skill

Plugin provides namespaced skill:

```text
/claude-jev:jev
```

Automatic hooks do not depend on skill invocation. Main manual operation is:

```bash
claude-jev check "text or command to judge"
```

Inspection and advanced exact-session controls:

```bash
claude-jev status [--session-id <id>]
claude-jev enable --session-id <id>
claude-jev disable --session-id <id>
claude-jev mode shadow --session-id <id>
claude-jev mode enforce --session-id <id>
claude-jev last --session-id <id>
claude-jev output --session-id <id>
```

Claude does not document session-ID environment variable for skill subprocesses. Exact controls require explicit hook session ID and, when applicable, `--scratchpad-dir`. They never edit persistent config.

## Test and validate

```bash
npm ci --ignore-scripts
npm run check
npm run validate:plugin
npm pack --dry-run --json
```

Normal suite uses fixed responses and local fetch fixtures. Real TypeSafe tests require both `CLAUDE_JEV_REAL_API=1` and preconfigured `TYPESAFE_API_KEY`; they skip otherwise.

## Current limitations

- TypeSafe judgments are probabilistic.
- Hooks fail open on infrastructure and timeout failures.
- `updatedToolOutput` cannot undo command effects or prior telemetry.
- Failed tool output cannot be replaced through `PostToolUseFailure`.
- Skill subprocesses do not receive documented hook session ID.
- Plugin needs Node.js `>=22.6` on PATH.
- Remote marketplace installation requires accessible GitHub repositories.
