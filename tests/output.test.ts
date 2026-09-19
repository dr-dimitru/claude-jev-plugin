import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OUTPUT_QUESTIONS,
  CLASS_ADVICE,
  WITHHELD_OUTPUT_TEXT,
  LEAK_SYSTEM_MESSAGE,
  normalizeToolOutput,
  outputJudgmentKey,
  evaluateOutput,
  redactBashOutput,
  judgeOutput,
  type FailureClass,
  type NormalizedOutput,
  type OutputVerdict,
  type BashToolResponse,
  type PostToolUsePayload,
  type PostToolUseFailurePayload,
} from "../src/output.ts";
import type { JevResponse, JevCall } from "../src/client.ts";
import { sessionStore } from "../src/hook-io.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

describe("Output Judge - Questions and Advice Constants", () => {
  it("defines OUTPUT_QUESTIONS with leaks_secret Noul and failure_class Choice matching architecture", () => {
    assert.equal(OUTPUT_QUESTIONS.leaks_secret.type, "noul");
    assert.equal(
      OUTPUT_QUESTIONS.leaks_secret.instructions,
      "Does `output` contain a secret or credential that must not be written to a session transcript?"
    );
    assert.equal(OUTPUT_QUESTIONS.leaks_secret.criteria?.true, "A key, token, password, or private key appears in the text");
    assert.equal(OUTPUT_QUESTIONS.leaks_secret.criteria?.false, "Only ordinary program output");

    assert.equal(OUTPUT_QUESTIONS.failure_class.type, "choice");
    assert.equal(
      OUTPUT_QUESTIONS.failure_class.instructions,
      "What kind of failure is `output` reporting?"
    );
    const criteria = OUTPUT_QUESTIONS.failure_class.criteria;
    assert.ok(criteria);
    assert.equal(criteria.transient, "A network or resource hiccup that may succeed on a retry");
    assert.equal(criteria.environment, "A missing dependency, port, or tool in the local setup");
    assert.equal(criteria.code_bug, "The code or types are wrong");
    assert.equal(criteria.permission, "Access was denied by the OS or a server");
    assert.equal(criteria.user_error, "The command itself was invoked wrongly");
    assert.equal(criteria.no_failure, "Output reports success or nothing wrong");
  });

  it("defines CLASS_ADVICE locally for all six architecture classes without Jev prose generation", () => {
    assert.equal(CLASS_ADVICE.transient, "Retrying the same command unchanged is reasonable.");
    assert.equal(CLASS_ADVICE.environment, "Fix the environment before retrying.");
    assert.equal(CLASS_ADVICE.code_bug, "Fix the code or types; retrying unchanged will not help.");
    assert.equal(CLASS_ADVICE.permission, "Access was denied; change what is accessed or ask the user.");
    assert.equal(CLASS_ADVICE.user_error, "Fix the command invocation or input.");
    assert.equal(CLASS_ADVICE.no_failure, null);
  });
});

describe("Output Normalization", () => {
  it("normalizes successful PostToolUse payload with structured Bash response", () => {
    const payload: PostToolUsePayload = {
      session_id: "sess-123",
      cwd: "/test/dir",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu-success-1",
      tool_input: { command: "echo 'hello world'" },
      tool_response: {
        stdout: "hello world\n",
        stderr: "",
        interrupted: false,
        isImage: false,
      },
    };

    const norm = normalizeToolOutput(payload);
    assert.equal(norm.tool, "Bash");
    assert.equal(norm.cwd, "/test/dir");
    assert.equal(norm.toolUseId, "toolu-success-1");
    assert.equal(norm.isError, false);
    assert.equal(norm.output, "hello world\n");
    assert.deepEqual(norm.toolResponse, payload.tool_response);
  });

  it("normalizes successful PostToolUse payload with stdout and stderr combined", () => {
    const payload: PostToolUsePayload = {
      tool_name: "Bash",
      tool_input: { command: "compile" },
      tool_response: {
        stdout: "compiling source...",
        stderr: "warning: deprecated function used",
      },
    };

    const norm = normalizeToolOutput(payload);
    assert.equal(norm.isError, false);
    assert.equal(norm.output, "compiling source...\nwarning: deprecated function used");
  });

  it("normalizes successful PostToolUse payload with raw string tool_response", () => {
    const payload: PostToolUsePayload = {
      tool_name: "Bash",
      tool_response: "just plain text result",
    };

    const norm = normalizeToolOutput(payload);
    assert.equal(norm.isError, false);
    assert.equal(norm.output, "just plain text result");
  });

  it("normalizes failed PostToolUseFailure payload with top-level error", () => {
    const payload: PostToolUseFailurePayload = {
      session_id: "sess-fail-1",
      cwd: "/test/dir",
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_use_id: "toolu-fail-1",
      tool_input: { command: "npm test" },
      error: "Exit code 1\nError: Cannot find module 'express'",
      is_interrupt: false,
    };

    const norm = normalizeToolOutput(payload);
    assert.equal(norm.tool, "Bash");
    assert.equal(norm.toolUseId, "toolu-fail-1");
    assert.equal(norm.isError, true);
    assert.equal(norm.output, "Exit code 1\nError: Cannot find module 'express'");
    assert.equal(norm.toolResponse, undefined);
  });

  it("treats explicit is_error: true as error even in PostToolUse", () => {
    const payload = {
      tool_name: "Bash",
      tool_response: { stdout: "failed run" },
      is_error: true,
    };

    const norm = normalizeToolOutput(payload);
    assert.equal(norm.isError, true);
    assert.equal(norm.output, "failed run");
  });
});

describe("State Bounding and Stable Output Keys", () => {
  it("bounds output state according to maxStateChars and outputChars", () => {
    const longOutput = "x".repeat(5000);
    const norm: NormalizedOutput = {
      tool: "Bash",
      cwd: "/repo",
      isError: false,
      toolInput: { command: "cat longfile" },
      output: longOutput,
    };

    const key = outputJudgmentKey(norm);
    assert.ok(typeof key === "string" && key.length === 64, "Key must be 64-char sha256 hex");
  });

  it("produces identical stable hash regardless of key insertion order in tool_input", () => {
    const normA: NormalizedOutput = {
      tool: "Bash",
      cwd: "/repo",
      isError: false,
      toolInput: { command: "npm test", timeout: 5000, verbose: true },
      output: "test output",
    };

    const normB: NormalizedOutput = {
      tool: "Bash",
      cwd: "/repo",
      isError: false,
      toolInput: { verbose: true, timeout: 5000, command: "npm test" },
      output: "test output",
    };

    const keyA = outputJudgmentKey(normA);
    const keyB = outputJudgmentKey(normB);
    assert.equal(keyA, keyB, "Keys must match regardless of object property ordering");
  });

  it("produces distinct keys when error flag or output differs", () => {
    const normSuccess: NormalizedOutput = {
      tool: "Bash",
      cwd: "/repo",
      isError: false,
      toolInput: { command: "run" },
      output: "done",
    };

    const normFailure: NormalizedOutput = {
      tool: "Bash",
      cwd: "/repo",
      isError: true,
      toolInput: { command: "run" },
      output: "done",
    };

    assert.notEqual(outputJudgmentKey(normSuccess), outputJudgmentKey(normFailure));
  });
});

describe("Redacting Bash Output", () => {
  it("replaces known Bash response wholesale with withheld output notice", () => {
    const bashRes: BashToolResponse = {
      stdout: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
      stderr: "fetching secrets...",
      interrupted: false,
      isImage: false,
    };

    const redacted = redactBashOutput(bashRes) as BashToolResponse;
    assert.equal(redacted.stdout, WITHHELD_OUTPUT_TEXT);
    assert.equal(redacted.stderr, "");
    assert.equal(redacted.interrupted, false);
    assert.equal(redacted.isImage, false);

    // Verify secret is completely purged
    assert.ok(!redacted.stdout.includes("wJalrXUtnFEMI"));
    assert.ok(!redacted.stderr.includes("secrets"));
  });

  it("leaves unknown response shape untouched", () => {
    const unknownRes = { customField: "keep-as-is" };
    const result = redactBashOutput(unknownRes);
    assert.deepEqual(result, unknownRes);
  });
});

describe("Output Verdict Evaluation - Fixtures", () => {
  it("fixture 1: npm test success -> no failure, no advice, silence", () => {
    const response: JevResponse = {
      model: "jev-latest",
      answers: {
        leaks_secret: { type: "noul", noul: 0.01 },
        failure_class: {
          type: "choice",
          choice: "no_failure",
          probabilities: {
            no_failure: 0.96,
            transient: 0.01,
            environment: 0.01,
            code_bug: 0.01,
            permission: 0.01,
            user_error: 0.01,
          },
          confidence: 0.96,
        },
      },
    };

    const verdict = evaluateOutput(response);
    assert.equal(verdict.flagged, false);
    assert.equal(verdict.leaksSecret, false);
    assert.equal(verdict.failureClass, "no_failure");
    assert.equal(verdict.advice, null);
    assert.equal(verdict.additionalContext, undefined);
    assert.equal(verdict.systemMessage, undefined);
  });

  it("fixture 2: ECONNRESET -> transient failure advice", () => {
    const response: JevResponse = {
      model: "jev-latest",
      answers: {
        leaks_secret: { type: "noul", noul: 0.02 },
        failure_class: {
          type: "choice",
          choice: "transient",
          probabilities: { transient: 0.92, environment: 0.04, code_bug: 0.02, permission: 0.01, user_error: 0.01, no_failure: 0.0 },
          confidence: 0.92,
        },
      },
    };

    const verdict = evaluateOutput(response);
    assert.equal(verdict.flagged, true);
    assert.equal(verdict.leaksSecret, false);
    assert.equal(verdict.failureClass, "transient");
    assert.equal(verdict.advice, "Retrying the same command unchanged is reasonable.");
    assert.ok(verdict.additionalContext?.includes("Retrying the same command unchanged is reasonable."));
    // Must never leak output or detected text
    assert.ok(!verdict.additionalContext?.includes("ECONNRESET"));
  });

  it("fixture 3: EADDRINUSE -> environment failure advice", () => {
    const response: JevResponse = {
      model: "jev-latest",
      answers: {
        leaks_secret: { type: "noul", noul: 0.01 },
        failure_class: {
          type: "choice",
          choice: "environment",
          probabilities: { environment: 0.94, transient: 0.03, code_bug: 0.01, permission: 0.01, user_error: 0.01, no_failure: 0.0 },
          confidence: 0.94,
        },
      },
    };

    const verdict = evaluateOutput(response);
    assert.equal(verdict.flagged, true);
    assert.equal(verdict.leaksSecret, false);
    assert.equal(verdict.failureClass, "environment");
    assert.equal(verdict.advice, "Fix the environment before retrying.");
    assert.ok(verdict.additionalContext?.includes("Fix the environment before retrying."));
    assert.ok(!verdict.additionalContext?.includes("EADDRINUSE"));
  });

  it("fixture 4: TS2322 -> code_bug failure advice", () => {
    const response: JevResponse = {
      model: "jev-latest",
      answers: {
        leaks_secret: { type: "noul", noul: 0.01 },
        failure_class: {
          type: "choice",
          choice: "code_bug",
          probabilities: { code_bug: 0.97, environment: 0.01, transient: 0.0, permission: 0.01, user_error: 0.01, no_failure: 0.0 },
          confidence: 0.97,
        },
      },
    };

    const verdict = evaluateOutput(response);
    assert.equal(verdict.flagged, true);
    assert.equal(verdict.leaksSecret, false);
    assert.equal(verdict.failureClass, "code_bug");
    assert.equal(verdict.advice, "Fix the code or types; retrying unchanged will not help.");
    assert.ok(verdict.additionalContext?.includes("Fix the code or types; retrying unchanged will not help."));
    assert.ok(!verdict.additionalContext?.includes("TS2322"));
  });

  it("fixture 5: EACCES -> permission failure advice", () => {
    const response: JevResponse = {
      model: "jev-latest",
      answers: {
        leaks_secret: { type: "noul", noul: 0.05 },
        failure_class: {
          type: "choice",
          choice: "permission",
          probabilities: { permission: 0.93, environment: 0.03, code_bug: 0.01, transient: 0.01, user_error: 0.02, no_failure: 0.0 },
          confidence: 0.93,
        },
      },
    };

    const verdict = evaluateOutput(response);
    assert.equal(verdict.flagged, true);
    assert.equal(verdict.leaksSecret, false);
    assert.equal(verdict.failureClass, "permission");
    assert.equal(verdict.advice, "Access was denied; change what is accessed or ask the user.");
    assert.ok(verdict.additionalContext?.includes("Access was denied; change what is accessed or ask the user."));
    assert.ok(!verdict.additionalContext?.includes("EACCES"));
  });

  it("fixture 6: command not found -> user_error failure advice", () => {
    const response: JevResponse = {
      model: "jev-latest",
      answers: {
        leaks_secret: { type: "noul", noul: 0.01 },
        failure_class: {
          type: "choice",
          choice: "user_error",
          probabilities: { user_error: 0.89, environment: 0.08, code_bug: 0.01, transient: 0.01, permission: 0.01, no_failure: 0.0 },
          confidence: 0.89,
        },
      },
    };

    const verdict = evaluateOutput(response);
    assert.equal(verdict.flagged, true);
    assert.equal(verdict.leaksSecret, false);
    assert.equal(verdict.failureClass, "user_error");
    assert.equal(verdict.advice, "Fix the command invocation or input.");
    assert.ok(verdict.additionalContext?.includes("Fix the command invocation or input."));
    assert.ok(!verdict.additionalContext?.includes("command not found"));
  });

  it("fixture 7: fatal not a git repository -> user_error failure advice", () => {
    const response: JevResponse = {
      model: "jev-latest",
      answers: {
        leaks_secret: { type: "noul", noul: 0.01 },
        failure_class: {
          type: "choice",
          choice: "user_error",
          probabilities: { user_error: 0.91, environment: 0.05, code_bug: 0.02, transient: 0.01, permission: 0.01, no_failure: 0.0 },
          confidence: 0.91,
        },
      },
    };

    const verdict = evaluateOutput(response);
    assert.equal(verdict.flagged, true);
    assert.equal(verdict.leaksSecret, false);
    assert.equal(verdict.failureClass, "user_error");
    assert.equal(verdict.advice, "Fix the command invocation or input.");
    assert.ok(verdict.additionalContext?.includes("Fix the command invocation or input."));
    assert.ok(!verdict.additionalContext?.includes("fatal: not a git repository"));
  });

  it("fixture 8: AWS key leak -> leaksSecret true, systemMessage present", () => {
    const response: JevResponse = {
      model: "jev-latest",
      answers: {
        leaks_secret: { type: "noul", noul: 0.99 },
        failure_class: {
          type: "choice",
          choice: "no_failure",
          probabilities: { no_failure: 0.95, transient: 0.01, environment: 0.01, code_bug: 0.01, permission: 0.01, user_error: 0.01 },
          confidence: 0.95,
        },
      },
    };

    const verdict = evaluateOutput(response);
    assert.equal(verdict.flagged, true);
    assert.equal(verdict.leaksSecret, true);
    assert.equal(verdict.leakScore, 0.99);
    assert.equal(verdict.systemMessage, LEAK_SYSTEM_MESSAGE);
    // Notice must never include secret values or detected text
    assert.ok(!verdict.systemMessage?.includes("AKIA"));
  });

  it("fixture 9: .env secret leak -> leaksSecret true", () => {
    const response: JevResponse = {
      model: "jev-latest",
      answers: {
        leaks_secret: { type: "noul", noul: 0.95 },
        failure_class: {
          type: "choice",
          choice: "no_failure",
          probabilities: { no_failure: 0.90, transient: 0.02, environment: 0.02, code_bug: 0.02, permission: 0.02, user_error: 0.02 },
          confidence: 0.90,
        },
      },
    };

    const verdict = evaluateOutput(response);
    assert.equal(verdict.flagged, true);
    assert.equal(verdict.leaksSecret, true);
    assert.equal(verdict.leakScore, 0.95);
    assert.equal(verdict.systemMessage, LEAK_SYSTEM_MESSAGE);
  });

  it("fixture 10: private key leak -> leaksSecret true", () => {
    const response: JevResponse = {
      model: "jev-latest",
      answers: {
        leaks_secret: { type: "noul", noul: 0.998 },
        failure_class: {
          type: "choice",
          choice: "no_failure",
          probabilities: { no_failure: 0.92, transient: 0.02, environment: 0.02, code_bug: 0.01, permission: 0.01, user_error: 0.02 },
          confidence: 0.92,
        },
      },
    };

    const verdict = evaluateOutput(response);
    assert.equal(verdict.flagged, true);
    assert.equal(verdict.leaksSecret, true);
    assert.equal(verdict.leakScore, 0.998);
  });

  it("fixture 11: hard-coded credential diff leak -> leaksSecret true", () => {
    const response: JevResponse = {
      model: "jev-latest",
      answers: {
        leaks_secret: { type: "noul", noul: 0.92 },
        failure_class: {
          type: "choice",
          choice: "no_failure",
          probabilities: { no_failure: 0.88, transient: 0.02, environment: 0.02, code_bug: 0.03, permission: 0.02, user_error: 0.03 },
          confidence: 0.88,
        },
      },
    };

    const verdict = evaluateOutput(response);
    assert.equal(verdict.flagged, true);
    assert.equal(verdict.leaksSecret, true);
    assert.equal(verdict.leakScore, 0.92);
  });
});

describe("Low-Confidence Silence & Edge Cases", () => {
  it("silences advice when confidence is below minConfidence (0.60)", () => {
    const response: JevResponse = {
      model: "jev-latest",
      answers: {
        leaks_secret: { type: "noul", noul: 0.10 },
        failure_class: {
          type: "choice",
          choice: "transient",
          probabilities: { transient: 0.45, environment: 0.35, user_error: 0.20 },
          confidence: 0.55, // below 0.60 threshold
        },
      },
    };

    const verdict = evaluateOutput(response);
    assert.equal(verdict.flagged, false);
    assert.equal(verdict.leaksSecret, false);
    assert.equal(verdict.failureClass, "transient");
    assert.equal(verdict.failureConfidence, 0.55);
    assert.equal(verdict.advice, null);
    assert.equal(verdict.additionalContext, undefined);
  });

  it("respects custom leakThreshold and minConfidence from config", () => {
    const response: JevResponse = {
      model: "jev-latest",
      answers: {
        leaks_secret: { type: "noul", noul: 0.85 },
        failure_class: {
          type: "choice",
          choice: "code_bug",
          probabilities: { code_bug: 0.50, transient: 0.50 },
          confidence: 0.50,
        },
      },
    };

    // Default thresholds: leaksSecret=false (0.85 < 0.90), advice=null (0.50 < 0.60)
    const defaultVerdict = evaluateOutput(response);
    assert.equal(defaultVerdict.leaksSecret, false);
    assert.equal(defaultVerdict.advice, null);

    // Custom thresholds: leakThreshold 0.80, minConfidence 0.45
    const customVerdict = evaluateOutput(response, {
      leakThreshold: 0.80,
      minConfidence: 0.45,
    });
    assert.equal(customVerdict.leaksSecret, true);
    assert.equal(customVerdict.advice, "Fix the code or types; retrying unchanged will not help.");
  });

  it("handles both leak and failure class simultaneously without leaking output text", () => {
    const response: JevResponse = {
      model: "jev-latest",
      answers: {
        leaks_secret: { type: "noul", noul: 0.98 },
        failure_class: {
          type: "choice",
          choice: "permission",
          probabilities: { permission: 0.90, user_error: 0.10 },
          confidence: 0.90,
        },
      },
    };

    const verdict = evaluateOutput(response);
    assert.equal(verdict.flagged, true);
    assert.equal(verdict.leaksSecret, true);
    assert.equal(verdict.failureClass, "permission");
    assert.equal(verdict.advice, "Access was denied; change what is accessed or ask the user.");
    assert.equal(verdict.systemMessage, LEAK_SYSTEM_MESSAGE);
    assert.ok(verdict.additionalContext?.includes("Access was denied; change what is accessed or ask the user."));
  });
});

describe("Batched Jev Invocation and Session Deduplication", () => {
  it("sends one batched request for both questions and records verdict in session store", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-jev-test-output-"));
    try {
      const store = sessionStore({ sessionId: "sess-judge-1", scratchpadDir: tmpDir });

      let askedCall: JevCall | undefined;
      const mockAskJev = async (call: JevCall): Promise<JevResponse> => {
        askedCall = call;
        return {
          model: call.model ?? "jev-latest",
          answers: {
            leaks_secret: { type: "noul", noul: 0.05 },
            failure_class: {
              type: "choice",
              choice: "transient",
              probabilities: { transient: 0.95 },
              confidence: 0.95,
            },
          },
        };
      };

      const payload: PostToolUsePayload = {
        session_id: "sess-judge-1",
        tool_name: "Bash",
        tool_use_id: "toolu-batch-1",
        tool_input: { command: "curl https://example.com" },
        tool_response: { stdout: "server error: ECONNRESET" },
      };

      const verdict = await judgeOutput(payload, {
        sessionStore: store,
        askJevFn: mockAskJev,
      });

      assert.ok(askedCall, "Must invoke askJev");
      assert.deepEqual(Object.keys(askedCall.questions).sort(), ["failure_class", "leaks_secret"]);
      assert.equal(verdict.failureClass, "transient");
      assert.equal(verdict.advice, "Retrying the same command unchanged is reasonable.");

      // Check tool_use_id was recorded in session store
      assert.equal(await store.hasSeenToolUseId("toolu-batch-1"), true);
      const lastVerdict = (await store.getLastVerdict("output")) as OutputVerdict;
      assert.equal(lastVerdict.failureClass, "transient");

      // Duplicate tool_use_id should be suppressed without re-querying Jev
      let secondCallAsked = false;
      const mockAskJevSecond = async (call: JevCall): Promise<JevResponse> => {
        secondCallAsked = true;
        return mockAskJev(call);
      };

      const secondVerdict = await judgeOutput(payload, {
        sessionStore: store,
        askJevFn: mockAskJevSecond,
      });

      assert.equal(secondCallAsked, false, "Duplicate tool_use_id must be suppressed");
      assert.equal(secondVerdict.failureClass, "transient");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("passes output limits and transport settings from config into Jev state", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.apiKey = "test-key";
    config.output.outputChars = 10;
    config.retries = 7;
    config.timeoutMs = 3210;

    let sentCall: JevCall | undefined;
    const verdict = await judgeOutput(
      {
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        tool_response: { stdout: "0123456789ABCDEFGHIJ" },
      },
      {
        config,
        askJevFn: async (call) => {
          sentCall = call;
          return {
            model: "jev-latest",
            answers: {
              leaks_secret: { type: "noul", noul: 0.01 },
              failure_class: {
                type: "choice",
                choice: "no_failure",
                probabilities: { no_failure: 1 },
                confidence: 1,
              },
            },
          };
        },
      },
    );

    assert.equal(verdict.flagged, false);
    assert.equal(sentCall?.retries, 7);
    assert.equal(sentCall?.timeoutMs, 3210);
    const state = sentCall?.state as Record<string, unknown>;
    assert.equal(typeof state.output, "string");
    assert.ok((state.output as string).startsWith("0123456789"));
    assert.ok((state.output as string).includes("chars elided"));
  });

  it("redacts tool_response in verdict when leak is detected in judgeOutput", async () => {
    const mockAskJev = async (call: JevCall): Promise<JevResponse> => {
      return {
        model: "jev-latest",
        answers: {
          leaks_secret: { type: "noul", noul: 0.97 },
          failure_class: {
            type: "choice",
            choice: "no_failure",
            probabilities: { no_failure: 0.90 },
            confidence: 0.90,
          },
        },
      };
    };

    const payload: PostToolUsePayload = {
      tool_name: "Bash",
      tool_input: { command: "cat .env" },
      tool_response: {
        stdout: "AWS_ACCESS_KEY_ID=AKIASECRET123\n",
        stderr: "",
        interrupted: false,
        isImage: false,
      },
    };

    const verdict = await judgeOutput(payload, {
      askJevFn: mockAskJev,
    });

    assert.equal(verdict.leaksSecret, true);
    assert.equal(verdict.systemMessage, LEAK_SYSTEM_MESSAGE);
    const updated = verdict.updatedToolOutput as BashToolResponse;
    assert.ok(updated);
    assert.equal(updated.stdout, WITHHELD_OUTPUT_TEXT);
    assert.ok(!updated.stdout.includes("AKIASECRET123"));
  });
});
