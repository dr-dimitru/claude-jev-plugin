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

Keep the existing `model` field in `~/.claude/claude-jev.json`; Jev remains the default. Continue accepting a non-empty model ID instead of adding a closed allowlist, so adding a TypeSafe model does not require a client change.

Verified on 2026-09-29 from https://docs.typesafe.ai/models: the hosted model ID is `jev-1.13.0`, and the aliases `jev-latest` and `jev-preview` both point to it. The response `model` field reports the versioned ID that answered. Two open-weight models are documented as local alternatives, verified on 2026-09-29 from each repository README. Neither is served by TypeSafe, and both are assumed to run locally.

- Kev (https://github.com/jaredpalmer/kev) is an Apache-2.0 community model by Jared Palmer. Start it with `uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009`. It binds `127.0.0.1` by default over plain HTTP and serves `POST /v1/systemone` with the TypeSafe wire contract. The request model example is `kev-latest`, and the response echoes the requested model. Checkpoints are `jaredpalmer/kev-0.8b`, `kev-4b`, `kev-9b`, and `kev-27b`. Auth is optional and applies only when the server sets `KEV_API_KEY`. The response adds `latency_ms`, which the plugin drops.
- Laya (https://github.com/NandhaKishorM/laya) is an Apache-2.0 model by Convai Innovations. Start it with `LAYA_DEVICE=cuda LAYA_PRELOAD=1 laya-serve`. It binds `0.0.0.0:8000` by default over plain HTTP, so it is reachable from the network. Users should restrict it with a firewall or bind it to loopback if their setup allows. It serves `POST /v1/systemone` with the TypeSafe Jev wire protocol. Models are `english`, `multilingual`, and `typed-decisions`, and the response `model` is the checkpoint name. Answers omit `type` and add `answer_confidence`. The plugin takes the type from the declared question and drops `answer_confidence`. Choice allows up to 100 options on Laya, and the plugin cap stays at 20. Every score level needs a description, and plugin score criteria are always strings. Auth is optional and applies only when the server sets `LAYA_API_KEY`. Laya's README shows only the choice response shape, so noul and score responses are unverified.

Local endpoint rules:

- A local endpoint has hostname `localhost`, `127.x.x.x`, or `[::1]`. Plain `http:` is allowed only for local endpoints. All others must use HTTPS.
- Endpoint and model come only from trusted global `~/.claude/claude-jev.json`. Project config cannot set them.
- A local endpoint needs no API key, and the client sends no Authorization header without one. `TYPESAFE_API_KEY` is never sent to a local endpoint. A key for a local server goes in the global `apiKeyFile`.
- The family check ignores an `org/` prefix, so `jaredpalmer/kev-4b` and `kev-latest` are both family `kev`. Laya names are their own families: `english`, `multilingual`, and `typed`.
- With a local model, state and questions stay on the machine and TypeSafe does not bill them. Hooks and `claude-jev ask` still send the same data to that local process.
- `claude-jev status` shows `Endpoint: local` or `Endpoint: remote` and says the key is not required for a local endpoint.

Example global configuration:

```json
{ "model": "kev-latest", "endpoint": "http://127.0.0.1:8009/v1/systemone" }
```

```json
{ "model": "english", "endpoint": "http://127.0.0.1:8000/v1/systemone" }
```

The documentation lists the verified Jev IDs as hosted IDs and describes Kev and Laya only as local alternatives.

The client checks the response model family, which is the lowercase text before the first `-`. It accepts `jev-1.13.0` for a `jev-latest` request and rejects a cross-family answer, such as `kev-latest` for a `jev-latest` request, with `MODEL_MISMATCH`. This is how the client detects a server-side substitution without failing on resolved aliases.

Keep model selection in trusted user config. Do not add a project-config model override, per-request CLI override, or automatic model routing. Keep endpoint and credential controls unchanged.

Make client and wire-type names model-neutral, such as `askTypeSafe`, `TypeSafeQuestion`, and `TypeSafeResponse`. Preserve existing Jev-named exports as deprecated aliases so package consumers do not break. Keep the integration specific to TypeSafe System One; do not add adapters for unrelated model providers.

## Decision helper skill

Add a `/claude-jev:decide` skill alongside the existing `/claude-jev:jev` skill. Link to it from the Jev skill and plugin documentation.

The skill runs only when the user asks for help with a decision. Its frontmatter sets `disable-model-invocation: true`, so Claude cannot start it on its own, even for a consequential choice. It does not run for tool calls or deterministic work such as arithmetic and exact lookups.

Before a TypeSafe request, Claude:

1. States the decision and relevant alternatives.
2. Checks whether the user's goals, constraints, or risk preferences are missing. It asks the user focused follow-up questions when needed.
3. Builds a minimal state object and a set of independent questions that fit the decision.
4. Shows the user a summary of the state and questions and asks for confirmation before every request. It flags sensitive details explicitly. It sends only decision-relevant context, never conversation history or secrets.
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

The command validates the input before sending it. Bound total input size to 64 KiB of UTF-8, serialized state to configured `maxStateChars` characters, and question count to 32. Question names match `^[A-Za-z][A-Za-z0-9_]{0,63}$` and exclude prototype names. Instructions are at most 2000 characters and each criterion at most 500. Score takes 2 to 10 criteria, the range the TypeSafe API accepts. Choice takes 2 to 20 criteria. The API allows 255, but two-decimal rounding can move a probability sum by up to 0.005 per category, so the plugin caps Choice at 20. Response validation accepts a sum within `max(0.05, categories x 0.005)` of 1 and renormalizes. Reject unknown question types, unknown fields, and malformed definitions. The caps limit accidental cost and keep the response sum check meaningful.

The command accepts no arguments or flags, so nothing on the command line can override the configured model or endpoint. The `check` command's former `--endpoint` flag is removed for the same reason.

The command sends one request containing the configured model, state, and all questions. It validates each answer against its declared question, including answer type, criteria keys, finite values, and complete probability distributions. It returns machine-readable JSON containing the answering model, usage token counts, and validated answers. The TypeSafe API reference states that `usage` is always present, so a response without it is malformed. The client drops unrequested response fields. Errors go to stderr as a fixed category, code, HTTP status, and model, never response bodies, state, or question text. The command exits 2 for invalid input without sending a request and 1 when TypeSafe or configuration fails. It never fabricates answers.

The existing hook questions, thresholds, cache behavior, and permission decisions remain unchanged.

## Privacy and trust boundaries

Decision state and custom questions leave the user's machine and go to TypeSafe. The skill sends only the minimum details needed for the decision, never a transcript. It warns against including secrets and asks for confirmation before sending sensitive details. Existing endpoint, key, and project-config restrictions remain in force.

TypeSafe results are semantic evidence, not authorization, consent, or ground truth. The helper cannot return Claude Code permission decisions and cannot change automatic hook behavior. If TypeSafe is unavailable or returns an invalid answer, Claude continues its ordinary reasoning and clearly reports that no TypeSafe judgment was available.

## Documentation

Update the README and TypeSafe integration guide to cover:

- User-level `model` configuration, Jev default, and the verified Jev IDs.
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

Resolved on 2026-09-29 for Jev: `jev-1.13.0`, `jev-latest`, and `jev-preview` are documented. Kev and Laya are documented as local alternatives with the facts and endpoint rules above, not as hosted IDs. Jev remains the configured default. If a selected model is unavailable or answers from another family, the command reports the error rather than silently falling back.
