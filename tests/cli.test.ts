import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { sessionStore } from "../src/hook-io.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BIN_PATH = path.join(REPO_ROOT, "bin", "claude-jev");
const SKILL_PATH = path.join(REPO_ROOT, "skills", "jev", "SKILL.md");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  options?: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    input?: string;
  }
): RunResult {
  const mergedEnv = {
    ...process.env,
    ...(options?.env ?? {}),
  };
  const res = spawnSync(process.execPath, [BIN_PATH, ...args], {
    cwd: options?.cwd ?? REPO_ROOT,
    env: mergedEnv as NodeJS.ProcessEnv,
    input: options?.input,
    encoding: "utf-8",
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function runCliAsync(
  args: string[],
  options?: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    input?: string;
  },
): Promise<RunResult> {
  const mergedEnv = { ...process.env, ...(options?.env ?? {}) };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      cwd: options?.cwd ?? REPO_ROOT,
      env: mergedEnv as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (status) =>
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
      }),
    );
    child.stdin.end(options?.input ?? "");
  });
}

describe("claude-jev CLI", { concurrency: false }, () => {
  let tempDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-jev-cli-test-"));
  });

  after(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("package metadata", () => {
    it("declares runtime, license, package files, and opt-in enablement", () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
      const plugin = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf8")
      );

      assert.equal(pkg.license, "BSD-3-Clause");
      assert.equal(pkg.engines.node, ">=22.6");
      assert.equal(plugin.defaultEnabled, false);
      assert.equal(plugin.license, "BSD-3-Clause");
      assert.ok(Array.isArray(pkg.files));
      assert.ok(pkg.devDependencies.typescript);
      assert.ok(
        pkg.scripts.check.indexOf("build") < pkg.scripts.check.indexOf("test"),
        "check must build committed runtime before CLI tests execute"
      );
    });

    it("has no lockfile, pins typescript exactly, and has no runtime dependencies", () => {
      assert.equal(fs.existsSync(path.join(REPO_ROOT, "package-lock.json")), false);
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
      assert.match(pkg.devDependencies.typescript, /^\d+\.\d+\.\d+$/);
      assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0);
    });
  });

  describe("File existence and permissions", () => {
    it("bin/claude-jev exists and is executable", () => {
      assert.ok(fs.existsSync(BIN_PATH), "bin/claude-jev must exist");
      const stat = fs.statSync(BIN_PATH);
      // On Unix, check executable bit (mode & 0o111)
      assert.ok(
        (stat.mode & 0o111) !== 0,
        "bin/claude-jev must have executable permissions"
      );
    });

    it("starts with node shebang", () => {
      const content = fs.readFileSync(BIN_PATH, "utf-8");
      assert.ok(
        content.startsWith("#!/usr/bin/env node"),
        "bin/claude-jev must start with #!/usr/bin/env node shebang"
      );
    });
  });

  describe("hook subprocess privacy", () => {
    it("uses a generic malformed hook diagnostic without echoing input", () => {
      const synthetic = "SYNTHETIC_CREDENTIAL_FRAGMENT";
      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", path.join(REPO_ROOT, "src/hooks/pre-tool.ts")],
        {
          cwd: REPO_ROOT,
          input: synthetic,
          encoding: "utf8",
        }
      );

      assert.equal(result.status, 0);
      assert.match(result.stdout, /claude-jev: malformed hook payload/i);
      assert.equal(result.stdout.includes(synthetic), false);
      assert.doesNotMatch(result.stdout, /unexpected token|invalid json/i);
    });
  });

  describe("status command", () => {
    it("reports global/project config status and labels session state unknown when --session-id is omitted", () => {
      const res = runCli(["status"], {
        env: { TYPESAFE_API_KEY: "secret-key-should-never-be-printed" },
      });
      assert.strictEqual(res.status, 0, `CLI exited with error: ${res.stderr}`);
      assert.match(res.stdout, /claude-jev status/i);
      assert.match(res.stdout, /gate:/i);
      assert.match(res.stdout, /output:/i);
      assert.match(res.stdout, /session.*unknown/i);
      // Ensure API key is NEVER printed
      assert.ok(
        !res.stdout.includes("secret-key-should-never-be-printed"),
        "API key must never be printed in status output"
      );
    });

    it("reports exact session status when --session-id is provided", async () => {
      const sessionId = "cli-status-sess-1";
      const scratchpadDir = path.join(tempDir, "scratch-status");
      const store = sessionStore({ sessionId, scratchpadDir });
      await store.setOverrides({ enabled: true, mode: "enforce" });

      const res = runCli([
        "status",
        "--session-id",
        sessionId,
        "--scratchpad-dir",
        scratchpadDir,
      ]);
      assert.strictEqual(res.status, 0, `CLI error: ${res.stderr}`);
      assert.match(res.stdout, /session/i);
      assert.match(res.stdout, /enforce/i);
      assert.doesNotMatch(res.stdout, /session.*unknown/i);
    });
  });

  describe("Session-only toggles (enable, disable, mode)", () => {
    it("enable requires --session-id or reports exact session state unavailable", () => {
      const res = runCli(["enable"]);
      assert.notStrictEqual(res.status, 0);
      assert.match(
        res.stderr + res.stdout,
        /--session-id.*required|session state.*unavailable/i
      );
    });

    it("enable writes session override only and does not touch config files", async () => {
      const sessionId = "cli-enable-sess";
      const scratchpadDir = path.join(tempDir, "scratch-enable");
      const fakeProjectDir = path.join(tempDir, "proj-enable");
      fs.mkdirSync(fakeProjectDir, { recursive: true });

      const res = runCli(
        ["enable", "--session-id", sessionId, "--scratchpad-dir", scratchpadDir],
        { cwd: fakeProjectDir }
      );
      assert.strictEqual(res.status, 0, `CLI error: ${res.stderr}`);
      assert.match(res.stdout, /enabled/i);

      // Verify session store has override enabled: true
      const store = sessionStore({ sessionId, scratchpadDir });
      const overrides = await store.getOverrides();
      assert.strictEqual(overrides.enabled, true);

      // Verify no config file was created or mutated
      const configFile = path.join(fakeProjectDir, ".claude", "claude-jev.json");
      assert.ok(!fs.existsSync(configFile), "Config file must never be created or modified by session toggles");
    });

    it("disable requires --session-id or reports exact session state unavailable", () => {
      const res = runCli(["disable"]);
      assert.notStrictEqual(res.status, 0);
      assert.match(
        res.stderr + res.stdout,
        /--session-id.*required|session state.*unavailable/i
      );
    });

    it("disable writes session override only and does not touch config files", async () => {
      const sessionId = "cli-disable-sess";
      const scratchpadDir = path.join(tempDir, "scratch-disable");
      const fakeProjectDir = path.join(tempDir, "proj-disable");
      fs.mkdirSync(fakeProjectDir, { recursive: true });

      const res = runCli(
        ["disable", "--session-id", sessionId, "--scratchpad-dir", scratchpadDir],
        { cwd: fakeProjectDir }
      );
      assert.strictEqual(res.status, 0, `CLI error: ${res.stderr}`);
      assert.match(res.stdout, /disabled/i);

      const store = sessionStore({ sessionId, scratchpadDir });
      const overrides = await store.getOverrides();
      assert.strictEqual(overrides.enabled, false);

      const configFile = path.join(fakeProjectDir, ".claude", "claude-jev.json");
      assert.ok(!fs.existsSync(configFile), "Config file must never be created or modified by session toggles");
    });

    it("mode validates valid choices (shadow, enforce) and rejects unknown modes", () => {
      const res = runCli(["mode", "invalid-mode", "--session-id", "sess-mode"]);
      assert.notStrictEqual(res.status, 0);
      assert.match(res.stderr + res.stdout, /shadow|enforce/i);
    });

    it("mode requires --session-id or reports exact session state unavailable", () => {
      const res = runCli(["mode", "shadow"]);
      assert.notStrictEqual(res.status, 0);
      assert.match(
        res.stderr + res.stdout,
        /--session-id.*required|session state.*unavailable/i
      );
    });

    it("mode shadow and mode enforce write session overrides only", async () => {
      const sessionId = "cli-mode-sess";
      const scratchpadDir = path.join(tempDir, "scratch-mode");
      const store = sessionStore({ sessionId, scratchpadDir });

      const resShadow = runCli([
        "mode",
        "shadow",
        "--session-id",
        sessionId,
        "--scratchpad-dir",
        scratchpadDir,
      ]);
      assert.strictEqual(resShadow.status, 0, `CLI error: ${resShadow.stderr}`);
      assert.match(resShadow.stdout, /shadow/i);
      let overrides = await store.getOverrides();
      assert.strictEqual(overrides.mode, "shadow");

      const resEnforce = runCli([
        "mode",
        "enforce",
        "--session-id",
        sessionId,
        "--scratchpad-dir",
        scratchpadDir,
      ]);
      assert.strictEqual(resEnforce.status, 0, `CLI error: ${resEnforce.stderr}`);
      assert.match(resEnforce.stdout, /enforce/i);
      overrides = await store.getOverrides();
      assert.strictEqual(overrides.mode, "enforce");
    });
  });

  describe("last and output verdict summaries", () => {
    it("last requires --session-id or reports unavailable", () => {
      const res = runCli(["last"]);
      assert.notStrictEqual(res.status, 0);
      assert.match(
        res.stderr + res.stdout,
        /--session-id.*required|session state.*unavailable/i
      );
    });

    it("last reports when no gate verdict exists for session", () => {
      const res = runCli([
        "last",
        "--session-id",
        "empty-sess-last",
        "--scratchpad-dir",
        tempDir,
      ]);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /no.*verdict/i);
    });

    it("last prints concise typed summary and never dumps full raw state", async () => {
      const sessionId = "sess-last-verdict";
      const scratchpadDir = path.join(tempDir, "scratch-last");
      const store = sessionStore({ sessionId, scratchpadDir });
      await store.setLastVerdict("gate", {
        flagged: true,
        reasons: ["destructive 0.95", "impact 2.80/3"],
        scores: {
          destructive: 0.95,
          exfiltration: 0.12,
          beyond_scope: 0.35,
          impact: 2.8,
          impactConfidence: 0.91,
        },
        rawSecretThatMustNotAppear: "SECRET_VALUE_XYZ",
      });

      const res = runCli([
        "last",
        "--session-id",
        sessionId,
        "--scratchpad-dir",
        scratchpadDir,
      ]);
      assert.strictEqual(res.status, 0, `CLI error: ${res.stderr}`);
      assert.match(res.stdout, /flagged/i);
      assert.match(res.stdout, /destructive/i);
      assert.match(res.stdout, /0\.95/);
      assert.ok(
        !res.stdout.includes("SECRET_VALUE_XYZ"),
        "Raw secret in verdict object must not be printed"
      );
    });

    it("output requires --session-id or reports unavailable", () => {
      const res = runCli(["output"]);
      assert.notStrictEqual(res.status, 0);
      assert.match(
        res.stderr + res.stdout,
        /--session-id.*required|session state.*unavailable/i
      );
    });

    it("output reports when no output verdict exists for session", () => {
      const res = runCli([
        "output",
        "--session-id",
        "empty-sess-out",
        "--scratchpad-dir",
        tempDir,
      ]);
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /no.*verdict/i);
    });

    it("output prints concise summary and never prints raw secrets or raw output text", async () => {
      const sessionId = "sess-output-verdict";
      const scratchpadDir = path.join(tempDir, "scratch-output");
      const store = sessionStore({ sessionId, scratchpadDir });
      await store.setLastVerdict("output", {
        flagged: true,
        leaksSecret: true,
        leakScore: 0.98,
        failureClass: "transient",
        failureConfidence: 0.85,
        advice: "Retrying the same command unchanged is reasonable.",
        rawSecretThatMustNotAppear: "LEAKED_API_KEY_9999",
      });

      const res = runCli([
        "output",
        "--session-id",
        sessionId,
        "--scratchpad-dir",
        scratchpadDir,
      ]);
      assert.strictEqual(res.status, 0, `CLI error: ${res.stderr}`);
      assert.match(res.stdout, /flagged/i);
      assert.match(res.stdout, /leak/i);
      assert.match(res.stdout, /transient/i);
      assert.ok(
        !res.stdout.includes("LEAKED_API_KEY_9999"),
        "Raw secret must never be printed in output summary"
      );
    });
  });

  describe("manual check command", { concurrency: 1 }, () => {
    const mockFetchImport = pathToFileURL(
      path.join(REPO_ROOT, "tests", "fixtures", "mock-fetch.mjs")
    ).href;
    const gateResponse = (destructive: number, impact: number) => JSON.stringify({
      model: "jev-test",
      answers: {
        destructive: { type: "noul", noul: destructive },
        exfiltration: { type: "noul", noul: 0.05 },
        beyond_scope: { type: "noul", noul: 0.1 },
        impact: {
          type: "score",
          score: impact,
          legend: {
            "0": "None, it only reads",
            "1": "Small, one file or one reversible change",
            "2": "Large, many files or shared state",
            "3": "Severe, data loss or a forced overwrite of shared history",
          },
          probabilities: impact >= 2.5
            ? { "0": 0, "1": 0, "2": 0, "3": 1 }
            : { "0": 1, "1": 0, "2": 0, "3": 0 },
          confidence: 0.9,
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const runMockedCheck = async (
      text: string,
      response: string,
      options?: { apiKey?: string; status?: number }
    ) => {
      const capturePath = path.join(
        tempDir,
        `capture-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
      );
      const result = await runCliAsync(
        ["check", text],
        {
          env: {
            TYPESAFE_API_KEY: options?.apiKey ?? "test-api-key",
            NODE_OPTIONS: `--import=${mockFetchImport}`,
            CLAUDE_JEV_TEST_CAPTURE: capturePath,
            CLAUDE_JEV_TEST_RESPONSE: response,
            CLAUDE_JEV_TEST_STATUS: String(options?.status ?? 200),
          },
        }
      );
      const request = fs.existsSync(capturePath)
        ? JSON.parse(fs.readFileSync(capturePath, "utf8"))
        : undefined;
      return { result, request };
    };

    it("sends the same four gate questions to the direct client, applies local thresholds, and prints concise typed results", async () => {
      const { result, request } = await runMockedCheck(
        "rm -rf /tmp/test && git push --force",
        gateResponse(0.95, 3)
      );

      assert.strictEqual(result.status, 0, `CLI error: ${result.stderr}`);
      assert.match(result.stdout, /flagged:\s*(yes|true)/i);
      assert.match(result.stdout, /destructive/i);
      assert.match(result.stdout, /0\.95/);
      assert.ok(request.questions.destructive);
      assert.ok(request.questions.exfiltration);
      assert.ok(request.questions.beyond_scope);
      assert.ok(request.questions.impact);
      assert.strictEqual(request.questions.destructive.type, "noul");
      assert.strictEqual(request.questions.impact.type, "score");
      assert.match(request.state.tool_input.command, /-rf/);
      assert.match(request.state.tool_input.command, /--force/);
    });

    it("bounds oversized input and never prints unbounded input", async () => {
      const hugeInput = "echo " + "A".repeat(5000);
      const { result, request } = await runMockedCheck(
        hugeInput,
        gateResponse(0.1, 0)
      );

      assert.strictEqual(result.status, 0, `CLI error: ${result.stderr}`);
      const command = request.state?.tool_input?.command ?? "";
      assert.ok(command.includes("chars elided]"));
      assert.ok(command.length < 1000);
    });

    it("handles missing API key safely without unhandled exception", () => {
      const result = runCli(["check", "echo hello"], {
        env: { TYPESAFE_API_KEY: "" },
      });
      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr + result.stdout, /missing.*api.*key|TYPESAFE_API_KEY/i);
    });

    it("reports API failures by fixed category without the response body or key", async () => {
      const apiKey = "synthetic-key-for-redaction";
      const { result } = await runMockedCheck(
        "echo test",
        `Invalid secret: ${apiKey}`,
        { apiKey, status: 401 }
      );

      assert.notStrictEqual(result.status, 0);
      const combined = result.stderr + result.stdout;
      assert.equal(combined.includes(apiKey), false);
      assert.equal(combined.includes("Invalid secret"), false);
      assert.match(result.stderr, /no TypeSafe judgment available \(HTTP_401, HTTP 401\)/);
    });

    it("ignores an --endpoint flag and sends only to the configured endpoint", async () => {
      const helpResult = runCli(["--help"]);
      assert.strictEqual(helpResult.status, 0);
      assert.ok(!helpResult.stdout.includes("--endpoint"), "help must not include --endpoint");

      const home = fs.mkdtempSync(path.join(tempDir, "home-"));
      const callsPath = path.join(tempDir, `calls-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
      const result = await runCliAsync(
        ["check", "ls", "--endpoint", "https://evil.test/x"],
        {
          env: {
            HOME: home,
            TYPESAFE_API_KEY: "test-api-key",
            NODE_OPTIONS: `--import=${mockFetchImport}`,
            CLAUDE_JEV_TEST_CALLS: callsPath,
            CLAUDE_JEV_TEST_RESPONSE: gateResponse(0.1, 0),
          },
        }
      );
      assert.strictEqual(result.status, 0, `CLI error: ${result.stderr}`);
      const urls = fs.readFileSync(callsPath, "utf8").trim().split("\n");
      assert.deepEqual(urls, ["https://api.typesafe.ai/v1/systemone"]);
    });
  });

  describe("ask command", { concurrency: 1 }, () => {
    const mockFetchImport = pathToFileURL(
      path.join(REPO_ROOT, "tests", "fixtures", "mock-fetch.mjs")
    ).href;
    const SECRET = "STATE-SECRET-MARKER-42";
    const request = {
      state: { decision: "Pick a database", facts: [SECRET] },
      questions: {
        fit_a: { type: "score", instructions: "How well does A fit?", criteria: ["Poor", "Mixed", "Strong"] },
        pick: { type: "choice", instructions: "Which option?", criteria: { a: "Option A", b: null } },
        risky: { type: "noul", instructions: "Is either option risky?" },
      },
    };
    const okResponse = (model = "jev-1.13.0") => JSON.stringify({
      model,
      debug: SECRET,
      answers: {
        fit_a: {
          type: "score",
          score: 1.6,
          legend: { "0": "Poor", "1": "Mixed", "2": "Strong" },
          probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 },
          confidence: 0.8,
        },
        pick: { type: "choice", choice: "a", probabilities: { a: 0.7, b: 0.3 }, confidence: 0.6 },
        risky: { type: "noul", noul: 0.2 },
        unrequested: { type: "noul", noul: 0.9 },
      },
      usage: { input_tokens: 10, output_tokens: 3, trace: SECRET },
    });

    const runAsk = async (
      input: string,
      options?: { args?: string[]; response?: string; status?: number; apiKey?: string | null; model?: string }
    ) => {
      const home = fs.mkdtempSync(path.join(tempDir, "home-"));
      if (options?.model !== undefined) {
        fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
        fs.writeFileSync(
          path.join(home, ".claude", "claude-jev.json"),
          JSON.stringify({ model: options.model })
        );
      }
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const capturePath = path.join(tempDir, `ask-capture-${id}.json`);
      const callsPath = path.join(tempDir, `ask-calls-${id}.txt`);
      const result = await runCliAsync(["ask", ...(options?.args ?? [])], {
        input,
        cwd: home,
        env: {
          HOME: home,
          TYPESAFE_API_KEY: options?.apiKey === null ? "" : options?.apiKey ?? "test-api-key",
          NODE_OPTIONS: `--import=${mockFetchImport}`,
          CLAUDE_JEV_TEST_CAPTURE: capturePath,
          CLAUDE_JEV_TEST_CALLS: callsPath,
          CLAUDE_JEV_TEST_RESPONSE: options?.response ?? okResponse(),
          CLAUDE_JEV_TEST_STATUS: String(options?.status ?? 200),
        },
      });
      const body = fs.existsSync(capturePath)
        ? JSON.parse(fs.readFileSync(capturePath, "utf8"))
        : undefined;
      const calls = fs.existsSync(callsPath)
        ? fs.readFileSync(callsPath, "utf8").trim().split("\n")
        : [];
      return { result, body, calls };
    };

    it("documents ask in help", () => {
      const result = runCli(["--help"]);
      assert.match(result.stdout, /claude-jev ask < request\.json/);
    });

    it("sends all questions in one request with the configured model and prints validated JSON", async () => {
      const { result, body, calls } = await runAsk(JSON.stringify(request));
      assert.strictEqual(result.status, 0, `CLI error: ${result.stderr}`);
      assert.equal(calls.length, 1);
      assert.equal(body.model, "jev-latest");
      assert.deepEqual(Object.keys(body.questions).sort(), ["fit_a", "pick", "risky"]);
      assert.deepEqual(body.state, request.state);

      const out = JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(out), ["model", "usage", "answers"]);
      assert.equal(out.model, "jev-1.13.0");
      assert.deepEqual(out.usage, { input_tokens: 10, output_tokens: 3 });
      assert.deepEqual(Object.keys(out.answers).sort(), ["fit_a", "pick", "risky"]);
      assert.equal(out.answers.pick.choice, "a");
      assert.equal(result.stdout.includes(SECRET), false);
      assert.equal(result.stderr, "");
    });

    it("uses the model from trusted global config", async () => {
      const { result, body } = await runAsk(JSON.stringify(request), {
        model: "jev-preview",
        response: okResponse("jev-1.13.0"),
      });
      assert.strictEqual(result.status, 0, `CLI error: ${result.stderr}`);
      assert.equal(body.model, "jev-preview");
    });

    it("rejects a cross-family model answer without falling back", async () => {
      const { result, calls } = await runAsk(JSON.stringify(request), {
        model: "kev-latest",
        response: okResponse("jev-1.13.0"),
      });
      assert.equal(result.status, 1);
      assert.equal(calls.length, 1);
      assert.match(result.stderr, /no TypeSafe judgment available \(MODEL_MISMATCH\)/);
      assert.equal(result.stdout, "");
    });

    it("reports an unavailable model without the response body or submitted state", async () => {
      const { result, calls } = await runAsk(JSON.stringify(request), {
        model: "kev-latest",
        status: 422,
        response: `unknown model; echo ${SECRET}`,
      });
      assert.equal(result.status, 1);
      assert.equal(calls.length, 1);
      assert.match(result.stderr, /HTTP_422, HTTP 422\) for model kev-latest/);
      assert.equal(result.stderr.includes(SECRET), false);
      assert.equal(result.stdout, "");
    });

    it("fails on a malformed response without fabricating answers", async () => {
      const bad = JSON.parse(okResponse());
      delete bad.answers.pick;
      const { result } = await runAsk(JSON.stringify(request), { response: JSON.stringify(bad) });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /MALFORMED_RESPONSE/);
      assert.equal(result.stdout, "");
    });

    it("rejects invalid input before any request", async () => {
      for (const input of ["", "not json", JSON.stringify({ state: {}, questions: {} })]) {
        const { result, calls } = await runAsk(input);
        assert.equal(result.status, 2, input);
        assert.match(result.stderr, /invalid decision request/);
        assert.equal(calls.length, 0);
      }
    });

    it("accepts 32 questions and rejects 33 before any request", async () => {
      const make = (n: number) => {
        const questions: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) questions[`q${i}`] = { type: "noul", instructions: "Is it?" };
        return JSON.stringify({ state: "s", questions });
      };
      const answers: Record<string, unknown> = {};
      for (let i = 0; i < 32; i++) answers[`q${i}`] = { type: "noul", noul: 0.5 };
      const ok = await runAsk(make(32), {
        response: JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 1, output_tokens: 1 } }),
      });
      assert.strictEqual(ok.result.status, 0, ok.result.stderr);
      assert.equal(ok.calls.length, 1);

      const tooMany = await runAsk(make(33));
      assert.equal(tooMany.result.status, 2);
      assert.equal(tooMany.calls.length, 0);
    });

    it("rejects oversized streamed input and never echoes it", async () => {
      const input = JSON.stringify({ state: SECRET + "x".repeat(70 * 1024), questions: request.questions });
      const { result, calls } = await runAsk(input);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /INPUT_TOO_LARGE/);
      assert.equal(result.stderr.includes(SECRET), false);
      assert.equal(calls.length, 0);
    });

    it("keeps invalid question text out of diagnostics", async () => {
      const input = JSON.stringify({
        state: SECRET,
        questions: { q: { type: "score", instructions: SECRET, criteria: [SECRET] } },
      });
      const { result, calls } = await runAsk(input);
      assert.equal(result.status, 2);
      assert.equal(result.stderr.includes(SECRET), false);
      assert.equal(calls.length, 0);
    });

    it("requires an API key after validating input", async () => {
      const { result, calls } = await runAsk(JSON.stringify(request), { apiKey: null });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Missing TypeSafe API key/);
      assert.equal(calls.length, 0);
    });

    it("calls a local Kev endpoint without TYPESAFE_API_KEY or an Authorization header", async () => {
      const home = fs.mkdtempSync(path.join(tempDir, "home-"));
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".claude", "claude-jev.json"),
        JSON.stringify({ model: "kev-latest", endpoint: "http://127.0.0.1:8009/v1/systemone" })
      );
      const callsPath = path.join(tempDir, `ask-local-${Date.now()}.txt`);
      const result = await runCliAsync(["ask"], {
        input: JSON.stringify(request),
        cwd: home,
        env: {
          HOME: home,
          TYPESAFE_API_KEY: "",
          NODE_OPTIONS: `--import=${mockFetchImport}`,
          CLAUDE_JEV_TEST_CALLS: callsPath,
          CLAUDE_JEV_TEST_RESPONSE: okResponse("kev-latest"),
        },
      });
      assert.strictEqual(result.status, 0, `CLI error: ${result.stderr}`);
      assert.deepEqual(fs.readFileSync(callsPath, "utf8").trim().split("\n"), [
        "http://127.0.0.1:8009/v1/systemone",
      ]);
      assert.equal(JSON.parse(result.stdout).model, "kev-latest");

      const status = runCli(["status"], { cwd: home, env: { HOME: home, TYPESAFE_API_KEY: "" } });
      assert.match(status.stdout, /not required for local endpoint/);
      assert.match(status.stdout, /Endpoint: local/);
    });

    it("rejects model, endpoint, and positional overrides", async () => {
      for (const args of [
        ["--model", "kev-latest"],
        ["--model"],
        ["--model=kev-latest"],
        ["--endpoint", "https://evil.test/x"],
        ["extra"],
      ]) {
        const { result, calls } = await runAsk(JSON.stringify(request), { args });
        assert.equal(result.status, 2, args.join(" "));
        assert.match(result.stderr, /ask takes no arguments or options/);
        assert.equal(calls.length, 0);
      }
    });

    it("times out when stdin remains idle without input", async () => {
      const home = fs.mkdtempSync(path.join(tempDir, "home-"));
      const mergedEnv = {
        ...process.env,
        HOME: home,
        CLAUDE_JEV_STDIN_TIMEOUT_MS: "300",
      };

      const result = await new Promise<RunResult>((resolve, reject) => {
        const child = spawn(process.execPath, [BIN_PATH, "ask"], {
          cwd: home,
          env: mergedEnv as NodeJS.ProcessEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });

        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let done = false;

        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            child.kill();
            reject(new Error("Process did not end within 5 seconds"));
          }
        }, 5000);

        child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
        child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
        child.on("error", (err) => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            reject(err);
          }
        });
        child.on("close", (status) => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolve({
              status,
              stdout: Buffer.concat(stdout).toString("utf-8"),
              stderr: Buffer.concat(stderr).toString("utf-8"),
            });
          }
        });
      });

      assert.equal(result.status, 2);
      assert.match(result.stderr, /no input arrived within 300 ms/);
    });
  });

  describe("documentation", () => {
    it("documents opt-in lifecycle, trusted transport, state, and total deadline", () => {
      const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
      for (const marker of [
        "defaultEnabled",
        "/plugin enable claude-jev@dr-dimitru-claude-tools",
        "/plugin update claude-jev@dr-dimitru-claude-tools",
        "/plugin disable claude-jev@dr-dimitru-claude-tools",
        "/plugin uninstall claude-jev@dr-dimitru-claude-tools",
        "BSD-3-Clause",
        "Project configuration cannot set",
        "CLAUDE_PLUGIN_DATA/sessions",
        "total request deadline",
      ]) {
        assert.ok(readme.includes(marker), `README is missing: ${marker}`);
      }
      assert.doesNotMatch(readme, /non-interactive run[^\n]*therefore fails open/i);
    });

    it("links every TypeSafe integration guide with Mermaid diagrams", () => {
      const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
      const guides = [
        "type-safe-integration.md",
        "pre-tool-judgments.md",
        "output-judgments.md",
        "reliability-and-privacy.md",
        "end-to-end-example.md",
      ];

      for (const guide of guides) {
        const relativePath = `docs/${guide}`;
        const fullPath = path.join(REPO_ROOT, relativePath);
        assert.ok(fs.existsSync(fullPath), `Missing guide: ${relativePath}`);
        assert.ok(
          readme.includes(`](${relativePath})`),
          `README does not link ${relativePath}`
        );
        assert.ok(pkg.files.includes(relativePath), `Package excludes ${relativePath}`);
        const content = fs.readFileSync(fullPath, "utf8");
        assert.match(content, /^# /, `${relativePath} needs a title`);
        assert.match(content, /```mermaid/, `${relativePath} needs a Mermaid diagram`);
        const mermaidCount = (content.match(/```mermaid/g) ?? []).length;
        const asciiCount = (content.match(/\*\*ASCII version\*\*/g) ?? []).length;
        assert.equal(
          asciiCount,
          mermaidCount,
          `${relativePath} needs one ASCII companion per Mermaid diagram`
        );
      }
    });

    it("marks architecture as implemented and reviewed", () => {
      const architecture = fs.readFileSync(
        path.join(REPO_ROOT, "docs", "architecture.md"),
        "utf8"
      );
      assert.match(architecture, /Status: Implemented and reviewed/);
      assert.doesNotMatch(architecture, /Runtime code is not implemented yet/);
    });
  });

  describe("Skill content markers in skills/jev/SKILL.md", () => {
    it("skills/jev/SKILL.md exists with valid frontmatter", () => {
      assert.ok(fs.existsSync(SKILL_PATH), "skills/jev/SKILL.md must exist");
      const content = fs.readFileSync(SKILL_PATH, "utf-8");
      assert.ok(
        content.startsWith("---"),
        "SKILL.md must start with YAML frontmatter delimiter ---"
      );
      const frontmatterEnd = content.indexOf("---", 3);
      assert.ok(
        frontmatterEnd > 3,
        "SKILL.md must have closing frontmatter delimiter ---"
      );
      const frontmatter = content.slice(3, frontmatterEnd);
      assert.match(frontmatter, /name:\s*jev/i);
      assert.match(frontmatter, /description:/i);
    });

    it("contains all required instruction markers and constraints", () => {
      const content = fs.readFileSync(SKILL_PATH, "utf-8");

      // When explicit Jev judgments help
      assert.match(
        content,
        /when explicit jev judgments help|explicit judgment/i,
        "Must explain when explicit judgments help"
      );

      // Noul vs Choice vs Score
      assert.match(content, /noul/i, "Must cover Noul");
      assert.match(content, /choice/i, "Must cover Choice");
      assert.match(content, /score/i, "Must cover Score");

      // Batching independent questions
      assert.match(content, /batch/i, "Must cover batching independent questions");

      // No Jev for deterministic calculations / exact lookups
      assert.match(
        content,
        /deterministic|exact lookup/i,
        "Must prohibit Jev for deterministic calculations or exact lookups"
      );

      // Confidence is not authorization
      assert.match(
        content,
        /confidence is not authorization/i,
        "Must state that confidence is not authorization"
      );

      // Do not reimplement automatic gate logic
      assert.match(
        content,
        /do not reimplement.*gate/i,
        "Must instruct not to reimplement automatic gate logic"
      );

      // Automatic judgments come from hooks
      assert.match(
        content,
        /hook/i,
        "Must state that automatic judgments come from hooks"
      );

      // Namespaced skill/CLI is the closest native replacement for Pi jev_ask
      assert.match(
        content,
        /jev_ask/i,
        "Must mention replacement for Pi jev_ask"
      );

      // Exact session toggles need --session-id
      assert.match(
        content,
        /--session-id/i,
        "Must explain that exact session toggles need --session-id"
      );
    });
  });
  describe("decide skill and decision helper docs", () => {
    const decidePath = path.join(REPO_ROOT, "skills", "decide", "SKILL.md");
    const read = (...parts: string[]) =>
      fs.readFileSync(path.join(REPO_ROOT, ...parts), "utf8");

    it("decide skill is user-invoked only and names the ask command", () => {
      assert.ok(fs.existsSync(decidePath), "skills/decide/SKILL.md must exist");
      const content = fs.readFileSync(decidePath, "utf8");
      assert.match(content, /^---\n[\s\S]*?\n---/);
      assert.match(content, /name:\s*decide/i);
      assert.match(content, /disable-model-invocation:\s*true/i);
      assert.match(content, /claude-jev ask/i);
    });

    it("decide skill requires follow-ups, confirmation, and advisory handling", () => {
      const content = fs.readFileSync(decidePath, "utf8");
      assert.match(content, /follow-up questions?/i);
      assert.match(content, /confirmation[\s\S]*before|before[\s\S]*confirm/i);
      assert.match(content, /noul/i);
      assert.match(content, /score/i);
      assert.match(content, /choice/i);
      assert.match(content, /advisory/i);
      assert.match(content, /not[^.\n]*authorization/i);
      assert.match(content, /no automatic model fallback|never retry with another model|do not retry with another model/i);
    });

    it("jev skill links the decide skill", () => {
      const content = fs.readFileSync(SKILL_PATH, "utf8");
      assert.match(content, /\/claude-jev:decide/);
    });

    it("README documents ask, hosted model ID, and limits", () => {
      const readme = read("README.md");
      assert.match(readme, /claude-jev ask/i);
      assert.match(readme, /jev-1\.13\.0/i);
      assert.match(readme, /64 KiB/i);
      assert.match(readme, /32 questions/i);
      assert.match(readme, /\/claude-jev:decide/);
    });

    it("guides document the decision helper", () => {
      for (const file of ["type-safe-integration.md", "reliability-and-privacy.md", "architecture.md"]) {
        assert.match(read("docs", file), /claude-jev ask/i, `${file} must mention claude-jev ask`);
      }
    });
  });
});
