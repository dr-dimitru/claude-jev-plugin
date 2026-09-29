import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  pruneStaleSessionData,
  maybePruneSessionData,
  PRUNE_INTERVAL_MS,
} from "../src/retention.ts";
import { runUserPrompt } from "../src/hooks/user-prompt.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 1);
const h = (c: string) => c.repeat(64);

function touch(p: string, ageMs: number, now = NOW): void {
  const t = new Date(now - ageMs);
  fs.utimesSync(p, t, t);
}

describe("retention", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-jev-retention-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function file(name: string, ageMs: number): string {
    const p = path.join(root, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "x");
    touch(p, ageMs);
    return p;
  }

  function cacheDir(name: string, dirAge: number, childAges: number[]): string {
    const d = path.join(root, "cache", name);
    fs.mkdirSync(d, { recursive: true });
    childAges.forEach((age, i) => {
      const c = path.join(d, `e${i}.json`);
      fs.writeFileSync(c, "x");
      touch(c, age);
    });
    touch(d, dirAge);
    return d;
  }

  it("removes old session files with siblings and keeps fresh ones", () => {
    const oldJson = file(`${h("a")}.json`, 10 * DAY);
    const oldLock = file(`${h("a")}.json.lock`, 10 * DAY);
    const oldTmp = file(`${h("a")}.json.123.abcd.tmp`, 10 * DAY);
    const fresh = file(`${h("b")}.json`, 1 * DAY);
    return pruneStaleSessionData({ roots: [root], maxAgeMs: 7 * DAY, now: NOW }).then((r) => {
      assert.equal(r.removedFiles, 3);
      for (const p of [oldJson, oldLock, oldTmp]) assert.equal(fs.existsSync(p), false);
      assert.equal(fs.existsSync(fresh), true);
    });
  });

  it("keeps an old session file with a fresh lock", async () => {
    const j = file(`${h("a")}.json`, 10 * DAY);
    file(`${h("a")}.json.lock`, 1000);
    await pruneStaleSessionData({ roots: [root], maxAgeMs: 7 * DAY, now: NOW });
    assert.equal(fs.existsSync(j), true);
  });

  it("removes old cache dirs and keeps dirs with a fresh child", async () => {
    const old = cacheDir(h("c"), 10 * DAY, [10 * DAY, 9 * DAY]);
    const mixed = cacheDir(h("d"), 10 * DAY, [10 * DAY, 1 * DAY]);
    const r = await pruneStaleSessionData({ roots: [root], maxAgeMs: 7 * DAY, now: NOW });
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(mixed), true);
    assert.equal(r.removedDirs, 1);
    assert.equal(r.removedFiles, 2);
  });

  it("skips cache dirs with a fresh lock file", async () => {
    const d = cacheDir(h("c"), 10 * DAY, [10 * DAY]);
    const lock = path.join(d, "k.lock");
    fs.writeFileSync(lock, "x");
    touch(lock, 1000);
    touch(d, 10 * DAY);
    await pruneStaleSessionData({ roots: [root], maxAgeMs: 7 * DAY, now: NOW });
    assert.equal(fs.existsSync(d), true);
  });

  it("honors keepNames", async () => {
    const f = file(`${h("a")}.json`, 10 * DAY);
    const d = cacheDir(h("a"), 10 * DAY, [10 * DAY]);
    await pruneStaleSessionData({
      roots: [root],
      maxAgeMs: 7 * DAY,
      now: NOW,
      keepNames: [h("a")],
    });
    assert.equal(fs.existsSync(f), true);
    assert.equal(fs.existsSync(d), true);
  });

  it("leaves non-matching names alone", async () => {
    const a = file("notes.json", 100 * DAY);
    const b = file(`${h("A")}.json`, 100 * DAY);
    const c = file(`${"a".repeat(63)}.json`, 100 * DAY);
    const d = cacheDir("custom", 100 * DAY, [100 * DAY]);
    const marker = file(".last-prune", 100 * DAY);
    await pruneStaleSessionData({ roots: [root], maxAgeMs: 7 * DAY, now: NOW });
    for (const p of [a, b, c, d, marker]) assert.equal(fs.existsSync(p), true);
  });

  it("does not follow symlinks", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "claude-jev-outside-"));
    try {
      const secret = path.join(outside, "secret.txt");
      fs.writeFileSync(secret, "keep");
      touch(secret, 100 * DAY);
      touch(outside, 100 * DAY);
      fs.symlinkSync(outside, path.join(root, `${h("e")}.json`));
      fs.mkdirSync(path.join(root, "cache"), { recursive: true });
      fs.symlinkSync(outside, path.join(root, "cache", h("f")));
      await pruneStaleSessionData({ roots: [root], maxAgeMs: 7 * DAY, now: NOW });
      assert.equal(fs.existsSync(secret), true);
      assert.equal(fs.existsSync(outside), true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("stops at maxDeletions", async () => {
    for (const c of "0123456789") file(`${h(c)}.json`, 10 * DAY);
    const r = await pruneStaleSessionData({
      roots: [root],
      maxAgeMs: 7 * DAY,
      now: NOW,
      maxDeletions: 4,
    });
    assert.equal(r.removedFiles, 4);
    assert.equal(fs.readdirSync(root).length, 6);
  });

  it("tolerates missing roots", async () => {
    const r = await pruneStaleSessionData({
      roots: [path.join(root, "nope")],
      maxAgeMs: DAY,
      now: NOW,
    });
    assert.deepEqual(r, { removedFiles: 0, removedDirs: 0 });
    await maybePruneSessionData({ roots: [path.join(root, "nope")], retentionDays: 7, now: NOW });
  });

  it("throttles with a marker file", async () => {
    const a = file(`${h("a")}.json`, 10 * DAY);
    await maybePruneSessionData({ roots: [root], retentionDays: 7, now: NOW });
    assert.equal(fs.existsSync(a), false);
    assert.equal(fs.existsSync(path.join(root, ".last-prune")), true);

    const b = file(`${h("b")}.json`, 10 * DAY);
    await maybePruneSessionData({
      roots: [root],
      retentionDays: 7,
      now: NOW + PRUNE_INTERVAL_MS - 1000,
    });
    assert.equal(fs.existsSync(b), true);

    await maybePruneSessionData({
      roots: [root],
      retentionDays: 7,
      now: NOW + PRUNE_INTERVAL_MS + 1000,
    });
    assert.equal(fs.existsSync(b), false);
  });

  it("is a no-op when retentionDays is 0", async () => {
    const a = file(`${h("a")}.json`, 100 * DAY);
    await maybePruneSessionData({ roots: [root], retentionDays: 0, now: NOW });
    assert.equal(fs.existsSync(a), true);
    assert.equal(fs.existsSync(path.join(root, ".last-prune")), false);
  });

  it("runUserPrompt prunes old data and keeps the current session", async () => {
    const now = Date.now();
    const oldJson = path.join(root, `${h("a")}.json`);
    fs.writeFileSync(oldJson, "{}");
    touch(oldJson, 30 * DAY, now);
    const oldCache = path.join(root, "cache", h("b"));
    fs.mkdirSync(oldCache, { recursive: true });
    touch(oldCache, 30 * DAY, now);

    // Isolate from the real ~/.claude/claude-jev.json, which could set
    // retentionDays: 0 and disable the sweep.
    const originalHome = process.env.HOME;
    process.env.HOME = root;
    try {
      await runUserPrompt({
        session_id: "s1",
        prompt: "hi",
        cwd: root,
        hook_event_name: "UserPromptSubmit",
        scratchpad_dir: root,
      });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }

    assert.equal(fs.existsSync(oldJson), false);
    assert.equal(fs.existsSync(oldCache), false);
    assert.equal(fs.existsSync(path.join(root, ".last-prune")), true);
  });
});
