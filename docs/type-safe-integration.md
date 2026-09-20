# TypeSafe AI integration overview

`claude-jev-plugin` inserts TypeSafe System One judgments into Claude Code's hook lifecycle. TypeSafe is an external semantic classifier. It does not replace Claude, grant permissions, or run an MCP server.

## Architecture

```mermaid
flowchart LR
    U[User] --> C[Claude Code]
    C --> H[claude-jev command hook]
    H --> B[Validate and bound state locally]
    B --> T[TypeSafe System One API]
    T --> V[Typed answers]
    V --> L[Local threshold evaluation]
    L --> C
    H -. no MCP .-> N[No persistent plugin process]
```

Claude starts a short-lived Node.js process for every matching hook event. Event JSON arrives on stdin. Hook writes either no output or one Claude-compatible JSON object to stdout.

Hook configuration uses exec form:

```json
{
  "type": "command",
  "command": "node",
  "args": ["${CLAUDE_PLUGIN_ROOT}/dist/hooks/pre-tool.js"],
  "timeout": 20
}
```

Tool input remains process data and is never interpolated into shell source.

## Activation

Plugin installs disabled by default because activation sends bounded data to an external service and may incur TypeSafe API cost.

```text
/plugin marketplace add dr-dimitru/claude-plugins-marketplace
/plugin install claude-jev@dr-dimitru-claude-tools --scope user
```

Set key outside project configuration:

```bash
export TYPESAFE_API_KEY="..."
```

Then enable and reload:

```text
/plugin enable claude-jev@dr-dimitru-claude-tools
/reload-plugins
```

Claude discovers four handlers:

```mermaid
flowchart TD
    A[Plugin enabled] --> B[Load hooks/hooks.json]
    B --> U[UserPromptSubmit]
    B --> P[PreToolUse]
    B --> S[PostToolUse]
    B --> F[PostToolUseFailure]
    U --> U1[Store bounded current request]
    P --> P1[Judge proposed Bash, Write, or Edit]
    S --> S1[Judge successful Bash output]
    F --> F1[Judge failed Bash output]
```

Automatic hooks do not require skill invocation.

## TypeSafe request

Plugin sends one HTTPS request for all independent questions about one state:

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
Content-Type: application/json
```

```json
{
  "model": "jev-latest",
  "state": {"tool": "Bash", "tool_input": {"command": "git status"}},
  "questions": {
    "destructive": {
      "type": "noul",
      "instructions": "Is this action destructive?"
    }
  }
}
```

Response must contain model, usage, and one typed answer per question. Plugin rejects missing answers, unknown options, incomplete distributions, invalid score legends, non-finite numbers, and probabilities that do not sum to one.

## Question primitives

### Noul

Noul answers a yes/no semantic question as probability from 0 to 1:

```json
{"type": "noul", "noul": 0.96}
```

Noul has no separate confidence value. Plugin uses it for destructive action, exfiltration, scope, and secret detection.

### Choice

Choice selects one declared category and returns full distribution:

```json
{
  "type": "choice",
  "choice": "environment",
  "probabilities": {
    "transient": 0.05,
    "environment": 0.80,
    "code_bug": 0.05,
    "permission": 0.05,
    "user_error": 0.03,
    "no_failure": 0.02
  },
  "confidence": 0.76
}
```

Plugin uses Choice to classify Bash failures.

### Score

Score rates state across ordered criteria:

```json
{
  "type": "score",
  "score": 2.8,
  "legend": {
    "0": "None, it only reads",
    "1": "Small, one file or one reversible change",
    "2": "Large, many files or shared state",
    "3": "Severe, data loss or a forced overwrite of shared history"
  },
  "probabilities": {"0": 0.0, "1": 0.0, "2": 0.2, "3": 0.8},
  "confidence": 0.84
}
```

TypeSafe supplies typed semantic evidence. Local plugin code decides whether configured thresholds were crossed.

## Related guides

- [Pre-tool judgments](pre-tool-judgments.md)
- [Output judgments](output-judgments.md)
- [Reliability and privacy](reliability-and-privacy.md)
- [End-to-end example](end-to-end-example.md)
