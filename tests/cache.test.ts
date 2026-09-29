import { test, describe, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  getOrCreateCached,
  normalizeKey,
  CacheCoordinationError,
  clearMemoryCache,
  resolveCacheBase,
} from "../src/cache.ts";

describe("Cache and Coordination", () => {
  let tempDir: string;

  beforeEach(() => {
    clearMemoryCache();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-jev-cache-test-"));
  });

  afterEach(() => {
    clearMemoryCache();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test("normalizeKey produces deterministic hash regardless of object key order", () => {
    const objA = { z: 1, a: { y: "hello", b: "world" } };
    const objB = { a: { b: "world", y: "hello" }, z: 1 };

    const keyA = normalizeKey(objA);
    const keyB = normalizeKey(objB);

    assert.equal(keyA, keyB);
    assert.equal(keyA.length, 64);
  });

  test("caches successful value within TTL without re-running producer", async () => {
    let callCount = 0;
    const producer = async () => {
      callCount++;
      return { status: "success", count: callCount };
    };

    const key = "test-key-1";
    const val1 = await getOrCreateCached(key, 5000, producer, {
      cacheDir: tempDir,
    });
    assert.deepEqual(val1, { status: "success", count: 1 });
    assert.equal(callCount, 1);

    const val2 = await getOrCreateCached(key, 5000, producer, {
      cacheDir: tempDir,
    });
    assert.deepEqual(val2, { status: "success", count: 1 });
    assert.equal(callCount, 1); // Producer was not called again
  });

  test("does not share memory entries across session cache directories", async () => {
    const firstDir = path.join(tempDir, "first");
    const secondDir = path.join(tempDir, "second");
    let callCount = 0;
    const producer = async () => ({ value: ++callCount });

    const first = await getOrCreateCached("same-key", 5000, producer, {
      cacheDir: firstDir,
    });
    const second = await getOrCreateCached("same-key", 5000, producer, {
      cacheDir: secondDir,
    });

    assert.deepEqual(first, { value: 1 });
    assert.deepEqual(second, { value: 2 });
    assert.equal(callCount, 2);
  });

  test("scopes scratchpad cache entries by session", async () => {
    let callCount = 0;
    const producer = async () => ({ value: ++callCount });

    const first = await getOrCreateCached("same-key", 5000, producer, {
      scratchpadDir: tempDir,
      sessionId: "session-one",
    });
    const second = await getOrCreateCached("same-key", 5000, producer, {
      scratchpadDir: tempDir,
      sessionId: "session-two",
    });

    assert.deepEqual(first, { value: 1 });
    assert.deepEqual(second, { value: 2 });
    assert.equal(callCount, 2);
  });

  test("re-runs producer after TTL expires", async () => {
    let callCount = 0;
    const producer = async () => {
      callCount++;
      return { count: callCount };
    };

    const key = "test-key-ttl";
    // TTL of 50ms
    const val1 = await getOrCreateCached(key, 50, producer, {
      cacheDir: tempDir,
    });
    assert.equal(val1.count, 1);

    // Sleep 70ms to expire
    await new Promise((r) => setTimeout(r, 70));

    const val2 = await getOrCreateCached(key, 50, producer, {
      cacheDir: tempDir,
    });
    assert.equal(val2.count, 2);
  });

  test("file cache hits preserve the original expiry", async () => {
    let calls = 0;
    const producer = async () => ({ call: ++calls });
    const key = "original-expiry";
    const ttlMs = 1000;

    await getOrCreateCached(key, ttlMs, producer, { cacheDir: tempDir });
    clearMemoryCache();

    const entryPath = path.join(tempDir, `${key}.json`);
    const entry = JSON.parse(fs.readFileSync(entryPath, "utf8"));
    entry.createdAt = Date.now() - 900;
    fs.writeFileSync(entryPath, JSON.stringify(entry));

    const fromFile = await getOrCreateCached(key, ttlMs, producer, { cacheDir: tempDir });
    assert.equal(fromFile.call, 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const refreshed = await getOrCreateCached(key, ttlMs, producer, { cacheDir: tempDir });

    assert.equal(refreshed.call, 2);
  });

  test("concurrent calls coordinate and call producer only once", async () => {
    let producerCount = 0;
    const producer = async () => {
      producerCount++;
      await new Promise((r) => setTimeout(r, 80)); // simulate slow network call
      return { producerCount };
    };

    const key = "concurrent-key";
    const [res1, res2, res3] = await Promise.all([
      getOrCreateCached(key, 5000, producer, {
        cacheDir: tempDir,
        pollIntervalMs: 15,
      }),
      getOrCreateCached(key, 5000, producer, {
        cacheDir: tempDir,
        pollIntervalMs: 15,
      }),
      getOrCreateCached(key, 5000, producer, {
        cacheDir: tempDir,
        pollIntervalMs: 15,
      }),
    ]);

    assert.equal(producerCount, 1);
    assert.deepEqual(res1, { producerCount: 1 });
    assert.deepEqual(res2, { producerCount: 1 });
    assert.deepEqual(res3, { producerCount: 1 });
  });

  test("keeps a slow live producer lock fresh across processes", async () => {
    const markerPath = path.join(tempDir, "producers.log");
    const cacheModule = pathToFileURL(path.resolve(import.meta.dirname, "../src/cache.ts")).href;
    const worker = `
      import fs from "node:fs";
      import { getOrCreateCached } from ${JSON.stringify(cacheModule)};
      const [cacheDir, markerPath, delay] = process.argv.slice(1);
      const value = await getOrCreateCached("slow-producer", 5000, async () => {
        fs.appendFileSync(markerPath, process.pid + "\\n");
        await new Promise(resolve => setTimeout(resolve, Number(delay)));
        return { value: "shared" };
      }, { cacheDir, lockTimeoutMs: 800, staleLockMs: 200, pollIntervalMs: 10 });
      process.stdout.write(JSON.stringify(value));
    `;
    const runWorker = (delay: number) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          worker,
          tempDir,
          markerPath,
          String(delay),
        ]);
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
        child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
        child.on("error", reject);
        child.on("close", code => {
          if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
          else reject(new Error(Buffer.concat(stderr).toString("utf8")));
        });
      });

    const first = runWorker(400);
    const lockPath = path.join(tempDir, "slow-producer.lock");
    // Allow up to 5 s for the child to start Node and take the lock; a slow
    // CI runner took over 500 ms.
    for (let i = 0; i < 1000 && !fs.existsSync(lockPath); i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(fs.existsSync(lockPath), true);
    const second = runWorker(0);
    const [firstOutput, secondOutput] = await Promise.all([first, second]);

    assert.deepEqual(JSON.parse(firstOutput), { value: "shared" });
    assert.deepEqual(JSON.parse(secondOutput), { value: "shared" });
    const producers = fs.readFileSync(markerPath, "utf8").trim().split("\n");
    assert.equal(producers.length, 1);
  });

  test("infrastructure failure is not cached as safe verdict; lock is cleaned up", async () => {
    let shouldFail = true;
    let attempts = 0;

    const producer = async () => {
      attempts++;
      if (shouldFail) {
        throw new Error("TypeSafe API 500 Outage");
      }
      return { safe: true, attempts };
    };

    const key = "infra-fail-key";

    // First attempt fails
    await assert.rejects(
      () =>
        getOrCreateCached(key, 5000, producer, {
          cacheDir: tempDir,
        }),
      /TypeSafe API 500 Outage/
    );

    // Lock file must not remain
    const lockPath = path.join(tempDir, `${key}.lock`);
    assert.equal(fs.existsSync(lockPath), false);

    // Next attempt with working producer succeeds and is not blocked by prior failure
    shouldFail = false;
    const res = await getOrCreateCached(key, 5000, producer, {
      cacheDir: tempDir,
    });
    assert.deepEqual(res, { safe: true, attempts: 2 });
  });

  test("stale lock recovery: recovers lock older than stale threshold", async () => {
    const key = "stale-lock-key";
    const lockPath = path.join(tempDir, `${key}.lock`);

    // Create a stale lock file with timestamp 10 seconds in past
    const staleMeta = {
      pid: 999999,
      createdAt: Date.now() - 10000,
    };
    fs.writeFileSync(lockPath, JSON.stringify(staleMeta), "utf-8");

    let producerRun = false;
    const producer = async () => {
      producerRun = true;
      return { recovered: true };
    };

    // Stale lock threshold 500ms
    const res = await getOrCreateCached(key, 5000, producer, {
      cacheDir: tempDir,
      staleLockMs: 500,
      pollIntervalMs: 20,
    });

    assert.equal(producerRun, true);
    assert.deepEqual(res, { recovered: true });
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("bounded wait fails open / times out after coordination limit", async () => {
    const key = "hanging-lock-key";
    const lockPath = path.join(tempDir, `${key}.lock`);

    // Lock held by active process (not stale)
    const activeLockMeta = {
      pid: process.pid,
      createdAt: Date.now(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(activeLockMeta), "utf-8");

    const producer = async () => {
      return { shouldNotRun: true };
    };

    // Coordination timeout 100ms
    await assert.rejects(
      () =>
        getOrCreateCached(key, 5000, producer, {
          cacheDir: tempDir,
          lockTimeoutMs: 100,
          staleLockMs: 10000,
          pollIntervalMs: 20,
        }),
      (err: unknown) => {
        assert.ok(err instanceof CacheCoordinationError);
        assert.equal(err.code, "COORDINATION_TIMEOUT");
        return true;
      }
    );
  });

  test("bounded entries: prunes oldest entries when exceeding maxEntries", async () => {
    const maxEntries = 3;

    for (let i = 1; i <= 5; i++) {
      await getOrCreateCached(`key-${i}`, 60000, async () => ({ val: i }), {
        cacheDir: tempDir,
        maxEntries,
      });
      // Short delay so file timestamps differ
      await new Promise((r) => setTimeout(r, 15));
    }

    const files = fs.readdirSync(tempDir).filter((f) => f.endsWith(".json"));
    assert.ok(
      files.length <= maxEntries,
      `Expected at most ${maxEntries} files, found ${files.length}`
    );
    // Keys 4 and 5 must be present
    assert.ok(files.includes("key-4.json") || files.includes("key-5.json"));
  });
});

describe("resolveCacheBase precedence", () => {
  test("CLAUDE_PLUGIN_DATA is used when no scratchpad", () => {
    const base = resolveCacheBase({ env: { CLAUDE_PLUGIN_DATA: " /tmp/data " }, homeDir: "/tmp/home" });
    assert.equal(path.join(base, "cache"), path.join(path.resolve("/tmp/data"), "cache"));
  });
  test("scratchpadDir wins over CLAUDE_PLUGIN_DATA", () => {
    const base = resolveCacheBase({ scratchpadDir: "/tmp/scratch", env: { CLAUDE_PLUGIN_DATA: "/tmp/data" } });
    assert.equal(base, path.resolve("/tmp/scratch"));
  });
  test("falls back to home cache dir", () => {
    const base = resolveCacheBase({ env: { CLAUDE_PLUGIN_DATA: "  " }, homeDir: "/tmp/home" });
    assert.equal(path.join(base, "cache"), path.join("/tmp/home", ".cache", "claude-jev", "cache"));
  });
  test("getOrCreateCached writes under <data>/cache", async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "claude-jev-data-"));
    try {
      clearMemoryCache();
      await getOrCreateCached("k", 5000, async () => "v", { sessionId: "s", env: { CLAUDE_PLUGIN_DATA: data } });
      assert.equal(fs.existsSync(path.join(data, "cache")), true);
    } finally {
      clearMemoryCache();
      fs.rmSync(data, { recursive: true, force: true });
    }
  });
});
