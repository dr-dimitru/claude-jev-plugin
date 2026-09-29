---
name: decide
description: Get TypeSafe semantic evidence for a decision. Runs only when the user asks for help with a decision.
disable-model-invocation: true
---

# Decide with TypeSafe evidence

User invokes this skill with `/claude-jev:decide`. Claude never starts it on its own.

TypeSafe output is evidence. It is not fact, user consent, or authorization. Claude gives its own recommendation, labeled as advisory. The user makes the final decision.

## When not to use

Do not call TypeSafe for arithmetic, exact lookups, deterministic checks, or routine tool calls. Answer those with ordinary tools.

## Workflow

1. State the decision and the alternatives in one or two sentences.
2. Ask the user focused follow-up questions for any missing goals, constraints, or risk preferences. Ask only what changes the answer. Wait for replies.
3. Build minimal state: the facts each question needs. Do not include conversation history, transcripts, credentials, tokens, or other secrets.
4. Show the user a summary of exactly what will be sent to TypeSafe and ask for confirmation. Do this every time, before anything is sent. Flag sensitive details explicitly, such as names, customer data, internal URLs, or business figures. Drop or generalize any detail the user does not approve.
5. After confirmation, batch all questions for the decision into one `claude-jev ask` call. Send JSON on stdin.
6. Interpret the validated answers with uncertainty. Report confidence and probabilities, not only the top result.
7. Give Claude's own recommendation, labeled as advisory. Say where it agrees or differs from TypeSafe and why.

## Request

`claude-jev ask` takes no arguments or flags. It reads one JSON object with `state` and `questions`, sends one request, and prints JSON with `model`, `usage`, and `answers`.

```bash
claude-jev ask <<'JSON'
{
  "state": {
    "decision": "Choose a queue for background jobs",
    "options": {"redis": "Already deployed, no durability tuning", "postgres": "One less service, slower at high volume"},
    "constraints": ["team of two", "under 200 jobs per minute"]
  },
  "questions": {
    "durability_risk": {
      "type": "noul",
      "instructions": "Is job loss a serious risk for the redis option?"
    },
    "ops_burden": {
      "type": "score",
      "instructions": "How much operational work does the postgres option add?",
      "criteria": ["None", "Low", "Moderate", "High"]
    },
    "best_fit": {
      "type": "choice",
      "instructions": "Which option fits the constraints best?",
      "criteria": {"redis": "Use Redis", "postgres": "Use Postgres"}
    }
  }
}
JSON
```

Question types:

- `noul`: binary semantic probability. `criteria` is optional and may only use the keys `true` and `false`.
- `score`: 2 to 10 ordered criteria, given as an array of strings. Answer includes `score`, `legend`, `probabilities`, and `confidence`.
- `choice`: 2 to 20 options, given as an object of option to description. Answer includes `choice`, `probabilities`, and `confidence`.

Limits:

- Input is at most 64 KiB (UTF-8 bytes).
- Serialized `state` is at most `maxStateChars` (default 8000).
- 1 to 32 questions.
- Question names match `^[A-Za-z][A-Za-z0-9_]{0,63}$`.
- `instructions` is at most 2000 characters. Each criterion is at most 500 characters.

State and questions go to the configured model's server, either TypeSafe or a local server. TypeSafe bills each request it serves. Retries resend the full body.

## Exit codes

- `0`: success. Read `answers`.
- `2`: invalid input. No request was sent. Fix the request and confirm any changed content again.
- `1`: TypeSafe or configuration error. Errors show only a fixed category, code, HTTP status, and model.

On any nonzero exit, tell the user no TypeSafe judgment was available and continue with ordinary reasoning. Do not retry with another model. There is no automatic model fallback, and the model comes from trusted global configuration only. Never invent answers.

## Reporting

Lead with the decision and Claude's advisory recommendation. Then list each TypeSafe answer with its probabilities and confidence. Note low confidence or close probabilities as real uncertainty. Ask the user which way to go.
