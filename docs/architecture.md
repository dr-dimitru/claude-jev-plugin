# claude-jev architecture

Status: Implemented and reviewed against current Claude Code and TypeSafe documentation.

`claude-jev` ports the decision parts of `@y0usaf/pi-jev` to Claude Code. Claude Code invokes local command hooks. Those hooks send one bounded JSON request directly to TypeSafe Jev over HTTPS. The plugin does not define an MCP server, an MCP tool, or a persistent MCP process.

## Lifecycle mapping

| pi-jev | claude-jev | Behavior |
| --- | --- | --- |
| `session_start` | `UserPromptSubmit` plus lazy config loading in each hook | Save the latest bounded user request and load config when a hook runs. |
| `tool_call` | `PreToolUse` | Judge Bash, Write, and Edit before execution. Shadow emits a short warning. Enforce returns native `permissionDecision: "ask"` for flagged calls. |
| `tool_result` | `PostToolUse` | Judge successful Bash output. Add short deterministic advice only when needed. Replace known Bash output with a generic warning when Jev flags a secret. |
| failed `tool_result` | `PostToolUseFailure` | Normalize top-level `error` separately from successful `tool_response`, then run the same two output questions. Failed-output replacement is not available on this event. |
| Pi notification | Hook JSON `systemMessage` | Show short user-facing warnings without appending normal safe verdicts to Claude's context. |
| Pi confirmation | `PreToolUse` `hookSpecificOutput.permissionDecision: "ask"` | Let Claude Code own the permission prompt. |
| Pi session memory | Session-keyed local files | Share cache and last-verdict state across short-lived hook processes. |
| `jev_ask` | Namespaced skill and local CLI | Keep explicit judgments outside the automatic hook path. No MCP replacement is used. |

A `UserPromptSubmit` hook is needed because `PreToolUse` does not include the current user prompt. It stores only the latest bounded prompt. The plugin does not fall back to reading `transcript_path`: Claude documents that the transcript can lag the in-memory conversation, and avoiding that read keeps prompt data out of the hook path when prompt capture is unavailable.

## Claude Code hook contracts

### Plugin hook configuration

A plugin places only its manifest in `.claude-plugin/plugin.json`. Hook configuration belongs at the plugin root in `hooks/hooks.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/dist/hooks/user-prompt.js"],
            "timeout": 5
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/dist/hooks/pre-tool.js"],
            "timeout": 20
          }
        ]
      }
    ]
  }
}
```

The real file will include `PostToolUse` for `Bash` and `PostToolUseFailure` for `Bash`. `args` selects Claude's exec form, so the plugin does not put tool input into shell source or interpolate untrusted values. Each handler reads one JSON object from stdin. Stdout is either empty or one JSON object. Stderr is reserved for local debugging and is never used for user-visible verdict content.

Claude runs matching handlers in parallel. A plugin hook stays separate from an identical hook declared in settings. Hooks also run for tools used by subagents. The state key therefore includes `session_id` and, when present, `agent_id`.

### Common input

Every relevant hook receives these fields:

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/path/to/project",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse"
}
```

`session_id`, `cwd`, and `hook_event_name` are required for this plugin. Missing or malformed values cause a fail-open no-decision result. `scratchpad_dir` is used for session state when available. Paths are treated as data and are never interpolated into a shell command.

### `UserPromptSubmit`

The input adds a `prompt` string. The hook stores a locally truncated copy and returns no output. It does not send the prompt to TypeSafe. It does not add a system reminder to Claude.

### `PreToolUse`

The input adds `tool_name`, `tool_input`, and `tool_use_id`. Claude sends absolute file paths for Write and Edit, using native path separators.

The hook returns no output for a clear verdict. For a shadow flag it returns a short user warning:

```json
{
  "systemMessage": "claude-jev shadow: Bash flagged (destructive 0.99, impact 3.00/3)"
}
```

For an enforce flag it returns:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "claude-jev flagged Bash: destructive 0.99, impact 3.00/3"
  }
}
```

Claude's documented precedence is `deny > defer > ask > allow`. The plugin never returns `allow` as a consequence of Jev confidence. The default enforcement action is `ask`, not a custom prompt and not an automatic approval.

`blockWithoutUI` applies only when Claude reports documented non-interactive permission modes, currently `dontAsk` or `bypassPermissions`. Its default is false, so those modes fail open; true returns `permissionDecision: "deny"`. Claude hook input has no universal prompt-host field. In other modes, enforce returns `ask` and Claude Code owns whether a prompt host can service it.

### `PostToolUse`

The input contains `tool_input` and structured `tool_response`. For Bash, Claude documents a response shape containing `stdout`, `stderr`, `interrupted`, and `isImage`. The hook judges a bounded rendering of this response.

The hook can return:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "claude-jev: this Bash result reads as a transient failure; retrying the same command unchanged is reasonable.",
    "updatedToolOutput": {
      "stdout": "[claude-jev] Output withheld because Jev flagged it as containing a secret. Do not reproduce the value.",
      "stderr": "",
      "interrupted": false,
      "isImage": false
    }
  },
  "systemMessage": "claude-jev: Bash output may contain a secret; output was withheld from Claude."
}
```

`additionalContext` is emitted only for deterministic failure advice. A safe result emits nothing. A leak result uses a whole-output replacement for a recognized Bash response instead of a global regular-expression scrub. This preserves no potentially sensitive text. The hook does not replace output for an unknown response shape.

### `PostToolUseFailure`

The input includes the same `tool_name` and `tool_input`, but failure text is top-level:

```json
{
  "hook_event_name": "PostToolUseFailure",
  "tool_name": "Bash",
  "tool_input": {"command": "npm test"},
  "tool_use_id": "toolu_01ABC123",
  "error": "Exit code 1\nError: Cannot find module 'express'",
  "is_interrupt": false
}
```

The normalized output uses `error` as output text and sets `is_error: true`. It does not assume `tool_response` exists. The hook can return `additionalContext`, but this event has no `updatedToolOutput` field. If Jev flags a secret in a failed result, the plugin warns the user and tells Claude not to repeat it. It cannot retroactively replace the failed result through this event.

`tool_use_id` is recorded in bounded session state. If a future Claude Code version emits overlapping success and failure events, the second event is not judged again.

## Jev questions and verdict composition

The client posts to the current documented endpoint:

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
Content-Type: application/json
```

The default model is `jev-latest`. The client validates the response before any verdict code reads it. All questions for one state go in one request. TypeSafe evaluates them independently, so the hook does not make four gate requests or two output requests.

### Pre-tool gate

The gate asks the source questions without changing their calibrated wording or thresholds:

```json
{
  "destructive": {
    "type": "noul",
    "instructions": "Is this action destructive?",
    "criteria": {
      "true": "Deletes or overwrites data, or rewrites shared history",
      "false": "Nothing is deleted or overwritten"
    }
  },
  "exfiltration": {
    "type": "noul",
    "instructions": "Does this action send local file contents, credentials, or environment variables to a network destination outside the project's own tooling?",
    "criteria": {
      "true": "Local data or secrets leave the machine",
      "false": "Nothing leaves the machine"
    }
  },
  "beyond_scope": {
    "type": "noul",
    "instructions": "Does this action affect anything beyond the change the user asked for?",
    "criteria": {
      "true": "Touches things the user did not ask about",
      "false": "Confined to what the user asked for"
    }
  },
  "impact": {
    "type": "score",
    "instructions": "How much damage would this action do if the user did not want it?",
    "criteria": [
      "None, it only reads",
      "Small, one file or one reversible change",
      "Large, many files or shared state",
      "Severe, data loss or a forced overwrite of shared history"
    ]
  }
}
```

A call is flagged when any of these source defaults is crossed:

```json
{
  "destructive": 0.90,
  "exfiltration": 0.70,
  "beyondScope": 0.85,
  "impact": 2.50
}
```

The impact threshold also requires the configured minimum confidence, `0.50` by default. Noul answers have no separate confidence, so their probabilities are compared directly. A missing or wrong answer shape is not a safe answer. It is a malformed Jev response and follows fail-open infrastructure handling.

### Output judge

Successful and failed Bash results use one batched request:

```json
{
  "leaks_secret": {
    "type": "noul",
    "instructions": "Does `output` contain a secret or credential that must not be written to a session transcript?",
    "criteria": {
      "true": "A key, token, password, or private key appears in the text",
      "false": "Only ordinary program output"
    }
  },
  "failure_class": {
    "type": "choice",
    "instructions": "What kind of failure is `output` reporting?",
    "criteria": {
      "transient": "A network or resource hiccup that may succeed on a retry",
      "environment": "A missing dependency, port, or tool in the local setup",
      "code_bug": "The code or types are wrong",
      "permission": "Access was denied by the OS or a server",
      "user_error": "The command itself was invoked wrongly",
      "no_failure": "Output reports success or nothing wrong"
    }
  }
}
```

`leaks_secret >= 0.90` produces a leak verdict. A failure class produces advice only when its confidence is at least `0.60`:

| Jev class | Fixed advice |
| --- | --- |
| `transient` | Retrying the same command unchanged is reasonable. |
| `environment` | Fix the environment before retrying. |
| `code_bug` | Fix the code or types; retrying unchanged will not help. |
| `permission` | Access was denied; change what is accessed or ask the user. |
| `user_error` | Fix the command invocation or input. |
| `no_failure` | No advice. |

Jev never generates this prose. The table is local code.

## Data sent to TypeSafe

The plugin sends only fields needed for the requested judgment. It never sends the full Claude conversation by default.

### Gate state

```json
{
  "cwd": "/Users/example/project",
  "tool": "Write",
  "tool_input": {
    "file_path": "/Users/example/project/src/index.ts",
    "content": "first 400 characters…[N chars elided]"
  },
  "user_request": "first 1200 characters…[N chars elided]"
}
```

The implementation may include `platform` because the source implementation did, but it will not include `transcript_path`, `session_id`, agent identity, permission mode, or unrelated conversation entries. Write and Edit inputs may contain source code or diff text. Their long string values are truncated locally before serialization. A user who wants no file content in gate requests can set `gate.tools` to only `Bash`.

### Output state

```json
{
  "cwd": "/Users/example/project",
  "tool": "Bash",
  "is_error": false,
  "tool_input": {
    "command": "npm test",
    "description": "first 400 characters…[N chars elided]"
  },
  "output": "first 2000 characters…[N chars elided]"
}
```

The output text is bounded locally. It may contain credentials because secret detection needs evidence to classify it. TypeSafe receives that bounded output over HTTPS. The plugin does not claim that Jev secret detection is local or that this is a hard security boundary. An API key in `TYPESAFE_API_KEY` is never placed in state and is sent only in the Authorization header.

`maxStateChars` is enforced after recursive field truncation. If the serialized JSON still exceeds the cap, optional user-request text is removed first, then string leaves are reduced, then oversized optional fields are replaced by a marker. The serializer never cuts a JSON string in the middle of a JSON document.

The marker format is `…[N chars elided]`. Omitted file, argument, prompt, and output text stays on the local machine.

## Configuration and state ownership

Configuration files use Claude's native locations:

- Global: `~/.claude/claude-jev.json`
- Project: `.claude/claude-jev.json`

Precedence is:

```text
defaults -> global config -> project config -> environment secret -> session override
```

The environment overrides any configured key source. The default configuration is:

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

Trusted global configuration may set `model`, `endpoint`, `timeoutMs`, `retries`, and `apiKeyFile`. Project configuration cannot set these fields or any API key. Remote endpoints must use HTTPS. Plain `http:` is allowed only for a local endpoint (`localhost`, `127.x.x.x`, or `[::1]`). No endpoint may contain embedded credentials. A local endpoint needs no API key, gets no Authorization header without one, and never receives `TYPESAFE_API_KEY`. Local open-weight models such as Kev (https://github.com/jaredpalmer/kev) and Laya (https://github.com/NandhaKishorM/laya) can serve the same `POST /v1/systemone` contract. The client takes the answer type from the declared question and drops extra response fields such as `answer_confidence` and `latency_ms`. `TYPESAFE_API_KEY` is the preferred secret source; plaintext JSON `apiKey` is not accepted. Relative global `apiKeyFile` paths resolve under `~/.claude`.

Session overrides, last verdicts, recent prompt text, cache entries, in-flight lock metadata, and warning timestamps are local state. Session state root precedence is hook `scratchpad_dir`, then `~/.cache/claude-jev`. It skips `CLAUDE_PLUGIN_DATA` because the CLI, run through Claude's Bash tool, does not receive that variable and must read the same state as the hooks. Judgment caches use `CLAUDE_PLUGIN_DATA/cache` when set. A session filename is a hash of `session_id` and `agent_id`, never the raw identifier. Per-session locks serialize mutations; atomic rename protects complete records. State is not sent to TypeSafe except for selected prompt and tool fields described above.

## Caching and concurrent deduplication

The cache is session-local. A gate key hashes normalized bounded judgment input, including:

- tool name;
- normalized tool input;
- bounded current working directory;
- bounded latest user request;
- model and question definitions.

An output key hashes the normalized tool name, tool input, error flag, and bounded output. Object keys are sorted recursively. Key generation does not use JavaScript object identity and does not put raw state in filenames.

A cached successful verdict is valid for `120` seconds by default. Entries are bounded and pruned by age and count. Infrastructure failures are not cached as safe verdicts.

Because Claude may start one Node process per hook and may run parallel tool hooks, an in-memory Promise map is insufficient. The shared cache uses an exclusive lock file per key:

1. The first process creates the lock and evaluates Jev.
2. Other processes poll the cache for a bounded interval rather than sending duplicate requests.
3. The owner atomically writes the result and removes the lock.
4. A lock older than the configured stale interval is removed and replaced.
5. A process that cannot coordinate within its bounded wait fails open rather than blocking Claude indefinitely.

The last gate and output verdict are stored separately from cache entries. `/last`-style inspection reads those local records and does not add full answers to Claude's context.

## Failure semantics

The plugin distinguishes these states:

1. **Unsafe verdict:** TypeSafe returned a validated response and local composition crossed a threshold. Shadow warns. Enforce asks. Output leak handling may replace known Bash output.
2. **Clear verdict:** TypeSafe returned a validated response and no threshold crossed. The hook is silent.
3. **No verdict:** The key is missing, the request timed out, the network failed, HTTP returned 429 or another retryable failure, TypeSafe returned malformed JSON, or response validation failed. The tool call proceeds.

No verdict never becomes a clear Jev answer in local records. It is marked as an infrastructure failure. Diagnostics are rate-limited to once per minute per session and redact the configured API key. A missing API key produces one setup warning and disables automatic requests until the environment changes.

The default is fail-open. A future `failClosed` or deny-on-infrastructure option may be added only as an explicit configuration feature. It is not part of the default path.

## Secret handling

The plugin keeps TypeSafe API-key redaction separate from Jev's `leaks_secret` judgment:

- API keys are registered in memory and scrubbed from client errors and hook diagnostics.
- Jev leak results are never echoed with the detected text or the output excerpt.
- A positive leak result emits a short user `systemMessage` and a short instruction in Claude context not to reproduce the value.
- A recognized successful Bash response is replaced wholesale with a generic warning. The plugin does not guess a secret span and does not run global regex replacements over ordinary output.
- A failed Bash result cannot be replaced through `PostToolUseFailure`; the plugin can only add a warning/context message. This limitation is explicit.
- Tool effects and telemetry occur before `PostToolUse`, so output replacement cannot undo a network transfer, file write, or command side effect.

This is semantic guidance, not a hard security sandbox. A Bash command that exfiltrates data is judged before it runs, but Jev can be unavailable or wrong. A secret already printed by a command has already left the process before the output hook can react.

## Performance

The gate uses one request for four questions. The output judge uses one request for two questions. Disabled judges make no request. Identical state reuses a cache result, and parallel identical hook processes coordinate through the local lock.

Pre-tool hooks are synchronous because Claude must receive a decision before execution. Post-tool hooks are synchronous when they may replace Bash output. Client has one 15-second total request deadline covering connection, body read, parsing, delays, and every retry. Matching hook timeout is 20 seconds. Cache wait is bounded within that hook budget.

The plugin does not load large dependencies or start a daemon. If measured process startup and file locking are a daily-use problem, that is a later optimization decision, not a reason to add a background service before evidence exists.

## Native UX and Pi limitations

Claude plugin skills are namespaced. This plugin provides one `/claude-jev:jev` skill; its bundled `claude-jev` executable provides the closest native equivalents for `status`, `enable`, `disable`, `mode shadow`, `mode enforce`, `last`, `output`, and `check`. Separate slash commands would require separate skill files and would not solve the documented session-ID limitation.

Claude does not document a session-ID environment variable for a slash-command skill. Hook stdin has `session_id`, but a skill's Bash process does not receive that hook payload. Therefore exact Pi command parity is not possible without requiring `--session-id` or using an explicitly selected project/session state. The CLI will accept `--session-id` for exact state changes and will label session state as unknown when it is omitted. Session toggles never mutate permanent config.

`jev_ask` was a Pi model-facing tool. Claude skills cannot add a new persistent tool without using MCP. The lightest supported alternative is a namespaced skill that invokes the bundled local CLI through Claude's existing Bash tool. Automatic hooks do not depend on this skill, and the skill teaches Claude to batch typed questions without reimplementing gate logic.

Other non-equivalences are:

- Pi's in-process `ctx.ui.notify`, status line, and confirmation UI have no one-to-one hook API. `systemMessage`, `additionalContext`, and native permission prompts are the closest primitives.
- Pi can append a result block directly from its result handler. Claude has structured output replacement for successful PostToolUse only, and the replacement must match the tool's schema.
- Claude hook processes do not share Pi's in-memory Promise maps, so local file coordination replaces exact in-process deduplication.
- Claude's transcript can lag the current prompt. The extra `UserPromptSubmit` state writer improves scope context but still cannot reconstruct prior Pi context APIs.
- A hook can request `ask`, but hook input does not identify every missing prompt host. Documented `dontAsk` and `bypassPermissions` modes are handled explicitly; other modes defer prompt behavior to Claude Code.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Source code, credentials, or command output leave the machine | Explicit bounded payload documentation, local truncation, configurable tool lists, environment-only key setup, no full transcript. |
| Jev false positive interrupts work | Shadow default, native `ask` rather than deny, source thresholds, confidence floor for impact/classification, fail-open infrastructure behavior. |
| Jev false negative is treated as security | README calls this a semantic guardrail, not a sandbox; deterministic permission rules remain the hard control. |
| Secret output is sent to TypeSafe | Document output payload clearly. Replace recognized Bash output after a positive result without repeating it. Do not promise local-only detection. |
| API outage blocks Claude | Catch all client/config/parse failures, emit no permission decision, rate-limit diagnostics. |
| Concurrent hooks duplicate API requests | Session cache, normalized keys, lock files, stale-lock recovery, bounded waits. |
| Untrusted tool input reaches a shell | Use structured stdin and Node APIs. Use exec-form hook `args`; never build shell source from payload values. |
| Hook response is rejected by Claude | Validate JSON output locally and test exact event-specific shapes. Keep replacement limited to recognized Bash output. |
| Session state leaks across users or repositories | Hash session identifiers, include project scope, use restrictive file permissions where supported, bound retained data, and prune old files. |

## Planned file tree

```text
claude-jev/
├── .claude-plugin/
│   └── plugin.json
├── hooks/
│   └── hooks.json
├── bin/
│   └── claude-jev
├── src/
│   ├── client.ts
│   ├── decision.ts
│   ├── config.ts
│   ├── gate.ts
│   ├── output.ts
│   ├── cache.ts
│   ├── state.ts
│   ├── hook-io.ts
│   └── hooks/
│       ├── user-prompt.ts
│       ├── pre-tool.ts
│       ├── post-tool.ts
│       └── post-tool-failure.ts
├── skills/
│   ├── jev/
│   │   └── SKILL.md
│   └── decide/
│       └── SKILL.md
├── docs/
│   └── architecture.md
├── tests/
│   ├── client.test.ts
│   ├── decision.test.ts
│   ├── config.test.ts
│   ├── state.test.ts
│   ├── hook-io.test.ts
│   ├── gate.test.ts
│   ├── cache.test.ts
│   ├── output.test.ts
│   ├── pre-tool.test.ts
│   ├── post-tool.test.ts
│   ├── post-tool-failure.test.ts
│   ├── cli.test.ts
│   └── integration/
│       └── real-api.test.ts
├── package.json
├── tsconfig.json
├── README.md
└── LICENSE
```

Compiled `dist/` files are build artifacts and are not hand-edited. The published plugin must include them or use its package installation build step before hooks run.

## Decision helper

`src/decision.ts` validates `claude-jev ask` input. It enforces the 64 KiB input limit, the `maxStateChars` state limit, 1 to 32 questions, name and length rules, Score 2 to 10 criteria, Choice 2 to 20 criteria, and Noul `true`/`false` criteria. Invalid input exits with code 2 before any request.

`src/client.ts` is model-neutral. It exports `askTypeSafe`, `TypeSafeError`, `TypeSafeQuestion`, `TypeSafeResponse`, `validateTypeSafeResponse`, and `DEFAULT_TYPESAFE_MODEL`. Jev-named exports remain as deprecated aliases. The client sends the configured model once per attempt and rejects an answer from another model family with `MODEL_MISMATCH`. It reduces responses to model, validated answers, and usage token counts.

`claude-jev ask` in `bin/claude-jev` reads one JSON object from stdin, sends one request with all questions, and prints `model`, `usage`, and `answers`. Exit code 0 is success, 2 is invalid input, and 1 is a TypeSafe or configuration error. Errors never include response bodies, state, or question text.

`skills/decide/SKILL.md` is user-invoked only (`disable-model-invocation: true`). It confirms what will be sent before every request and treats results as advisory evidence.

## Implementation status

Gate, output lifecycle, direct TypeSafe client, locked session state, coordinated cache, CLI, skill, packaging, and opt-in real API tests are implemented. Generated `dist/` files ship with plugin and must match a fresh TypeScript build.

## Sources read

- Pi reference source: https://github.com/y0usaf/pi-jev/tree/main/src
- Pi reference README: https://github.com/y0usaf/pi-jev/blob/main/README.md
- Claude hooks reference: https://code.claude.com/docs/en/hooks
- Claude plugin guide: https://code.claude.com/docs/en/plugins
- TypeSafe HTTP API reference: https://docs.typesafe.ai/api
- TypeSafe primitives: https://docs.typesafe.ai/primitives
- TypeSafe confidence: https://docs.typesafe.ai/confidence
- TypeSafe JavaScript SDK reference: https://docs.typesafe.ai/sdk/javascript.md
