---
name: jev
description: TypeSafe Jev semantic judgments, question types, manual checks, and session controls.
---

# TypeSafe Jev Skill

This skill guides the use of TypeSafe Jev for semantic reasoning, manual checks, and session-level controls via the `claude-jev` CLI.

## Key Principles & Native Replacement

- **Automatic judgments come from hooks**: The plugin automatically runs pre-tool gates (`PreToolUse` for Bash, Write, Edit) and post-tool output verification (`PostToolUse`, `PostToolUseFailure` for Bash). You do not need to invoke Jev for routine tool calls.
- **Do not reimplement automatic gate logic**: Never manually simulate or duplicate hook gate evaluation in prompt text.
- **Closest native replacement for Pi jev_ask**: In Claude Code, the namespaced skill and bundled CLI (`bin/claude-jev`) provide the closest native replacement for Pi's `jev_ask` tool.
- **Confidence is not authorization**: A high-confidence Jev verdict is semantic guidance, not security authorization or user consent. Never bypass permissions or assume authorization based on Jev confidence.
- **No Jev for deterministic calculations or exact lookups**: Never call Jev for mathematical arithmetic, regex matching, exact string lookups, or deterministic file searches. Use standard code and tools for deterministic tasks.

## When Explicit Jev Judgments Help

Explicit judgments via `claude-jev check <text>` help when:
1. Evaluating semantic ambiguity in user requests or command safety.
2. Assessing risk, scope creep, or exfiltration potential before proposing complex command sequences.
3. Classifying unstructured human intent or diagnostic output that lacks deterministic rules.

## Question Types: Noul vs Choice vs Score

TypeSafe System One evaluates three typed question primitives:

1. **Noul (`type: "noul"`)**:
   - Binary semantic probability between 0.0 and 1.0.
   - Evaluates whether a statement is true or false according to specified criteria.
   - Example: `destructive` (data deletion or history rewriting) and `exfiltration` (secret or data transfer).
   - Noul returns a single probability (`noul`), without separate confidence.

2. **Choice (`type: "choice"`)**:
   - Selects one discrete category from mutually exclusive options.
   - Returns selected `choice`, probability distribution `probabilities`, and overall `confidence` (0.0 to 1.0).
   - Example: `failure_class` classifying failures as `transient`, `environment`, `code_bug`, `permission`, `user_error`, or `no_failure`.

3. **Score (`type: "score"`)**:
   - Evaluates an ordinal or continuous severity score against graduated criteria (0 to N).
   - Returns numerical `score`, `legend`, `probabilities`, and `confidence` (0.0 to 1.0).
   - Example: `impact` rated 0 (none), 1 (small), 2 (large), or 3 (severe).

## Batching Independent Questions

Always batch independent questions into a single request. TypeSafe evaluates questions in parallel in one batched call. Never make sequential individual calls for questions that can be answered together.

## CLI Usage & Session Controls

The CLI is located at `bin/claude-jev`. Exact session toggles need `--session-id` because Claude skills run in separate subprocesses from hooks.

### Commands

- `claude-jev status [--session-id <id>]`:
  Display global configuration, gate/output status, and session overrides. Without `--session-id`, session state is reported as unknown.
- `claude-jev enable --session-id <id>`:
  Enable Jev gate for the current session. Requires `--session-id`. Writes session state only, never config files.
- `claude-jev disable --session-id <id>`:
  Disable Jev gate for the current session. Requires `--session-id`. Writes session state only, never config files.
- `claude-jev mode <shadow|enforce> --session-id <id>`:
  Set gate mode to `shadow` (warn only) or `enforce` (ask user for permission on flags). Requires `--session-id`. Writes session state only.
- `claude-jev last --session-id <id>`:
  Show concise summary of the last pre-tool gate verdict.
- `claude-jev output --session-id <id>`:
  Show concise summary of the last post-tool output verdict.
- `claude-jev check "<command or text>"`:
  Run a manual pre-tool check on the specified text using the four standard gate questions (`destructive`, `exfiltration`, `beyond_scope`, `impact`).
