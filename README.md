# claude-jev

`claude-jev` adds TypeSafe Jev as a semantic decision layer around Claude Code tool execution.

- `PreToolUse` judges Bash, Write, and Edit calls.
- `PostToolUse` judges successful Bash output.
- `PostToolUseFailure` judges failed Bash output.
- All requests go directly from local plugin code to TypeSafe's HTTPS API.
- The plugin does not define or start an MCP server.

This is a semantic guardrail, not a hard security sandbox. Jev can be unavailable or wrong. Claude Code permission rules remain the hard control.

## Installation

For local development:

```bash
claude --plugin-dir /path/to/claude-jev
```

For a published plugin, add its marketplace and install it with Claude Code's plugin manager. Enable it at user scope to make hooks available across projects. Plugin installation and marketplace commands depend on the marketplace source.

Set the API key in the environment before starting Claude Code:

```bash
export TYPESAFE_API_KEY="..."
```

The key is sent only as a Bearer token to `https://api.typesafe.ai/v1/systemone`. Do not put it in project configuration or commit it.

## How it works

Claude Code starts a local command hook for each matching event. The hook reads structured JSON from stdin, bounds the fields it needs, calls TypeSafe, and writes either no output or one valid JSON hook response to stdout.

```text
Claude Code
  -> command hook
  -> local config/state and TypeSafe client
  -> HTTPS POST /v1/systemone
  -> typed verdict
  -> Claude Code permission or output response
```

The pre-tool gate sends four independent questions in one request:

| Question | Type | Default threshold |
| --- | --- | ---: |
| Is this action destructive? | Noul | `0.90` |
| Does it send local data or secrets off-machine? | Noul | `0.70` |
| Does it affect anything beyond the requested change? | Noul | `0.85` |
| How much damage would it do if unwanted? | Score, four levels | `2.50` |

Shadow mode is default. A flagged call produces a short warning and continues. Enforce mode returns Claude Code's native `permissionDecision: "ask"`. The plugin never auto-approves a call because Jev is confident.

Successful and failed Bash output use one request containing:

- `leaks_secret`, a Noul question with threshold `0.90`;
- `failure_class`, a Choice question with minimum confidence `0.60`.

Failure advice is fixed local code:

- `transient`: retry may be appropriate;
- `environment`: fix the environment;
- `code_bug`: fix code or types;
- `permission`: resolve access instead of blindly retrying;
- `user_error`: fix invocation or input;
- `no_failure`: no advice.

Jev never generates this advice.

## Failure behavior

The plugin fails open when TypeSafe infrastructure cannot provide a judgment. Missing keys, timeouts, network failures, HTTP 429, malformed responses, and TypeSafe outages let the tool call proceed. Diagnostics are rate-limited and API keys are redacted.

A Jev safety verdict and a missing Jev verdict are separate states. A validated flagged response can ask for permission. A failed request cannot.

`gate.blockWithoutUI` defaults to `false`. In a non-interactive run, enforce mode therefore fails open unless this option is enabled. With it enabled, a flagged call returns native `permissionDecision: "deny"`.

## Privacy and data flow

The plugin never sends the full Claude conversation by default. It sends these bounded fields for a gate:

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

For Bash output it sends:

```json
{
  "cwd": "/path/to/project",
  "tool": "Bash",
  "is_error": false,
  "tool_input": {"command": "first 400 characters…[N chars elided]"},
  "output": "first 2000 characters…[N chars elided]"
}
```

The serialized request state is capped at 8000 characters. `Write` and `Edit` arguments may contain source code or diff content. Long strings are truncated locally before the HTTPS request. The omitted text stays local.

Secret detection requires TypeSafe to see the bounded output. If Jev flags a recognized successful Bash response, the plugin replaces the output Claude receives with a generic warning. It does not guess secret spans or run global regex replacements. The command has already run, so replacement cannot undo command side effects, network transfers, or telemetry. Failed output has no Claude-supported replacement field; the failure hook can warn but cannot replace it.

The API key is never included in state, verdict summaries, cache keys, or errors.

## Configuration

Global configuration:

```text
~/.claude/claude-jev.json
```

Project configuration:

```text
.claude/claude-jev.json
```

Precedence:

```text
defaults -> global config -> project config -> environment secret -> session override
```

Example:

```json
{
  "model": "jev-latest",
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

Optional transport fields are `endpoint`, `timeoutMs`, and `retries`. The source-compatible optional `apiKeyFile` is supported, but `TYPESAFE_API_KEY` is recommended. Plaintext `apiKey` config is not required.

## Caching and performance

Gate results use a session-local cache with a 120-second default TTL. Keys include normalized bounded judgment input, model, and questions. Object keys are sorted before hashing. Concurrent hook processes coordinate through bounded local lock files. Infrastructure failures are never cached as clear verdicts.

Output results use the same session-local coordination and a fixed 120-second TTL. Safe judgments produce no model-visible context. Hook startup and TypeSafe request time add latency to matching tool calls. The plugin uses Node built-ins and does not start a daemon.

## Commands and skill

The plugin provides one namespaced skill:

```text
/claude-jev:jev
```

It explains Jev question types and when explicit judgments help. Automatic hooks do not depend on Claude invoking this skill.

The bundled CLI provides the Pi-style operations:

```bash
claude-jev status
claude-jev enable --session-id <id>
claude-jev disable --session-id <id>
claude-jev mode shadow --session-id <id>
claude-jev mode enforce --session-id <id>
claude-jev last --session-id <id>
claude-jev output --session-id <id>
claude-jev check "text or command to judge"
```

Use `--scratchpad-dir` when inspecting a session whose hooks use a specific scratchpad directory. Claude Code does not document a session-ID environment variable for skill subprocesses. Exact session toggles therefore require `--session-id`; they never mutate permanent configuration. Without it, `status` reports session state as unknown.

This CLI and skill are the closest native alternative to Pi's `jev_ask`. They do not create a persistent Claude tool surface or use MCP.

## Testing

Unit tests use fixed Jev responses and local HTTP fixtures. They cover:

- gate composition and calibration fixtures;
- output classification and leak handling;
- truncation and aggregate state bounds;
- config precedence;
- session cache and lock behavior;
- malformed API and hook payloads;
- exact Claude hook response shapes;
- CLI session and manual-check behavior.

Run:

```bash
npm test
npm run build
```

Real TypeSafe API tests are not part of the normal test command. If added for local calibration, run them only with an explicit `TYPESAFE_API_KEY` and an opt-in flag.

## Inspecting and disabling judgments

Use `claude-jev last --session-id <id>` and `claude-jev output --session-id <id>` to inspect the latest local verdict summaries. They do not print raw state, output, or secrets.

Disable both automatic paths in project config:

```json
{
  "gate": {"enabled": false},
  "output": {"enabled": false}
}
```

For a current session, use the CLI session override with its exact session ID:

```bash
claude-jev disable --session-id <id>
```

## Limitations compared with pi-jev

- Claude hook notifications, status UI, and prompts are not Pi's UI. `systemMessage`, `additionalContext`, and native permission decisions are the closest equivalents.
- `PostToolUseFailure` cannot replace failed output.
- Hook processes do not share Pi's in-memory state, so cache and verdict state use bounded local files.
- Skills do not receive the hook `session_id` through a documented environment variable.
- `jev_ask` is not reproduced as a persistent model tool. The skill and CLI are the supported alternative.
- Claude permission mode can limit whether an `ask` prompt is serviceable in headless or bypass-permissions runs.

## Uninstall

Remove the plugin through Claude Code's plugin manager, or stop passing `--plugin-dir /path/to/claude-jev`. Remove `~/.claude/claude-jev.json`, project `.claude/claude-jev.json`, and local session state if you no longer need them. Unsetting `TYPESAFE_API_KEY` prevents API requests but does not remove hooks from an installed plugin.
