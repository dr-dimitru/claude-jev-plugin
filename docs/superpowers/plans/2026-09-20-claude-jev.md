# claude-jev implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native Claude Code plugin that sends bounded hook state to TypeSafe Jev, gates Bash/Write/Edit calls, judges Bash results, and fails open on Jev infrastructure errors.

**Architecture:** Plugin command hooks invoke compiled Node modules through `hooks/hooks.json`. Pure client, config, state shaping, cache, gate, and output modules stay independent of Claude hook I/O. Session state uses Claude's `session_id` and bounded files so separate hook processes can share cache entries, in-flight locks, last verdicts, and session overrides without an MCP server.

**Tech Stack:** TypeScript, Node.js built-in `fetch`, `AbortController`, `fs`, `crypto`, and test runner; no runtime dependency required for the hook path.

**Spec:** `docs/architecture.md`

## Global constraints

- Do not add an MCP server, MCP tool, or persistent MCP process.
- Send one batched request for the four pre-tool questions and one batched request for the two Bash-output questions.
- Default thresholds remain `destructive: 0.90`, `exfiltration: 0.70`, `beyondScope: 0.85`, `impact: 2.50`, `leakThreshold: 0.90`, and output `minConfidence: 0.60`.
- Missing key, timeout, network error, HTTP 429, malformed response, and TypeSafe outage fail open and produce rate-limited diagnostics.
- Read no full conversation by default. Bound user text to 1200 characters, argument strings to 400 characters, output to 2000 characters, and serialized state to 8000 characters.
- Read `TYPESAFE_API_KEY` from the environment. Do not require an API key in JSON configuration.
- Hook stdout contains only valid JSON when a hook returns a result. Infrastructure failures exit successfully with no decision.
- Never put raw API keys, full secrets, or unbounded tool input in diagnostics or state files.

## Review focus

- A malformed or oversized hook payload must exit fail-open without shell evaluation; test in `tests/hook-io.test.ts`.
- A flagged enforce verdict must return `permissionDecision: "ask"`, never `allow`; test in `tests/pre-tool.test.ts`.
- A Bash leak verdict must replace a schema-valid Bash output without copying original output into diagnostics; test in `tests/post-tool.test.ts`.
- A failed Bash payload must use top-level `error` and must not be treated as a successful `tool_response`; test in `tests/post-tool-failure.test.ts`.
- Two hook processes judging the same state must share one cached result and recover from a stale lock; test in `tests/cache.test.ts`.

### Task 1: Scaffold the plugin and direct Jev client

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/client.ts`
- Create: `tests/client.test.ts`

**Interfaces:**
- `askJev(call: JevCall): Promise<JevResponse>` posts the current TypeSafe request body to `https://api.typesafe.ai/v1/systemone`.
- `JevQuestion`, `JevAnswer`, `JevResponse`, and `JevError` model validated wire data.
- `redact(text: string): string` removes registered API-key values from diagnostics.

- [ ] **Step 1: Write failing client tests** for the exact request body, Bearer header, timeout, abort, 429/529 retry classification, malformed JSON, malformed answer, and API-key redaction.
- [ ] **Step 2: Run** `npm test -- --runInBand tests/client.test.ts` and confirm the new tests fail because client modules do not exist.
- [ ] **Step 3: Implement** fetch-based request and response validation. Retry only configured transient statuses and 5xx responses. Keep response-body error text bounded and redacted.
- [ ] **Step 4: Run** `npm test -- --runInBand tests/client.test.ts` and confirm all client tests pass.
- [ ] **Step 5: Run** `npm run build` and confirm compiled hook imports contain no Pi or MCP imports.

### Task 2: Config, bounded state, and session storage

**Files:**
- Create: `src/config.ts`
- Create: `src/state.ts`
- Create: `src/hook-io.ts`
- Create: `tests/config.test.ts`
- Create: `tests/state.test.ts`
- Create: `tests/hook-io.test.ts`

**Interfaces:**
- `loadConfig(cwd: string): LoadedConfig` applies defaults, `~/.claude/claude-jev.json`, `.claude/claude-jev.json`, then environment secrets.
- `buildGateState(input: GateInput): JsonValue` produces only bounded `cwd`, `tool`, `tool_input`, and recent user request fields.
- `buildOutputState(input: OutputInput): JsonValue` produces only bounded tool, error flag, bounded arguments, and bounded output.
- `readHookInput(stream: NodeJS.ReadableStream): Promise<unknown>` parses one bounded JSON object and rejects arrays, primitives, invalid JSON, and over-limit input.
- `sessionStore(input): SessionStore` reads and atomically writes session data under a hashed session key.

- [ ] **Step 1: Write failing tests** for default values, global/project precedence, invalid-field rejection, environment key precedence, nested string truncation, aggregate state bounds, Unicode-safe markers, and session-path traversal resistance.
- [ ] **Step 2: Run** `npm test -- --runInBand tests/config.test.ts tests/state.test.ts tests/hook-io.test.ts` and confirm failure.
- [ ] **Step 3: Implement** strict JSON config parsing, recursive bounded summaries, final serialized-state enforcement, and atomic bounded session files. Use `…[N chars elided]` for argument/output fields.
- [ ] **Step 4: Add** prompt storage keyed by `session_id` and optional `agent_id`; store only the last 1200 characters needed by the next gate.
- [ ] **Step 5: Run** the focused tests and `npm run build`.

### Task 3: Gate composition and minimal Bash vertical slice

**Files:**
- Create: `src/gate.ts`
- Create: `src/cache.ts`
- Create: `src/hooks/user-prompt.ts`
- Create: `src/hooks/pre-tool.ts`
- Create: `hooks/hooks.json`
- Create: `tests/gate.test.ts`
- Create: `tests/cache.test.ts`
- Create: `tests/pre-tool.test.ts`

**Interfaces:**
- `GATE_QUESTIONS` contains `destructive`, `exfiltration`, `beyond_scope`, and `impact`.
- `evaluateGate(response, config): GateVerdict` applies the four source thresholds and impact confidence floor.
- `judgmentKey(state, questions, model): string` hashes normalized bounded input, not object identity.
- `getOrCreateCached(key, ttlMs, producer): Promise<T>` shares cached and locked results across hook processes.
- `runPreTool(payload): Promise<HookOutput>` returns no output for clear calls, `systemMessage` for shadow flags, and `permissionDecision: "ask"` for enforce flags.

- [ ] **Step 1: Write failing gate tests** for the safe `git status --short`, destructive `rm -rf src && git push --force origin main`, exfiltration curl, requested edit, and out-of-scope system-file edit fixtures using fixed Jev answers.
- [ ] **Step 2: Write failing cache tests** for normalized object key ordering, TTL expiry, concurrent lock sharing, stale-lock recovery, and bounded cache size.
- [ ] **Step 3: Implement** pure gate questions/composition and cache protocol. Cache successful verdicts only; never cache infrastructure failures as safe.
- [ ] **Step 4: Implement** `UserPromptSubmit` prompt capture and the `PreToolUse` Bash handler. On a Jev failure, return no decision and rate-limit a `systemMessage`.
- [ ] **Step 5: Run** focused tests and invoke a built hook with representative JSON stdin to verify stdout is either empty or valid JSON.

### Task 4: Add Write/Edit coverage and enforce configuration

**Files:**
- Modify: `src/hooks/pre-tool.ts`
- Modify: `hooks/hooks.json`
- Modify: `src/config.ts`
- Modify: `tests/pre-tool.test.ts`
- Modify: `README.md`

**Interfaces:**
- The same pre-tool handler accepts `Bash`, `Write`, and `Edit`; it uses Claude's absolute `tool_input.file_path` without shell interpolation.
- `gate.mode` supports `shadow` and `enforce`; `gate.blockWithoutUI` defaults false and is configurable.
- Session override values take precedence over project config without mutating config files.

- [ ] **Step 1: Add failing tests** for Write content truncation, Edit old/new string truncation, absolute Windows paths, shadow warnings, enforce ask output, and fail-open headless behavior.
- [ ] **Step 2: Implement** tool-name normalization and session override lookup. Never return `allow` merely because a Jev verdict is high confidence.
- [ ] **Step 3: Run** gate, cache, hook-contract, and config tests.
- [ ] **Step 4: Run** `claude plugin validate .` when Claude Code is available; record any version-specific warning.

### Task 5: Output judge and failed Bash lifecycle

**Files:**
- Create: `src/output.ts`
- Create: `src/hooks/post-tool.ts`
- Create: `src/hooks/post-tool-failure.ts`
- Modify: `hooks/hooks.json`
- Create: `tests/output.test.ts`
- Create: `tests/post-tool.test.ts`
- Create: `tests/post-tool-failure.test.ts`

**Interfaces:**
- `OUTPUT_QUESTIONS` contains `leaks_secret` and `failure_class` with six source-equivalent classes.
- `normalizeToolOutput(payload): NormalizedOutput` accepts successful `tool_response` and failed top-level `error` forms.
- `evaluateOutput(response, config): OutputVerdict` maps failure classes to fixed advice and never asks Jev for prose.
- `redactBashOutput(toolResponse): BashOutput` replaces the whole known Bash output with a generic safe notice when leak threshold is crossed.

- [ ] **Step 1: Write failing tests** for success, `ECONNRESET`, `EADDRINUSE`, `TS2322`, `EACCES`, command-not-found, missing Git repository, AWS key, `.env`, private key, and hard-coded credential diff fixtures.
- [ ] **Step 2: Implement** output state truncation, output-key hashing, duplicate `tool_use_id` suppression, and one batched API request per normalized result.
- [ ] **Step 3: Implement** `PostToolUse.updatedToolOutput` only for a schema-recognized Bash object. Use `additionalContext` for deterministic advice and `systemMessage` for user warnings.
- [ ] **Step 4: Implement** `PostToolUseFailure` with no replacement claim. Preserve the failure text only in the bounded request; never include it in diagnostics when a leak is flagged.
- [ ] **Step 5: Run** output and lifecycle tests plus malformed payload tests.

### Task 6: CLI, skill, package docs, and local UX

**Files:**
- Create: `bin/claude-jev`
- Create: `skills/jev/SKILL.md`
- Create: `README.md`
- Create: `LICENSE`
- Modify: `.claude-plugin/plugin.json`
- Modify: `package.json`
- Create: `tests/cli.test.ts`

**Interfaces:**
- `claude-jev status`, `enable`, `disable`, `mode shadow`, `mode enforce`, `last`, `output`, and `check <text>` use the same client and state files as hooks.
- `skills/jev/SKILL.md` teaches typed questions and invokes the CLI through the plugin `bin` path only when explicit judgment is useful.
- The CLI accepts `--session-id` for exact session state; without it, it reports project/global state and labels session status unknown.

- [ ] **Step 1: Write failing CLI tests** for status, session-only toggles, mode validation, last verdict summaries, output summaries, manual checks, missing key, and redacted error output.
- [ ] **Step 2: Implement** a no-shell-interpolation CLI with bounded arguments and the same direct client.
- [ ] **Step 3: Write** the concise namespaced skill. State that automatic hook judgments already run and that confidence is not authorization.
- [ ] **Step 4: Write** README sections for installation, environment key, data flow, config, fail-open semantics, redaction limits, performance, limitations, inspection, disablement, and uninstall.
- [ ] **Step 5: Run** unit tests, build, plugin validation, and a package-content check that rejects MCP files or API-key literals.

### Task 7: Integration, performance, and opt-in real API tests

**Files:**
- Create: `tests/integration/real-api.test.ts`
- Create: `tests/fixtures/*.json`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Add** fixture tests for all requested calibration and output cases without network access.
- [ ] **Step 2: Add** real API tests guarded by `TYPESAFE_API_KEY` and `CLAUDE_JEV_REAL_API=1`; skip by default and never run in normal CI.
- [ ] **Step 3: Measure** cold hook startup and warm TypeSafe request latency with a local fixture server; record results without exposing key or payload contents.
- [ ] **Step 4: Run** `npm test`, `npm run build`, `claude plugin validate .`, and the opt-in integration command when credentials are explicitly present.
- [ ] **Step 5: Inspect the final package tree** to confirm no MCP server, no generated shell scripts, no secret fixtures, and no unbounded logging.
