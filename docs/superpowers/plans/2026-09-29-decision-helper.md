# On-demand decision helper implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an on-demand Claude skill and CLI command that send Claude-authored typed questions to the configured TypeSafe model.

**Architecture:** Build a pure request parser and validator in `src/decision.ts`. Add `claude-jev ask` to read bounded JSON from stdin, call the model-neutral TypeSafe client, and return only validated typed results. Add a skill that gathers missing user context, constructs questions, and explains results without delegating the final decision.

**Tech Stack:** TypeScript 5.9, Node.js `>=22.6`, Node test runner, TypeSafe System One HTTPS API.

**Spec:** `docs/superpowers/specs/2026-09-29-model-agnostic-decision-helper-design.md`

**Dependency:** Complete `docs/superpowers/plans/2026-09-29-model-agnostic-client.md` first. This plan consumes its `askTypeSafe`, `TypeSafeQuestion`, and `TypeSafeResponse` exports.

## Global Constraints

- Use the configured user-level model; Jev remains the default, `jev-latest`.
- Do not add a per-request model override, project-config model override, or automatic model routing.
- The command accepts at most 64 KiB of JSON input, at most `maxStateChars` serialized state characters, and at most 32 questions.
- Batch questions about the same decision into one TypeSafe request.
- Do not send conversation history. Send only relevant bounded decision context.
- Ask the user before sending sensitive details.
- TypeSafe results are advisory evidence. They cannot authorize tools or make the final decision.
- Keep existing hook question maps, thresholds, cache behavior, and permission decisions unchanged.

## Review Focus

- UTF-8 input exactly at and just above the 64 KiB limit must be handled by byte count; test in `tests/decision.test.ts` and `tests/cli.test.ts`.
- Serialized state exactly at and just above `maxStateChars` must be handled correctly; test in `tests/decision.test.ts`.
- Exactly 32 questions must pass and 33 must fail before a request; test in `tests/decision.test.ts` and `tests/cli.test.ts`.
- Malformed question definitions and prototype-sensitive question names must be rejected without sending a request; test in `tests/decision.test.ts`.
- Unrequested TypeSafe response fields and submitted state must not appear in CLI JSON or error diagnostics; test in `tests/cli.test.ts`.

---

## File map

- `src/decision.ts`: input contract, size limits, question validation, and fixed local input errors.
- `bin/claude-jev`: bounded stdin read, `ask` command, configured client call, JSON output, and command-specific option rejection.
- `tests/decision.test.ts`: pure parser and validation tests.
- `tests/cli.test.ts`: subprocess, request-body, error, output, skill, and package tests.
- `skills/decide/SKILL.md`: Claude's on-demand decision workflow.
- `skills/jev/SKILL.md`: link existing manual-check guidance to the decision helper.
- `README.md`, `docs/type-safe-integration.md`, and `docs/reliability-and-privacy.md`: command, workflow, limits, costs, and data disclosure.
- `package.json`: modify only if package dry-run shows the new skill or updated documentation is not included; the existing `skills` directory is already packaged.

## Task 1: Validate bounded custom question input

**Files:**
- Create: `src/decision.ts`
- Test: `tests/decision.test.ts`

**Interfaces:**
- Consumes: `TypeSafeQuestion` from the model-neutral client plan.
- Produces:
  - `MAX_DECISION_INPUT_BYTES = 64 * 1024`.
  - `MAX_DECISION_QUESTIONS = 32`.
  - `DecisionRequest` with `state: unknown` and `questions: Record<string, TypeSafeQuestion>`.
  - `parseDecisionRequest(input: string, maxStateChars: number): DecisionRequest`.
  - `DecisionInputError` with fixed messages that never include submitted input.

- [ ] **Step 1: Write failing parser tests**

Create `tests/decision.test.ts`. Cover valid Noul, Score, and Choice definitions; invalid JSON; missing or extra top-level fields; missing state or questions; empty question maps; malformed instructions or criteria; unknown question types; prototype-sensitive question names; state-size boundaries; the 32/33 question boundary; and UTF-8 byte-size boundaries.

- [ ] **Step 2: Run parser tests to verify they fail**

Run: `node --experimental-strip-types --test tests/decision.test.ts`
Expected: FAIL because `src/decision.ts` does not exist.

- [ ] **Step 3: Implement request types and validation in `src/decision.ts`**

Parse exactly one `{ state, questions }` object. Reject unknown top-level properties, non-object question maps, zero questions, more than 32 questions, and question names `__proto__`, `constructor`, or `prototype`. Require non-empty instructions and reject unknown question properties. Noul criteria may be omitted; if present, require an object with optional `true` and `false` non-empty string values. Require Score criteria to be a non-empty array of non-empty strings. Require Choice criteria to be a non-empty object with non-empty category names and string-or-null descriptions; reject prototype-sensitive category names. Measure total serialized input with `Buffer.byteLength(input, "utf8")`; measure state using `JSON.stringify(state).length`. Throw fixed `DecisionInputError` messages without echoing input.

- [ ] **Step 4: Run parser tests and typecheck**

Run: `node --experimental-strip-types --test tests/decision.test.ts && npm run typecheck`
Expected: PASS for supported definitions, both sides of every size boundary, and malformed input rejection.

- [ ] **Step 5: Commit request validation**

```bash
git add src/decision.ts tests/decision.test.ts
git commit -m "feat: validate custom TypeSafe questions"
```

## Task 2: Add the `claude-jev ask` command

**Files:**
- Modify: `bin/claude-jev`
- Modify: `tests/cli.test.ts`
- Consume: `src/decision.ts` and model-neutral exports from Task 1 of the client plan

**Interfaces:**
- Consumes: `parseDecisionRequest(input, maxStateChars)`, `askTypeSafe(call)`, and `LoadedConfig`.
- Produces: `claude-jev ask`, reading one JSON request from stdin and writing JSON with only `model`, optional `usage`, and validated `answers` to stdout.

- [ ] **Step 1: Write failing CLI tests**

Add subprocess tests in `tests/cli.test.ts` for help output, a valid stdin request, one captured TypeSafe request containing all questions, configured-model propagation, JSON response output, missing API key, invalid input without a network call, oversized streamed input, selected-model failure without fallback, malformed response handling, and input/state exclusion from stdout and stderr. Assert `ask --model ...`, `ask --endpoint ...`, and `ask <positional>` fail rather than override transport config. Mock TypeSafe using the existing fetch fixture.

- [ ] **Step 2: Run CLI tests to verify the new command is absent**

Run: `npm run build && node --experimental-strip-types --test tests/cli.test.ts`
Expected: FAIL because `ask` is not a CLI command and its tests cannot receive the expected JSON result.

- [ ] **Step 3: Add a bounded stdin reader and `ask` command**

In `bin/claude-jev`, read stdin incrementally and stop after `MAX_DECISION_INPUT_BYTES`; do not buffer unbounded input. Add `ask` to help output. Update `parseArgs` to record `--model` even when it has no value, then reject positional arguments, `--model`, and `--endpoint` for `ask`. Load config, parse with `parseDecisionRequest`, and call `askTypeSafe` once with configured model, endpoint, key, timeout, and retries. Write only `{ model, usage?, answers }` as JSON. On errors, write a fixed local category and HTTP status when available; omit response bodies, submitted state, questions, and raw response fields. Exit nonzero without fabricating answers. Leave the existing `check` command behavior unchanged.

- [ ] **Step 4: Run CLI tests and typecheck**

Run: `npm run build && node --experimental-strip-types --test tests/cli.test.ts && npm run typecheck`
Expected: PASS. Invalid input makes no API request, valid input makes one request, and output contains only the documented response fields.

- [ ] **Step 5: Commit the CLI command**

```bash
git add bin/claude-jev tests/cli.test.ts
git commit -m "feat: add custom TypeSafe ask command"
```

## Task 3: Add the decision skill and documentation

**Files:**
- Create: `skills/decide/SKILL.md`
- Modify: `skills/jev/SKILL.md`, `README.md`, `docs/type-safe-integration.md`, `docs/reliability-and-privacy.md`
- Modify: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `claude-jev ask` JSON stdin and stdout contract from Task 2.
- Produces: `/claude-jev:decide` guidance for on-demand user follow-up, bounded custom questions, explicit sensitive-data handling, and advisory result synthesis.

- [ ] **Step 1: Write failing skill and documentation-link tests**

Add tests to `tests/cli.test.ts` that require a `skills/decide/SKILL.md` with `name: decide`, references to `claude-jev ask`, user follow-up questions, bounded context, sensitive-data confirmation, all three question types, and advisory-only result handling. Assert the Jev skill links to the decision skill and README links to updated docs.

- [ ] **Step 2: Run the skill tests to verify they fail**

Run: `node --experimental-strip-types --test tests/cli.test.ts`
Expected: FAIL because the decision skill and its links do not exist.

- [ ] **Step 3: Write the on-demand decision skill**

Create `skills/decide/SKILL.md`. Tell Claude when to use the helper, when not to use it, how to ask focused follow-up questions, how to build a minimal `{ state, questions }` JSON request over stdin, and how to report uncertainty and its own recommendation. Require disclosure and confirmation before sending sensitive details. Never send conversation history or treat failed requests as clear verdicts.

- [ ] **Step 4: Update plugin documentation**

Link the new skill from `skills/jev/SKILL.md`. Document CLI input/output, the 64 KiB, `maxStateChars`, and 32-question limits, one-request batching, TypeSafe cost and external data flow, configured-model use, and advisory-only behavior in README and the TypeSafe integration and reliability guides.

- [ ] **Step 5: Run skill, package, and full verification**

Run: `npm run check && npm run validate:plugin && npm pack --dry-run --json`
Expected: all checks pass, the package includes `skills/decide/SKILL.md`, and no new runtime dependency is added.

- [ ] **Step 6: Commit skill and documentation**

```bash
git add skills README.md docs tests/cli.test.ts
git commit -m "docs: add on-demand decision helper skill"
```
