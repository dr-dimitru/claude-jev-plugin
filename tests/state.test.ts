import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildGateState,
  buildOutputState,
  boundTextLeaves,
} from "../src/state.ts";

describe("bounded state builders", () => {
  describe("buildGateState", () => {
    it("preserves tool and cwd, and bounds user_request to 1200 chars by default", () => {
      const longRequest = "A".repeat(1300);
      const state = buildGateState({
        tool: "Bash",
        cwd: "/Users/test/project",
        tool_input: { command: "git status" },
        user_request: longRequest,
      });

      assert.equal(state.tool, "Bash");
      assert.equal(state.cwd, "/Users/test/project");
      assert.deepEqual(state.tool_input, { command: "git status" });
      assert.equal(
        state.user_request,
        "A".repeat(1200) + "…[100 chars elided]"
      );
    });

    it("normalizes tool_name to tool", () => {
      const state = buildGateState({
        tool_name: "Bash",
        cwd: "/Users/test/project",
        tool_input: { command: "ls" },
      });

      assert.equal(state.tool, "Bash");
    });

    it("bounds tool_input argument strings to 400 chars by default", () => {
      const longContent = "B".repeat(450);
      const state = buildGateState({
        tool: "Write",
        cwd: "/Users/test/project",
        tool_input: {
          file_path: "/Users/test/project/src/index.ts",
          content: longContent,
        },
      });

      const toolInput = state.tool_input as Record<string, unknown>;
      assert.equal(toolInput.file_path, "/Users/test/project/src/index.ts");
      assert.equal(
        toolInput.content,
        "B".repeat(400) + "…[50 chars elided]"
      );
    });

    it("recursively bounds string leaves in nested objects and arrays", () => {
      const long1 = "X".repeat(500);
      const long2 = "Y".repeat(600);
      const state = buildGateState({
        tool: "Edit",
        cwd: "/Users/test/project",
        tool_input: {
          file_path: "/path/file.ts",
          nested: {
            old_string: long1,
            tags: [long2, 123, true, null],
          },
        },
      });

      const toolInput = state.tool_input as any;
      assert.equal(
        toolInput.nested.old_string,
        "X".repeat(400) + "…[100 chars elided]"
      );
      assert.equal(
        toolInput.nested.tags[0],
        "Y".repeat(400) + "…[200 chars elided]"
      );
      assert.equal(toolInput.nested.tags[1], 123);
      assert.equal(toolInput.nested.tags[2], true);
      assert.equal(toolInput.nested.tags[3], null);
    });

    it("does not include transcript_path or session_id in gate state", () => {
      const state = buildGateState({
        tool: "Bash",
        cwd: "/Users/test/project",
        tool_input: { command: "echo hi" },
        // Even if passed accidentally in input
        ...({ session_id: "secret-session-id", transcript_path: "/path/to/transcript.jsonl" } as any),
      });

      assert.equal((state as any).session_id, undefined);
      assert.equal((state as any).transcript_path, undefined);
    });
  });

  describe("buildOutputState", () => {
    it("preserves tool, cwd, is_error, and bounds output to 2000 chars by default", () => {
      const longOutput = "C".repeat(2250);
      const state = buildOutputState({
        tool: "Bash",
        cwd: "/Users/test/project",
        is_error: false,
        tool_input: { command: "npm test" },
        output: longOutput,
      });

      assert.equal(state.tool, "Bash");
      assert.equal(state.cwd, "/Users/test/project");
      assert.equal(state.is_error, false);
      assert.deepEqual(state.tool_input, { command: "npm test" });
      assert.equal(
        state.output,
        "C".repeat(2000) + "…[250 chars elided]"
      );
    });

    it("handles failure payloads with top-level error", () => {
      const state = buildOutputState({
        tool_name: "Bash",
        cwd: "/Users/test/project",
        tool_input: { command: "npm test" },
        error: "Exit code 1\nCommand failed",
      });

      assert.equal(state.tool, "Bash");
      assert.equal(state.is_error, true);
      assert.equal(state.output, "Exit code 1\nCommand failed");
    });
  });

  describe("Unicode handling and markers", () => {
    it("uses exact Unicode ellipsis marker …[N chars elided]", () => {
      const text = "Hello World! Extra";
      const bounded = boundTextLeaves(text, 12);
      assert.equal(bounded, "Hello World!…[6 chars elided]");
      assert.ok(bounded.includes("…[6 chars elided]"));
      assert.ok(!bounded.includes("...[")); // Must use Unicode ellipsis …
    });

    it("safely bounds Unicode strings containing emojis without splitting code points", () => {
      // 🚀 is 2 UTF-16 code units, 1 code point
      const emojis = "🚀🌟🎉🔥".repeat(100); // 400 emojis
      const bounded = boundTextLeaves(emojis, 10);
      // First 10 emojis
      assert.equal(bounded, "🚀🌟🎉🔥🚀🌟🎉🔥🚀🌟…[390 chars elided]");
      // Ensure no dangling surrogate pairs
      assert.doesNotThrow(() => JSON.stringify(bounded));
    });
  });

  describe("aggregate maxStateChars enforcement", () => {
    it("enforces maxStateChars while producing valid JSON", () => {
      const hugeInput: Record<string, string> = {};
      for (let i = 0; i < 50; i++) {
        hugeInput[`key_${i}`] = "V".repeat(300);
      }

      const state = buildGateState({
        tool: "Bash",
        cwd: "/Users/test/project",
        tool_input: hugeInput,
        user_request: "U".repeat(1000),
        config: {
          maxStateChars: 1500,
        },
      });

      const serialized = JSON.stringify(state);
      assert.ok(
        serialized.length <= 1500,
        `Expected serialized length <= 1500, got ${serialized.length}`
      );

      // Must be valid JSON
      const parsed = JSON.parse(serialized);
      assert.equal(parsed.tool, "Bash");
      assert.equal(parsed.cwd, "/Users/test/project");
    });

    it("removes user_request first when cap is exceeded", () => {
      const state = buildGateState({
        tool: "Bash",
        cwd: "/short/path",
        tool_input: { command: "short command" },
        user_request: "R".repeat(500),
        config: {
          maxStateChars: 100, // Very tight cap
        },
      });

      const serialized = JSON.stringify(state);
      assert.ok(serialized.length <= 100);
      const parsed = JSON.parse(serialized);
      assert.equal(parsed.tool, "Bash");
      // user_request was trimmed or removed to fit under 100 chars
      assert.ok(
        parsed.user_request === undefined ||
          parsed.user_request.length < 500
      );
    });

    it("enforces maxStateChars when tool_input has many keys", () => {
      const manyKeysInput: Record<string, string> = {};
      for (let i = 0; i < 1000; i++) {
        manyKeysInput[`key_${i}`] = `val_${i}`;
      }

      const state = buildGateState({
        tool: "Bash",
        cwd: "/Users/test/project",
        tool_input: {
          command: "npm test",
          ...manyKeysInput,
        },
        config: {
          maxStateChars: 8000,
        },
      });

      const serialized = JSON.stringify(state);
      assert.ok(
        serialized.length <= 8000,
        `Expected serialized length <= 8000, got ${serialized.length}`
      );
      const parsed = JSON.parse(serialized);
      assert.equal(parsed.tool, "Bash");
      assert.equal(parsed.cwd, "/Users/test/project");
    });
  });
});
