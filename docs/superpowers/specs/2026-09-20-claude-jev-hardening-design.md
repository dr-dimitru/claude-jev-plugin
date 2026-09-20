# Claude Jev hardening design

## Status

Approved design for hardening `claude-jev-plugin` and preparing `claude-plugins-marketplace` for publication. No publication or push is part of this work.

## Goals

- Prevent project-controlled configuration from disclosing TypeSafe credentials or redirecting bounded judgment data.
- Match current Claude Code hook and TypeSafe API contracts.
- Preserve explicit fail-open behavior when no valid judgment is available.
- Make cache, deduplication, and session state correct across concurrent hook processes.
- Reduce installation, upgrade, disablement, and uninstall friction.
- Make plugin and marketplace validation meaningful in clean checkouts.
- Add regression tests before behavior changes.

## Non-goals

- No MCP server or MCP dependency.
- No hard security-sandbox claim.
- No publication, remote push, or live marketplace registration.
- No real TypeSafe request without existing explicit test opt-in.
- No attempt to infer every non-interactive Claude Code environment from undocumented hook fields.

## Repository ownership

`claude-jev-plugin` remains the only source repository for plugin code. `claude-plugins-marketplace` becomes a catalog that references that repository through Claude Code's documented `github` plugin source. The marketplace will not use a Git submodule or duplicate plugin source.

The marketplace reference can validate structurally before publication. Installation still requires the plugin repository to be reachable through the user's GitHub credentials or publicly accessible.

## Trust boundaries

### Project configuration

Project configuration may control judgment behavior:

- enabled state;
- shadow or enforce mode;
- selected tools;
- payload bounds;
- cache duration;
- thresholds;
- `blockWithoutUI` behavior.

Project configuration must not control:

- API keys;
- API key files;
- endpoint URLs;
- request timeout;
- retry count or retry delays.

This prevents a repository from redirecting the environment API key and bounded local data to an attacker-controlled endpoint.

### Global configuration and environment

`TYPESAFE_API_KEY` remains the preferred secret source. Global user configuration may provide an API key file and transport settings. Relative key-file paths resolve against the global configuration directory, not the project working directory.

Every configured endpoint must use HTTPS. Tests may inject a fetch implementation and do not need a live endpoint. Explicit CLI endpoint overrides follow the same HTTPS rule.

### External data

The plugin sends only documented bounded state. It never sends session IDs, transcript paths, agent identities, raw cache records, or API keys as state. Documentation must state that bounded source text, prompts, commands, and command output can leave the machine.

## Hook contracts

Hook configuration keeps exec-form command handlers through `command` plus `args`. Each hook reads one bounded JSON object from stdin and returns either no stdout or one event-valid JSON object.

- `UserPromptSubmit` stores a bounded prompt only when the gate is enabled and credentials are configured.
- `PreToolUse` handles Bash, Write, and Edit. Shadow mode warns. Enforce mode returns `permissionDecision: "ask"` for flagged actions.
- `PostToolUse` handles successful Bash results and may return `additionalContext` or a schema-compatible `updatedToolOutput`.
- `PostToolUseFailure` handles top-level failure text and may return `additionalContext`, but never output replacement.

Claude Code documents `permission_mode`, but it does not provide a universal prompt-host boolean. The plugin may recognize documented modes such as `dontAsk` and `bypassPermissions`. It must not claim reliable detection of every headless execution context. In unknown contexts, Claude Code owns the behavior of an `ask` decision.

Hook entry points must avoid immediate `process.exit()` after writing stdout. They set an exit code or await output completion so structured responses cannot be truncated.

## TypeSafe client

The client sends one request containing all independent questions for a judgment.

A call has one total deadline, including:

- request connection and headers;
- response-body reads;
- JSON parsing;
- retry delays;
- all retry attempts.

Retries apply only to network failures, timeouts, HTTP 429, HTTP 529, and retryable server failures. Delay grows exponentially with bounded jitter. A valid `Retry-After` value may extend the delay only within the remaining total deadline.

Response validation checks the documented answer contract and each expected question:

- answer type matches question type;
- required values are finite and in range;
- choice values and probability keys belong to declared criteria;
- score legends and probability keys match declared score levels;
- probability maps are non-empty and approximately sum to one;
- required top-level response fields are present when required by current TypeSafe documentation.

Any malformed response produces no verdict. Local verdict evaluation never converts an unknown choice or malformed distribution into a clear judgment.

## Cache and session state

### Cache keys

Cache keys derive from the exact bounded state sent to TypeSafe plus:

- model;
- question definitions;
- effective thresholds;
- relevant payload-bound settings;
- current working directory already present in state.

The output path must not build a default-bounded cache key and then send differently bounded state. Hooks build bounded state once and use it for both the key and request.

### Cache lifetime

File entries retain their original expiry time when loaded into memory. Reading an old file must not restart its TTL.

### Cross-process coordination

The lock lease exceeds the maximum producer lifetime or is renewed while the producer runs. Waiters may wait only within the hook's remaining deadline. They do not delete a lock held by a live producer merely because a short static stale interval passed.

If coordination cannot complete before the deadline, the waiter returns no verdict. It does not start a duplicate request by default.

### Session updates

Session record read-modify-write operations use a per-session lock. Atomic rename still protects file integrity, while the lock protects against lost updates.

Tool-use deduplication becomes one atomic claim operation. Concurrent success and failure events for the same `tool_use_id` cannot both claim it. Verdict records remain separate for gate and output inspection.

Session and cache paths include session ID and optional agent ID hashes. The PreToolUse cache must pass agent identity as the other hooks do.

## Failure behavior

The plugin fails open when it has no validated TypeSafe judgment because of:

- missing credentials;
- invalid configuration;
- timeout or abort;
- network failure;
- retry exhaustion;
- malformed response;
- cache coordination timeout;
- local state failure;
- Claude hook timeout.

A no-verdict state is not cached as clear. Diagnostics contain fixed local wording, never parser excerpts, response bodies, request state, command output, prompts, or credentials. Diagnostics remain rate-limited without relying on race-prone updates.

A validated unsafe verdict remains distinct from infrastructure failure. Shadow mode warns. Enforce mode asks. Explicit deny in documented non-interactive modes is available only when `blockWithoutUI` is true.

## Privacy and retention

Prompt capture is conditional and bounded. Cache records contain verdicts rather than raw request state. Session records contain bounded prompts, summaries, overrides, IDs, and timestamps.

Fallback state has a documented path and retention policy. Where practical, plugin-owned persistent state should use Claude Code's plugin data directory so standard uninstall removes it unless the user requests `--keep-data`. Scratchpad state remains session-local when Claude provides `scratchpad_dir`.

Uninstall documentation names any custom fallback directories that users may remove manually.

## Code structure

Shared modules own repeated behavior:

- hook payload validation and common context extraction;
- tool-name normalization;
- rate-limited fixed diagnostics;
- output judgment execution and response formatting;
- bounded-state construction and cache-key generation;
- locked session mutations.

The refactor must preserve public CLI behavior unless a documented security correction requires a change. Unused duplicate judgment paths should be removed or routed through the shared implementation.

## Plugin UX

The plugin manifest sets `defaultEnabled: false` because enabling the plugin sends data to an external service and can incur cost. Installation instructions require users to:

1. install the plugin;
2. set `TYPESAFE_API_KEY` outside project configuration;
3. review privacy and default payload settings;
4. enable the plugin explicitly;
5. start or reload Claude Code.

The CLI keeps `status`, `check`, and exact session controls. Documentation explains that session controls require a hook session ID and scratchpad path, which limits their convenience. The skill should prioritize automatic-hook behavior and manual `check` usage rather than imply full Pi command parity.

## Packaging

The plugin package adds:

- a supported Node engine range;
- a pinned TypeScript development dependency and lockfile;
- license, repository, homepage, and keywords;
- an explicit package file list;
- check, build, validation, and package-inspection scripts.

Published contents include runtime files, manifests, hooks, skill, user documentation, license, and generated declarations where useful. Tests, source maps, fixtures, internal plans, and superpowers artifacts are excluded unless needed for source distribution.

Generated `dist` remains committed because hooks must run immediately after installation. Verification compares a fresh build with committed output.

## Marketplace metadata

The marketplace adds a description and complete plugin metadata useful before installation. The plugin entry uses a documented GitHub source object for `dr-dimitru/claude-jev-plugin`. Version authority lives in the plugin manifest only. The marketplace entry does not duplicate the version.

The submodule gitlink and `.gitmodules` are removed. Validation includes a clean clone where the marketplace contains no uninitialized plugin directory dependency.

## Documentation

Update README and architecture documentation to cover:

- current implementation status;
- current Claude hook fields and event behavior;
- TypeSafe endpoint and answer shapes;
- total timeout and retry semantics;
- trusted versus project-configurable fields;
- exact data sent externally;
- fail-open limits;
- unsupported universal prompt-host detection;
- install, enable, update, disable, and uninstall commands;
- state locations and retention;
- marketplace repository accessibility requirements.

## Test strategy

Each behavior change starts with a failing regression test. Required cases include:

- project config cannot set secret or transport fields;
- global transport settings remain supported;
- non-HTTPS endpoints fail before fetch;
- response-body hangs obey the total deadline;
- retries obey the total deadline and bounded backoff;
- `Retry-After` is honored only within budget;
- malformed choice and score distributions produce no verdict;
- slow concurrent producers do not duplicate requests;
- file-cache reads preserve original expiry;
- concurrent session updates preserve independent fields;
- duplicate tool-use claims are atomic;
- gate and output cache keys include all effective inputs;
- main-thread and subagent caches remain isolated;
- prompt capture skips disabled or unconfigured operation;
- hook entry points flush structured output;
- marketplace metadata uses the GitHub source and has no submodule.

Existing malformed payload, state-bound, output replacement, API redaction, CLI, and calibration tests remain.

## Verification

Run after implementation:

1. full unit and integration suite with real API tests skipped unless already explicitly enabled;
2. TypeScript build;
3. clean generated-output comparison;
4. strict plugin validation;
5. strict marketplace validation;
6. package dry run and file-list inspection;
7. clean-clone marketplace inspection;
8. Git diff checks and object/connectivity checks in both repositories;
9. checks that no gitlink or `.gitmodules` entry remains;
10. final status showing no unexpected files and no exposed secrets.

## Remaining publication dependency

No local change can make the documented GitHub installation URL usable while both repositories return HTTP 404 to unauthenticated users. Publication requires repository creation or visibility changes and pushes, which remain outside this task.
