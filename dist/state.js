/**
 * Bounded state builders for TypeSafe Jev gate and output evaluation.
 *
 * Implements recursive string leaf bounding, Unicode-safe ellipsis markers,
 * field preservation (tool, cwd, error), and final serialized maxStateChars cap enforcement
 * without producing invalid JSON.
 */
export const DEFAULT_USER_REQUEST_CHARS = 1200;
export const DEFAULT_ARGUMENT_CHARS = 400;
export const DEFAULT_OUTPUT_CHARS = 2000;
export const DEFAULT_MAX_STATE_CHARS = 8000;
/**
 * Bounds text using Unicode code points and appends the marker …[N chars elided].
 */
export function boundTextLeaves(val, maxChars) {
    if (typeof val === "string") {
        const codePoints = Array.from(val);
        if (codePoints.length <= maxChars) {
            return val;
        }
        const elided = codePoints.length - maxChars;
        return codePoints.slice(0, maxChars).join("") + `…[${elided} chars elided]`;
    }
    if (Array.isArray(val)) {
        return val.map((item) => boundTextLeaves(item, maxChars));
    }
    if (val !== null && typeof val === "object") {
        const res = {};
        for (const [k, v] of Object.entries(val)) {
            res[k] = boundTextLeaves(v, maxChars);
        }
        return res;
    }
    return val;
}
function deepClone(obj) {
    if (obj === null || typeof obj !== "object") {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(deepClone);
    }
    const copy = {};
    for (const [k, v] of Object.entries(obj)) {
        copy[k] = deepClone(v);
    }
    return copy;
}
/**
 * Enforces the final serialized maxStateChars cap without producing invalid JSON.
 * Follows spec:
 * 1. Optional user-request text is reduced or removed first.
 * 2. String leaves are reduced.
 * 3. Oversized optional fields are replaced by a marker.
 * Never cuts a JSON string in the middle of a JSON document.
 */
const PRIORITY_KEYS = [
    "command",
    "file_path",
    "content",
    "old_string",
    "new_string",
    "description",
];
function boundStructure(val, maxContainerItems) {
    if (Array.isArray(val)) {
        if (val.length > maxContainerItems) {
            const elided = val.length - maxContainerItems;
            const sliced = val
                .slice(0, maxContainerItems)
                .map((v) => boundStructure(v, maxContainerItems));
            return [...sliced, `…[${elided} items elided]`];
        }
        return val.map((v) => boundStructure(v, maxContainerItems));
    }
    if (val !== null && typeof val === "object") {
        const obj = val;
        const keys = Object.keys(obj);
        if (keys.length > maxContainerItems) {
            const sortedKeys = [...keys].sort((a, b) => {
                const aPri = PRIORITY_KEYS.indexOf(a);
                const bPri = PRIORITY_KEYS.indexOf(b);
                if (aPri !== -1 && bPri !== -1)
                    return aPri - bPri;
                if (aPri !== -1)
                    return -1;
                if (bPri !== -1)
                    return 1;
                return 0;
            });
            const elided = keys.length - maxContainerItems;
            const res = {};
            for (const k of sortedKeys.slice(0, maxContainerItems)) {
                res[k] = boundStructure(obj[k], maxContainerItems);
            }
            res["_elided"] = `…[${elided} keys elided]`;
            return res;
        }
        const res = {};
        for (const k of keys) {
            res[k] = boundStructure(obj[k], maxContainerItems);
        }
        return res;
    }
    return val;
}
/**
 * Enforces the final serialized maxStateChars cap without producing invalid JSON.
 * Follows spec:
 * 1. Optional user-request text is reduced or removed first.
 * 2. String leaves are reduced.
 * 3. Oversized optional fields are reduced or replaced by bounded markers/prefixes.
 * Never cuts a JSON string in the middle of a JSON document.
 * Never returns a value over maxStateChars.
 */
export function enforceMaxStateChars(rawState, maxStateChars) {
    const state = deepClone(rawState);
    let serialized = JSON.stringify(state);
    if (serialized.length <= maxStateChars) {
        return state;
    }
    // Step 1: Reduce or remove user_request if present
    if (typeof state.user_request === "string") {
        const overage = serialized.length - maxStateChars;
        const currentCodePoints = Array.from(state.user_request);
        const newBudget = currentCodePoints.length - overage - 40; // budget room for marker
        if (newBudget > 50) {
            state.user_request = boundTextLeaves(state.user_request, newBudget);
        }
        else {
            delete state.user_request;
        }
        serialized = JSON.stringify(state);
        if (serialized.length <= maxStateChars) {
            return state;
        }
    }
    // Step 2: Progressively reduce string leaves in tool_input and output
    const stepLimits = [200, 100, 50, 20, 5];
    for (const limit of stepLimits) {
        if (state.tool_input !== undefined) {
            state.tool_input = boundTextLeaves(state.tool_input, limit);
        }
        if (typeof state.output === "string") {
            state.output = boundTextLeaves(state.output, limit);
        }
        serialized = JSON.stringify(state);
        if (serialized.length <= maxStateChars) {
            return state;
        }
    }
    // Step 3: Structural reduction of large objects and arrays (tool_input, etc.)
    const containerLimits = [50, 25, 10, 5, 2, 1];
    for (const limit of containerLimits) {
        if (state.tool_input !== undefined) {
            state.tool_input = boundStructure(state.tool_input, limit);
        }
        serialized = JSON.stringify(state);
        if (serialized.length <= maxStateChars) {
            return state;
        }
    }
    // Step 4: If still over cap, reduce tool_input to minimal or marker
    if (state.tool_input !== undefined) {
        if (state.tool_input && typeof state.tool_input === "object" && !Array.isArray(state.tool_input)) {
            const ti = state.tool_input;
            const primaryKey = PRIORITY_KEYS.find((k) => k in ti);
            if (primaryKey) {
                state.tool_input = {
                    [primaryKey]: boundTextLeaves(ti[primaryKey], 50),
                    _elided: "…[input elided]",
                };
            }
            else {
                state.tool_input = "…[input elided]";
            }
        }
        else {
            state.tool_input = "…[input elided]";
        }
        serialized = JSON.stringify(state);
        if (serialized.length <= maxStateChars) {
            return state;
        }
    }
    // Step 5: Reduce output to marker
    if (typeof state.output === "string") {
        state.output = "…[output elided]";
        serialized = JSON.stringify(state);
        if (serialized.length <= maxStateChars) {
            return state;
        }
    }
    // Step 6: Remove optional platform, user_request
    delete state.platform;
    delete state.user_request;
    serialized = JSON.stringify(state);
    if (serialized.length <= maxStateChars) {
        return state;
    }
    // Step 7: Bound cwd
    if (typeof state.cwd === "string") {
        const minNeeded = JSON.stringify({ tool: state.tool }).length;
        const cwdBudget = Math.max(0, maxStateChars - minNeeded - 25);
        state.cwd = cwdBudget > 0 ? boundTextLeaves(state.cwd, cwdBudget) : "";
        serialized = JSON.stringify(state);
        if (serialized.length <= maxStateChars) {
            return state;
        }
    }
    // Step 8: Absolute hard guarantee - never return a value over maxStateChars
    state.tool_input = undefined;
    state.output = undefined;
    serialized = JSON.stringify(state);
    if (serialized.length <= maxStateChars) {
        return state;
    }
    if (typeof state.tool === "string") {
        const toolBudget = Math.max(1, maxStateChars - 20);
        state.tool = state.tool.slice(0, toolBudget);
        state.cwd = "";
    }
    return state;
}
/**
 * Builds the bounded gate state to send to TypeSafe Jev.
 * Includes only: cwd, tool, tool_input, user_request, and platform (if provided).
 * Strips session_id, transcript_path, etc.
 */
export function buildGateState(input) {
    const tool = input.tool ?? input.tool_name ?? "unknown";
    const argumentChars = input.config?.gate?.argumentChars ??
        input.config?.argumentChars ??
        DEFAULT_ARGUMENT_CHARS;
    const userRequestChars = input.config?.userRequestChars ??
        DEFAULT_USER_REQUEST_CHARS;
    const maxStateChars = input.config?.maxStateChars ??
        DEFAULT_MAX_STATE_CHARS;
    const rawToolInput = input.tool_input ?? {};
    const boundedToolInput = boundTextLeaves(rawToolInput, argumentChars);
    const state = {
        cwd: input.cwd ?? process.cwd(),
        tool,
        tool_input: boundedToolInput,
    };
    if (typeof input.user_request === "string" && input.user_request.length > 0) {
        state.user_request = boundTextLeaves(input.user_request, userRequestChars);
    }
    if (typeof input.platform === "string") {
        state.platform = input.platform;
    }
    return enforceMaxStateChars(state, maxStateChars);
}
/**
 * Builds the bounded output state to send to TypeSafe Jev.
 * Includes only: cwd, tool, is_error, tool_input, output.
 */
export function buildOutputState(input) {
    const tool = input.tool ?? input.tool_name ?? "unknown";
    const argumentChars = input.config?.argumentChars ??
        DEFAULT_ARGUMENT_CHARS;
    const outputChars = input.config?.output?.outputChars ??
        input.config?.outputChars ??
        DEFAULT_OUTPUT_CHARS;
    const maxStateChars = input.config?.maxStateChars ??
        DEFAULT_MAX_STATE_CHARS;
    const rawToolInput = input.tool_input ?? {};
    const boundedToolInput = boundTextLeaves(rawToolInput, argumentChars);
    const isError = input.is_error ??
        (input.error !== undefined);
    let rawOutput = "";
    if (typeof input.output === "string") {
        rawOutput = input.output;
    }
    else if (typeof input.error === "string") {
        rawOutput = input.error;
    }
    const boundedOutput = boundTextLeaves(rawOutput, outputChars);
    const state = {
        cwd: input.cwd ?? process.cwd(),
        tool,
        is_error: isError,
        tool_input: boundedToolInput,
        output: boundedOutput,
    };
    return enforceMaxStateChars(state, maxStateChars);
}
