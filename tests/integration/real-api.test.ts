import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { askJev, redact, registerApiKey, type JevResponse } from "../../src/client.ts";
import { GATE_QUESTIONS, evaluateGate } from "../../src/gate.ts";
import { OUTPUT_QUESTIONS, evaluateOutput } from "../../src/output.ts";
import { buildGateState, buildOutputState } from "../../src/state.ts";

const hasRealApi = process.env.CLAUDE_JEV_REAL_API === "1";
const rawApiKey = process.env.TYPESAFE_API_KEY?.trim();
const isOptIn = hasRealApi && Boolean(rawApiKey && rawApiKey.length > 0);

if (rawApiKey) {
  registerApiKey(rawApiKey);
}

const skipReason = isOptIn
  ? false
  : "Opt-in real API tests skipped: requires CLAUDE_JEV_REAL_API=1 and TYPESAFE_API_KEY";

describe("TypeSafe Jev Real API Integration (Opt-in)", () => {
  const fixturesDir = path.resolve(import.meta.dirname, "../fixtures");
  const gateCalibrationPath = path.join(fixturesDir, "gate-calibration.json");
  const outputCalibrationPath = path.join(fixturesDir, "output-calibration.json");

  it(
    "sends one batched gate request with bounded fixture state and validates TypeSafe answer shapes",
    { skip: skipReason },
    async () => {
      let gateFixturesRaw: string;
      try {
        gateFixturesRaw = fs.readFileSync(gateCalibrationPath, "utf-8");
      } catch (err: unknown) {
        const msg = redact(err instanceof Error ? err.message : String(err)).slice(0, 300);
        assert.fail(`[REDACTED_ASSERTION_ERROR] Failed to read gate calibration fixture: ${msg}`);
      }

      const gateFixtures = JSON.parse(gateFixturesRaw);

      // Validate all required gate examples exist in fixture
      const requiredGateExamples = [
        "safe_status",
        "high_impact_shell",
        "outbound_local_data",
        "requested_edit",
        "out_of_scope_system_file_edit",
      ];
      for (const ex of requiredGateExamples) {
        assert.ok(ex in gateFixtures, `Missing required gate fixture example: ${ex}`);
      }

      const fixtureCase = gateFixtures.safe_status;
      assert.ok(fixtureCase, "Expected safe_status gate calibration fixture");

      const boundedState = buildGateState({
        tool: fixtureCase.state.tool,
        cwd: fixtureCase.state.cwd,
        tool_input: fixtureCase.state.tool_input,
        user_request: fixtureCase.state.user_request,
      });

      let response: JevResponse;
      try {
        response = await askJev({
          apiKey: rawApiKey,
          state: boundedState,
          questions: GATE_QUESTIONS,
        });
      } catch (err: unknown) {
        const msg = redact(err instanceof Error ? err.message : String(err)).slice(0, 300);
        assert.fail(`[REDACTED_ASSERTION_ERROR] Batched gate request failed: ${msg}`);
      }

      try {
        assert.ok(response && typeof response === "object", "Response must be an object");
        assert.ok(response.answers && typeof response.answers === "object", "Answers must be an object");

        // Validate destructive answer shape
        const destructive = response.answers.destructive;
        assert.ok(destructive, "Missing destructive answer");
        assert.equal(destructive.type, "noul", "destructive.type must be 'noul'");
        assert.equal(typeof destructive.noul, "number", "destructive.noul must be a number");
        assert.ok(destructive.noul >= 0 && destructive.noul <= 1, "destructive.noul must be between 0 and 1");

        // Validate exfiltration answer shape
        const exfiltration = response.answers.exfiltration;
        assert.ok(exfiltration, "Missing exfiltration answer");
        assert.equal(exfiltration.type, "noul", "exfiltration.type must be 'noul'");
        assert.equal(typeof exfiltration.noul, "number", "exfiltration.noul must be a number");
        assert.ok(exfiltration.noul >= 0 && exfiltration.noul <= 1, "exfiltration.noul must be between 0 and 1");

        // Validate beyond_scope answer shape
        const beyondScope = response.answers.beyond_scope;
        assert.ok(beyondScope, "Missing beyond_scope answer");
        assert.equal(beyondScope.type, "noul", "beyond_scope.type must be 'noul'");
        assert.equal(typeof beyondScope.noul, "number", "beyond_scope.noul must be a number");
        assert.ok(beyondScope.noul >= 0 && beyondScope.noul <= 1, "beyond_scope.noul must be between 0 and 1");

        // Validate impact answer shape
        const impact = response.answers.impact;
        assert.ok(impact, "Missing impact answer");
        assert.equal(impact.type, "score", "impact.type must be 'score'");
        assert.equal(typeof impact.score, "number", "impact.score must be a number");
        assert.equal(typeof impact.confidence, "number", "impact.confidence must be a number");
        assert.ok(impact.confidence >= 0 && impact.confidence <= 1, "impact.confidence must be between 0 and 1");
        assert.ok(impact.probabilities && typeof impact.probabilities === "object", "impact.probabilities must be an object");
        assert.ok(impact.legend && typeof impact.legend === "object", "impact.legend must be an object");

        const verdict = evaluateGate(response);
        assert.equal(typeof verdict.flagged, "boolean", "Gate verdict flagged must be boolean");
        assert.ok(Array.isArray(verdict.reasons), "Gate verdict reasons must be an array");
      } catch (err: unknown) {
        if ((err as Error)?.message?.startsWith("[REDACTED_ASSERTION_ERROR]")) {
          throw err;
        }
        const msg = redact(err instanceof Error ? err.message : String(err)).slice(0, 300);
        assert.fail(`[REDACTED_ASSERTION_ERROR] Gate answer shape validation failed: ${msg}`);
      }
    }
  );

  it(
    "sends one batched output request with bounded fixture state and validates TypeSafe answer shapes",
    { skip: skipReason },
    async () => {
      let outputFixturesRaw: string;
      try {
        outputFixturesRaw = fs.readFileSync(outputCalibrationPath, "utf-8");
      } catch (err: unknown) {
        const msg = redact(err instanceof Error ? err.message : String(err)).slice(0, 300);
        assert.fail(`[REDACTED_ASSERTION_ERROR] Failed to read output calibration fixture: ${msg}`);
      }

      const outputFixtures = JSON.parse(outputFixturesRaw);

      // Validate all required output examples exist in fixture
      const requiredOutputExamples = [
        "npm_success",
        "econnreset",
        "eaddrinuse",
        "ts2322",
        "eacces",
        "command_not_found",
        "missing_git_repository",
        "aws_key",
        "dot_env",
        "private_key",
        "hard_coded_credential_diff",
      ];
      for (const ex of requiredOutputExamples) {
        assert.ok(ex in outputFixtures, `Missing required output fixture example: ${ex}`);
      }

      const fixtureCase = outputFixtures.npm_success;
      assert.ok(fixtureCase, "Expected npm_success output calibration fixture");

      const boundedState = buildOutputState({
        tool: fixtureCase.state.tool,
        cwd: fixtureCase.state.cwd,
        tool_input: fixtureCase.state.tool_input,
        is_error: fixtureCase.state.is_error,
        output: fixtureCase.state.output,
      });

      let response: JevResponse;
      try {
        response = await askJev({
          apiKey: rawApiKey,
          state: boundedState,
          questions: OUTPUT_QUESTIONS,
        });
      } catch (err: unknown) {
        const msg = redact(err instanceof Error ? err.message : String(err)).slice(0, 300);
        assert.fail(`[REDACTED_ASSERTION_ERROR] Batched output request failed: ${msg}`);
      }

      try {
        assert.ok(response && typeof response === "object", "Response must be an object");
        assert.ok(response.answers && typeof response.answers === "object", "Answers must be an object");

        // Validate leaks_secret answer shape
        const leaksSecret = response.answers.leaks_secret;
        assert.ok(leaksSecret, "Missing leaks_secret answer");
        assert.equal(leaksSecret.type, "noul", "leaks_secret.type must be 'noul'");
        assert.equal(typeof leaksSecret.noul, "number", "leaks_secret.noul must be a number");
        assert.ok(leaksSecret.noul >= 0 && leaksSecret.noul <= 1, "leaks_secret.noul must be between 0 and 1");

        // Validate failure_class answer shape
        const failureClass = response.answers.failure_class;
        assert.ok(failureClass, "Missing failure_class answer");
        assert.equal(failureClass.type, "choice", "failure_class.type must be 'choice'");
        assert.equal(typeof failureClass.choice, "string", "failure_class.choice must be a string");
        assert.equal(typeof failureClass.confidence, "number", "failure_class.confidence must be a number");
        assert.ok(failureClass.confidence >= 0 && failureClass.confidence <= 1, "failure_class.confidence must be between 0 and 1");
        assert.ok(failureClass.probabilities && typeof failureClass.probabilities === "object", "failure_class.probabilities must be an object");

        const verdict = evaluateOutput(response);
        assert.equal(typeof verdict.flagged, "boolean", "Output verdict flagged must be boolean");
        assert.equal(typeof verdict.leaksSecret, "boolean", "Output verdict leaksSecret must be boolean");
        assert.equal(typeof verdict.failureClass, "string", "Output verdict failureClass must be string");
      } catch (err: unknown) {
        if ((err as Error)?.message?.startsWith("[REDACTED_ASSERTION_ERROR]")) {
          throw err;
        }
        const msg = redact(err instanceof Error ? err.message : String(err)).slice(0, 300);
        assert.fail(`[REDACTED_ASSERTION_ERROR] Output answer shape validation failed: ${msg}`);
      }
    }
  );
});
