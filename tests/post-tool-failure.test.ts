import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runPostToolFailure } from "../src/hooks/post-tool-failure.ts";
import { clearRegisteredApiKeys } from "../src/client.ts";
import { clearMemoryCache } from "../src/cache.ts";

describe("PostToolUseFailure Hook", () => {
  let tmpDir: string;

  beforeEach(() => {
    clearRegisteredApiKeys();
    clearMemoryCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-jev-post-failure-test-"));
  });

  it("failed payload with top-level error: normalizes error and provides deterministic advice", async () => {
    let capturedState: any = null;
    const askJevFn = async (call: any) => {
      capturedState = call.state;
      return {
        answers: {
          leaks_secret: { type: "noul" as const, noul: 0.02 },
          failure_class: {
            type: "choice" as const,
            choice: "environment",
            probabilities: { environment: 0.92 },
            confidence: 0.92,
          },
        },
      };
    };

    const payload = {
      session_id: "sess-fail-1",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "node server.js" },
      tool_use_id: "toolu_fail_01",
      error: "Exit code 1\nError: Cannot find module 'express'",
      is_interrupt: false,
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

    const result = await runPostToolFailure(payload, {
      askJevFn: askJevFn as any,
      config,
    });

    assert.ok(capturedState);
    assert.strictEqual(capturedState.is_error, true);
    assert.ok(capturedState.output.includes("Cannot find module 'express'"));

    assert.ok(result);
    assert.strictEqual(result.systemMessage, undefined);
    assert.ok(result.hookSpecificOutput);
    assert.strictEqual(result.hookSpecificOutput.hookEventName, "PostToolUseFailure");
    assert.strictEqual(
      result.hookSpecificOutput.additionalContext,
      "claude-jev: this Bash result reads as a environment failure; Fix the environment before retrying."
    );
    // CRITICAL: PostToolUseFailure has no replacement field, never return updatedToolOutput
    assert.strictEqual((result as any).hookSpecificOutput.updatedToolOutput, undefined);
    assert.strictEqual((result as any).updatedToolOutput, undefined);
  });

  it("leak on failure: warns user and adds context without claiming output replacement", async () => {
    const rawSecret = "super-secret-password-xyz123";
    const askJevFn = async () => ({
      answers: {
        leaks_secret: { type: "noul" as const, noul: 0.97 },
        failure_class: {
          type: "choice" as const,
          choice: "permission",
          probabilities: { permission: 0.85 },
          confidence: 0.85,
        },
      },
    });

    const payload = {
      session_id: "sess-fail-leak",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "curl -u user:password https://internal.corp" },
      tool_use_id: "toolu_fail_leak",
      error: `HTTP 401 Unauthorized: token ${rawSecret} rejected`,
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

    const result = await runPostToolFailure(payload, {
      askJevFn: askJevFn as any,
      config,
    });

    assert.ok(result);
    assert.ok(result.systemMessage);
    assert.ok(result.systemMessage.includes("Bash failure output may contain a secret"));
    assert.ok(result.hookSpecificOutput);
    assert.strictEqual(result.hookSpecificOutput.hookEventName, "PostToolUseFailure");
    assert.ok(result.hookSpecificOutput.additionalContext);
    assert.ok(
      result.hookSpecificOutput.additionalContext.includes(
        "claude-jev: this Bash result reads as a permission failure"
      )
    );
    assert.ok(
      result.hookSpecificOutput.additionalContext.includes(
        "do not reproduce or expose the value"
      )
    );

    // CRITICAL: NEVER claim output replacement on failure
    assert.strictEqual((result as any).hookSpecificOutput.updatedToolOutput, undefined);
    assert.strictEqual((result as any).updatedToolOutput, undefined);

    // NEVER echo raw secret in result
    const serialized = JSON.stringify(result);
    assert.strictEqual(serialized.includes(rawSecret), false);
  });

  it("success / no_failure silence: clear failure classification emits silence", async () => {
    const askJevFn = async () => ({
      answers: {
        leaks_secret: { type: "noul" as const, noul: 0.05 },
        failure_class: {
          type: "choice" as const,
          choice: "no_failure",
          probabilities: { no_failure: 0.95 },
          confidence: 0.95,
        },
      },
    });

    const payload = {
      session_id: "sess-fail-clear",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      error: "Command exited with code 0",
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

    const result = await runPostToolFailure(payload, {
      askJevFn: askJevFn as any,
      config,
    });

    assert.strictEqual(result, null);
  });

  it("low confidence silence: failure advice below minConfidence returns silence", async () => {
    const askJevFn = async () => ({
      answers: {
        leaks_secret: { type: "noul" as const, noul: 0.05 },
        failure_class: {
          type: "choice" as const,
          choice: "code_bug",
          probabilities: { code_bug: 0.45 },
          confidence: 0.45,
        },
      },
    });

    const payload = {
      session_id: "sess-fail-lowconf",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      error: "Some vague error",
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

    const result = await runPostToolFailure(payload, {
      askJevFn: askJevFn as any,
      config,
    });

    assert.strictEqual(result, null);
  });

  it("duplicate tool_use_id: suppresses re-judging and returns silence", async () => {
    let callCount = 0;
    const askJevFn = async () => {
      callCount++;
      return {
        answers: {
          leaks_secret: { type: "noul" as const, noul: 0.02 },
          failure_class: {
            type: "choice" as const,
            choice: "code_bug",
            probabilities: { code_bug: 0.9 },
            confidence: 0.9,
          },
        },
      };
    };

    const payload = {
      session_id: "sess-fail-dup",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_use_id: "toolu_fail_dup_999",
      tool_input: { command: "npm run build" },
      error: "TS2322: Type 'string' is not assignable to type 'number'.",
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

    const first = await runPostToolFailure(payload, {
      askJevFn: askJevFn as any,
      config,
    });
    assert.ok(first);
    assert.strictEqual(callCount, 1);

    const second = await runPostToolFailure(payload, {
      askJevFn: askJevFn as any,
      config,
    });
    assert.strictEqual(callCount, 1);
    assert.strictEqual(second, null);
  });

  it("malformed payload: returns rate-limited diagnostic", async () => {
    const result = await runPostToolFailure([] as any);
    assert.ok(result);
    assert.ok(result.systemMessage?.includes("malformed hook payload"));
  });

  it("infrastructure failure: fails open with rate-limited diagnostic", async () => {
    const askJevFn = async () => {
      throw new Error("HTTP 503 Service Unavailable");
    };

    const payload = {
      session_id: "sess-fail-infra",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      error: "Command failed",
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

    const result = await runPostToolFailure(payload, {
      askJevFn: askJevFn as any,
      config,
    });

    assert.ok(result);
    assert.ok(result.systemMessage?.includes("infrastructure error"));
    assert.strictEqual(result.hookSpecificOutput, undefined);
  });

  it("output shape validity: schema valid JSON with hookEventName PostToolUseFailure and no updatedToolOutput", async () => {
    const askJevFn = async () => ({
      answers: {
        leaks_secret: { type: "noul" as const, noul: 0.01 },
        failure_class: {
          type: "choice" as const,
          choice: "user_error",
          probabilities: { user_error: 0.8 },
          confidence: 0.8,
        },
      },
    });

    const payload = {
      session_id: "sess-fail-shape",
      cwd: tmpDir,
      scratchpad_dir: tmpDir,
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "git commit -m" },
      error: "error: switch `m' requires a value",
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

    const result = await runPostToolFailure(payload, {
      askJevFn: askJevFn as any,
      config,
    });

    assert.ok(result);
    const serialized = JSON.stringify(result);
    const parsed = JSON.parse(serialized);

    assert.strictEqual(parsed.systemMessage, undefined);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, "PostToolUseFailure");
    assert.strictEqual(
      parsed.hookSpecificOutput.additionalContext,
      "claude-jev: this Bash result reads as a user_error failure; Fix the command invocation or input."
    );
    assert.strictEqual(parsed.hookSpecificOutput.updatedToolOutput, undefined);
  });

  it("skips disabled output, unconfigured tool, and missing API key", async () => {
    let called = false;
    const askJevFn = async () => {
      called = true;
      return { answers: {} };
    };

    // 1. Disabled output
    const resDisabled = await runPostToolFailure(
      {
        session_id: "sess-dis",
        cwd: tmpDir,
        tool_name: "Bash",
        error: "err",
      },
      {
        askJevFn: askJevFn as any,
        config: { output: { enabled: false, tools: ["Bash"] } } as any,
      }
    );
    assert.strictEqual(resDisabled, null);
    assert.strictEqual(called, false);

    // 2. Unconfigured tool
    const resTool = await runPostToolFailure(
      {
        session_id: "sess-dis",
        cwd: tmpDir,
        tool_name: "Write",
        error: "err",
      },
      {
        askJevFn: askJevFn as any,
        config: { output: { enabled: true, tools: ["Bash"] } } as any,
      }
    );
    assert.strictEqual(resTool, null);
    assert.strictEqual(called, false);

    // 3. Missing API key
    const resKey = await runPostToolFailure(
      {
        session_id: "sess-nokey",
        cwd: tmpDir,
        scratchpad_dir: tmpDir,
        tool_name: "Bash",
        error: "err",
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
});
