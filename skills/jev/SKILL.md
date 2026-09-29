---
name: jev
description: TypeSafe Jev semantic judgments, manual checks, and advanced session controls.
---

# TypeSafe Jev

Use automatic hooks for routine Bash, Write, and Edit judgments. Do not reimplement automatic gate logic in prompt text or run a second manual check for every tool call.

Confidence is not authorization or user consent. TypeSafe confidence is semantic guidance. Never use a Jev result to bypass Claude Code permissions.

## When explicit judgments help

`claude-jev check` is closest native replacement for Pi's `jev_ask`. Use a manual check for ambiguous text or a proposed command that is not already passing through automatic hooks:

```bash
claude-jev check "command or text to judge"
```

Useful cases:

- ambiguous destructive effect;
- possible transfer of local data or credentials;
- uncertain scope relative to user request;
- unstructured diagnostic classification.

Do not call Jev for arithmetic, regex matching, exact lookups, deterministic file searches, or facts available through ordinary tools.

Manual check sends bounded text and current directory to TypeSafe. Do not pass material user did not consent to send externally.

## Question types

### Noul

Binary semantic probability from 0 to 1. Noul answer uses `noul` and has no separate confidence field.

Example uses: destructive action, exfiltration, secret in output.

### Choice

One category selected from declared options. Answer includes `choice`, complete `probabilities`, and `confidence`.

Example use: classify failure as `transient`, `environment`, `code_bug`, `permission`, `user_error`, or `no_failure`.

### Score

Probability-weighted value across ordered criteria. Answer includes `score`, `legend`, complete `probabilities`, and `confidence`.

Example use: impact from 0, no damage, through 3, severe damage.

Batch independent questions into one TypeSafe request. Do not make sequential requests for questions about same state.

## User-requested decisions

When the user asks for help with a decision and wants custom questions, use `/claude-jev:decide`. That skill asks follow-up questions, confirms what leaves the machine, and sends one `claude-jev ask` request. Do not use manual checks for that purpose.

## Automatic hooks

- `PreToolUse` judges configured Bash, Write, and Edit inputs.
- `PostToolUse` judges successful Bash output.
- `PostToolUseFailure` judges failed Bash output.
- Infrastructure failures fail open.
- Plugin never returns `allow` based on TypeSafe confidence.
- Successful output replacement affects what Claude sees, not command effects or prior telemetry.

## Status and advanced session controls

```bash
claude-jev status [--session-id <id>]
claude-jev last --session-id <id>
claude-jev output --session-id <id>
claude-jev enable --session-id <id>
claude-jev disable --session-id <id>
claude-jev mode <shadow|enforce> --session-id <id>
```

These are advanced controls. Claude skill subprocesses do not receive documented hook session ID. Exact inspection and toggles require explicit `--session-id` and may require `--scratchpad-dir` to reach hook state. Without session ID, `status` reports session state as unknown.

Session controls modify session state only. They do not edit global or project configuration.
