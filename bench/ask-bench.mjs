import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN_PATH = path.resolve(__dirname, "../bin/claude-jev");
const QUESTION_COUNTS = [1, 8, 32];
const DEFAULT_RUNS = 30;

function calculatePercentile(numbers, p) {
  if (numbers.length === 0) {
    return 0;
  }
  const sorted = [...numbers].sort((a, b) => a - b);
  if (sorted.length === 1) {
    return sorted[0];
  }
  const index = (sorted.length - 1) * (p / 100);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function generatePayload(questionCount) {
  const filler = "x".repeat(2000);
  const questions = {};
  for (let i = 0; i < questionCount; i++) {
    questions[`q${i}`] = {
      type: "choice",
      instructions: "Which option fits?",
      criteria: {
        a: "Option A",
        b: "Option B",
      },
    };
  }

  return {
    state: {
      decision: "Pick one",
      options: ["A", "B"],
      facts: [filler],
    },
    questions,
  };
}

function createMockModule(tempDir) {
  const mockFilePath = path.join(tempDir, "mock-fetch.mjs");
  const code = [
    "import * as fs from \"node:fs\";",
    "",
    "const originalFetch = globalThis.fetch;",
    "",
    "globalThis.fetch = async (input, init = {}) => {",
    "  const latencyMs = Number(process.env.BENCH_LATENCY_MS || 0);",
    "  if (latencyMs > 0) {",
    "    await new Promise((resolve) => setTimeout(resolve, latencyMs));",
    "  }",
    "",
    "  const body = init?.body ?? \"\";",
    "  const bodyStr = typeof body === \"string\"",
    "    ? body",
    "    : Buffer.isBuffer(body)",
    "      ? body.toString(\"utf8\")",
    "      : \"\";",
    "  const byteLength = Buffer.byteLength(bodyStr, \"utf8\");",
    "",
    "  if (process.env.BENCH_BYTES_FILE) {",
    "    fs.appendFileSync(process.env.BENCH_BYTES_FILE, `${byteLength}\\n`);",
    "  }",
    "",
    "  let questions = {};",
    "  try {",
    "    const parsed = JSON.parse(bodyStr);",
    "    if (parsed?.questions && typeof parsed.questions === \"object\") {",
    "      questions = parsed.questions;",
    "    }",
    "  } catch {",
    "    // Ignore parse error",
    "  }",
    "",
    "  const answers = {};",
    "  for (const qName of Object.keys(questions)) {",
    "    answers[qName] = {",
    "      type: \"choice\",",
    "      choice: \"a\",",
    "      probabilities: {",
    "        a: 0.6,",
    "        b: 0.4,",
    "      },",
    "      confidence: 0.7,",
    "    };",
    "  }",
    "",
    "  const responsePayload = {",
    "    model: \"jev-1.13.0\",",
    "    answers,",
    "    usage: {",
    "      input_tokens: 1,",
    "      output_tokens: 1,",
    "    },",
    "  };",
    "",
    "  return new Response(JSON.stringify(responsePayload), {",
    "    status: 200,",
    "    headers: {",
    "      \"Content-Type\": \"application/json\",",
    "    },",
    "  });",
    "};",
    "",
  ].join("\n");

  fs.writeFileSync(mockFilePath, code, "utf8");
  return mockFilePath;
}

function runChild({ stdinData, env }) {
  return new Promise((resolve, reject) => {
    const startTime = performance.now();
    const child = spawn(process.execPath, [BIN_PATH, "ask"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    let stderr = "";
    child.stdout.on("data", () => {
      // Drain stdout
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      const wallMs = performance.now() - startTime;
      if (code !== 0) {
        reject(new Error(`claude-jev ask exited with code ${code}: ${stderr}`));
        return;
      }
      resolve({ wallMs });
    });

    child.stdin.on("error", () => {
      // Child close handler will catch exit code
    });

    child.stdin.end(stdinData, "utf8");
  });
}

async function runSuite({ runs, latencyMs, tempDir, mockUrl, bytesFilePath }) {
  const childEnv = {
    ...process.env,
    HOME: tempDir,
    TYPESAFE_API_KEY: "bench-key",
    NODE_OPTIONS: process.env.NODE_OPTIONS
      ? `${process.env.NODE_OPTIONS} --import=${mockUrl}`
      : `--import=${mockUrl}`,
    BENCH_BYTES_FILE: bytesFilePath,
    BENCH_LATENCY_MS: String(latencyMs),
  };

  const results = [];

  for (const qCount of QUESTION_COUNTS) {
    fs.writeFileSync(bytesFilePath, "", "utf8");
    const payload = generatePayload(qCount);
    const stdinData = JSON.stringify(payload);
    const stdinBytes = Buffer.byteLength(stdinData, "utf8");

    const wallTimes = [];
    for (let i = 0; i < runs; i++) {
      const { wallMs } = await runChild({ stdinData, env: childEnv });
      wallTimes.push(wallMs);
    }

    const bytesContent = fs.readFileSync(bytesFilePath, "utf8").trim();
    const byteLines = bytesContent.split("\n").filter(Boolean);
    const requestBytes = byteLines.length > 0 ? parseInt(byteLines[0], 10) : 0;

    const p50 = calculatePercentile(wallTimes, 50);
    const p95 = calculatePercentile(wallTimes, 95);

    results.push({
      questions: qCount,
      request_bytes: requestBytes,
      stdin_bytes: stdinBytes,
      p50_ms: Number(p50.toFixed(2)),
      p95_ms: Number(p95.toFixed(2)),
    });
  }

  return results;
}

async function main() {
  const runs = process.env.BENCH_RUNS
    ? parseInt(process.env.BENCH_RUNS, 10) || DEFAULT_RUNS
    : DEFAULT_RUNS;

  console.log(`Node version: ${process.version}`);
  console.log(`Platform: ${process.platform} (${process.arch})`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-bench-"));
  const mockFilePath = createMockModule(tempDir);
  const mockUrl = pathToFileURL(mockFilePath).href;
  const bytesFilePath = path.join(tempDir, "bytes.txt");

  try {
    console.log(`\nConfigured latency: 0 ms (runs: ${runs})`);
    const baseResults = await runSuite({
      runs,
      latencyMs: 0,
      tempDir,
      mockUrl,
      bytesFilePath,
    });
    console.table(baseResults);

    const envLatencyRaw = process.env.BENCH_LATENCY_MS;
    const hasEnvLatency = envLatencyRaw !== undefined && envLatencyRaw.trim() !== "";
    const envLatency = hasEnvLatency ? Number(envLatencyRaw) : null;

    if (hasEnvLatency && envLatency > 0) {
      console.log(`\nConfigured latency: ${envLatency} ms (runs: ${runs})`);
      const latencyResults = await runSuite({
        runs,
        latencyMs: envLatency,
        tempDir,
        mockUrl,
        bytesFilePath,
      });
      console.table(latencyResults);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
