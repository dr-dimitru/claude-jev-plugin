---
name: decide
description: Use when the user asks for help choosing between meaningful alternatives or Claude faces a consequential choice with uncertainty.
---

# Decide with TypeSafe

Use this skill on demand for a consequential choice with meaningful uncertainty. Do not use it for every tool call, arithmetic, exact lookups, or deterministic work.

## Gather the decision

State the decision and its realistic alternatives. Check whether the user's goals, constraints, or risk preferences are missing. Ask focused follow-up questions before requesting a TypeSafe judgment when the answer could change the recommendation.

Before sending a request, explain that its state and questions go to the configured TypeSafe endpoint and may incur API cost. Send only details needed for this decision. Never send conversation history. Leave out secrets and sensitive details. If a sensitive detail is necessary, describe what would be sent and ask the user to confirm before including it.

## Build one bounded request

Create one minimal `state` value and one or more independent questions about that same state. `claude-jev ask` sends all questions in one request. Input must stay within 64 KiB, serialized state must stay within configured `maxStateChars` (8,000 by default), and a request can contain at most 32 questions.

Use Noul for a yes or no probability, Score for an ordered rubric, and Choice for one option among named categories. Example:

```bash
claude-jev ask <<'JSON'
{
  "state": {
    "decision": "Which option best fits the user's constraints?",
    "options": ["Option A", "Option B"],
    "constraints": ["Keep existing user data intact."]
  },
  "questions": {
    "option_a_fit": {
      "type": "score",
      "instructions": "How well does Option A fit the stated constraints?",
      "criteria": ["Poor fit", "Mixed fit", "Strong fit"]
    },
    "option_b_safe": {
      "type": "noul",
      "instructions": "Can Option B preserve the user's existing data?"
    },
    "best_option": {
      "type": "choice",
      "instructions": "Which option best fits the stated constraints?",
      "criteria": {
        "option_a": "Choose Option A.",
        "option_b": "Choose Option B."
      }
    }
  }
}
JSON
```

The command uses the model, endpoint, key, deadline, and retry settings from trusted user configuration. Jev remains the default model. Do not pass `--model` or `--endpoint`; the command rejects per-request overrides.

## Explain the result

The command writes JSON with the resolved model, usage when supplied, and validated answers. Explain the useful answer fields and uncertainty. Give Claude's own recommendation against the user's goals and constraints.

Treat TypeSafe results as advisory evidence. They are not facts, user consent, or permission to use a tool. If the request fails or returns an invalid answer, report that no TypeSafe judgment is available. Continue with ordinary reasoning, do not call another model automatically, and do not invent answers.
