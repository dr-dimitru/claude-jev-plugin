import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseDecisionRequest,
  DecisionInputError,
  MAX_DECISION_INPUT_BYTES,
  MAX_DECISION_QUESTIONS,
} from "../src/decision.ts";

const MAX_STATE = 10_000;
const SECRET = "SECRET-MARKER-123";

function req(state: unknown, questions: unknown): string {
  return JSON.stringify({ state, questions });
}
const noul = { type: "noul", instructions: "Is it ok?" };

function fails(input: string, code: string, max = MAX_STATE): DecisionInputError {
  try {
    parseDecisionRequest(input, max);
  } catch (err) {
    assert.ok(err instanceof DecisionInputError, "expected DecisionInputError");
    assert.equal(err.code, code);
    assert.ok(!err.message.includes(SECRET), "message leaks secret");
    return err;
  }
  assert.fail(`expected ${code}`);
}

function qs(n: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) out[`q${i}`] = noul;
  return out;
}

describe("parseDecisionRequest valid input", () => {
  it("accepts noul without criteria", () => {
    const r = parseDecisionRequest(req({ a: 1 }, { q: noul }), MAX_STATE);
    assert.deepEqual(r, { state: { a: 1 }, questions: { q: { type: "noul", instructions: "Is it ok?" } } });
  });

  it("accepts noul with criteria", () => {
    const q = { ...noul, criteria: { true: "yes when x", false: "no when y" } };
    const r = parseDecisionRequest(req("s", { q }), MAX_STATE);
    assert.deepEqual(r.questions.q, q);
  });

  it("accepts score", () => {
    const q = { type: "score", instructions: "Rate", criteria: ["bad", "good"] };
    assert.deepEqual(parseDecisionRequest(req({}, { q }), MAX_STATE).questions.q, q);
  });

  it("accepts choice with null and string values", () => {
    const q = { type: "choice", instructions: "Pick", criteria: { a: "first", b: null } };
    assert.deepEqual(parseDecisionRequest(req([1], { q }), MAX_STATE).questions.q, q);
  });

  it("returns a fresh object with only validated fields", () => {
    const r = parseDecisionRequest(req({}, { q: noul }), MAX_STATE);
    assert.equal(Object.getPrototypeOf(r.questions), Object.prototype);
  });
});

describe("parseDecisionRequest top level", () => {
  it("rejects invalid JSON without quoting input", () => {
    const err = fails(`{"state": "${SECRET}", `, "INVALID_JSON");
    assert.ok(!err.message.includes("Unexpected"));
  });
  it("rejects array top level", () => fails("[]", "INVALID_REQUEST"));
  it("rejects null top level", () => fails("null", "INVALID_REQUEST"));
  it("rejects missing state", () => fails(JSON.stringify({ questions: { q: noul } }), "MISSING_STATE"));
  it("rejects null state", () => fails(req(null, { q: noul }), "MISSING_STATE"));
  it("rejects missing questions", () => fails(JSON.stringify({ state: SECRET }), "MISSING_QUESTIONS"));
  it("rejects extra top-level field", () =>
    fails(JSON.stringify({ state: 1, questions: { q: noul }, extra: SECRET }), "UNKNOWN_FIELD"));
  it("rejects questions array", () => fails(req(1, [noul]), "INVALID_QUESTIONS"));
  it("rejects empty questions", () => fails(req(1, {}), "INVALID_QUESTIONS"));
  it("accepts 32 questions", () => {
    const r = parseDecisionRequest(req(1, qs(MAX_DECISION_QUESTIONS)), MAX_STATE);
    assert.equal(Object.keys(r.questions).length, 32);
  });
  it("rejects 33 questions", () => fails(req(1, qs(33)), "INVALID_QUESTIONS"));
});

describe("parseDecisionRequest size limits", () => {
  function padded(bytes: number): string {
    const base = req({ p: "" }, { q: noul });
    const need = bytes - Buffer.byteLength(base, "utf8");
    assert.ok(need >= 2);
    const pad = "é".repeat(Math.floor(need / 2)) + (need % 2 ? "a" : "");
    const input = req({ p: pad }, { q: noul });
    assert.equal(Buffer.byteLength(input, "utf8"), bytes);
    return input;
  }

  it("accepts exactly 64 KiB of UTF-8", () => {
    parseDecisionRequest(padded(MAX_DECISION_INPUT_BYTES), 1_000_000);
  });
  it("rejects 64 KiB + 1 byte", () => {
    fails(padded(MAX_DECISION_INPUT_BYTES + 1), "INPUT_TOO_LARGE", 1_000_000);
  });
  it("counts bytes, not characters", () => {
    // 40000 two-byte chars: 40000 chars < 64K, 80000 bytes > 64K
    fails(req({ p: "é".repeat(40_000) }, { q: noul }), "INPUT_TOO_LARGE", 1_000_000);
  });
  it("accepts state exactly at maxStateChars", () => {
    const state = "x".repeat(98);
    assert.equal(JSON.stringify(state).length, 100);
    parseDecisionRequest(req(state, { q: noul }), 100);
  });
  it("rejects state one over maxStateChars", () => {
    const state = "x".repeat(99);
    fails(req(state, { q: noul }), "STATE_TOO_LARGE", 100);
  });
});

describe("parseDecisionRequest question names", () => {
  it("rejects __proto__ from raw JSON", () => {
    fails(`{"state":1,"questions":{"__proto__":{"type":"noul","instructions":"x"}}}`, "INVALID_QUESTION_NAME");
  });
  it("rejects constructor", () => fails(req(1, { constructor: noul }), "INVALID_QUESTION_NAME"));
  it("rejects other reserved names", () => {
    for (const n of ["prototype", "hasOwnProperty", "toString", "valueOf"]) {
      fails(req(1, { [n]: noul }), "INVALID_QUESTION_NAME");
    }
  });
  it("rejects bad name patterns", () => {
    for (const n of ["1a", "a-b", "a b", "", "a".repeat(65), "é"]) {
      fails(req(1, { [n]: noul }), "INVALID_QUESTION_NAME");
    }
  });
  it("accepts 64 char name", () => {
    parseDecisionRequest(req(1, { ["a".repeat(64)]: noul }), MAX_STATE);
  });
});

describe("parseDecisionRequest question fields", () => {
  it("rejects unknown type", () =>
    fails(req(1, { q: { type: "other", instructions: "x" } }), "UNKNOWN_QUESTION_TYPE"));
  it("rejects missing type", () => fails(req(1, { q: { instructions: "x" } }), "UNKNOWN_QUESTION_TYPE"));
  it("rejects non-object question", () => fails(req(1, { q: "x" }), "INVALID_QUESTION"));
  it("rejects missing instructions", () => fails(req(1, { q: { type: "noul" } }), "INVALID_QUESTION"));
  it("rejects empty and blank instructions", () => {
    fails(req(1, { q: { type: "noul", instructions: "" } }), "INVALID_QUESTION");
    fails(req(1, { q: { type: "noul", instructions: "   " } }), "INVALID_QUESTION");
  });
  it("rejects non-string instructions", () =>
    fails(req(1, { q: { type: "noul", instructions: 5 } }), "INVALID_QUESTION"));
  it("accepts 2000 and rejects 2001 char instructions", () => {
    parseDecisionRequest(req(1, { q: { type: "noul", instructions: "a".repeat(2000) } }), MAX_STATE);
    fails(req(1, { q: { type: "noul", instructions: "a".repeat(2001) } }), "INVALID_QUESTION");
  });
  it("rejects unknown question field", () =>
    fails(req(1, { q: { ...noul, extra: 1 } }), "UNKNOWN_QUESTION_FIELD"));
});

describe("parseDecisionRequest criteria", () => {
  const score = (n: number) => ({
    type: "score",
    instructions: "x",
    criteria: Array.from({ length: n }, (_, i) => `level ${i}`),
  });
  const choice = (n: number) => ({
    type: "choice",
    instructions: "x",
    criteria: Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, null])),
  });

  it("score: rejects 1 and 11, accepts 2 and 10", () => {
    fails(req(1, { q: score(1) }), "INVALID_QUESTION");
    fails(req(1, { q: score(11) }), "INVALID_QUESTION");
    parseDecisionRequest(req(1, { q: score(2) }), MAX_STATE);
    parseDecisionRequest(req(1, { q: score(10) }), MAX_STATE);
  });
  it("score: rejects missing, non-array, empty and oversized entries", () => {
    fails(req(1, { q: { type: "score", instructions: "x" } }), "INVALID_QUESTION");
    fails(req(1, { q: { type: "score", instructions: "x", criteria: { a: "b" } } }), "INVALID_QUESTION");
    fails(req(1, { q: { type: "score", instructions: "x", criteria: ["a", ""] } }), "INVALID_QUESTION");
    fails(req(1, { q: { type: "score", instructions: "x", criteria: ["a", "b".repeat(501)] } }), "INVALID_QUESTION");
  });
  it("choice: rejects 1 and 21, accepts 2 and 20", () => {
    fails(req(1, { q: choice(1) }), "INVALID_QUESTION");
    fails(req(1, { q: choice(21) }), "INVALID_QUESTION");
    parseDecisionRequest(req(1, { q: choice(2) }), MAX_STATE);
    parseDecisionRequest(req(1, { q: choice(20) }), MAX_STATE);
  });
  it("choice: rejects missing, array, bad values and long keys", () => {
    fails(req(1, { q: { type: "choice", instructions: "x" } }), "INVALID_QUESTION");
    fails(req(1, { q: { type: "choice", instructions: "x", criteria: ["a", "b"] } }), "INVALID_QUESTION");
    fails(req(1, { q: { type: "choice", instructions: "x", criteria: { a: 1, b: null } } }), "INVALID_QUESTION");
    fails(req(1, { q: { type: "choice", instructions: "x", criteria: { a: "", b: null } } }), "INVALID_QUESTION");
    fails(req(1, { q: { type: "choice", instructions: "x", criteria: { ["k".repeat(65)]: null, b: null } } }), "INVALID_QUESTION");
    fails(req(1, { q: { type: "choice", instructions: "x", criteria: { "": null, b: null } } }), "INVALID_QUESTION");
  });
  it("choice: rejects __proto__ key from raw JSON", () => {
    fails(
      `{"state":1,"questions":{"q":{"type":"choice","instructions":"x","criteria":{"__proto__":null,"b":null}}}}`,
      "INVALID_QUESTION"
    );
  });
  it("choice: rejects constructor key", () => {
    fails(req(1, { q: { type: "choice", instructions: "x", criteria: { constructor: null, b: null } } }), "INVALID_QUESTION");
  });
  it("noul: rejects extra criteria key", () => {
    fails(req(1, { q: { ...noul, criteria: { true: "a", maybe: "b" } } }), "INVALID_QUESTION");
  });
  it("noul: rejects non-object, empty and non-string criteria", () => {
    fails(req(1, { q: { ...noul, criteria: ["a"] } }), "INVALID_QUESTION");
    fails(req(1, { q: { ...noul, criteria: { true: "" } } }), "INVALID_QUESTION");
    fails(req(1, { q: { ...noul, criteria: { false: 1 } } }), "INVALID_QUESTION");
  });
  it("noul: accepts only one of true/false", () => {
    parseDecisionRequest(req(1, { q: { ...noul, criteria: { true: "a" } } }), MAX_STATE);
  });
});

describe("parseDecisionRequest error hygiene", () => {
  it("never echoes secrets from state, instructions or criteria", () => {
    const cases = [
      req({ s: SECRET }, {}),
      req({ s: SECRET }, { q: { type: "bogus", instructions: SECRET } }),
      req({ s: SECRET }, { q: { type: "noul", instructions: "", criteria: { true: SECRET, x: SECRET } } }),
      req({ s: SECRET }, { q: { type: "noul", instructions: SECRET.repeat(200) } }),
      req({ s: SECRET }, { q: { type: "score", instructions: SECRET, criteria: [SECRET] } }),
      req({ s: SECRET }, { q: { type: "choice", instructions: SECRET, criteria: { [SECRET]: SECRET, constructor: null } } }),
      req({ s: SECRET }, { q: { ...noul, [SECRET]: 1 } }),
      req({ s: SECRET }, { [SECRET + "!"]: noul }),
    ];
    for (const c of cases) {
      try {
        parseDecisionRequest(c, MAX_STATE);
        assert.fail("expected error");
      } catch (err) {
        assert.ok(err instanceof DecisionInputError);
        assert.ok(!err.message.includes(SECRET));
      }
    }
    fails(req({ s: SECRET }, { q: noul }), "STATE_TOO_LARGE", 5);
  });
});
