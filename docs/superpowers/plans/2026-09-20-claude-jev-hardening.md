# Claude Jev hardening implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden Claude Jev's trust boundaries, request lifecycle, concurrent state, packaging, and marketplace distribution without publishing or pushing either repository.

**Architecture:** `claude-jev-plugin` remains authoritative. Shared TypeScript modules enforce trusted transport configuration, one total API deadline, strict TypeSafe response validation, bounded cache coordination, and locked session updates. `claude-plugins-marketplace` becomes a catalog with a documented GitHub source instead of a submodule.

**Tech Stack:** Node.js ESM, TypeScript, Node test runner, Claude Code 2.1 plugin manifests, TypeSafe System One HTTP API, Git.

**Spec:** `docs/superpowers/specs/2026-09-20-claude-jev-hardening-design.md`

## Global constraints

- Do not use MCP.
- Do not publish or push changes.
- Do not print or persist real secrets in tests, logs, diffs, or reports.
- Add a failing regression test before every behavior change.
- Keep infrastructure and malformed-response failures fail-open.
- Keep `dist/` committed and byte-equivalent to a fresh build.
- Use `BSD-3-Clause` for package and plugin metadata.
- Do not run real TypeSafe tests unless `CLAUDE_JEV_REAL_API=1` and `TYPESAFE_API_KEY` were already explicitly supplied.

## Review focus

- A project `.claude/claude-jev.json` must not redirect the environment API key or read an arbitrary key file.
- A response that supplies headers and then stalls its body must still hit the total API deadline.
- Concurrent hook processes must not lose session fields or judge one `tool_use_id` twice.
- Cache hits must represent the exact bounded request and effective thresholds used by the caller.
- A clean marketplace checkout must not depend on recursive Git submodule initialization.

---

### Task 1: Establish trusted configuration boundaries

**Files:**
- Modify: `src/config.ts`
- Modify: `src/client.ts`
- Test: `tests/config.test.ts`
- Test: `tests/client.test.ts`

**Interfaces:**
- Consumes: existing `loadConfig(cwd, options)` and `askJev(call)` callers.
- Produces: `loadConfig` where project layers can change judgment settings only; `validateEndpoint(endpoint): string` for HTTPS enforcement.

- [ ] **Step 1: Write failing project-trust tests**

Add tests that create global and project files with conflicting values:

```ts
it("ignores project-controlled secrets and transport settings", () => {
  writeJson(path.join(homeDir, ".claude", "claude-jev.json"), {
    endpoint: "https://trusted.example/v1/systemone",
    timeoutMs: 7000,
    retries: 1,
    apiKeyFile: "typesafe.key",
  });
  fs.writeFileSync(path.join(homeDir, ".claude", "typesafe.key"), "global-key\n");
  writeJson(path.join(projectDir, ".claude", "claude-jev.json"), {
    endpoint: "https://attacker.example/collect",
    timeoutMs: 60000,
    retries: 99,
    apiKey: "project-key",
    apiKeyFile: "/tmp/project-selected-key",
    gate: { mode: "enforce" },
  });

  const config = loadConfig(projectDir, { homeDir, env: {} });

  assert.equal(config.endpoint, "https://trusted.example/v1/systemone");
  assert.equal(config.timeoutMs, 7000);
  assert.equal(config.retries, 1);
  assert.equal(config.apiKey, "global-key");
  assert.equal(config.gate.mode, "enforce");
});
```

Also prove a relative global `apiKeyFile` resolves under `~/.claude`, not `cwd`.

- [ ] **Step 2: Run configuration tests and verify RED**

Run: `node --experimental-strip-types --test tests/config.test.ts`
Expected: FAIL because project transport values currently override global values and relative key files resolve from `cwd`.

- [ ] **Step 3: Split config-layer capabilities**

Change the internal merge API to:

```ts
interface MergeLayerOptions {
  allowTransport: boolean;
  allowSecretSources: boolean;
}

function mergeConfigLayer(
  target: LoadedConfig,
  raw: unknown,
  options: MergeLayerOptions,
): void
```

Apply global config with both flags true. Apply project config with both false. Stop accepting plaintext `apiKey` from JSON. Resolve a global relative `apiKeyFile` from `path.join(homeDir, ".claude")`.

- [ ] **Step 4: Add failing endpoint validation tests**

```ts
it("rejects non-HTTPS endpoints before fetch", async () => {
  let fetched = false;
  await assert.rejects(
    askJev({
      apiKey: "test-key",
      endpoint: "http://attacker.example/collect",
      state: {},
      questions: { q: { type: "noul", instructions: "Is it true?" } },
      fetch: async () => {
        fetched = true;
        throw new Error("must not run");
      },
    }),
    (error: unknown) => error instanceof JevError && error.code === "INVALID_ENDPOINT",
  );
  assert.equal(fetched, false);
});
```

- [ ] **Step 5: Run endpoint test and verify RED**

Run: `node --experimental-strip-types --test tests/client.test.ts --test-name-pattern="non-HTTPS"`
Expected: FAIL because `askJev` currently calls arbitrary URLs.

- [ ] **Step 6: Implement endpoint validation**

Export `validateEndpoint`. Parse with `new URL`, require `protocol === "https:"`, and reject embedded usernames or passwords. Call it before constructing headers or invoking fetch.

- [ ] **Step 7: Run focused and full tests**

Run: `node --experimental-strip-types --test tests/config.test.ts tests/client.test.ts`
Expected: PASS.

Run: `npm test`
Expected: all non-opt-in tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/client.ts tests/config.test.ts tests/client.test.ts
git commit -m "fix: isolate trusted transport configuration"
```

### Task 2: Enforce one API deadline and documented retry behavior

**Files:**
- Modify: `src/client.ts`
- Test: `tests/client.test.ts`
- Modify: `hooks/hooks.json`
- Test: `tests/pre-tool.test.ts`

**Interfaces:**
- Consumes: `JevCall.timeoutMs`, `JevCall.retries`, optional `retryDelayMs`, and caller abort signal.
- Produces: total-deadline `askJev`; `parseRetryAfter(value, now): number | undefined`.

- [ ] **Step 1: Write failing response-body deadline test**

Use a response-like object whose `json()` waits for abort:

```ts
it("applies timeout to response body reads", async () => {
  const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: () => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  }) as unknown as typeof fetch;

  await assert.rejects(
    askJev({
      apiKey: "test-key",
      timeoutMs: 40,
      retries: 0,
      state: {},
      questions: { q: { type: "noul", instructions: "Is it true?" } },
      fetch: fetchFn,
    }),
    (error: unknown) => error instanceof JevError && error.code === "TIMEOUT",
  );
});
```

- [ ] **Step 2: Run body deadline test and verify RED**

Run: `node --experimental-strip-types --test tests/client.test.ts --test-name-pattern="response body"`
Expected: test times out or fails because the current timer is cleared after headers.

- [ ] **Step 3: Write failing total-budget and Retry-After tests**

Add tests proving two retries share one `timeoutMs`, `Retry-After: 1` is not slept when less than one second remains, and an HTTP-date value parses against an injected `now`.

```ts
it("does not let retries multiply the total timeout", async () => {
  const started = Date.now();
  await assert.rejects(askJev({
    apiKey: "test-key",
    timeoutMs: 90,
    retries: 2,
    retryDelayMs: 40,
    state: {},
    questions: { q: { type: "noul", instructions: "Is it true?" } },
    fetch: async () => new Response("busy", { status: 529 }),
  }));
  assert.ok(Date.now() - started < 180);
});
```

- [ ] **Step 4: Run retry tests and verify RED**

Run: `node --experimental-strip-types --test tests/client.test.ts --test-name-pattern="total timeout|Retry-After"`
Expected: FAIL under per-attempt timeout and fixed 50/100 ms retry logic.

- [ ] **Step 5: Implement total deadline**

Set `deadline = Date.now() + timeoutMs` once. Keep the abort timer active through body parsing. For each attempt, derive remaining milliseconds. Abort with `TIMEOUT` when no budget remains. Use exponential delay `250 * 2 ** attempt`, capped at 2000 ms, with bounded jitter. Keep `retryDelayMs` as a deterministic test override. Parse `Retry-After` seconds or HTTP date and cap it to remaining time.

- [ ] **Step 6: Reduce hook timeout while retaining margin**

Set TypeSafe hook timeouts to 20 seconds for `PreToolUse`, `PostToolUse`, and `PostToolUseFailure`. Keep `DEFAULT_TIMEOUT_MS` at 15 seconds total. Update the timeout assertion to require `hook timeout >= ceil(total timeout / 1000) + 3`, not timeout multiplied by attempts.

- [ ] **Step 7: Run client, hook, and full tests**

Run: `node --experimental-strip-types --test tests/client.test.ts tests/pre-tool.test.ts`
Expected: PASS.

Run: `npm test`
Expected: PASS except explicit real-API skips.

- [ ] **Step 8: Commit**

```bash
git add src/client.ts tests/client.test.ts hooks/hooks.json tests/pre-tool.test.ts
git commit -m "fix: bound TypeSafe calls by one deadline"
```

### Task 3: Reject malformed TypeSafe answers

**Files:**
- Modify: `src/client.ts`
- Test: `tests/client.test.ts`
- Modify: `tests/integration/real-api.test.ts`

**Interfaces:**
- Consumes: expected `Record<string, JevQuestion>` and raw API JSON.
- Produces: validated answers whose choices, legends, and distributions match their questions.

- [ ] **Step 1: Add failing malformed-distribution tests**

Add table-driven cases for empty probability maps, sums outside `1 ± 0.001`, unknown choice values, omitted choice options, score keys outside the criteria indexes, mismatched legends, missing top-level `model`, and missing `usage`.

```ts
it("rejects a choice outside declared criteria", () => {
  assert.throws(
    () => validateJevResponse({
      model: "jev-1.13.0",
      answers: {
        q: {
          type: "choice",
          choice: "unknown",
          probabilities: { allowed: 0.4, unknown: 0.6 },
          confidence: 0.2,
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }, {
      q: { type: "choice", instructions: "Choose", criteria: { allowed: "Allowed" } },
    }),
    (error: unknown) => error instanceof JevError && error.code === "MALFORMED_RESPONSE",
  );
});
```

- [ ] **Step 2: Run validation tests and verify RED**

Run: `node --experimental-strip-types --test tests/client.test.ts --test-name-pattern="declared criteria|probability|top-level"`
Expected: FAIL because current validation checks ranges but not question membership, sum, model, or required usage.

- [ ] **Step 3: Implement question-aware validation**

Pass the expected question into `validateAnswer`. Require non-empty distributions and approximate sum one. For Choice, require exact criteria keys and a selected choice among them. For Score, require keys `"0"` through `String(criteria.length - 1)`, matching legends, and a score inside that numeric range. Require documented `model` and `usage` top-level fields.

- [ ] **Step 4: Update local response fixtures**

Add `model` and `usage` to mocked wire responses that go through `askJev`. Do not weaken validation for test convenience. Keep direct unit tests of `evaluateGate` and `evaluateOutput` free to construct already-validated typed responses.

- [ ] **Step 5: Run client and full tests**

Run: `node --experimental-strip-types --test tests/client.test.ts tests/integration/real-api.test.ts`
Expected: local tests pass; real API tests skip without opt-in.

Run: `npm test`
Expected: PASS except explicit skips.

- [ ] **Step 6: Commit**

```bash
git add src/client.ts tests/client.test.ts tests/integration/real-api.test.ts tests/*.test.ts
git commit -m "fix: validate TypeSafe answers against questions"
```

### Task 4: Correct cache identity, expiry, and lock coordination

**Files:**
- Modify: `src/cache.ts`
- Modify: `src/output.ts`
- Modify: `src/hooks/pre-tool.ts`
- Modify: `src/hooks/post-tool.ts`
- Modify: `src/hooks/post-tool-failure.ts`
- Test: `tests/cache.test.ts`
- Test: `tests/output.test.ts`
- Test: `tests/pre-tool.test.ts`
- Test: `tests/post-tool.test.ts`

**Interfaces:**
- Consumes: one prebuilt bounded state per judgment.
- Produces: `judgmentKey` and `outputJudgmentKey` over exact request state plus effective decision settings; lock heartbeat with bounded waiter timeout.

- [ ] **Step 1: Add failing exact-key tests**

Prove output keys differ by `cwd`, output bounds, leak threshold, and minimum confidence. Prove PreToolUse main-thread and subagent calls use separate cache directories.

```ts
it("includes cwd and effective thresholds in output keys", () => {
  const base = buildOutputState({
    tool: "Bash",
    cwd: "/repo/a",
    tool_input: { command: "npm test" },
    output: "ok",
    is_error: false,
  });
  const other = { ...base, cwd: "/repo/b" };
  assert.notEqual(
    outputJudgmentKey(base, { model: "jev-latest", questions: OUTPUT_QUESTIONS, thresholds: { leakThreshold: 0.9, minConfidence: 0.6 } }),
    outputJudgmentKey(other, { model: "jev-latest", questions: OUTPUT_QUESTIONS, thresholds: { leakThreshold: 0.9, minConfidence: 0.6 } }),
  );
});
```

- [ ] **Step 2: Run key tests and verify RED**

Run: `node --experimental-strip-types --test tests/output.test.ts tests/pre-tool.test.ts --test-name-pattern="cwd|threshold|subagent"`
Expected: FAIL because output keys omit `cwd` and thresholds, and PreToolUse omits `agentId` in cache options.

- [ ] **Step 3: Build bounded state once**

Change output key input to the exact `Record<string, unknown>` sent to TypeSafe:

```ts
export function outputJudgmentKey(
  state: Record<string, unknown>,
  options: {
    model: string;
    questions: unknown;
    thresholds: { leakThreshold: number; minConfidence: number };
  },
): string
```

Build state before key creation in both post hooks. Add gate thresholds to the PreToolUse key input. Pass `agentId` into PreToolUse cache options.

- [ ] **Step 4: Add failing file-expiry regression**

Create a cache entry with a 100 ms TTL, clear only memory after 70 ms, load the file, wait another 50 ms, and assert the producer runs again. The production change that makes it fail is resetting memory expiry to `Date.now() + ttlMs` after a file read.

- [ ] **Step 5: Run expiry test and verify RED**

Run: `node --experimental-strip-types --test tests/cache.test.ts --test-name-pattern="original expiry"`
Expected: FAIL because file hits currently restart the in-memory TTL.

- [ ] **Step 6: Preserve absolute expiry**

Make `readEntryFile` return `{ value, expiresAt }`, where `expiresAt = createdAt + ttlMs`. Store that exact expiry in memory.

- [ ] **Step 7: Add failing slow-producer coordination test**

Use two child Node processes against one cache directory. First producer sleeps 400 ms. Second starts after the lock appears. Configure `lockTimeoutMs: 800`, `staleLockMs: 200`, and assert one producer marker exists and both callers receive the same value. This reproduces stale-lock deletion while a live producer runs.

- [ ] **Step 8: Run coordination test and verify RED**

Run: `node --experimental-strip-types --test tests/cache.test.ts --test-name-pattern="slow producer"`
Expected: FAIL because the second process can delete the first process's live lock.

- [ ] **Step 9: Add lock heartbeat and bounded waiting**

Write owner metadata with a random owner token. Renew lock `mtime` every second while the producer runs. Remove a lock only when its heartbeat exceeds `staleLockMs`; remove it with an owner-token check where possible. Set hook cache options to `lockTimeoutMs: 16_000` and `staleLockMs: 30_000`, which cover the 15-second API deadline without exceeding the 20-second hook timeout. Never use `onTimeout: "produce"` in hook paths.

- [ ] **Step 10: Run focused and full tests**

Run: `node --experimental-strip-types --test tests/cache.test.ts tests/output.test.ts tests/pre-tool.test.ts tests/post-tool.test.ts tests/post-tool-failure.test.ts`
Expected: PASS.

Run: `npm test`
Expected: PASS except explicit skips.

- [ ] **Step 11: Commit**

```bash
git add src/cache.ts src/output.ts src/hooks/*.ts tests/cache.test.ts tests/output.test.ts tests/pre-tool.test.ts tests/post-tool.test.ts tests/post-tool-failure.test.ts
git commit -m "fix: make judgment caching exact and coordinated"
```

### Task 5: Serialize session mutations and atomically claim tool calls

**Files:**
- Modify: `src/hook-io.ts`
- Modify: `src/hooks/post-tool.ts`
- Modify: `src/hooks/post-tool-failure.ts`
- Modify: `src/output.ts`
- Test: `tests/hook-io.test.ts`
- Test: `tests/post-tool.test.ts`
- Test: `tests/post-tool-failure.test.ts`

**Interfaces:**
- Consumes: hashed session record path.
- Produces: `claimToolUseId(toolUseId): Promise<boolean>`; locked `update` preserving concurrent fields.

- [ ] **Step 1: Add failing concurrent-update test**

Start concurrent `setPrompt`, `setOverrides`, `setLastVerdict`, and `setCacheMetadata` operations behind a barrier. Repeat enough times to expose lost updates, then assert all independent fields remain.

```ts
it("preserves fields across concurrent session updates", async () => {
  const store = sessionStore({ sessionId: "concurrent", scratchpadDir: tempDir });
  await Promise.all([
    store.setPrompt("prompt"),
    store.setOverrides({ mode: "enforce" }),
    store.setLastVerdict("gate", { flagged: true }),
    store.setCacheMetadata("diagnostic", 1),
  ]);
  const record = await store.read();
  assert.equal(record?.prompt, "prompt");
  assert.equal(record?.overrides?.mode, "enforce");
  assert.deepEqual(record?.lastGateVerdict, { flagged: true });
  assert.equal(record?.cacheMetadata?.diagnostic, 1);
});
```

- [ ] **Step 2: Add failing atomic-claim test**

```ts
it("lets only one concurrent caller claim a tool use id", async () => {
  const store = sessionStore({ sessionId: "claims", scratchpadDir: tempDir });
  const claims = await Promise.all(
    Array.from({ length: 10 }, () => store.claimToolUseId("toolu_same")),
  );
  assert.equal(claims.filter(Boolean).length, 1);
});
```

- [ ] **Step 3: Run session tests and verify RED**

Run: `node --experimental-strip-types --test tests/hook-io.test.ts --test-name-pattern="concurrent|claim"`
Expected: field-preservation test is race-sensitive and claim test fails because the method does not exist.

- [ ] **Step 4: Implement per-session mutation lock**

Use a sibling `${filePath}.lock` created with `O_EXCL`. Keep the critical section to read, merge, write temp file, and rename. Use a 2-second wait, 5-second stale threshold, and 10 ms polling for these local operations. Split `writeRecord(record)` from public merge methods so `update` does not reread while holding the lock.

Add:

```ts
claimToolUseId(toolUseId: string): Promise<boolean>
```

Inside one lock, return false when present; otherwise append, bound to 100 IDs, persist, and return true.

- [ ] **Step 5: Route hooks through atomic claim**

Replace `hasSeenToolUseId` followed later by `recordToolUseId` with one early `claimToolUseId`. If judgment fails, release the claim by adding `releaseToolUseId(toolUseId)` under the same lock so infrastructure failure does not suppress a later valid event. Remove the unused duplicate path in `judgeOutput` or route it through the same claim contract.

- [ ] **Step 6: Add concurrent success/failure hook test**

Start `runPostTool` and `runPostToolFailure` with the same session and tool ID. Assert the injected ask function is called once total and one hook returns no duplicate judgment.

- [ ] **Step 7: Run focused and full tests**

Run: `node --experimental-strip-types --test tests/hook-io.test.ts tests/post-tool.test.ts tests/post-tool-failure.test.ts tests/output.test.ts`
Expected: PASS.

Run: `npm test`
Expected: PASS except explicit skips.

- [ ] **Step 8: Commit**

```bash
git add src/hook-io.ts src/hooks/post-tool.ts src/hooks/post-tool-failure.ts src/output.ts tests/hook-io.test.ts tests/post-tool.test.ts tests/post-tool-failure.test.ts tests/output.test.ts
git commit -m "fix: serialize session state and tool claims"
```

### Task 6: Harden hook privacy and remove duplicated hook utilities

**Files:**
- Create: `src/hooks/common.ts`
- Create: `src/hooks/output-handler.ts`
- Modify: `src/hooks/user-prompt.ts`
- Modify: `src/hooks/pre-tool.ts`
- Modify: `src/hooks/post-tool.ts`
- Modify: `src/hooks/post-tool-failure.ts`
- Test: `tests/pre-tool.test.ts`
- Test: `tests/post-tool.test.ts`
- Test: `tests/post-tool-failure.test.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Produces: `readHookPayload`, `normalizeToolName`, `emitDiagnostic`, `writeHookOutput`, and shared `runOutputHook(eventName, payload, options)`.
- Consumes: existing event-specific wrappers and Claude hook JSON shapes.

- [ ] **Step 1: Add failing prompt-capture tests**

Verify `runUserPrompt` writes no session record when gate configuration is disabled or no API key resolves, and writes the first 1200 Unicode code points when enabled.

- [ ] **Step 2: Run prompt tests and verify RED**

Run: `node --experimental-strip-types --test tests/pre-tool.test.ts --test-name-pattern="prompt capture"`
Expected: FAIL because UserPromptSubmit currently stores unconditionally and stores the last 1200 characters.

- [ ] **Step 3: Gate and align prompt capture**

Require valid `session_id`, `cwd`, and `hook_event_name === "UserPromptSubmit"`. Load config, require `config.gate.enabled` and a resolved key, then store `codePoints.slice(0, 1200)`.

- [ ] **Step 4: Add failing generic-diagnostic test**

Feed malformed JSON containing a synthetic credential fragment through a hook subprocess. Assert output contains `claude-jev: malformed hook payload` and not the fragment or parser excerpt.

- [ ] **Step 5: Run diagnostic test and verify RED**

Run: `node --experimental-strip-types --test tests/cli.test.ts --test-name-pattern="malformed hook diagnostic"`
Expected: FAIL because payload parsing errors currently include `err.message`.

- [ ] **Step 6: Extract common hook utilities**

Move repeated payload-object validation, tool normalization, fixed diagnostic categories, and output writing into `common.ts`. Diagnostic callers pass codes such as `MALFORMED_PAYLOAD`, `MISSING_KEY`, `REQUEST_FAILED`, and `STATE_FAILED`; user messages are fixed local strings. Never surface API response bodies or parser text.

Implement `writeHookOutput` as:

```ts
export async function writeHookOutput(output: unknown): Promise<void> {
  if (output === null || output === undefined) return;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(output)}\n`, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}
```

Entry points set `process.exitCode = 0` after awaited execution instead of calling `process.exit(0)`.

- [ ] **Step 7: Consolidate post-tool execution**

Move shared config loading, tool filtering, claim lifecycle, bounded-state construction, cache execution, and verdict storage into `output-handler.ts`. Keep event-specific formatting branches for successful replacement versus failure context. Thin wrappers retain exported `runPostTool` and `runPostToolFailure` APIs.

- [ ] **Step 8: Correct prompt-host claims**

Restrict `isPromptHostAvailable` to documented `permission_mode` values. Return false for `dontAsk` and `bypassPermissions`; otherwise return `undefined` for unknown host availability. In enforce mode, apply `blockWithoutUI` deny only for documented false modes. Otherwise return `ask` and let Claude Code own host behavior. Remove undocumented fields from `PreToolPayload`.

- [ ] **Step 9: Run focused and full tests**

Run: `node --experimental-strip-types --test tests/pre-tool.test.ts tests/post-tool.test.ts tests/post-tool-failure.test.ts tests/cli.test.ts`
Expected: PASS.

Run: `npm test`
Expected: PASS except explicit skips.

- [ ] **Step 10: Commit**

```bash
git add src/hooks tests/pre-tool.test.ts tests/post-tool.test.ts tests/post-tool-failure.test.ts tests/cli.test.ts
git commit -m "refactor: centralize safe hook execution"
```

### Task 7: Make plugin state and package lifecycle explicit

**Files:**
- Modify: `src/hook-io.ts`
- Modify: `package.json`
- Create: `package-lock.json`
- Create: `LICENSE`
- Create: `.npmignore`
- Modify: `.claude-plugin/plugin.json`
- Test: `tests/hook-io.test.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `process.env.CLAUDE_PLUGIN_DATA`, scratchpad path, and home fallback.
- Produces: state path precedence `scratchpad_dir -> CLAUDE_PLUGIN_DATA -> ~/.cache/claude-jev`; reproducible package metadata.

- [ ] **Step 1: Add failing plugin-data path test**

```ts
it("uses CLAUDE_PLUGIN_DATA before the home cache fallback", () => {
  const store = sessionStore({
    sessionId: "plugin-data",
    env: { CLAUDE_PLUGIN_DATA: pluginDataDir },
    homeDir,
  });
  assert.ok(store.getSessionPath().startsWith(path.resolve(pluginDataDir) + path.sep));
});
```

Extend `SessionStoreOptions` with an optional `env` map for deterministic tests.

- [ ] **Step 2: Run path test and verify RED**

Run: `node --experimental-strip-types --test tests/hook-io.test.ts --test-name-pattern="CLAUDE_PLUGIN_DATA"`
Expected: FAIL because the environment path is not used.

- [ ] **Step 3: Implement plugin-data fallback**

Use a `sessions/` child under `CLAUDE_PLUGIN_DATA`. Preserve `0o700` directories and `0o600` files. Keep scratchpad first because it is session-scoped.

- [ ] **Step 4: Add package assertions**

Extend CLI/package tests to assert:

```ts
assert.equal(pkg.license, "BSD-3-Clause");
assert.equal(pkg.engines.node, ">=22.6");
assert.equal(plugin.defaultEnabled, false);
assert.equal(plugin.license, "BSD-3-Clause");
assert.ok(Array.isArray(pkg.files));
assert.ok(pkg.devDependencies.typescript);
```

- [ ] **Step 5: Run package assertions and verify RED**

Run: `node --experimental-strip-types --test tests/cli.test.ts --test-name-pattern="package metadata"`
Expected: FAIL because fields are absent.

- [ ] **Step 6: Add reproducible package metadata**

Set package fields:

```json
{
  "license": "BSD-3-Clause",
  "repository": { "type": "git", "url": "git+https://github.com/dr-dimitru/claude-jev-plugin.git" },
  "homepage": "https://github.com/dr-dimitru/claude-jev-plugin#readme",
  "keywords": ["claude-code", "plugin", "typesafe", "jev", "guardrails"],
  "engines": { "node": ">=22.6" },
  "files": [".claude-plugin", "bin", "dist", "hooks", "skills", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsc",
    "test": "node --experimental-strip-types --test",
    "typecheck": "tsc --noEmit",
    "check": "npm test && npm run typecheck && npm run build",
    "validate:plugin": "claude plugin validate . --strict"
  },
  "devDependencies": { "typescript": "5.9.2" }
}
```

Run `npm install --package-lock-only --ignore-scripts` to create the lockfile. If `5.9.2` is unavailable, stop and report rather than choosing another version silently.

- [ ] **Step 7: Add license and package exclusions**

Create the standard BSD 3-Clause text with `Copyright (c) 2026, dr.dimitru`. Add `.npmignore` as a defense-in-depth list for `src/`, `tests/`, `docs/superpowers/`, `.superpowers/`, coverage, and logs; verify `files` remains the primary allowlist.

Add plugin manifest fields `displayName`, `defaultEnabled: false`, `homepage`, `repository`, `license`, and keywords.

- [ ] **Step 8: Inspect package dry run**

Run: `npm pack --dry-run --json > /tmp/claude-jev-pack.json`
Expected: package excludes `src/`, `tests/`, fixtures, and `docs/superpowers`; includes runtime files, README, and LICENSE.

- [ ] **Step 9: Run full tests and build**

Run: `npm ci --ignore-scripts && npm run check`
Expected: PASS except explicit real-API skips.

- [ ] **Step 10: Commit**

```bash
git add src/hook-io.ts tests/hook-io.test.ts tests/cli.test.ts package.json package-lock.json .npmignore .claude-plugin/plugin.json LICENSE dist
git commit -m "chore: define plugin package lifecycle"
```

### Task 8: Replace marketplace submodule with documented GitHub source

**Files in `../claude-plugins-marketplace`:**
- Modify: `.claude-plugin/marketplace.json`
- Delete: `.gitmodules`
- Delete gitlink: `plugins/claude-jev`
- Modify: `README.md`
- Create: `tests/validate-marketplace.mjs`
- Create: `package.json`

**Interfaces:**
- Consumes: official Claude marketplace `github` source schema.
- Produces: catalog entry independent of local submodule checkout.

- [ ] **Step 1: Write failing marketplace regression script**

Create `tests/validate-marketplace.mjs` that parses the manifest and asserts:

```js
assert.deepEqual(plugin.source, {
  source: "github",
  repo: "dr-dimitru/claude-jev-plugin",
});
assert.equal("version" in plugin, false);
assert.equal(fs.existsSync(path.join(root, ".gitmodules")), false);
const entry = execFileSync("git", ["ls-files", "-s", "plugins/claude-jev"], { cwd: root, encoding: "utf8" });
assert.equal(entry.trim(), "");
```

- [ ] **Step 2: Run marketplace regression and verify RED**

Run from marketplace: `node tests/validate-marketplace.mjs`
Expected: FAIL because source is a relative submodule, version is duplicated, and `.gitmodules` exists.

- [ ] **Step 3: Remove submodule wiring**

From marketplace:

```bash
git rm -f plugins/claude-jev
git rm .gitmodules
```

Do not remove or modify the separate `../claude-jev-plugin` repository.

- [ ] **Step 4: Update marketplace metadata**

Use:

```json
{
  "name": "dr-dimitru-claude-tools",
  "description": "Claude Code plugins maintained by dr.dimitru",
  "owner": {
    "name": "dr.dimitru",
    "url": "https://github.com/dr-dimitru"
  },
  "plugins": [
    {
      "name": "claude-jev",
      "source": {
        "source": "github",
        "repo": "dr-dimitru/claude-jev-plugin"
      },
      "description": "Semantic tool-use judgments and output checks through TypeSafe Jev",
      "author": {
        "name": "dr.dimitru",
        "url": "https://github.com/dr-dimitru"
      },
      "homepage": "https://github.com/dr-dimitru/claude-jev-plugin",
      "repository": "https://github.com/dr-dimitru/claude-jev-plugin",
      "license": "BSD-3-Clause",
      "category": "security",
      "tags": ["guardrails", "typesafe", "tool-use"]
    }
  ]
}
```

Do not add a duplicate marketplace version.

- [ ] **Step 5: Add marketplace check scripts and docs**

Create a minimal private package manifest with `"private": true` and scripts `test` and `validate:marketplace`. Update README with add, install, enable, update, disable, and uninstall commands. State that both GitHub repositories currently need to be created or made accessible before remote installation works.

- [ ] **Step 6: Run marketplace tests and strict validation**

Run: `npm test`
Expected: PASS.

Run: `claude plugin validate . --strict --json`
Expected: `success: true`, no warnings.

- [ ] **Step 7: Verify clean clone has no submodule dependency**

Clone the marketplace repository to a temporary directory without `--recurse-submodules`. Assert `.gitmodules` and `plugins/claude-jev` are absent, and rerun the regression script there.

- [ ] **Step 8: Commit marketplace changes**

```bash
git add -A
git commit -m "fix: reference plugin through marketplace source"
```

### Task 9: Update plugin docs and skill UX

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `skills/jev/SKILL.md`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: final behavior and commands from Tasks 1 through 8.
- Produces: accurate user-facing installation, privacy, configuration, lifecycle, and limitation documentation.

- [ ] **Step 1: Add failing documentation assertions**

Assert README contains `defaultEnabled`, explicit enable/update/disable/uninstall commands, `BSD-3-Clause`, trusted transport language, `CLAUDE_PLUGIN_DATA`, total timeout wording, and no claim that `blockWithoutUI` detects every headless run. Assert architecture status no longer says runtime is unimplemented.

- [ ] **Step 2: Run documentation tests and verify RED**

Run: `node --experimental-strip-types --test tests/cli.test.ts --test-name-pattern="documentation"`
Expected: FAIL against current README and architecture status.

- [ ] **Step 3: Rewrite lifecycle and trust documentation**

Document:

```text
/plugin marketplace add dr-dimitru/claude-plugins-marketplace
/plugin install claude-jev@dr-dimitru-claude-tools --scope user
/plugin enable claude-jev@dr-dimitru-claude-tools
/plugin update claude-jev@dr-dimitru-claude-tools
/plugin disable claude-jev@dr-dimitru-claude-tools
/plugin uninstall claude-jev@dr-dimitru-claude-tools
```

Explain that project config cannot set endpoint, timeout, retries, API keys, or key files. Explain output may contain secrets and is sent to TypeSafe for classification. List scratchpad, `CLAUDE_PLUGIN_DATA/sessions`, and `~/.cache/claude-jev` fallback state. Explain uninstall removes plugin data unless `--keep-data`, but users should remove the legacy fallback manually.

- [ ] **Step 4: Update architecture and skill**

Change architecture status to implemented and reviewed. Replace per-attempt timeout claims with total deadline semantics. Remove unsupported universal prompt-host detection claims. Keep exact Claude fields and TypeSafe answer shapes linked to official docs. In the skill, emphasize automatic hooks and `claude-jev check`; label exact session controls as advanced and requiring explicit IDs.

- [ ] **Step 5: Run docs, full tests, and build**

Run: `node --experimental-strip-types --test tests/cli.test.ts`
Expected: PASS.

Run: `npm test && npm run build`
Expected: PASS except explicit skips.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/architecture.md skills/jev/SKILL.md tests/cli.test.ts dist
git commit -m "docs: clarify plugin trust and lifecycle"
```

### Task 10: Final verification and review report

**Files:**
- Modify only if verification finds a regression, using a new failing test before any behavior fix.

**Interfaces:**
- Produces: evidence-backed final assessment with exact file and line references, completed changes, remaining risks, and deferred publication work.

- [ ] **Step 1: Verify plugin suite and build**

```bash
cd /Users/drdimitru/Sites/claude-jev-plugin
npm ci --ignore-scripts
npm test
npm run typecheck
npm run build
```

Expected: all local tests pass; two real API tests skip unless explicit opt-in exists.

- [ ] **Step 2: Compare generated artifacts**

```bash
git diff --exit-code -- dist
```

Expected: no diff after build.

- [ ] **Step 3: Validate plugin and package**

```bash
claude plugin validate . --strict --json
npm pack --dry-run --json
```

Expected: strict validation succeeds without warnings; package contains only allowlisted runtime and documentation files.

- [ ] **Step 4: Validate marketplace**

```bash
cd /Users/drdimitru/Sites/claude-plugins-marketplace
npm test
claude plugin validate . --strict --json
```

Expected: both succeed without warnings.

- [ ] **Step 5: Verify clean marketplace clone**

Clone to a temporary directory without recursive options. Run `npm test` and confirm no `.gitmodules`, no gitlink mode `160000`, and no local plugin directory dependency.

- [ ] **Step 6: Run Git integrity checks**

In both repositories:

```bash
git diff --check
git fsck --no-progress --connectivity-only
git status --short --branch
```

In marketplace:

```bash
test ! -e .gitmodules
test -z "$(git ls-files -s | awk '$1 == "160000" { print }')"
```

Expected: no whitespace errors or connectivity failures; no marketplace submodule remains. Report intended commits and any unrelated status without altering it.

- [ ] **Step 7: Check remote publication dependency without credentials**

```bash
curl -L -s -o /dev/null -w '%{http_code}\n' https://github.com/dr-dimitru/claude-jev-plugin
curl -L -s -o /dev/null -w '%{http_code}\n' https://github.com/dr-dimitru/claude-plugins-marketplace
```

Expected before publication: HTTP 404 remains a reported blocker. Do not create repositories, change visibility, push, or publish.

- [ ] **Step 8: Prepare final report**

Report:

- executive assessment;
- findings grouped Critical, Important, and Minor;
- exact final file and line references;
- completed refactor order and commits;
- test, build, plugin validation, marketplace validation, package, and Git evidence;
- skipped real API verification and why;
- remaining risks, including TypeSafe semantic errors, external data processing, Claude hook timeout fail-open behavior, and inaccessible remote repositories.
