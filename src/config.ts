/**
 * Configuration loading and validation for claude-jev.
 *
 * Implements strict config loading with precedence:
 * defaults -> ~/.claude/claude-jev.json -> <cwd>/.claude/claude-jev.json -> TYPESAFE_API_KEY env.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  DEFAULT_MODEL,
  DEFAULT_ENDPOINT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES,
  registerApiKey,
} from "./client.ts";

export interface GateBlockOnConfig {
  destructive: number;
  exfiltration: number;
  beyondScope: number;
  impact: number;
}

export interface GateConfig {
  enabled: boolean;
  mode: "shadow" | "enforce";
  tools: string[];
  argumentChars: number;
  cacheSeconds: number;
  minConfidence: number;
  blockOn: GateBlockOnConfig;
  blockWithoutUI: boolean;
}

export interface OutputConfig {
  enabled: boolean;
  tools: string[];
  outputChars: number;
  leakThreshold: number;
  minConfidence: number;
}

export interface LoadedConfig {
  model: string;
  endpoint: string;
  timeoutMs: number;
  retries: number;
  maxStateChars: number;
  apiKey?: string;
  apiKeyFile?: string;
  gate: GateConfig;
  output: OutputConfig;
}

export class ConfigError extends Error {
  constructor() {
    super("Invalid configuration file");
    this.name = "ConfigError";
  }
}

export interface ConfigOptions {
  homeDir?: string;
  env?: Record<string, string | undefined>;
}

export const DEFAULT_CONFIG: LoadedConfig = {
  model: DEFAULT_MODEL,
  maxStateChars: 8000,
  endpoint: DEFAULT_ENDPOINT,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  retries: DEFAULT_RETRIES,
  gate: {
    enabled: true,
    mode: "shadow",
    tools: ["Bash", "Write", "Edit"],
    argumentChars: 400,
    cacheSeconds: 120,
    minConfidence: 0.5,
    blockOn: {
      destructive: 0.9,
      exfiltration: 0.7,
      beyondScope: 0.85,
      impact: 2.5,
    },
    blockWithoutUI: false,
  },
  output: {
    enabled: true,
    tools: ["Bash"],
    outputChars: 2000,
    leakThreshold: 0.9,
    minConfidence: 0.6,
  },
};

function cloneConfig(c: LoadedConfig): LoadedConfig {
  return {
    model: c.model,
    maxStateChars: c.maxStateChars,
    endpoint: c.endpoint,
    timeoutMs: c.timeoutMs,
    retries: c.retries,
    apiKey: c.apiKey,
    apiKeyFile: c.apiKeyFile,
    gate: {
      enabled: c.gate.enabled,
      mode: c.gate.mode,
      tools: [...c.gate.tools],
      argumentChars: c.gate.argumentChars,
      cacheSeconds: c.gate.cacheSeconds,
      minConfidence: c.gate.minConfidence,
      blockOn: { ...c.gate.blockOn },
      blockWithoutUI: c.gate.blockWithoutUI,
    },
    output: {
      enabled: c.output.enabled,
      tools: [...c.output.tools],
      outputChars: c.output.outputChars,
      leakThreshold: c.output.leakThreshold,
      minConfidence: c.output.minConfidence,
    },
  };
}

function readJsonFileSync(filePath: string): unknown | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    throw new ConfigError();
  }
}

interface MergeLayerOptions {
  allowTransport: boolean;
  allowSecretSources: boolean;
}

function mergeConfigLayer(
  target: LoadedConfig,
  raw: unknown,
  options: MergeLayerOptions
): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError();
  }

  const obj = raw as Record<string, unknown>;

  if (
    options.allowTransport &&
    typeof obj.model === "string" &&
    obj.model.trim().length > 0
  ) {
    target.model = obj.model.trim();
  }

  if (
    options.allowTransport &&
    typeof obj.endpoint === "string" &&
    obj.endpoint.trim().length > 0
  ) {
    target.endpoint = obj.endpoint.trim();
  }

  if (
    options.allowTransport &&
    typeof obj.timeoutMs === "number" &&
    Number.isFinite(obj.timeoutMs) &&
    obj.timeoutMs > 0
  ) {
    target.timeoutMs = Math.round(obj.timeoutMs);
  }

  if (
    options.allowTransport &&
    typeof obj.retries === "number" &&
    Number.isFinite(obj.retries) &&
    obj.retries >= 0
  ) {
    target.retries = Math.round(obj.retries);
  }

  if (typeof obj.maxStateChars === "number" && Number.isFinite(obj.maxStateChars) && obj.maxStateChars > 0) {
    target.maxStateChars = Math.round(obj.maxStateChars);
  }

  if (
    options.allowSecretSources &&
    typeof obj.apiKeyFile === "string" &&
    obj.apiKeyFile.trim().length > 0
  ) {
    target.apiKeyFile = obj.apiKeyFile.trim();
  }

  if (obj.gate && typeof obj.gate === "object" && !Array.isArray(obj.gate)) {
    const g = obj.gate as Record<string, unknown>;

    if (typeof g.enabled === "boolean") {
      target.gate.enabled = g.enabled;
    }

    if (g.mode === "shadow" || g.mode === "enforce") {
      target.gate.mode = g.mode;
    }

    if (Array.isArray(g.tools) && g.tools.every((t) => typeof t === "string")) {
      target.gate.tools = [...g.tools];
    }

    if (typeof g.argumentChars === "number" && Number.isFinite(g.argumentChars) && g.argumentChars > 0) {
      target.gate.argumentChars = Math.round(g.argumentChars);
    }

    if (typeof g.cacheSeconds === "number" && Number.isFinite(g.cacheSeconds) && g.cacheSeconds >= 0) {
      target.gate.cacheSeconds = g.cacheSeconds;
    }

    if (typeof g.minConfidence === "number" && Number.isFinite(g.minConfidence) && g.minConfidence >= 0 && g.minConfidence <= 1) {
      target.gate.minConfidence = g.minConfidence;
    }

    if (typeof g.blockWithoutUI === "boolean") {
      target.gate.blockWithoutUI = g.blockWithoutUI;
    }

    if (g.blockOn && typeof g.blockOn === "object" && !Array.isArray(g.blockOn)) {
      const b = g.blockOn as Record<string, unknown>;
      if (typeof b.destructive === "number" && Number.isFinite(b.destructive) && b.destructive >= 0 && b.destructive <= 1) {
        target.gate.blockOn.destructive = b.destructive;
      }
      if (typeof b.exfiltration === "number" && Number.isFinite(b.exfiltration) && b.exfiltration >= 0 && b.exfiltration <= 1) {
        target.gate.blockOn.exfiltration = b.exfiltration;
      }
      if (typeof b.beyondScope === "number" && Number.isFinite(b.beyondScope) && b.beyondScope >= 0 && b.beyondScope <= 1) {
        target.gate.blockOn.beyondScope = b.beyondScope;
      }
      if (typeof b.impact === "number" && Number.isFinite(b.impact) && b.impact >= 0) {
        target.gate.blockOn.impact = b.impact;
      }
    }
  }

  if (obj.output && typeof obj.output === "object" && !Array.isArray(obj.output)) {
    const o = obj.output as Record<string, unknown>;

    if (typeof o.enabled === "boolean") {
      target.output.enabled = o.enabled;
    }

    if (Array.isArray(o.tools) && o.tools.every((t) => typeof t === "string")) {
      target.output.tools = [...o.tools];
    }

    if (typeof o.outputChars === "number" && Number.isFinite(o.outputChars) && o.outputChars > 0) {
      target.output.outputChars = Math.round(o.outputChars);
    }

    if (typeof o.leakThreshold === "number" && Number.isFinite(o.leakThreshold) && o.leakThreshold >= 0 && o.leakThreshold <= 1) {
      target.output.leakThreshold = o.leakThreshold;
    }

    if (typeof o.minConfidence === "number" && Number.isFinite(o.minConfidence) && o.minConfidence >= 0 && o.minConfidence <= 1) {
      target.output.minConfidence = o.minConfidence;
    }
  }
}

/**
 * Loads and validates configuration with standard precedence:
 * defaults -> ~/.claude/claude-jev.json -> <cwd>/.claude/claude-jev.json -> apiKeyFile -> env.TYPESAFE_API_KEY
 */
export function loadConfig(
  cwd: string = process.cwd(),
  options?: ConfigOptions
): LoadedConfig {
  const config = cloneConfig(DEFAULT_CONFIG);
  const homeDir = options?.homeDir ?? process.env.HOME ?? os.homedir();
  const env = options?.env ?? process.env;

  // 1. Global config (~/.claude/claude-jev.json)
  if (homeDir) {
    const globalPath = path.join(homeDir, ".claude", "claude-jev.json");
    const globalJson = readJsonFileSync(globalPath);
    if (globalJson !== undefined) {
      mergeConfigLayer(config, globalJson, {
        allowTransport: true,
        allowSecretSources: true,
      });
    }
  }

  // 2. Project config (<cwd>/.claude/claude-jev.json)
  if (cwd) {
    const projectPath = path.join(cwd, ".claude", "claude-jev.json");
    const projectJson = readJsonFileSync(projectPath);
    if (projectJson !== undefined) {
      mergeConfigLayer(config, projectJson, {
        allowTransport: false,
        allowSecretSources: false,
      });
    }
  }

  // 3. Optional apiKeyFile resolution if apiKey not already resolved from env
  if (!config.apiKey && config.apiKeyFile) {
    try {
      const resolvedKeyPath = path.isAbsolute(config.apiKeyFile)
        ? config.apiKeyFile
        : path.resolve(homeDir, ".claude", config.apiKeyFile);
      if (fs.existsSync(resolvedKeyPath)) {
        const fileContent = fs.readFileSync(resolvedKeyPath, "utf-8").trim();
        if (fileContent.length > 0) {
          config.apiKey = fileContent;
        }
      }
    } catch {
      // File read error: ignore safely
    }
  }

  // 4. Environment secret (TYPESAFE_API_KEY has highest precedence)
  const envKey = env.TYPESAFE_API_KEY?.trim();
  if (envKey && envKey.length > 0) {
    config.apiKey = envKey;
  }

  // 5. Register resolved apiKey for error redaction
  if (config.apiKey) {
    registerApiKey(config.apiKey);
  }

  return config;
}
