// Hook startup benchmark. Usage: node bench/hook-startup.mjs [--runs=30]
// Spawns dist/hooks/<name>.js.
// No network: TYPESAFE_API_KEY is unset, so hooks skip or emit a diagnostic.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runs = Number(process.argv.find(a => a.startsWith("--runs="))?.slice(7) ?? 30);
const WARMUPS = 3;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jev-bench-"));
const home = path.join(tmp, "home");
const cwd = path.join(tmp, "cwd");
const scratch = path.join(tmp, "scratch");
for (const d of [home, cwd, scratch]) fs.mkdirSync(d, { recursive: true });

const env = { ...process.env, HOME: home, TMPDIR: tmp };
delete env.TYPESAFE_API_KEY;
delete env.CLAUDE_PLUGIN_DATA;
if (process.env.BENCH_PLUGIN_DATA) env.CLAUDE_PLUGIN_DATA = path.join(tmp, "plugin-data");

const base = { session_id: "bench-session", cwd, scratchpad_dir: scratch };
const hooks = {
  "user-prompt": { ...base, hook_event_name: "UserPromptSubmit", prompt: "run the tests" },
  "pre-tool": { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls -la" } },
  "post-tool": {
    ...base,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls -la" },
    tool_response: { stdout: "a\nb\n", stderr: "", exit_code: 0 },
  },
};

function pct(sorted, p) {
  const i = (sorted.length - 1) * (p / 100);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function measure(label, args, input) {
  const times = [];
  for (let i = 0; i < WARMUPS + runs; i++) {
    const t0 = performance.now();
    const r = spawnSync(process.execPath, args, { input, env, cwd, encoding: "utf8" });
    const dt = performance.now() - t0;
    if (r.status !== 0) throw new Error(`${label} exited ${r.status}: ${r.stderr}`);
    if (i >= WARMUPS) times.push(dt);
  }
  times.sort((a, b) => a - b);
  return { label, p50: pct(times, 50), p95: pct(times, 95) };
}

const rows = [
  measure("node -e 0", ["-e", "0"], ""),
  measure("node --no-warnings -e 0", ["--no-warnings", "-e", "0"], ""),
];
for (const [name, payload] of Object.entries(hooks)) {
  const args = [path.join(root, `dist/hooks/${name}.js`)];
  rows.push(measure(name, args, JSON.stringify(payload)));
}
console.log(`runs=${runs} warmups=${WARMUPS} node=${process.version}`);
console.log("label".padEnd(26) + "p50 ms".padStart(9) + "p95 ms".padStart(9));
for (const r of rows) console.log(r.label.padEnd(26) + r.p50.toFixed(1).padStart(9) + r.p95.toFixed(1).padStart(9));
fs.rmSync(tmp, { recursive: true, force: true });
