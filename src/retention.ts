/**
 * Retention cleanup for per-session state files and judgment cache directories.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_RETENTION_DAYS = 7;
export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MAX_PRUNE_DELETIONS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_MARKER = ".last-prune";
// <hash>.json, plus lock and temp siblings written by sessionStore.
const SESSION_FILE_RE = /^([0-9a-f]{64})\.json(?:\.lock|\.\d+\.[0-9a-f]+\.tmp)?$/;
const CACHE_DIR_RE = /^[0-9a-f]{64}$/;

export interface PruneOptions {
  roots: string[];
  maxAgeMs: number;
  now?: number;
  keepNames?: string[];
  maxDeletions?: number;
}

export interface PruneResult {
  removedFiles: number;
  removedDirs: number;
}

async function pruneRoot(
  root: string,
  cutoff: number,
  keep: Set<string>,
  budget: { left: number },
  result: PruneResult
): Promise<void> {
  // Session state files and their lock/tmp siblings, grouped by hash.
  let names: string[] = [];
  try {
    names = await fs.promises.readdir(root);
  } catch {
    return;
  }

  const groups = new Map<string, { newest: number; files: string[] }>();
  for (const name of names) {
    const m = SESSION_FILE_RE.exec(name);
    if (!m || keep.has(m[1])) continue;
    try {
      const st = await fs.promises.lstat(path.join(root, name));
      if (!st.isFile()) continue;
      const g = groups.get(m[1]) ?? { newest: 0, files: [] };
      g.newest = Math.max(g.newest, st.mtimeMs);
      g.files.push(name);
      groups.set(m[1], g);
    } catch {
      // ignore
    }
  }
  for (const g of groups.values()) {
    if (g.newest >= cutoff) continue;
    for (const name of g.files) {
      if (budget.left <= 0) return;
      try {
        await fs.promises.unlink(path.join(root, name));
        result.removedFiles++;
        budget.left--;
      } catch {
        // ignore
      }
    }
  }

  // Judgment cache directories.
  const cacheRoot = path.join(root, "cache");
  let dirNames: string[] = [];
  try {
    dirNames = await fs.promises.readdir(cacheRoot);
  } catch {
    return;
  }
  for (const name of dirNames) {
    if (budget.left <= 0) return;
    if (!CACHE_DIR_RE.test(name) || keep.has(name)) continue;
    const dir = path.join(cacheRoot, name);
    try {
      const st = await fs.promises.lstat(dir);
      if (!st.isDirectory()) continue;
      let newest = st.mtimeMs;
      const children = await fs.promises.readdir(dir);
      const files: string[] = [];
      let skip = false;
      for (const child of children) {
        const cst = await fs.promises.lstat(path.join(dir, child));
        newest = Math.max(newest, cst.mtimeMs);
        if (!cst.isFile()) skip = true;
        else files.push(child);
      }
      // A fresh child or lock file keeps the dir. Nested dirs are not ours.
      if (skip || newest >= cutoff) continue;
      let complete = true;
      for (const f of files) {
        if (budget.left <= 0) {
          complete = false;
          break;
        }
        await fs.promises.unlink(path.join(dir, f));
        result.removedFiles++;
        budget.left--;
      }
      if (!complete || budget.left <= 0) return;
      await fs.promises.rmdir(dir);
      result.removedDirs++;
      budget.left--;
    } catch {
      // ignore
    }
  }
}

/**
 * Removes session state and cache data older than maxAgeMs. Never throws.
 */
export async function pruneStaleSessionData(options: PruneOptions): Promise<PruneResult> {
  const result: PruneResult = { removedFiles: 0, removedDirs: 0 };
  try {
    const now = options.now ?? Date.now();
    const cutoff = now - options.maxAgeMs;
    const keep = new Set(options.keepNames ?? []);
    const budget = { left: options.maxDeletions ?? MAX_PRUNE_DELETIONS };
    for (const root of options.roots) {
      if (budget.left <= 0) break;
      try {
        await pruneRoot(root, cutoff, keep, budget, result);
      } catch {
        // ignore
      }
    }
  } catch {
    // fail-open
  }
  return result;
}

/**
 * Runs pruneStaleSessionData at most once per PRUNE_INTERVAL_MS. Never throws.
 */
export async function maybePruneSessionData(options: {
  roots: string[];
  retentionDays: number;
  now?: number;
  keepNames?: string[];
}): Promise<void> {
  try {
    if (!(options.retentionDays > 0)) return;
    const now = options.now ?? Date.now();
    const root = options.roots.find((r) => {
      try {
        return fs.statSync(r).isDirectory();
      } catch {
        return false;
      }
    });
    if (!root) return;
    const marker = path.join(root, PRUNE_MARKER);
    try {
      const st = await fs.promises.stat(marker);
      if (now - st.mtimeMs < PRUNE_INTERVAL_MS) return;
    } catch {
      // no marker yet
    }
    // Touch first so concurrent hooks skip.
    const when = new Date(now);
    await fs.promises.writeFile(marker, "", { mode: 0o600 });
    await fs.promises.utimes(marker, when, when);
    await pruneStaleSessionData({
      roots: options.roots,
      maxAgeMs: options.retentionDays * DAY_MS,
      now,
      keepNames: options.keepNames,
    });
  } catch {
    // fail-open
  }
}
