import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DECISION_INPUT_BYTES,
  MAX_DECISION_QUESTIONS,
  DecisionInputError,
  parseDecisionRequest,
} from "../src/decision.ts";

const noul = { type: "noul", instructions: "Does this fit?" };
const score = {
  type: "score",
  instructions: "How well does this fit?",
  criteria: ["poor", "strong"],
};
const choice = {
  type: "choice",
  instructions: "Which option fits?",
  criteria: { first: "First option", second: null },
};

function request(questions: unknown, state: unknown = { decision: "Choose" }) {
  return JSON.stringify({ state, questions });
}

function errorMessage(input: string, maxStateChars = 8000): string {
  try {
    parseDecisionRequest(input, maxStateChars);
  } catch (error) {
    assert.ok(error instanceof DecisionInputError);
    return error.message;
  }
  assert.fail("expected DecisionInputError");
}

function inputWithBytes(targetBytes: number): string {
  const prefix = '{"state":"';
  const suffix = '","questions":{"q":{"type":"noul","instructions":"x"}}}';
  const fillBytes = targetBytes - Buffer.byteLength(prefix + suffix, "utf8");
  const fill = "é".repeat(Math.floor(fillBytes / 2)) + (fillBytes % 2 === 1 ? "a" : "");
  const input = prefix + fill + suffix;
  assert.equal(Buffer.byteLength(input, "utf8"), targetBytes);
  return input;
}

describe("parseDecisionRequest", () => {
  it("parses Noul, Score, and Choice question definitions", () => {
    const input = request({ noul, score, choice });

    const parsed = parseDecisionRequest(input, 100);

    assert.deepEqual(parsed, {
      state: { decision: "Choose" },
      questions: { noul, score, choice },
    });
  });

  it("accepts nullable state and omitted Noul criteria", () => {
    const parsed = parseDecisionRequest(request({ q: noul }, null), 4);

    assert.equal(parsed.state, null);
    assert.deepEqual(parsed.questions.q, noul);
  });

  it("rejects invalid JSON with a fixed message", () => {
    const secret = "PRIVATE_DECISION_TEXT_9182";
    const message = errorMessage(`{"state":"${secret}"`);

    assert.match(message, /invalid json/i);
    assert.equal(message.includes(secret), false);
  });

  it("requires exactly state and questions at the top level", () => {
    const validQuestions = { q: noul };

    for (const input of [
      JSON.stringify({ questions: validQuestions }),
      JSON.stringify({ state: {}, questions: validQuestions, extra: "private" }),
    ]) {
      const message = errorMessage(input);
      assert.match(message, /top-level|state/i);
      assert.equal(message.includes("private"), false);
    }
  });

  it("requires an object question map with at least one question", () => {
    for (const questions of [null, [], {}, "question"]) {
      assert.throws(
        () => parseDecisionRequest(request(questions), 100),
        DecisionInputError
      );
    }
  });

  it("rejects malformed instructions and question properties", () => {
    const invalidQuestions = [
      { q: { ...noul, instructions: " \t " } },
      { q: { ...noul, instructions: 42 } },
      { q: { ...noul, unexpected: "private" } },
      { q: { type: "unknown", instructions: "Choose" } },
    ];

    for (const questions of invalidQuestions) {
      const message = errorMessage(request(questions));
      assert.equal(message.includes("private"), false);
    }
  });

  it("rejects malformed Noul criteria", () => {
    const invalidQuestions = [
      { q: { ...noul, criteria: "yes" } },
      { q: { ...noul, criteria: { true: "  " } } },
      { q: { ...noul, criteria: { false: 0 } } },
      { q: { ...noul, criteria: { other: "unexpected" } } },
    ];

    for (const questions of invalidQuestions) {
      assert.throws(
        () => parseDecisionRequest(request(questions), 100),
        DecisionInputError
      );
    }
  });

  it("rejects malformed Score criteria", () => {
    const invalidQuestions = [
      { q: { ...score, criteria: [] } },
      { q: { ...score, criteria: ["only one"] } },
      { q: { ...score, criteria: ["strong", "  "] } },
      { q: { ...score, criteria: "low,high" } },
      { q: { ...score, criteria: Array.from({ length: 11 }, (_, index) => `level ${index}`) } },
    ];

    for (const questions of invalidQuestions) {
      assert.throws(
        () => parseDecisionRequest(request(questions), 100),
        DecisionInputError
      );
    }
  });

  it("rejects malformed Choice criteria", () => {
    const invalidQuestions = [
      { q: { ...choice, criteria: {} } },
      { q: { ...choice, criteria: { " ": "blank name" } } },
      { q: { ...choice, criteria: { first: 1 } } },
    ];

    for (const questions of invalidQuestions) {
      assert.throws(
        () => parseDecisionRequest(request(questions), 100),
        DecisionInputError
      );
    }
  });

  it("accepts TypeSafe criteria limits and rejects definitions above them", () => {
    const maxScore = {
      ...score,
      criteria: Array.from({ length: 10 }, (_, index) => `level ${index}`),
    };
    const maxChoice = {
      ...choice,
      criteria: Object.fromEntries(
        Array.from({ length: 255 }, (_, index) => [`option_${index}`, null])
      ),
    };
    const accepted = parseDecisionRequest(request({ maxScore, maxChoice }), 100);

    assert.equal(accepted.questions.maxScore.criteria.length, 10);
    assert.equal(Object.keys(accepted.questions.maxChoice.criteria).length, 255);
    assert.throws(
      () => parseDecisionRequest(request({ q: { ...score, criteria: ["one"] } }), 100),
      DecisionInputError
    );
    assert.throws(
      () => parseDecisionRequest(
        request({ q: { ...choice, criteria: Object.fromEntries([...Object.entries(maxChoice.criteria), ["option_255", null]]) } }),
        100
      ),
      DecisionInputError
    );
  });

  it("rejects prototype-sensitive question names", () => {
    for (const name of ["", "  ", "__proto__", "constructor", "prototype"]) {
      const questions = JSON.parse(`{"${name}":${JSON.stringify(noul)}}`);
      assert.throws(
        () => parseDecisionRequest(request(questions), 100),
        DecisionInputError
      );
    }
  });

  it("rejects prototype-sensitive Choice criteria names", () => {
    for (const name of ["__proto__", "constructor", "prototype"]) {
      const criteria = JSON.parse(`{"${name}":"special option"}`);
      const questions = { q: { ...choice, criteria } };
      assert.throws(
        () => parseDecisionRequest(request(questions), 100),
        DecisionInputError
      );
    }
  });

  it("accepts serialized state exactly at maxStateChars and rejects one character above", () => {
    const atLimit = parseDecisionRequest(request({ q: noul }, "abc"), 5);

    assert.equal(atLimit.state, "abc");
    assert.throws(
      () => parseDecisionRequest(request({ q: noul }, "abcd"), 5),
      DecisionInputError
    );
  });

  it("accepts 32 questions and rejects 33", () => {
    assert.equal(MAX_DECISION_QUESTIONS, 32);
    const atLimit = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`q${index}`, noul])
    );
    const aboveLimit = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`q${index}`, noul])
    );

    assert.equal(Object.keys(parseDecisionRequest(request(atLimit), 100).questions).length, 32);
    assert.throws(
      () => parseDecisionRequest(request(aboveLimit), 100),
      DecisionInputError
    );
  });

  it("uses UTF-8 byte count at and above the 64 KiB input limit", () => {
    assert.equal(MAX_DECISION_INPUT_BYTES, 64 * 1024);
    const atLimit = inputWithBytes(MAX_DECISION_INPUT_BYTES);
    const aboveLimit = inputWithBytes(MAX_DECISION_INPUT_BYTES + 1);

    assert.ok(atLimit.length < MAX_DECISION_INPUT_BYTES);
    assert.doesNotThrow(() => parseDecisionRequest(atLimit, MAX_DECISION_INPUT_BYTES));
    assert.throws(
      () => parseDecisionRequest(aboveLimit, MAX_DECISION_INPUT_BYTES),
      DecisionInputError
    );
  });
});
