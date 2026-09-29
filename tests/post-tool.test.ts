import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runPostTool } from "../src/hooks/post-tool.ts";
import { runPostToolFailure } from "../src/hooks/post-tool-failure.ts";
import { clearRegisteredApiKeys } from "../src/client.ts";
import { clearMemoryCache } from "../src/cache.ts";
import {
  LEAK_SYSTEM_MESSAGE,
  WITHHELD_OUTPUT_TEXT,
} from "../src/output.ts";

describe("PostToolUse Hook", () => {
  let tmpDir: string;

  beforeEach(() => {
    clearRegisteredApiKeys();
    clearMemoryCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-jev-post-tool-test-"));
  });

  it("success silence: clear Bash output emits no decision / silence", async () => {
    let jevCalled = false;
    const askJevFn = async () => {
      jevCalled = true;
      return {
        answers: {
          leaks_secret: { type: "noul" as const, noul: 0.02 },
          failure_class: {
            type: "choice" as const,
            choice: "no_failure",
            probabilities: { no_failure: 0.98 },
            confidence: 0.98,
          },
        },
      };
    };

    const payload = {
      session_id: "sess-success",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: {
        stdout: "All 12 tests passed",
        stderr: "",
        interrupted: false,
        isImage: false,
      },
    };

    const config: any = {
      model: "jev-latest",
      apiKey: "test-api-key",
      output: {
        enabled: true,
        tools: ["Bash"],
        outputChars: 2000,
        leakThreshold: 0.9,
        minConfidence: 0.6,
        successCheck: "always",
      },
    };

    const result = await runPostTool(payload, {
      askJevFn: askJevFn as any,
      config,
    });

    assert.strictEqual(jevCalled, true);
    assert.strictEqual(result, null);
  });

  it("passes outputChars and maxStateChars into successful output state", async () => {
    let capturedState: any;
    const askJevFn = async (call: any) => {
      capturedState = call.state;
      return {
        answers: {
          leaks_secret: { type: "noul" as const, noul: 0.01 },
          failure_class: {
            type: "choice" as const,
            choice: "no_failure",
            probabilities: { no_failure: 1 },
            confidence: 1,
          },
        },
      };
    };

    const result = await runPostTool(
      {
        session_id: "sess-output-bounds",
        cwd: tmpDir,
        scratchpad_dir: tmpDir,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        tool_response: { stdout: "0123456789ABCDEFGHIJ" },
      },
      {
        askJevFn: askJevFn as any,
        config: {
          model: "jev-latest",
          apiKey: "test-api-key",
          maxStateChars: 8000,
          gate: { argumentChars: 400 },
          timeoutMs: 20000,
          retries: 2,
          output: {
            enabled: true,
            tools: ["Bash"],
            outputChars: 10,
            leakThreshold: 0.9,
            minConfidence: 0.6,
            successCheck: "always",
          },
        } as any,
      },
    );

    assert.equal(result, null);
    assert.ok(capturedState);
    assert.ok(capturedState.output.startsWith("0123456789"));
    assert.match(capturedState.output, /chars elided/);
  });

  it("successful output gets no failure advice even with a confident failure class", async () => {
    let jevCalled = false;
    const askJevFn = async () => {
      jevCalled = true;
      return {
        answers: {
          leaks_secret: { type: "noul" as const, noul: 0.01 },
          failure_class: {
            type: "choice" as const,
            choice: "transient",
            probabilities: { transient: 0.88 },
            confidence: 0.88,
          },
        },
      };
    };

    const payload = {
      session_id: "sess-transient",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "curl https://api.example.com" },
      tool_response: {
        stdout: "",
        stderr: "ECONNRESET",
        interrupted: false,
        isImage: false,
      },
    };

    const config: any = {
      model: "jev-latest",
      apiKey: "test-api-key",
      output: {
        enabled: true,
        tools: ["Bash"],
        outputChars: 2000,
        leakThreshold: 0.9,
        minConfidence: 0.6,
        successCheck: "always",
      },
    };

    const result = await runPostTool(payload, {
      askJevFn: askJevFn as any,
      config,
    });

    // A successful command never gets failure advice, even when its output
    // mentions an error and TypeSafe returns a failure class.
    assert.strictEqual(jevCalled, true);
    assert.strictEqual(result?.systemMessage, undefined);
    assert.strictEqual(result?.hookSpecificOutput?.additionalContext, undefined);
    assert.strictEqual(result?.hookSpecificOutput?.updatedToolOutput, undefined);
  });

  it("low confidence silence: failure advice below minConfidence returns silence", async () => {
    const askJevFn = async () => ({
      answers: {
        leaks_secret: { type: "noul" as const, noul: 0.01 },
        failure_class: {
          type: "choice" as const,
          choice: "transient",
          probabilities: { transient: 0.52 },
          confidence: 0.52, // Below 0.60
        },
      },
    });

    const payload = {
      session_id: "sess-low-conf",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { stdout: "flaky test failed" },
    };

    const config: any = {
      model: "jev-latest",
      apiKey: "test-api-key",
      output: {
        enabled: true,
        tools: ["Bash"],
        outputChars: 2000,
        leakThreshold: 0.9,
        minConfidence: 0.6,
        successCheck: "always",
      },
    };

    const result = await runPostTool(payload, {
      askJevFn: askJevFn as any,
      config,
    });

    assert.strictEqual(result, null);
  });

  it("leak replacement: replaces stdout with WITHHELD_OUTPUT_TEXT, preserves interrupted/isImage, never echoes secret", async () => {
    const secretValue = "AKIAIOSFODNN7EXAMPLE";
    const askJevFn = async () => ({
      answers: {
        leaks_secret: { type: "noul" as const, noul: 0.96 },
        failure_class: {
          type: "choice" as const,
          choice: "no_failure",
          probabilities: { no_failure: 0.9 },
          confidence: 0.9,
        },
      },
    });

    const payload = {
      session_id: "sess-leak",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "env" },
      tool_response: {
        stdout: `AWS_ACCESS_KEY_ID=${secretValue}`,
        stderr: "",
        interrupted: true,
        isImage: false,
        extraField: 123,
      },
    };

    const config: any = {
      model: "jev-latest",
      apiKey: "test-api-key",
      output: {
        enabled: true,
        tools: ["Bash"],
        outputChars: 2000,
        leakThreshold: 0.9,
        minConfidence: 0.6,
        successCheck: "always",
      },
    };

    const result = await runPostTool(payload, {
      askJevFn: askJevFn as any,
      config,
    });

    assert.ok(result);
    assert.strictEqual(result.systemMessage, LEAK_SYSTEM_MESSAGE);
    assert.ok(result.hookSpecificOutput);
    assert.strictEqual(result.hookSpecificOutput.hookEventName, "PostToolUse");

    const updated = result.hookSpecificOutput.updatedToolOutput as any;
    assert.ok(updated);
    assert.strictEqual(updated.stdout, WITHHELD_OUTPUT_TEXT);
    assert.strictEqual(updated.stderr, "");
    assert.strictEqual(updated.interrupted, true);
    assert.strictEqual(updated.isImage, false);
    assert.strictEqual(updated.extraField, 123);

    // Verify secret is NOT leaked anywhere in returned structure
    const serialized = JSON.stringify(result);
    assert.strictEqual(serialized.includes(secretValue), false);
  });

  it("leak with unrecognized tool_response shape: warns via systemMessage but does not replace output", async () => {
    const askJevFn = async () => ({
      answers: {
        leaks_secret: { type: "noul" as const, noul: 0.95 },
        failure_class: {
          type: "choice" as const,
          choice: "no_failure",
          probabilities: { no_failure: 0.9 },
          confidence: 0.9,
        },
      },
    });

    const payload = {
      session_id: "sess-unrec",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "cat secret.txt" },
      tool_response: "raw string response without stdout/stderr",
    };

    const config: any = {
      model: "jev-latest",
      apiKey: "test-api-key",
      output: {
        enabled: true,
        tools: ["Bash"],
        outputChars: 2000,
        leakThreshold: 0.9,
        minConfidence: 0.6,
        successCheck: "always",
      },
    };

    const result = await runPostTool(payload, {
      askJevFn: askJevFn as any,
      config,
    });

    assert.ok(result);
    assert.strictEqual(result.systemMessage, LEAK_SYSTEM_MESSAGE);
    // Because tool_response is not recognized bash response, updatedToolOutput is not set
    assert.strictEqual(result.hookSpecificOutput?.updatedToolOutput, undefined);
  });

  it("malformed successful payload: returns rate-limited diagnostic and fails open", async () => {
    const result = await runPostTool("not an object" as any);
    assert.ok(result);
    assert.ok(result.systemMessage?.includes("malformed hook payload"));
  });

  it("duplicate tool_use_id: suppresses re-judging and returns silence", async () => {
    let callCount = 0;
    const askJevFn = async () => {
      callCount++;
      return {
        answers: {
          leaks_secret: { type: "noul" as const, noul: 0.01 },
          failure_class: {
            type: "choice" as const,
            choice: "transient",
            probabilities: { transient: 0.9 },
            confidence: 0.9,
          },
        },
      };
    };

    const payload = {
      session_id: "sess-dup",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_dup_123",
      tool_input: { command: "curl https://api.example.com" },
      tool_response: { stdout: "", stderr: "ECONNRESET" },
      is_error: true,
    };

    const config: any = {
      model: "jev-latest",
      apiKey: "test-api-key",
      output: {
        enabled: true,
        tools: ["Bash"],
        outputChars: 2000,
        leakThreshold: 0.9,
        minConfidence: 0.6,
        successCheck: "always",
      },
    };

    const first = await runPostTool(payload, {
      askJevFn: askJevFn as any,
      config,
    });
    assert.ok(first);
    assert.strictEqual(callCount, 1);

    const second = await runPostTool(payload, {
      askJevFn: askJevFn as any,
      config,
    });
    assert.strictEqual(callCount, 1); // Not called again!
    assert.strictEqual(second, null); // Duplicate tool_use_id suppressed
  });

  it("infrastructure failure fails open and releases the tool-use claim", async () => {
    let shouldFail = true;
    const askJevFn = async () => {
      if (shouldFail) throw new Error("Network timeout after 15000ms");
      return {
        answers: {
          leaks_secret: { type: "noul" as const, noul: 0.01 },
          failure_class: {
            type: "choice" as const,
            choice: "no_failure",
            probabilities: { no_failure: 1 },
            confidence: 1,
          },
        },
      };
    };

    const payload = {
      session_id: "sess-infra",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_infra_retry",
      tool_input: { command: "npm test" },
      tool_response: { stdout: "tests passed" },
    };

    const config: any = {
      model: "jev-latest",
      apiKey: "test-api-key",
      output: {
        enabled: true,
        tools: ["Bash"],
        outputChars: 2000,
        leakThreshold: 0.9,
        minConfidence: 0.6,
        successCheck: "always",
      },
    };

    const result = await runPostTool(payload, {
      askJevFn: askJevFn as any,
      config,
    });

    assert.ok(result);
    assert.ok(result.systemMessage?.includes("hook failed open"));
    assert.strictEqual(result.hookSpecificOutput, undefined);

    shouldFail = false;
    const retry = await runPostTool(payload, {
      askJevFn: askJevFn as any,
      config,
    });
    assert.equal(retry, null);
  });

  it("output shape validity: schema valid JSON with hookSpecificOutput and systemMessage", async () => {
    const askJevFn = async () => ({
      answers: {
        leaks_secret: { type: "noul" as const, noul: 0.95 },
        failure_class: {
          type: "choice" as const,
          choice: "environment",
          probabilities: { environment: 0.85 },
          confidence: 0.85,
        },
      },
    });

    const payload = {
      session_id: "sess-shape",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUse",
      is_error: true,
      tool_name: "Bash",
      tool_input: { command: "npm start" },
      tool_response: {
        stdout: "API_KEY=12345",
        stderr: "Error: EADDRINUSE: address already in use :::3000",
        interrupted: false,
        isImage: false,
      },
    };

    const config: any = {
      model: "jev-latest",
      apiKey: "test-api-key",
      output: {
        enabled: true,
        tools: ["Bash"],
        outputChars: 2000,
        leakThreshold: 0.9,
        minConfidence: 0.6,
        successCheck: "always",
      },
    };

    const result = await runPostTool(payload, {
      askJevFn: askJevFn as any,
      config,
    });

    assert.ok(result);
    // Must be serializable to valid JSON
    const jsonStr = JSON.stringify(result);
    const parsed = JSON.parse(jsonStr);

    assert.strictEqual(parsed.systemMessage, LEAK_SYSTEM_MESSAGE);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes(
        "claude-jev: this Bash result reads as a environment failure; Fix the environment before retrying."
      )
    );
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes("do not reproduce")
    );
    assert.strictEqual(
      parsed.hookSpecificOutput.updatedToolOutput.stdout,
      WITHHELD_OUTPUT_TEXT
    );
    assert.strictEqual(parsed.hookSpecificOutput.updatedToolOutput.stderr, "");
    assert.strictEqual(parsed.hookSpecificOutput.updatedToolOutput.interrupted, false);
    assert.strictEqual(parsed.hookSpecificOutput.updatedToolOutput.isImage, false);
  });

  it("skips disabled output, unconfigured tool, and missing API key", async () => {
    let called = false;
    const askJevFn = async () => {
      called = true;
      return { answers: {} };
    };

    // 1. Disabled output
    const resDisabled = await runPostTool(
      {
        session_id: "sess-dis",
        cwd: tmpDir,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_response: { stdout: "ok" },
      },
      {
        askJevFn: askJevFn as any,
        config: { output: { enabled: false, tools: ["Bash"] } } as any,
      }
    );
    assert.strictEqual(resDisabled, null);
    assert.strictEqual(called, false);

    // 2. Unconfigured tool
    const resTool = await runPostTool(
      {
        session_id: "sess-dis",
        cwd: tmpDir,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_response: { stdout: "ok" },
      },
      {
        askJevFn: askJevFn as any,
        config: { output: { enabled: true, tools: ["Bash"] } } as any,
      }
    );
    assert.strictEqual(resTool, null);
    assert.strictEqual(called, false);

    // 3. Missing API key
    const resKey = await runPostTool(
      {
        session_id: "sess-nokey",
        cwd: tmpDir,
        scratchpad_dir: tmpDir,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_response: { stdout: "ok" },
      },
      {
        askJevFn: askJevFn as any,
        config: { apiKey: "", output: { enabled: true, tools: ["Bash"] } } as any,
      }
    );
    assert.ok(resKey);
    assert.ok(resKey.systemMessage?.includes("TYPESAFE_API_KEY is not configured"));
    assert.strictEqual(called, false);
  });

  it("atomically deduplicates concurrent success and failure events for one tool use", async () => {
    let callCount = 0;
    const askJevFn = async () => {
      callCount++;
      await new Promise(resolve => setTimeout(resolve, 50));
      return {
        answers: {
          leaks_secret: { type: "noul" as const, noul: 0.01 },
          failure_class: {
            type: "choice" as const,
            choice: "no_failure",
            probabilities: { no_failure: 1 },
            confidence: 1,
          },
        },
      };
    };
    const base = {
      session_id: "sess-cross-event",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      tool_name: "Bash",
      tool_use_id: "toolu_cross_event",
      tool_input: { command: "npm test" },
    };
    const config: any = {
      model: "jev-latest",
      apiKey: "test-api-key",
      maxStateChars: 8000,
      gate: { argumentChars: 400 },
      output: {
        enabled: true,
        tools: ["Bash"],
        outputChars: 2000,
        leakThreshold: 0.9,
        minConfidence: 0.6,
        successCheck: "always",
      },
    };

    await Promise.all([
      runPostTool(
        {
          ...base,
          hook_event_name: "PostToolUse",
          tool_response: { stdout: "ok", stderr: "" },
        },
        { askJevFn: askJevFn as any, config }
      ),
      runPostToolFailure(
        {
          ...base,
          hook_event_name: "PostToolUseFailure",
          error: "Exit code 1",
        },
        { askJevFn: askJevFn as any, config }
      ),
    ]);

    assert.equal(callCount, 1);
  });

  it("concurrent identical PostToolUse payloads share cache coordination and run ask function once", async () => {
    let callCount = 0;
    const askJevFn = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return {
        answers: {
          leaks_secret: { type: "noul" as const, noul: 0.01 },
          failure_class: {
            type: "choice" as const,
            choice: "transient",
            probabilities: { transient: 0.9 },
            confidence: 0.9,
          },
        },
      };
    };

    const payload1 = {
      session_id: "sess-concurrent",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { stdout: "", stderr: "ECONNRESET" },
      is_error: true,
    };
    const payload2 = {
      session_id: "sess-concurrent",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { stdout: "", stderr: "ECONNRESET" },
      is_error: true,
    };

    const config: any = {
      model: "jev-latest",
      apiKey: "test-api-key",
      output: {
        enabled: true,
        tools: ["Bash"],
        outputChars: 2000,
        leakThreshold: 0.9,
        minConfidence: 0.6,
        successCheck: "always",
      },
    };

    const [res1, res2] = await Promise.all([
      runPostTool(payload1, { askJevFn: askJevFn as any, config }),
      runPostTool(payload2, { askJevFn: askJevFn as any, config }),
    ]);

    assert.strictEqual(callCount, 1);
    assert.ok(res1);
    assert.ok(res2);
    assert.strictEqual(
      res1.hookSpecificOutput?.additionalContext,
      "claude-jev: this Bash result reads as a transient failure; Retrying the same command unchanged is reasonable."
    );
    assert.strictEqual(
      res2.hookSpecificOutput?.additionalContext,
      "claude-jev: this Bash result reads as a transient failure; Retrying the same command unchanged is reasonable."
    );
  });

  it("leak response always includes Claude-facing additionalContext instructing Claude not to reproduce the value, even when response shape is not replaceable", async () => {
    const askJevFn = async () => ({
      answers: {
        leaks_secret: { type: "noul" as const, noul: 0.95 },
        failure_class: {
          type: "choice" as const,
          choice: "no_failure",
          probabilities: { no_failure: 0.9 },
          confidence: 0.9,
        },
      },
    });

    const payload = {
      session_id: "sess-leak-context",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "cat token.txt" },
      tool_response: "raw unreplaceable string token=abc12345",
    };

    const config: any = {
      model: "jev-latest",
      apiKey: "test-api-key",
      output: {
        enabled: true,
        tools: ["Bash"],
        outputChars: 2000,
        leakThreshold: 0.9,
        minConfidence: 0.6,
        successCheck: "always",
      },
    };

    const result = await runPostTool(payload, {
      askJevFn: askJevFn as any,
      config,
    });

    assert.ok(result);
    assert.strictEqual(result.systemMessage, LEAK_SYSTEM_MESSAGE);
    assert.ok(result.hookSpecificOutput);
    assert.strictEqual(result.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.ok(result.hookSpecificOutput.additionalContext);
    assert.ok(result.hookSpecificOutput.additionalContext.includes("do not reproduce"));
    assert.strictEqual(result.hookSpecificOutput.updatedToolOutput, undefined);
  });

  it("non-Bash direct payload never receives updatedToolOutput even if leak detected with bash-shaped response", async () => {
    const askJevFn = async () => ({
      answers: {
        leaks_secret: { type: "noul" as const, noul: 0.98 },
        failure_class: {
          type: "choice" as const,
          choice: "no_failure",
          probabilities: { no_failure: 0.9 },
          confidence: 0.9,
        },
      },
    });

    const payload = {
      session_id: "sess-non-bash",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUse",
      tool_name: "CustomTool",
      tool_input: { arg: "foo" },
      tool_response: {
        stdout: "AWS_SECRET=secret123",
        stderr: "",
        interrupted: false,
        isImage: false,
      },
    };

    const config: any = {
      model: "jev-latest",
      apiKey: "test-api-key",
      output: {
        enabled: true,
        tools: ["Bash", "CustomTool"],
        outputChars: 2000,
        leakThreshold: 0.9,
        minConfidence: 0.6,
        successCheck: "always",
      },
    };

    const result = await runPostTool(payload, {
      askJevFn: askJevFn as any,
      config,
    });

    assert.ok(result);
    assert.strictEqual(result.systemMessage, LEAK_SYSTEM_MESSAGE);
    assert.ok(result.hookSpecificOutput);
    assert.strictEqual(result.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.ok(result.hookSpecificOutput.additionalContext?.includes("do not reproduce"));
    assert.strictEqual(result.hookSpecificOutput.updatedToolOutput, undefined);
  });
});

describe("Successful output prefilter", () => {
  let tmpDir: string;
  beforeEach(() => {
    clearRegisteredApiKeys();
    clearMemoryCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-jev-prefilter-test-"));
  });

  const baseConfig = (successCheck?: "prefilter" | "always"): any => ({
    model: "jev-latest",
    apiKey: "test-api-key",
    output: {
      enabled: true,
      tools: ["Bash"],
      outputChars: 2000,
      leakThreshold: 0.9,
      minConfidence: 0.6,
      ...(successCheck ? { successCheck } : {}),
    },
  });

  const payload = (id: string, stdout: string, command = "ls -la", extra: Record<string, unknown> = {}) => ({
    session_id: `sess-${id}`,
    cwd: tmpDir,
    scratchpad_dir: tmpDir,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: `toolu-${id}`,
    tool_input: { command },
    tool_response: { stdout, stderr: "", interrupted: false, isImage: false },
    ...extra,
  });

  const recordingAsk = (calls: any[], noul = 0.01) => async (call: any) => {
    calls.push(call);
    return { model: "jev-1.13.0", answers: { leaks_secret: { type: "noul" as const, noul } } };
  };

  it("skips the TypeSafe call for benign successful output by default", async () => {
    const calls: any[] = [];
    const result = await runPostTool(
      payload("benign", "total 8\ndrwxr-xr-x  3 user staff 96 src\ncommit 3c5fa97e1b2d4f6a8c0e2d4f6a8c0e2d4f6a8c0e"),
      { askJevFn: recordingAsk(calls) as any, config: baseConfig() }
    );
    assert.equal(calls.length, 0);
    assert.equal(result?.hookSpecificOutput?.additionalContext, undefined);
  });

  it("sends credential-like successful output with only the leak question", async () => {
    const calls: any[] = [];
    const result = await runPostTool(
      payload("secret", "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"),
      { askJevFn: recordingAsk(calls, 0.97) as any, config: baseConfig() }
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0].questions), ["leaks_secret"]);
    assert.equal(result?.systemMessage, LEAK_SYSTEM_MESSAGE);
    assert.equal(result?.hookSpecificOutput?.updatedToolOutput?.stdout, WITHHELD_OUTPUT_TEXT);
  });

  it("sends output of a secret-reading command even when it looks benign", async () => {
    const calls: any[] = [];
    await runPostTool(payload("env", "HOME=/Users/me\nSHELL=/bin/zsh", "env | sort"), {
      askJevFn: recordingAsk(calls) as any,
      config: baseConfig(),
    });
    assert.equal(calls.length, 1);
  });

  it("sends every successful output when successCheck is always", async () => {
    const calls: any[] = [];
    await runPostTool(payload("always", "hello"), {
      askJevFn: recordingAsk(calls) as any,
      config: baseConfig("always"),
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0].questions), ["leaks_secret"]);
  });

  it("always judges failed output with both questions", async () => {
    const calls: any[] = [];
    await runPostToolFailure(
      {
        session_id: "sess-fail-prefilter",
        cwd: tmpDir,
        scratchpad_dir: tmpDir,
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_use_id: "toolu-fail-prefilter",
        tool_input: { command: "npm test" },
        error: "Exit code 1\n1 failing",
      },
      {
        askJevFn: (async (call: any) => {
          calls.push(call);
          return {
            model: "jev-1.13.0",
            answers: {
              leaks_secret: { type: "noul" as const, noul: 0.01 },
              failure_class: { type: "choice" as const, choice: "code_bug", probabilities: { code_bug: 1 }, confidence: 0.9 },
            },
          };
        }) as any,
        config: baseConfig(),
      }
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0].questions).sort(), ["failure_class", "leaks_secret"]);
  });
});
