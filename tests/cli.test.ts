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
    child.stdin.on("error", (error: { code?: string }) => {
      if (error.code !== "EPIPE") reject(error);
    });
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
        ["check", text, "--endpoint", "https://typesafe.test/v1/systemone"],
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

    it("keeps a missing check endpoint value in existing positional handling", () => {
      const result = runCli(["check", "--endpoint"], {
        env: { TYPESAFE_API_KEY: "" },
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr + result.stdout, /missing.*api.*key/i);
    });

    it("redacts API keys from errors when API fails", async () => {
      const apiKey = "synthetic-key-for-redaction";
      const { result } = await runMockedCheck(
        "echo test",
        `Invalid secret: ${apiKey}`,
        { apiKey, status: 401 }
      );

      assert.notStrictEqual(result.status, 0);
      const combined = result.stderr + result.stdout;
      assert.equal(combined.includes(apiKey), false);
      assert.match(combined, /\[REDACTED\]/);
    });
  });

  describe("ask command", { concurrency: 1 }, () => {
    const mockFetchImport = pathToFileURL(
      path.join(REPO_ROOT, "tests", "fixtures", "mock-fetch.mjs")
    ).href;
    const stateSecret = "PRIVATE_USAGE_ECHO_STATE_6072";
    const state = {
      decision: "Choose the option that fits the stated constraints.",
      constraints: ["Keep existing user data intact.", stateSecret],
    };
    const questions = {
      option_a_fit: {
        type: "noul",
        instructions: "Does Option A fit the stated constraints?",
      },
      option_b_fit: {
        type: "noul",
        instructions: "Does Option B fit the stated constraints?",
      },
    };
    const validInput = JSON.stringify({ state, questions });
    const validResponse = {
      model: "provider/custom-model-v2",
      answers: {
        option_a_fit: { type: "noul", noul: 0.8 },
        option_b_fit: { type: "noul", noul: 0.4 },
      },
      usage: {
        input_tokens: 12,
        output_tokens: 0,
        echoed_state: stateSecret,
      },
      internal_response_field: "RESPONSE_EXTENSION_SECRET",
    };

    const inputWithUtf8Bytes = (targetBytes: number) => {
      const baseQuestions = {
        ...questions,
        option_a_fit: { ...questions.option_a_fit, instructions: "" },
      };
      const baseInput = JSON.stringify({ state, questions: baseQuestions });
      const fillBytes = targetBytes - Buffer.byteLength(baseInput, "utf8");
      const instructions = "é".repeat(Math.floor(fillBytes / 2)) +
        (fillBytes % 2 === 1 ? "a" : "");
      const input = JSON.stringify({
        state,
        questions: {
          ...baseQuestions,
          option_a_fit: { ...baseQuestions.option_a_fit, instructions },
        },
      });
      assert.equal(Buffer.byteLength(input, "utf8"), targetBytes);
      assert.ok(input.length < targetBytes);
      return input;
    };

    const runMockedAsk = async (
      args: string[] = ["ask"],
      input: string = validInput,
      response: unknown = validResponse,
      options?: { apiKey?: string; model?: string; status?: number }
    ) => {
      const caseDir = fs.mkdtempSync(path.join(tempDir, "ask-case-"));
      const cwd = path.join(caseDir, "project");
      const home = path.join(caseDir, "home");
      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(home, { recursive: true });

      if (options?.model !== undefined) {
        const globalConfigDir = path.join(home, ".claude");
        fs.mkdirSync(globalConfigDir, { recursive: true });
        fs.writeFileSync(
          path.join(globalConfigDir, "claude-jev.json"),
          JSON.stringify({ model: options.model }),
          "utf8"
        );
      }

      const capturePath = path.join(caseDir, "request.json");
      const callCountPath = path.join(caseDir, "call-count.txt");
      const result = await runCliAsync(args, {
        cwd,
        input,
        env: {
          HOME: home,
          TYPESAFE_API_KEY: options?.apiKey ?? "test-api-key",
          NODE_OPTIONS: `--import=${mockFetchImport}`,
          CLAUDE_JEV_TEST_CAPTURE: capturePath,
          CLAUDE_JEV_TEST_CALL_COUNT: callCountPath,
          CLAUDE_JEV_TEST_RESPONSE:
            typeof response === "string" ? response : JSON.stringify(response),
          CLAUDE_JEV_TEST_STATUS: String(options?.status ?? 200),
        },
      });
      const request = fs.existsSync(capturePath)
        ? JSON.parse(fs.readFileSync(capturePath, "utf8"))
        : undefined;
      const callCount = fs.existsSync(callCountPath)
        ? Number(fs.readFileSync(callCountPath, "utf8"))
        : 0;
      return { result, request, callCount };
    };

    it("lists ask in help output", () => {
      const result = runCli(["--help"]);

      assert.equal(result.status, 0);
      assert.match(result.stdout, /claude-jev ask/i);
    });

    it("sends configured model and all questions once, then prints only validated fields", async () => {
      const selectedModel = "provider/custom-model-v2";
      const { result, request, callCount } = await runMockedAsk(
        ["ask"],
        validInput,
        validResponse,
        { model: selectedModel }
      );

      assert.equal(result.status, 0, result.stderr);
      assert.equal(callCount, 1);
      assert.deepEqual(request, {
        model: selectedModel,
        state,
        questions,
      });
      const output = JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(output).sort(), ["answers", "model", "usage"]);
      assert.deepEqual(output, {
        model: validResponse.model,
        usage: { input_tokens: 12, output_tokens: 0 },
        answers: validResponse.answers,
      });
      assert.equal(result.stdout.includes("RESPONSE_EXTENSION_SECRET"), false);
      assert.equal(result.stdout.includes(stateSecret), false);
      assert.equal(result.stderr, "");
    });

    it("fails safely when the API key is missing", async () => {
      const { result, request, callCount } = await runMockedAsk(
        ["ask"],
        validInput,
        validResponse,
        { apiKey: "" }
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr + result.stdout, /missing.*api.*key/i);
      assert.equal(request, undefined);
      assert.equal(callCount, 0);
    });

    it("rejects invalid input without making a network request or echoing it", async () => {
      const privateState = "PRIVATE_DECISION_STATE_3128";
      const { result, request, callCount } = await runMockedAsk(
        ["ask"],
        `{"state":"${privateState}"`,
        validResponse
      );

      assert.notEqual(result.status, 0);
      assert.equal(request, undefined);
      assert.equal(callCount, 0);
      assert.match(result.stderr + result.stdout, /invalid decision request/i);
      assert.equal((result.stdout + result.stderr).includes(privateState), false);
    });

    it("accepts exactly 64 KiB of UTF-8 input and rejects one byte above before a request", async () => {
      const atLimit = await runMockedAsk(["ask"], inputWithUtf8Bytes(64 * 1024));
      assert.equal(atLimit.result.status, 0, atLimit.result.stderr);
      assert.equal(atLimit.callCount, 1);
      assert.ok(JSON.parse(atLimit.result.stdout).answers.option_a_fit);
      assert.equal(Object.keys(atLimit.request.questions).length, 2);

      const aboveLimit = await runMockedAsk(["ask"], inputWithUtf8Bytes(64 * 1024 + 1));
      assert.notEqual(aboveLimit.result.status, 0);
      assert.equal(aboveLimit.request, undefined);
      assert.equal(aboveLimit.callCount, 0);
      assert.match(aboveLimit.result.stderr + aboveLimit.result.stdout, /64\s*KiB|too large/i);
    });

    it("accepts 32 questions and rejects 33 before a request", async () => {
      const questionsAtLimit = Object.fromEntries(
        Array.from({ length: 32 }, (_, index) => [
          `q${index}`,
          { type: "noul", instructions: `Evaluate question ${index}.` },
        ])
      );
      const questionsAboveLimit = Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [
          `q${index}`,
          { type: "noul", instructions: `Evaluate question ${index}.` },
        ])
      );
      const answers = Object.fromEntries(
        Array.from({ length: 32 }, (_, index) => [`q${index}`, { type: "noul", noul: 0.5 }])
      );
      const response = {
        model: "jev-latest",
        answers,
        usage: { input_tokens: 1, output_tokens: 0 },
      };

      const atLimit = await runMockedAsk(
        ["ask"],
        JSON.stringify({ state: { decision: "Choose." }, questions: questionsAtLimit }),
        response
      );
      assert.equal(atLimit.result.status, 0, atLimit.result.stderr);
      assert.equal(atLimit.callCount, 1);
      assert.equal(Object.keys(atLimit.request.questions).length, 32);

      const aboveLimit = await runMockedAsk(
        ["ask"],
        JSON.stringify({ state: { decision: "Choose." }, questions: questionsAboveLimit }),
        response
      );
      assert.notEqual(aboveLimit.result.status, 0);
      assert.equal(aboveLimit.request, undefined);
      assert.equal(aboveLimit.callCount, 0);
    });

    it("does not fall back to Jev when the configured model fails", async () => {
      const selectedModel = "provider/unavailable-model";
      const privateState = "PRIVATE_MODEL_FAILURE_STATE_4481";
      const { result, request, callCount } = await runMockedAsk(
        ["ask"],
        JSON.stringify({ state: { note: privateState }, questions }),
        `Upstream rejected request containing ${privateState}`,
        { model: selectedModel, status: 404 }
      );

      assert.notEqual(result.status, 0);
      assert.ok(request, "ask must send selected-model request");
      assert.equal(callCount, 1);
      assert.equal(request.model, selectedModel);
      assert.match(result.stderr, /404/);
      assert.equal((result.stdout + result.stderr).includes(privateState), false);
      assert.equal(result.stderr.includes("Upstream rejected"), false);
    });

    it("reports malformed responses without echoing state or response fields", async () => {
      const privateState = "PRIVATE_MALFORMED_RESPONSE_STATE_7791";
      const { result, request, callCount } = await runMockedAsk(
        ["ask"],
        JSON.stringify({ state: { note: privateState }, questions }),
        {
          model: "provider/custom-model-v2",
          answers: { option_a_fit: { type: "noul", noul: "invalid" } },
          usage: { input_tokens: 1, output_tokens: 0 },
          echoed_state: privateState,
        }
      );

      assert.notEqual(result.status, 0);
      assert.ok(request, "ask must send request before response validation");
      assert.equal(callCount, 1);
      assert.equal((result.stdout + result.stderr).includes(privateState), false);
      assert.equal(result.stderr.includes("echoed_state"), false);
    });

    it("rejects per-request model, endpoint, and positional overrides", async () => {
      for (const args of [
        ["ask", "--model", "jev-latest"],
        ["ask", "--model"],
        ["ask", "--endpoint", "https://typesafe.test/v1/systemone"],
        ["ask", "--endpoint"],
        ["ask", "unexpected-position"],
      ]) {
        const { result, request, callCount } = await runMockedAsk(args);

        assert.notEqual(result.status, 0, args.join(" "));
        assert.match(result.stderr + result.stdout, /ask command.*does not accept/i);
        assert.equal(request, undefined, args.join(" "));
        assert.equal(callCount, 0, args.join(" "));
      }
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

  describe("decision skill", () => {
    const decideSkillPath = path.join(REPO_ROOT, "skills", "decide", "SKILL.md");

    it("has required on-demand workflow and trust boundaries", () => {
      assert.ok(fs.existsSync(decideSkillPath), "skills/decide/SKILL.md must exist");
      const content = fs.readFileSync(decideSkillPath, "utf8");
      assert.ok(content.startsWith("---"), "decision skill needs frontmatter");
      const frontmatterEnd = content.indexOf("---", 3);
      assert.ok(frontmatterEnd > 3, "decision skill needs closing frontmatter");
      assert.match(content.slice(3, frontmatterEnd), /name:\s*decide/i);

      for (const [pattern, label] of [
        [/claude-jev ask/i, "CLI command"],
        [/node\s+["']\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/claude-jev["']\s+ask/i, "bundled CLI path"],
        [/follow-up/i, "focused user follow-up"],
        [/bounded/i, "bounded context"],
        [/sensitive/i, "sensitive-data handling"],
        [/noul/i, "Noul questions"],
        [/choice/i, "Choice questions"],
        [/score/i, "Score questions"],
        [/advisory/i, "advisory-only results"],
        [/recommendation/i, "Claude's own recommendation"],
      ]) {
        assert.match(content, pattern, `Decision skill is missing ${label}`);
      }
    });

    it("links the decision skill from Jev skill and README", () => {
      const jevSkill = fs.readFileSync(SKILL_PATH, "utf8");
      const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");

      assert.match(jevSkill, /\.\.\/decide\/SKILL\.md/);
      assert.match(readme, /\/claude-jev:decide/);
      assert.ok(readme.includes("docs/type-safe-integration.md"));
      assert.ok(readme.includes("docs/reliability-and-privacy.md"));
    });
  });
});
