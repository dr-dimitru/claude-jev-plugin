# TypeSafe model-neutral client implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the TypeSafe client model-neutral while keeping Jev as the default and preserving existing Jev-named exports.

**Architecture:** Keep the direct TypeSafe System One transport and current response contract. Add generic client and type names, then retain Jev names as deprecated aliases. Keep the existing user-config model field and its trust boundary.

**Tech Stack:** TypeScript 5.9, Node.js `>=22.6`, Node test runner, TypeSafe System One HTTPS API.

**Spec:** `docs/superpowers/specs/2026-09-29-model-agnostic-decision-helper-design.md`

## Global Constraints

- Jev remains the configured default, `jev-latest`.
- Keep model selection in trusted user config at `~/.claude/claude-jev.json`.
- Do not add a project-config model override, per-request CLI override, or automatic model routing.
- Keep the integration specific to TypeSafe System One; do not add adapters for unrelated model providers.
- Preserve existing Jev-named exports as deprecated aliases so package consumers do not break.
- Confirm exact Laya and Kev model IDs and their System One response compatibility before documenting them as supported choices.
- Do not silently fall back when a selected model is unavailable or incompatible.

## Review Focus

- Empty or whitespace-only global model values must leave `jev-latest` selected; test in `tests/config.test.ts`.
- Project config must not override a model selected in global config; test in `tests/config.test.ts`.
- A non-empty TypeSafe model ID must reach the request unchanged; test in `tests/client.test.ts`.
- An unavailable selected model must return an error without retrying under Jev; test in `tests/client.test.ts`.
- Existing Jev exports must remain callable and preserve error-class identity; test in `tests/client.test.ts`.

---

## File map

- `src/client.ts`: model-neutral wire types, errors, response validation, and request function; Jev aliases remain exported here.
- `src/gate.ts`, `src/output.ts`, and `src/hooks/*.ts`: use model-neutral client exports internally.
- `bin/claude-jev`: use model-neutral client function for the existing `check` command.
- `tests/client.test.ts`, `tests/config.test.ts`, `tests/gate.test.ts`, `tests/output.test.ts`, `tests/pre-tool.test.ts`, `tests/post-tool.test.ts`, and `tests/post-tool-failure.test.ts`: protect the client contract and current hook behavior.
- `README.md`, `docs/type-safe-integration.md`, `docs/reliability-and-privacy.md`, and `docs/architecture.md`: explain user-level model selection and verified model IDs.

## Task 1: Add model-neutral client exports

**Files:**
- Modify: `src/client.ts`
- Test: `tests/client.test.ts`

**Interfaces:**
- Consumes: existing Jev-named request, question, answer, error, and response implementations.
- Produces:
  - `TypeSafeNoulQuestion`, `TypeSafeScoreQuestion`, `TypeSafeChoiceQuestion`, and their `TypeSafeQuestion` union.
  - `TypeSafeNoulAnswer`, `TypeSafeScoreAnswer`, `TypeSafeChoiceAnswer`, and their `TypeSafeAnswer` union.
  - `TypeSafeUsage`, `TypeSafeResponse`, and `TypeSafeCall`.
  - `TypeSafeError`.
  - `DEFAULT_TYPESAFE_MODEL`, retaining `DEFAULT_MODEL` as an alias.
  - `validateTypeSafeResponse(raw, expectedQuestions?)`.
  - `askTypeSafe(call): Promise<TypeSafeResponse>`.
  - Deprecated aliases for every existing Jev-named export, including `askJev`, `JevError`, `JevNoulQuestion`, `JevScoreQuestion`, `JevChoiceQuestion`, `JevQuestion`, `JevNoulAnswer`, `JevScoreAnswer`, `JevChoiceAnswer`, `JevAnswer`, `JevUsage`, `JevResponse`, `JevCall`, and `validateJevResponse`.

- [ ] **Step 1: Write failing client API tests**

Add tests that import the new generic exports, verify `askJev === askTypeSafe`, verify `JevError` and `TypeSafeError` are the same constructor, and verify `askTypeSafe` sends a configured non-empty model ID unchanged.

- [ ] **Step 2: Run client tests to verify the new API test fails**

Run: `node --experimental-strip-types --test tests/client.test.ts`
Expected: FAIL because `askTypeSafe` and other generic exports do not exist.

- [ ] **Step 3: Add generic types and aliases in `src/client.ts`**

Make generic names the implementation symbols. Keep the existing request body and response validation contract unchanged. Export Jev-named functions, types, constants, and error class as aliases to their generic counterparts. Do not add model allowlisting or fallback logic.

- [ ] **Step 4: Run client tests and typecheck**

Run: `node --experimental-strip-types --test tests/client.test.ts && npm run typecheck`
Expected: PASS. Existing Jev imports continue to work, and generic imports compile.

- [ ] **Step 5: Commit client API changes**

```bash
git add src/client.ts tests/client.test.ts
git commit -m "refactor: make TypeSafe client model-neutral"
```

## Task 2: Migrate internal callers and document model selection

**Files:**
- Modify: `src/gate.ts`, `src/output.ts`, `src/hooks/pre-tool.ts`, `src/hooks/output-handler.ts`, `src/hooks/post-tool.ts`, `src/hooks/post-tool-failure.ts`, `bin/claude-jev`
- Modify: `tests/config.test.ts` and relevant tests under `tests/`
- Modify: `README.md`, `docs/type-safe-integration.md`, `docs/reliability-and-privacy.md`, `docs/architecture.md`

**Interfaces:**
- Consumes: generic exports from Task 1.
- Produces: all first-party runtime callers use model-neutral client functions and types; existing public Jev aliases remain available.

- [ ] **Step 1: Add regression tests for config and no-fallback behavior**

In `tests/config.test.ts`, add tests that a non-empty global model value is retained and that an empty or whitespace-only model leaves the Jev default. Assert project model input cannot replace the global model. In `tests/client.test.ts`, add a mocked unavailable-model response and assert one request uses the selected model and returns an error without sending a second request for Jev.

- [ ] **Step 2: Run the targeted tests**

Run: `node --experimental-strip-types --test tests/config.test.ts tests/client.test.ts`
Expected: PASS for existing config behavior and no-fallback client behavior.

- [ ] **Step 3: Update internal imports to generic client names**

Use `TypeSafeResponse` and `TypeSafeAnswer` in `src/gate.ts` and `src/output.ts`. Use `askTypeSafe` and `DEFAULT_TYPESAFE_MODEL` in hook and CLI call sites. Keep existing exported test-injection properties compatible where renaming them would break callers.

- [ ] **Step 4: Verify current gate, output, and CLI behavior**

Run: `node --experimental-strip-types --test tests/gate.test.ts tests/output.test.ts tests/pre-tool.test.ts tests/post-tool.test.ts tests/post-tool-failure.test.ts tests/cli.test.ts`
Expected: PASS. Fixed questions, thresholds, cache keys, and hook behavior remain unchanged.

- [ ] **Step 5: Verify exact Laya and Kev model IDs from TypeSafe documentation**

Check the current official TypeSafe model documentation and System One response contract. Record only confirmed IDs. If either model lacks the existing typed response contract, do not list it as supported.

- [ ] **Step 6: Update model-selection documentation**

Document the existing `model` field in trusted global config, retain `jev-latest` as the default, and show only verified Laya/Kev IDs. State that project config cannot set model or endpoint and that the client does not fall back automatically. Update the TypeSafe architecture description to use model-neutral client names while retaining the plugin's `claude-jev` branding.

- [ ] **Step 7: Run full verification**

Run: `npm run check && npm run validate:plugin && npm pack --dry-run --json`
Expected: typecheck, build, tests, plugin validation, and package dry-run succeed.

- [ ] **Step 8: Commit caller and documentation changes**

```bash
git add src tests README.md docs
git commit -m "refactor: use model-neutral client internally"
```
