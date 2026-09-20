import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Readable } from "node:stream";
import {
  readHookInput,
  sessionStore,
  type SessionStore,
} from "../src/hook-io.ts";

function createStream(text: string): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(text, "utf-8")]);
}

function createChunkedStream(chunks: string[]): NodeJS.ReadableStream {
  return Readable.from(chunks.map((c) => Buffer.from(c, "utf-8")));
}

describe("hook-io", () => {
  describe("readHookInput", () => {
    it("parses valid JSON object from stream", async () => {
      const payload = {
        session_id: "sess-123",
        cwd: "/Users/test",
        hook_event_name: "PreToolUse",
      };
      const stream = createStream(JSON.stringify(payload));
      const res = await readHookInput(stream);
      assert.deepEqual(res, payload);
    });

    it("rejects invalid JSON syntax", async () => {
      const stream = createStream("{ not json");
      await assert.rejects(
        () => readHookInput(stream),
        (err: Error) => {
          assert.match(err.message, /JSON/i);
          return true;
        }
      );
    });

    it("rejects JSON primitives (number, string, boolean)", async () => {
      await assert.rejects(
        () => readHookInput(createStream("12345")),
        /expected.*object/i
      );
      await assert.rejects(
        () => readHookInput(createStream('"just a string"')),
        /expected.*object/i
      );
      await assert.rejects(
        () => readHookInput(createStream("true")),
        /expected.*object/i
      );
    });

    it("rejects JSON arrays", async () => {
      await assert.rejects(
        () => readHookInput(createStream('[{"tool": "Bash"}]')),
        /expected.*object/i
      );
    });

    it("rejects empty or whitespace-only stream", async () => {
      await assert.rejects(
        () => readHookInput(createStream("")),
        /empty/i
      );
      await assert.rejects(
        () => readHookInput(createStream("   \n\t  ")),
        /empty/i
      );
    });

    it("rejects oversized input payload", async () => {
      // 2000 bytes with limit 500
      const largeData = JSON.stringify({ large: "x".repeat(2000) });
      const stream = createStream(largeData);
      await assert.rejects(
        () => readHookInput(stream, { maxBytes: 500 }),
        /payload too large|oversized/i
      );
    });
  });

  describe("sessionStore", () => {
    let tempDir: string;
    let scratchpadDir: string;
    let fakeHomeDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-jev-session-test-"));
      scratchpadDir = path.join(tempDir, "scratchpad");
      fakeHomeDir = path.join(tempDir, "home");
      fs.mkdirSync(scratchpadDir, { recursive: true });
      fs.mkdirSync(fakeHomeDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("prefers scratchpad_dir when provided", async () => {
      const store = sessionStore({
        sessionId: "sess-abc-123",
        scratchpadDir,
        homeDir: fakeHomeDir,
      });

      const sessionPath = store.getSessionPath();
      assert.ok(sessionPath.startsWith(path.resolve(scratchpadDir)));
      assert.ok(!sessionPath.includes("sess-abc-123")); // Must be hashed!
    });

    it("falls back to ~/.cache/claude-jev when scratchpad_dir is not provided", async () => {
      const store = sessionStore({
        sessionId: "sess-abc-123",
        homeDir: fakeHomeDir,
      });

      const sessionPath = store.getSessionPath();
      const expectedCacheDir = path.join(fakeHomeDir, ".cache", "claude-jev");
      assert.ok(sessionPath.startsWith(path.resolve(expectedCacheDir)));
    });

    it("uses CLAUDE_PLUGIN_DATA before the home cache fallback", () => {
      const pluginDataDir = path.join(tempDir, "plugin-data");
      const store = sessionStore({
        sessionId: "plugin-data",
        env: { CLAUDE_PLUGIN_DATA: pluginDataDir },
        homeDir: fakeHomeDir,
      });
      assert.ok(
        store.getSessionPath().startsWith(
          path.join(path.resolve(pluginDataDir), "sessions") + path.sep
        )
      );
    });

    it("prevents path traversal by hashing sessionId and agentId", async () => {
      const store = sessionStore({
        sessionId: "../../etc/passwd",
        agentId: "../../../root/.ssh/id_rsa",
        scratchpadDir,
      });

      const sessionPath = store.getSessionPath();
      // Filename must be pure hex hash, safe inside scratchpadDir
      assert.ok(!sessionPath.includes(".."));
      assert.ok(!sessionPath.includes("passwd"));
      assert.ok(sessionPath.startsWith(path.resolve(scratchpadDir)));
    });

    it("atomically writes and reads prompt bounded to 1200 characters", async () => {
      const store = sessionStore({
        sessionId: "sess-prompt-test",
        scratchpadDir,
      });

      const longPrompt = "Please help me do this: " + "P".repeat(1500);
      await store.setPrompt(longPrompt);

      const prompt = await store.getPrompt();
      assert.ok(prompt);
      assert.equal(prompt.length, 1200);
      // Stores the first 1200 Unicode code points, matching documented payload bounds.
      assert.equal(prompt, Array.from(longPrompt).slice(0, 1200).join(""));
    });

    it("does not steal a stale-looking session lock from a live process", async () => {
      const store = sessionStore({
        sessionId: "live-lock-owner",
        scratchpadDir,
        lockTimeoutMs: 50,
        staleLockMs: 10,
        pollIntervalMs: 5,
      });
      const lockPath = `${store.getSessionPath()}.lock`;
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ ownerToken: "live", pid: process.pid, createdAt: Date.now() - 10_000 })
      );
      const old = new Date(Date.now() - 10_000);
      fs.utimesSync(lockPath, old, old);

      await assert.rejects(store.setPrompt("blocked"), /lock timeout/i);
      assert.equal(fs.existsSync(lockPath), true);
    });

    it("preserves fields across concurrent session updates", async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const store = sessionStore({
          sessionId: `concurrent-${attempt}`,
          scratchpadDir,
        });
        await Promise.all([
          store.setPrompt("prompt"),
          store.setOverrides({ mode: "enforce" }),
          store.setLastVerdict("gate", { flagged: true }),
          store.setCacheMetadata("diagnostic", 1),
        ]);
        const record = await store.read();
        assert.equal(record?.prompt, "prompt");
        assert.equal(record?.overrides?.mode, "enforce");
        assert.deepEqual(record?.lastGateVerdict, { flagged: true });
        assert.equal(record?.cacheMetadata?.diagnostic, 1);
      }
    });

    it("lets only one concurrent caller claim a tool use id", async () => {
      const store = sessionStore({ sessionId: "claims", scratchpadDir });
      const claims = await Promise.all(
        Array.from({ length: 10 }, () => store.claimToolUseId("toolu_same"))
      );
      assert.equal(claims.filter(Boolean).length, 1);
    });

    it("stores and retrieves session overrides", async () => {
      const store = sessionStore({
        sessionId: "sess-override-test",
        scratchpadDir,
      });

      assert.deepEqual(await store.getOverrides(), {});

      await store.setOverrides({ mode: "enforce", enabled: false });
      const overrides = await store.getOverrides();
      assert.equal(overrides.mode, "enforce");
      assert.equal(overrides.enabled, false);
    });

    it("stores and retrieves last gate and output verdicts", async () => {
      const store = sessionStore({
        sessionId: "sess-verdicts-test",
        scratchpadDir,
      });

      const gateVerdict = { decision: "ask", reason: "destructive" };
      const outputVerdict = { leaks: true };

      await store.setLastVerdict("gate", gateVerdict);
      await store.setLastVerdict("output", outputVerdict);

      assert.deepEqual(await store.getLastVerdict("gate"), gateVerdict);
      assert.deepEqual(await store.getLastVerdict("output"), outputVerdict);
    });

    it("records and checks seen tool_use_ids for deduplication", async () => {
      const store = sessionStore({
        sessionId: "sess-tooluse-test",
        scratchpadDir,
      });

      assert.equal(await store.hasSeenToolUseId("tu_123"), false);
      await store.recordToolUseId("tu_123");
      assert.equal(await store.hasSeenToolUseId("tu_123"), true);
      assert.equal(await store.hasSeenToolUseId("tu_456"), false);
    });

    it("stores and retrieves cache metadata", async () => {
      const store = sessionStore({
        sessionId: "sess-cache-meta-test",
        scratchpadDir,
      });

      await store.setCacheMetadata("key_foo", { score: 0.95 });
      assert.deepEqual(await store.getCacheMetadata("key_foo"), { score: 0.95 });
      assert.equal(await store.getCacheMetadata("nonexistent"), undefined);
    });

    it("safely handles oversized session record on disk by returning null", async () => {
      const store = sessionStore({
        sessionId: "sess-oversized-read-test",
        scratchpadDir,
        maxRecordBytes: 1024,
      });

      const sessionPath = store.getSessionPath();
      fs.writeFileSync(
        sessionPath,
        JSON.stringify({
          sessionIdHash: "somehash",
          updatedAt: Date.now(),
          largeField: "x".repeat(2048),
        }),
        "utf-8"
      );

      const record = await store.read();
      assert.equal(record, null);
    });
  });
});
