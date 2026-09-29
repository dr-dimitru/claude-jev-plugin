import type { TypeSafeQuestion } from "./client.ts";

/** Maximum raw request size in UTF-8 bytes. */
export const MAX_DECISION_INPUT_BYTES = 64 * 1024;
/** Maximum number of questions per request. */
export const MAX_DECISION_QUESTIONS = 32;
/** TypeSafe Score accepts at least two levels, up to 10. */
export const MIN_SCORE_CRITERIA = 2;
export const MAX_SCORE_CRITERIA = 10;
/**
 * Plugin cap for Choice categories. The API allows 255, but two-decimal
 * probability rounding drift grows 0.005 per category, so a lower cap keeps
 * the response sum check meaningful.
 */
export const MIN_CHOICE_CRITERIA = 2;
export const MAX_CHOICE_CRITERIA = 20;
export const MAX_INSTRUCTIONS_CHARS = 2000;
export const MAX_CRITERION_CHARS = 500;
const MAX_CHOICE_KEY_CHARS = 64;
export const QUESTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const FORBIDDEN_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "hasOwnProperty",
  "toString",
  "valueOf",
]);

/** Validated custom question request. */
export interface DecisionRequest {
  state: unknown;
  questions: Record<string, TypeSafeQuestion>;
}

/** Input validation failure. Messages never include submitted content. */
export class DecisionInputError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "DecisionInputError";
    this.code = code;
    Object.setPrototypeOf(this, DecisionInputError.prototype);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(name: string, rule: string): DecisionInputError {
  return new DecisionInputError(`Invalid question '${name}': ${rule}`, "INVALID_QUESTION");
}

function isCriterionText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_CRITERION_CHARS;
}

function parseNoulCriteria(name: string, raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw invalid(name, "criteria must be an object");
  const out: Record<string, string> = {};
  for (const key of Object.keys(raw)) {
    if (key !== "true" && key !== "false") {
      throw invalid(name, "criteria may only contain 'true' and 'false'");
    }
    const value = raw[key];
    if (!isCriterionText(value)) {
      throw invalid(name, `criteria '${key}' must be a non-empty string of at most ${MAX_CRITERION_CHARS} chars`);
    }
    out[key] = value;
  }
  return out;
}

function parseScoreCriteria(name: string, raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < MIN_SCORE_CRITERIA || raw.length > MAX_SCORE_CRITERIA) {
    throw invalid(name, `criteria must be an array of ${MIN_SCORE_CRITERIA} to ${MAX_SCORE_CRITERIA} strings`);
  }
  return raw.map((item) => {
    if (!isCriterionText(item)) {
      throw invalid(name, `each criterion must be a non-empty string of at most ${MAX_CRITERION_CHARS} chars`);
    }
    return item;
  });
}

function parseChoiceCriteria(name: string, raw: unknown): Record<string, string | null> {
  if (!isPlainObject(raw)) throw invalid(name, "criteria must be an object");
  const keys = Object.keys(raw);
  if (keys.length < MIN_CHOICE_CRITERIA || keys.length > MAX_CHOICE_CRITERIA) {
    throw invalid(name, `criteria must have ${MIN_CHOICE_CRITERIA} to ${MAX_CHOICE_CRITERIA} entries`);
  }
  const out: Record<string, string | null> = {};
  for (const key of keys) {
    if (key.length === 0 || key.length > MAX_CHOICE_KEY_CHARS || FORBIDDEN_NAMES.has(key)) {
      throw invalid(name, `category names must be 1 to ${MAX_CHOICE_KEY_CHARS} chars and not reserved`);
    }
    const value = raw[key];
    if (value !== null && !isCriterionText(value)) {
      throw invalid(name, `category descriptions must be null or a non-empty string of at most ${MAX_CRITERION_CHARS} chars`);
    }
    out[key] = value as string | null;
  }
  return out;
}

function parseQuestion(name: string, raw: unknown): TypeSafeQuestion {
  if (!isPlainObject(raw)) throw invalid(name, "must be an object");
  for (const key of Object.keys(raw)) {
    if (key !== "type" && key !== "instructions" && key !== "criteria") {
      throw new DecisionInputError(
        `Unknown field in question '${name}'`,
        "UNKNOWN_QUESTION_FIELD"
      );
    }
  }
  const type = raw.type;
  if (type !== "noul" && type !== "score" && type !== "choice") {
    throw new DecisionInputError(
      `Unknown type for question '${name}'; expected noul, score, or choice`,
      "UNKNOWN_QUESTION_TYPE"
    );
  }
  const instructions = raw.instructions;
  if (
    typeof instructions !== "string" ||
    instructions.trim().length === 0 ||
    instructions.length > MAX_INSTRUCTIONS_CHARS
  ) {
    throw invalid(name, `instructions must be a non-empty string of at most ${MAX_INSTRUCTIONS_CHARS} chars`);
  }
  const trimmed = instructions.trim();

  if (type === "noul") {
    const criteria = parseNoulCriteria(name, raw.criteria);
    return criteria
      ? { type, instructions: trimmed, criteria }
      : { type, instructions: trimmed };
  }
  if (type === "score") {
    return { type, instructions: trimmed, criteria: parseScoreCriteria(name, raw.criteria) };
  }
  return { type, instructions: trimmed, criteria: parseChoiceCriteria(name, raw.criteria) };
}

/**
 * Parses and validates one `{ state, questions }` request.
 * Throws DecisionInputError with fixed messages that never echo submitted content.
 */
export function parseDecisionRequest(input: string, maxStateChars: number): DecisionRequest {
  if (Buffer.byteLength(input, "utf8") > MAX_DECISION_INPUT_BYTES) {
    throw new DecisionInputError(
      `Input exceeds ${MAX_DECISION_INPUT_BYTES} bytes`,
      "INPUT_TOO_LARGE"
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new DecisionInputError("Input is not valid JSON", "INVALID_JSON");
  }

  if (!isPlainObject(parsed)) {
    throw new DecisionInputError("Input must be a JSON object with 'state' and 'questions'", "INVALID_REQUEST");
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "state" && key !== "questions") {
      throw new DecisionInputError("Input has an unknown top-level field", "UNKNOWN_FIELD");
    }
  }
  if (!Object.hasOwn(parsed, "state") || parsed.state === null || parsed.state === undefined) {
    throw new DecisionInputError("Input requires a non-null 'state'", "MISSING_STATE");
  }
  if (!Object.hasOwn(parsed, "questions")) {
    throw new DecisionInputError("Input requires 'questions'", "MISSING_QUESTIONS");
  }

  const state = parsed.state;
  if (JSON.stringify(state).length > maxStateChars) {
    throw new DecisionInputError(
      `State exceeds ${maxStateChars} characters`,
      "STATE_TOO_LARGE"
    );
  }

  const rawQuestions = parsed.questions;
  if (!isPlainObject(rawQuestions)) {
    throw new DecisionInputError("'questions' must be an object", "INVALID_QUESTIONS");
  }
  const names = Object.keys(rawQuestions);
  if (names.length < 1 || names.length > MAX_DECISION_QUESTIONS) {
    throw new DecisionInputError(
      `'questions' must have 1 to ${MAX_DECISION_QUESTIONS} entries`,
      "INVALID_QUESTIONS"
    );
  }
  for (const name of names) {
    if (!QUESTION_NAME_PATTERN.test(name) || FORBIDDEN_NAMES.has(name)) {
      throw new DecisionInputError(
        "Question names must match /^[A-Za-z][A-Za-z0-9_]{0,63}$/ and not be reserved",
        "INVALID_QUESTION_NAME"
      );
    }
  }

  const questions: Record<string, TypeSafeQuestion> = {};
  for (const name of names) {
    if (!Object.hasOwn(rawQuestions, name)) continue;
    questions[name] = parseQuestion(name, rawQuestions[name]);
  }
  return { state, questions };
}
