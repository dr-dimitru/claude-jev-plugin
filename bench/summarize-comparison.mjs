// Builds Markdown tables from compare-models.mjs reports.
// Usage: node bench/summarize-comparison.mjs [docs/benchmarks/data]
// Reports named <config>-r<N>.json are grouped by <config>.
import * as fs from "node:fs";
import * as path from "node:path";

const dir = process.argv[2] ?? "docs/benchmarks/data";
const ORDER = ["hosted-jev", "kev-4b-tuned", "kev-4b-defaults", "kev-0.8b", "laya-english", "laya-typed-decisions"];
const LABELS = {
  "hosted-jev": "Hosted Jev",
  "kev-4b-tuned": "Kev-4B, tuned thresholds",
  "kev-4b-defaults": "Kev-4B, default thresholds",
  "kev-0.8b": "Kev-0.8B",
  "laya-english": "Laya `english`",
  "laya-typed-decisions": "Laya `typed-decisions`",
};

const groups = new Map();
for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
  const config = file.replace(/-r\d+\.json$/, "");
  const report = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  if (!groups.has(config)) groups.set(config, []);
  groups.get(config).push(report);
}
const configs = [...groups.keys()].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));

const range = values => {
  const lo = Math.min(...values), hi = Math.max(...values);
  return lo === hi ? `${lo}` : `${lo}–${hi}`;
};
const count = (reports, key) => {
  const [, total] = reports[0].summary[key].split("/");
  return `${range(reports.map(r => Number(r.summary[key].split("/")[0])))} of ${total}`;
};
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const mark = (reports, pick) => {
  const hits = reports.filter(pick).length;
  return hits === reports.length ? "yes" : hits === 0 ? "no" : `${hits}/${reports.length}`;
};

const out = [];
out.push("| Configuration | Dangerous caught | False alarms | Secrets withheld | Failures classified | Median `check` | Median warm `ask` | First `ask` |");
out.push("|---|---|---|---|---|---|---|---|");
for (const c of configs) {
  const rs = groups.get(c);
  out.push(`| ${LABELS[c] ?? c} | ${count(rs, "dangerous_caught")} | ${count(rs, "false_alarms")} | ${count(rs, "secrets_withheld")} | ${count(rs, "failures_classified")} | ${median(rs.map(r => r.summary.check_median_ms))} ms | ${median(rs.map(r => r.summary.ask_warm_median_ms))} ms | ${range(rs.map(r => r.summary.ask_first_ms))} ms |`);
}

const matrix = (title, key, pick) => {
  out.push("", `### ${title}`, "");
  out.push(`| Command | ${configs.map(c => LABELS[c] ?? c).join(" | ")} |`);
  out.push(`|---|${configs.map(() => "---").join("|")}|`);
  const items = groups.get(configs[0])[0][key];
  items.forEach((item, i) => {
    const cells = configs.map(c => mark(groups.get(c), r => pick(r[key][i])));
    out.push(`| \`${(item.command ?? item.id).replaceAll("|", "\\|")}\` | ${cells.join(" | ")} |`);
  });
};
matrix("Dangerous commands flagged", "dangerous", r => r.flagged);
matrix("Routine commands flagged (false alarms)", "routine", r => r.flagged);
matrix("Secret output withheld", "secrets", r => r.withheld);
matrix("Failure classified correctly", "failures", r => r.correct);

out.push("", "### Decision helper answers (last run)", "");
out.push(`| Question | ${configs.map(c => LABELS[c] ?? c).join(" | ")} |`);
out.push(`|---|${configs.map(() => "---").join("|")}|`);
for (const q of Object.keys(groups.get(configs[0]).at(-1).ask.answers ?? {})) {
  const cells = configs.map(c => {
    const a = groups.get(c).at(-1).ask.answers?.[q];
    if (!a) return "error";
    const value = a.noul ?? a.score ?? a.choice;
    const v = typeof value === "number" ? value.toFixed(2) : value;
    return a.confidence === undefined ? `${v}` : `${v} (conf ${Number(a.confidence).toFixed(2)})`;
  });
  out.push(`| \`${q}\` | ${cells.join(" | ")} |`);
}

process.stdout.write(out.join("\n") + "\n");
