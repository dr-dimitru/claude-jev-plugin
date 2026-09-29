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

API key is sent only as Bearer token to the configured endpoint, which is HTTPS unless it is local. `TYPESAFE_API_KEY` is never sent to a local endpoint. Do not commit it or place it in project configuration.

## Update, disable, and uninstall

```text
/plugin update claude-jev@dr-dimitru-claude-tools
/plugin disable claude-jev@dr-dimitru-claude-tools
/plugin uninstall claude-jev@dr-dimitru-claude-tools
```

Claude Code removes plugin data on uninstall unless `--keep-data` is passed. Legacy fallback state under `~/.cache/claude-jev` is outside Claude's plugin-data lifecycle and must be removed manually if no longer needed.

## Detailed integration guides

- [TypeSafe AI integration overview](docs/type-safe-integration.md)
- [Pre-tool judgments](docs/pre-tool-judgments.md)
- [Output judgments](docs/output-judgments.md)
- [Reliability, privacy, and trust boundaries](docs/reliability-and-privacy.md)
- [End-to-end judgment example](docs/end-to-end-example.md)
- [Architecture and design notes](docs/architecture.md)

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

Successful Bash output is asked only `leaks_secret` (Noul threshold `0.90`). Failed Bash output is asked both `leaks_secret` and `failure_class` (Choice confidence threshold `0.60`). Classifying successful output produced false advice, so successful commands never receive failure advice.

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

`retentionDays` (default `7`, global configuration only) sets how long per-session state and judgment caches are kept. Once a day, `UserPromptSubmit` deletes data for other sessions that is older than this. `0` disables cleanup.

Every remote endpoint must use HTTPS. Plain `http:` is allowed only for a local endpoint (`localhost`, `127.x.x.x`, or `[::1]`). No endpoint may contain embedded credentials. See [Model selection](#model-selection).

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
    "minConfidence": 0.6,
    "successCheck": "prefilter"
  }
}
```

Setting `output.successCheck` controls when successful output is evaluated. Value `"prefilter"` (default) sends successful output to TypeSafe only when a local scan finds credential-like text or a secret-reading command. Value `"always"` sends every successful command output to TypeSafe.

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

## Model selection

`model` is set only in trusted global configuration (`~/.claude/claude-jev.json`). Project configuration cannot set `model` or `endpoint`, and no CLI flag overrides either. The default is `jev-latest`.

Hosted TypeSafe model IDs (source: https://docs.typesafe.ai/models):

| ID | Meaning |
| --- | --- |
| `jev-1.13.0` | Current hosted model. |
| `jev-latest` | Alias for `jev-1.13.0`. Plugin default. |
| `jev-preview` | Alias for `jev-1.13.0`. |

The response `model` field reports the versioned ID that answered.

Any non-empty model ID in global configuration is sent unchanged. The plugin verifies only the hosted IDs above. Jev remains the default.

### Local alternative models

Two open-weight models are documented as local alternatives. Neither is served by TypeSafe. Both are assumed to run on your machine. The plugin does not test them against a live server.

| Model | Source | Start command | Default bind | Endpoint |
| --- | --- | --- | --- | --- |
| Kev | https://github.com/jaredpalmer/kev | `uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009` | `127.0.0.1` | `http://127.0.0.1:8009/v1/systemone` |
| Laya | https://github.com/NandhaKishorM/laya | `LAYA_HOST=127.0.0.1 LAYA_DEVICE=mps laya-serve` | `0.0.0.0:8000` | `http://127.0.0.1:8000/v1/systemone` |

Kev is an Apache-2.0 community model by Jared Palmer. Checkpoints are `jaredpalmer/kev-0.8b`, `kev-4b`, `kev-9b`, and `kev-27b`. It answers `POST /v1/systemone` with the TypeSafe wire contract, echoes the requested model, and adds `latency_ms`, which the plugin drops.

Laya is an Apache-2.0 model by Convai Innovations. Checkpoints are `english`, `multilingual`, and `typed-decisions`. `LAYA_DEVICE` is `cuda`, `mps`, or `cpu`. The response `model` is `laya-rl-agent`, not the requested checkpoint name. The requested checkpoint appears in a top-level `routing` object (`routing.model`, `routing.reason`). The plugin drops `routing`. It answers `POST /v1/systemone` with the TypeSafe Jev wire protocol, with these differences:

- Answers include `type`. They add `answer_confidence` and an `action` object, which the plugin drops. Noul answers also carry `confidence`, which the plugin drops (the System One noul contract has no confidence). The plugin still accepts answers without `type` when the question is declared.
- Noul, score, and choice answers all pass plugin validation (score legend keys "0".."n-1" equal the criteria).
- Choice allows up to 100 options on Laya. The plugin cap stays at 20.
- Every score level needs a description. Plugin score criteria are always strings, so this holds.

Laya binds 0.0.0.0 by default; start it with LAYA_HOST=127.0.0.1 to keep it on loopback.

Example global configuration for Kev:

```json
{ "model": "kev-latest", "endpoint": "http://127.0.0.1:8009/v1/systemone" }
```

Example global configuration for Laya:

```json
{ "model": "english", "endpoint": "http://127.0.0.1:8000/v1/systemone" }
```

Local endpoint rules:

- A local endpoint has hostname `localhost`, `127.x.x.x`, or `[::1]`. Only local endpoints may use plain `http:`. All others must use HTTPS.
- Endpoint and model come only from trusted global configuration. Project configuration cannot set them.
- A local endpoint does not need an API key, and the client sends no Authorization header without one. `TYPESAFE_API_KEY` is never sent to a local endpoint. If the local server sets `KEV_API_KEY` or `LAYA_API_KEY`, put that key in the global `apiKeyFile`.
- State and questions stay on your machine and TypeSafe does not bill them. Hooks and `claude-jev ask` still send the same data to the local process.
- `claude-jev status` shows `Endpoint: local` or `Endpoint: remote`, and says the key is not required for a local endpoint.

There is no automatic fallback. The client sends the configured model once per attempt. The model-family check applies only to remote endpoints. A local server is run by the user and may report its own checkpoint name (Laya answers `english` requests as `laya-rl-agent`), so local responses are not rejected for a model mismatch. Remote endpoints fail with `MODEL_MISMATCH` on a cross-family answer. Family is the text before the first `-`. An `org/` prefix is ignored, so `jaredpalmer/kev-4b` and `kev-latest` are both family `kev`. Versioned IDs in the same family are accepted, so `jev-latest` may answer as `jev-1.13.0`.

Probability maps must sum to one within `max(0.05, categories x 0.005)`. The client then renormalizes them.

## Decision helper

`claude-jev ask` sends custom typed questions about one state in a single TypeSafe request. It reads one JSON object from stdin and prints JSON:

```bash
claude-jev ask <<'JSON'
{
  "state": {"decision": "Use Redis or Postgres for jobs", "constraints": ["team of two"]},
  "questions": {
    "risky": {"type": "noul", "instructions": "Is job loss a serious risk?"},
    "fit": {"type": "score", "instructions": "How well does Postgres fit?", "criteria": ["Poor", "Fair", "Good"]},
    "pick": {"type": "choice", "instructions": "Which option fits best?", "criteria": {"redis": "Redis", "postgres": "Postgres"}}
  }
}
JSON
```

Output has `model`, `usage` (token counts), and validated `answers`. The command accepts no arguments or flags.

Limits:

- input up to 64 KiB (UTF-8 bytes);
- serialized `state` up to `maxStateChars` (default 8000);
- 1 to 32 questions, named `^[A-Za-z][A-Za-z0-9_]{0,63}$`, excluding prototype names;
- `instructions` up to 2000 characters and each criterion up to 500 characters;
- Score takes 2 to 10 criteria. Choice takes 2 to 20 criteria. The TypeSafe API allows up to 255 options, but rounding drift grows by 0.005 per category, so the plugin caps Choice lower;
- Noul `criteria` is optional and may only use the keys `true` and `false`.

Exit codes:

| Code | Meaning |
| ---: | --- |
| `0` | Success. |
| `2` | Invalid input. No request was sent. |
| `1` | TypeSafe or configuration error. |

Errors report only a fixed category, code, HTTP status, and model. They never include response bodies, state, or question text.

Skill `/claude-jev:decide` wraps this command for user-requested decisions. Only the user can invoke it. It asks follow-up questions, shows a summary of what will be sent, and waits for confirmation before every request. It reports uncertainty and gives Claude's own recommendation, labeled as advisory. TypeSafe output is evidence, not fact, consent, or authorization. The user makes the final decision. If the command exits nonzero, Claude continues with ordinary reasoning and does not retry with another model.

State and questions go to the configured model's server. With a TypeSafe model they leave the machine and TypeSafe bills each request. With a local model they stay on the machine and are not billed by TypeSafe. Retries resend the full body, for up to 1 plus `retries` attempts within `timeoutMs`.

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

Custom decision questions use `claude-jev ask` through `/claude-jev:decide`. See [Decision helper](#decision-helper).

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

The repository has no lockfile on purpose: Claude Code installs dependencies in installed plugin copies when a lockfile exists, and the only dependency is the exactly pinned TypeScript compiler used at build time.

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
