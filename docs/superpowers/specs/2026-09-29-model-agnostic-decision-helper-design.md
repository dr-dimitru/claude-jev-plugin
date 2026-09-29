# Model-agnostic decision helper design

## Goal

Keep Jev as the default TypeSafe model, make model selection a user-level configuration choice, and let Claude use custom typed TypeSafe questions to support decisions beyond the plugin's fixed safety judgments.

The decision helper runs on demand. Claude asks the user for missing goals or constraints, composes a bounded question set, sends one request to TypeSafe, then weighs the typed answers against known facts. TypeSafe informs Claude's recommendation; it does not make the decision or authorize tools.

## Current state

- `src/client.ts` accepts a model string and sends it to TypeSafe System One. The default is `jev-latest`.
- `src/config.ts` reads `model` from trusted global config. Project config cannot set model or endpoint.
- The request and response types, functions, and errors use Jev-specific names.
- Automatic hooks use fixed question maps for tool safety and output judgments.
- `claude-jev check` also uses fixed gate questions. There is no public command for custom typed questions.
- The existing hook cache keys include model and question definitions.

## Model selection

Keep the existing `model` field in `~/.claude/claude-jev.json`; Jev remains the default. Document the supported Jev, Laua, and Kev model identifiers after confirming their exact TypeSafe IDs. Continue accepting a non-empty model ID instead of adding a closed allowlist, so adding a TypeSafe model does not require a client change.

Keep model selection in trusted user config. Do not add a project-config model override, per-request CLI override, or automatic model routing. Keep endpoint and credential controls unchanged.

Make client and wire-type names model-neutral, such as `askTypeSafe`, `TypeSafeQuestion`, and `TypeSafeResponse`. Preserve existing Jev-named exports as deprecated aliases so package consumers do not break. Keep the integration specific to TypeSafe System One; do not add adapters for unrelated model providers.

## Decision helper skill

Add a `/claude-jev:decide` skill alongside the existing `/claude-jev:jev` skill. Link to it from the Jev skill and plugin documentation.

The skill applies when the user requests help choosing, or when Claude reaches a consequential choice with meaningful uncertainty. It does not run for every tool call or deterministic work such as arithmetic and exact lookups.

Before a TypeSafe request, Claude:

1. States the decision and relevant alternatives.
2. Checks whether the user's goals, constraints, or risk preferences are missing. It asks the user focused follow-up questions when needed.
3. Builds a minimal state object and a set of independent questions that fit the decision.
4. Sends only decision-relevant context. It does not send conversation history. It avoids secrets and asks before sending sensitive details.
5. Explains the validated TypeSafe results, including uncertainty, and gives its own recommendation. It does not present TypeSafe's output as fact or user consent.

The skill tells Claude to use the configured model, batch questions about the same decision into one request, and report when no valid TypeSafe judgment is available. It must not treat a failed request as a clear result or switch models automatically.

## Custom question command

Add `claude-jev ask`. It reads one JSON object from stdin with this shape:

```json
{
  "state": {
    "decision": "Which option best fits the user's constraints?",
    "options": ["Option A", "Option B"],
    "constraints": ["Relevant user-provided facts"]
  },
  "questions": {
    "option_a_fit": {
      "type": "score",
      "instructions": "How well does Option A fit the stated constraints?",
      "criteria": ["Poor fit", "Mixed fit", "Strong fit"]
    },
    "option_b_fit": {
      "type": "score",
      "instructions": "How well does Option B fit the stated constraints?",
      "criteria": ["Poor fit", "Mixed fit", "Strong fit"]
    }
  }
}
```

`state` is JSON data. `questions` must contain one or more uniquely named Noul, Score, or Choice question definitions supported by the TypeSafe API. The command uses the configured model, endpoint, key, deadline, and retry policy. It does not accept a model override.

The command validates the input before sending it. Bound total input size to 64 KiB, state size to configured `maxStateChars`, and question count to 32. Validate each question's required fields and criteria shape. Reject unknown question types and malformed definitions. The cap limits accidental cost and aligns with the current TypeSafe question-map interface.

The command sends one request containing the configured model, state, and all questions. It validates each answer against its declared question, including answer type, criteria keys, finite values, and complete probability distributions. It returns machine-readable JSON containing the model, usage when supplied, and validated answers. It writes errors to stderr and exits nonzero when input or the TypeSafe response is invalid or unavailable. It never fabricates answers.

The existing hook questions, thresholds, cache behavior, and permission decisions remain unchanged.

## Privacy and trust boundaries

Decision state and custom questions leave the user's machine and go to TypeSafe. The skill sends only the minimum details needed for the decision, never a transcript. It warns against including secrets and asks for confirmation before sending sensitive details. Existing endpoint, key, and project-config restrictions remain in force.

TypeSafe results are semantic evidence, not authorization, consent, or ground truth. The helper cannot return Claude Code permission decisions and cannot change automatic hook behavior. If TypeSafe is unavailable or returns an invalid answer, Claude continues its ordinary reasoning and clearly reports that no TypeSafe judgment was available.

## Documentation

Update the README and TypeSafe integration guide to cover:

- User-level `model` configuration, Jev default, and verified Laua/Kev IDs.
- `claude-jev ask` JSON input and output, supported question types, and limits.
- The `/claude-jev:decide` skill's on-demand workflow and user follow-up behavior.
- The external data and cost implications of custom decision context.
- The advisory-only boundary between TypeSafe results and Claude's final recommendation.

## Tests

- Verify the default model remains Jev and configured model IDs reach the request unchanged.
- Verify Jev-named exports remain compatible with the model-neutral client API.
- Test valid and invalid Noul, Score, and Choice question definitions.
- Test stdin parsing, size and question-count bounds, configured model use, JSON output, and nonzero failures in `claude-jev ask`.
- Test response validation against custom question names, types, criteria, probabilities, and confidence values.
- Keep tests deterministic with local fetch fixtures; real API tests remain opt-in.
- Run typecheck, build, unit tests, plugin validation, and package dry-run.

## Release prerequisite

Confirm the exact TypeSafe model IDs for Laua and Kev and verify that each returns the same System One typed-answer contract before documenting them as supported choices. Jev remains the configured default; if a selected alternate model is unavailable or incompatible, the command reports the error rather than silently falling back.
