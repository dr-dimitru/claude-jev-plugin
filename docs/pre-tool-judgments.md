# Pre-tool judgments

Claude Code invokes `PreToolUse` before configured Bash, Write, and Edit calls. Plugin asks TypeSafe about semantic risk, validates answers, and applies local thresholds.

## Capturing current user intent

`PreToolUse` does not include current prompt. `UserPromptSubmit` stores first 1,200 Unicode code points when gate is enabled, session is not disabled, and TypeSafe key exists.

```mermaid
sequenceDiagram
    participant User
    participant Claude as Claude Code
    participant Prompt as UserPromptSubmit hook
    participant State as Session state

    User->>Claude: Only update tests
    Claude->>Prompt: prompt, cwd, session_id
    Prompt->>Prompt: Validate event and effective config
    Prompt->>State: Store bounded prompt prefix
    Prompt-->>Claude: No output
```

**ASCII version**

```text
User                  Claude Code        UserPromptSubmit       Session state
 |                            |                    |                      |
 |-- "Only update tests" --->|                    |                      |
 |                            |---- prompt ------->|                      |
 |                            |                    |-- validate config -->|
 |                            |                    |-- store 1,200 chars->|
 |                            |<--- no output -----|                      |
```


Plugin never reads full transcript for this purpose.

## Judgment sequence

```mermaid
sequenceDiagram
    participant Claude as Claude Code
    participant Hook as PreToolUse hook
    participant Cache as Session cache
    participant TS as TypeSafe API
    participant User

    Claude->>Hook: Proposed tool call
    Hook->>Hook: Validate payload and load config
    Hook->>Hook: Build bounded gate state
    Hook->>Cache: Look up exact judgment key
    alt Cache hit
        Cache-->>Hook: Validated verdict
    else Cache miss
        Hook->>TS: State plus four questions
        TS-->>Hook: Typed answers
        Hook->>Hook: Validate answers and apply thresholds
        Hook->>Cache: Store verdict
    end
    alt Clear
        Hook-->>Claude: No decision
    else Shadow flag
        Hook-->>Claude: systemMessage warning
    else Enforce flag
        Hook-->>Claude: permissionDecision ask
        Claude->>User: Native permission prompt
    end
```

**ASCII version**

```text
Claude Code        PreToolUse hook        Session cache       TypeSafe       User
     |                       |                       |                 |             |
     |-- proposed call ----->|                       |                 |             |
     |                       |-- validate + bound -->|                 |             |
     |                       |-- lookup exact key ->|                 |             |
     |                       |<----- hit ------------|                 |             |
     |                       |                                         |             |
     |                       |-- on miss: state + 4 questions -------->|             |
     |                       |<------------- typed answers ------------|             |
     |                       |-- validate + thresholds                 |             |
     |                       |-- cache verdict ----->|                 |             |
     |                       |                                         |             |
     |<-- clear: no output --|                                         |             |
     |<-- shadow: warning ---|                                         |             |
     |<-- enforce: ask ------|------------------------------------------------------>|
     |<------------------------------------------------ user decision ---------------|
```


## State sent to TypeSafe

Example Write call:

```json
{
  "cwd": "/project",
  "tool": "Write",
  "tool_input": {
    "file_path": "/project/src/auth.ts",
    "content": "first 400 characters…[N chars elided]"
  },
  "user_request": "Only update authentication tests"
}
```

Default limits:

| Value | Limit |
| --- | ---: |
| Each tool-input string | 400 characters |
| Current user request | 1,200 characters |
| Complete serialized state | 8,000 characters |

State excludes session ID, agent ID, transcript path, permission mode, API key, and unrelated conversation.

## Four questions

```mermaid
flowchart LR
    S[One bounded action] --> D[destructive<br/>Noul]
    S --> E[exfiltration<br/>Noul]
    S --> B[beyond_scope<br/>Noul]
    S --> I[impact<br/>Score]
```

**ASCII version**

```text
                         [One bounded action]
                                  |
          +----------------+------+-------+----------------+
          |                |              |                |
          v                v              v                v
[destructive/Noul] [exfiltration/Noul] [beyond_scope/Noul] [impact/Score]
```


| ID | Meaning | Default threshold |
| --- | --- | ---: |
| `destructive` | Deletes, overwrites, or rewrites shared history | `0.90` |
| `exfiltration` | Sends local data or secrets outside project tooling | `0.70` |
| `beyond_scope` | Affects anything outside user request | `0.85` |
| `impact` | Damage if action was unwanted | `2.50`, confidence at least `0.50` |

Any crossed threshold flags action.

```mermaid
flowchart TD
    R[Validated answers] --> D{destructive ≥ 0.90?}
    R --> E{exfiltration ≥ 0.70?}
    R --> B{beyond_scope ≥ 0.85?}
    R --> I{impact ≥ 2.50 and confidence ≥ 0.50?}
    D -->|yes| F[Flag]
    E -->|yes| F
    B -->|yes| F
    I -->|yes| F
```

**ASCII version**

```text
[Validated TypeSafe answers]
              |
  +-----------+------------+-------------+
  |           |            |             |
  v           v            v             v
destructive exfiltration beyond_scope   impact
 >= 0.90?    >= 0.70?      >= 0.85?     >= 2.50 and confidence >= 0.50?
  |           |            |             |
  +----- yes--+----- yes ---+----- yes ---+
              |
              v
          [Flag action]
```


## Shadow mode

Default shadow mode returns warning and does not approve or deny:

```json
{
  "systemMessage": "claude-jev shadow: Bash flagged (destructive 0.96, impact 2.80/3)"
}
```

## Enforce mode

Interactive case returns native ask decision:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "claude-jev flagged Bash: destructive 0.96, impact 2.80/3"
  }
}
```

Plugin never returns `allow` from TypeSafe confidence.

Claude hook payload has no universal prompt-host field. Plugin recognizes documented non-interactive `permission_mode` values `dontAsk` and `bypassPermissions`:

- `blockWithoutUI: false`: no decision, fail open;
- `blockWithoutUI: true`: return `deny`.

Other modes return `ask`; Claude Code owns prompt-host behavior.

## Related guides

- [Integration overview](type-safe-integration.md)
- [Output judgments](output-judgments.md)
- [Reliability and privacy](reliability-and-privacy.md)
