import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runPostTool } from "../src/hooks/post-tool.ts";
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
      },
    };

    const result = await runPostTool(payload, {
      askJevFn: askJevFn as any,
      config,
    });

    assert.strictEqual(jevCalled, true);
    assert.strictEqual(result, null);
  });

  it("deterministic advice: high confidence failure advice returned in additionalContext", async () => {
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
      },
    };

    const result = await runPostTool(payload, {
      askJevFn: askJevFn as any,
      config,
    });

    assert.strictEqual(jevCalled, true);
    assert.ok(result);
    assert.strictEqual(result.systemMessage, undefined);
    assert.ok(result.hookSpecificOutput);
    assert.strictEqual(result.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.strictEqual(result.hookSpecificOutput.updatedToolOutput, undefined);
    assert.strictEqual(
      result.hookSpecificOutput.additionalContext,
      "claude-jev: this Bash result reads as a transient failure; Retrying the same command unchanged is reasonable."
    );
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

  it("infrastructure failure: fails open with rate-limited diagnostic", async () => {
    const askJevFn = async () => {
      throw new Error("Network timeout after 20000ms");
    };

    const payload = {
      session_id: "sess-infra",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
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
      },
    };

    const result = await runPostTool(payload, {
      askJevFn: askJevFn as any,
      config,
    });

    assert.ok(result);
    assert.ok(result.systemMessage?.includes("infrastructure error"));
    assert.strictEqual(result.hookSpecificOutput, undefined);
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
    };
    const payload2 = {
      session_id: "sess-concurrent",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { stdout: "", stderr: "ECONNRESET" },
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
