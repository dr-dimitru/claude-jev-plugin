export const MAX_DECISION_INPUT_BYTES = 64 * 1024;
export const MAX_DECISION_QUESTIONS = 32;
const INVALID_JSON = "Invalid decision request: invalid JSON.";
const INVALID_TOP_LEVEL = "Invalid decision request: expected only state and questions.";
const INVALID_STATE = "Invalid decision request: state is missing or exceeds its configured limit.";
const INVALID_QUESTIONS = "Invalid decision request: questions must contain 1 to 32 entries.";
const INVALID_QUESTION = "Invalid decision request: question definition is invalid.";
const INPUT_TOO_LARGE = "Invalid decision request: input exceeds 64 KiB.";
export class DecisionInputError extends Error {
    constructor(message) {
        super(message);
        this.name = "DecisionInputError";
    }
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isSafeName(name) {
    return name.trim().length > 0 &&
        name !== "__proto__" &&
        name !== "constructor" &&
        name !== "prototype";
}
function isNonEmptyText(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function validateNoulCriteria(criteria) {
    if (criteria === undefined)
        return true;
    if (!isRecord(criteria))
        return false;
    for (const [key, value] of Object.entries(criteria)) {
        if ((key !== "true" && key !== "false") || !isNonEmptyText(value)) {
            return false;
        }
    }
    return true;
}
function validateScoreCriteria(criteria) {
    return Array.isArray(criteria) &&
        criteria.length >= 2 &&
        criteria.length <= 10 &&
        criteria.every(isNonEmptyText);
}
function validateChoiceCriteria(criteria) {
    if (!isRecord(criteria))
        return false;
    const entries = Object.entries(criteria);
    return entries.length > 0 &&
        entries.length <= 255 &&
        entries.every(([name, description]) => isSafeName(name) && (typeof description === "string" || description === null));
}
function isTypeSafeQuestion(value) {
    if (!isRecord(value))
        return false;
    if (Object.keys(value).some((key) => key !== "type" && key !== "instructions" && key !== "criteria")) {
        return false;
    }
    if (!isNonEmptyText(value.instructions))
        return false;
    if (value.type === "noul")
        return validateNoulCriteria(value.criteria);
    if (value.type === "score")
        return validateScoreCriteria(value.criteria);
    if (value.type === "choice")
        return validateChoiceCriteria(value.criteria);
    return false;
}
export function parseDecisionRequest(input, maxStateChars) {
    if (typeof input !== "string")
        throw new DecisionInputError(INVALID_JSON);
    if (Buffer.byteLength(input, "utf8") > MAX_DECISION_INPUT_BYTES) {
        throw new DecisionInputError(INPUT_TOO_LARGE);
    }
    let parsed;
    try {
        parsed = JSON.parse(input);
    }
    catch {
        throw new DecisionInputError(INVALID_JSON);
    }
    if (!isRecord(parsed))
        throw new DecisionInputError(INVALID_TOP_LEVEL);
    const fields = Object.keys(parsed);
    if (fields.length !== 2 ||
        !Object.prototype.hasOwnProperty.call(parsed, "state") ||
        !Object.prototype.hasOwnProperty.call(parsed, "questions")) {
        throw new DecisionInputError(INVALID_TOP_LEVEL);
    }
    const serializedState = JSON.stringify(parsed.state);
    if (serializedState === undefined || serializedState.length > maxStateChars) {
        throw new DecisionInputError(INVALID_STATE);
    }
    const rawQuestions = parsed.questions;
    if (!isRecord(rawQuestions))
        throw new DecisionInputError(INVALID_QUESTIONS);
    const questionNames = Object.keys(rawQuestions);
    if (questionNames.length === 0 || questionNames.length > MAX_DECISION_QUESTIONS) {
        throw new DecisionInputError(INVALID_QUESTIONS);
    }
    for (const name of questionNames) {
        if (!isSafeName(name) || !isTypeSafeQuestion(rawQuestions[name])) {
            throw new DecisionInputError(INVALID_QUESTION);
        }
    }
    return {
        state: parsed.state,
        questions: rawQuestions,
    };
}
