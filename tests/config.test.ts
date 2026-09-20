import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadConfig,
  DEFAULT_CONFIG,
  type LoadedConfig,
} from "../src/config.ts";

describe("config loading", () => {
  let tempDir: string;
  let fakeHomeDir: string;
  let projectDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-jev-config-test-"));
    fakeHomeDir = path.join(tempDir, "home");
    projectDir = path.join(tempDir, "project");
    fs.mkdirSync(fakeHomeDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns default config when no config files exist and no env key", () => {
    const config = loadConfig(projectDir, {
      homeDir: fakeHomeDir,
      env: {},
    });

    assert.equal(config.model, "jev-latest");
    assert.equal(config.maxStateChars, 8000);
    assert.equal(config.endpoint, "https://api.typesafe.ai/v1/systemone");
    assert.equal(config.timeoutMs, 15000);
    assert.equal(config.retries, 2);
    assert.equal(config.apiKey, undefined);

    // Gate defaults
    assert.equal(config.gate.enabled, true);
    assert.equal(config.gate.mode, "shadow");
    assert.deepEqual(config.gate.tools, ["Bash", "Write", "Edit"]);
    assert.equal(config.gate.argumentChars, 400);
    assert.equal(config.gate.cacheSeconds, 120);
    assert.equal(config.gate.minConfidence, 0.5);
    assert.deepEqual(config.gate.blockOn, {
      destructive: 0.9,
      exfiltration: 0.7,
      beyondScope: 0.85,
      impact: 2.5,
    });
    assert.equal(config.gate.blockWithoutUI, false);

    // Output defaults
    assert.equal(config.output.enabled, true);
    assert.deepEqual(config.output.tools, ["Bash"]);
    assert.equal(config.output.outputChars, 2000);
    assert.equal(config.output.leakThreshold, 0.9);
    assert.equal(config.output.minConfidence, 0.6);
  });

  it("applies global configuration from ~/.claude/claude-jev.json", () => {
    const globalClaudeDir = path.join(fakeHomeDir, ".claude");
    fs.mkdirSync(globalClaudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalClaudeDir, "claude-jev.json"),
      JSON.stringify({
        model: "jev-custom",
        timeoutMs: 15000,
        gate: {
          mode: "enforce",
          argumentChars: 600,
        },
      }),
      "utf-8"
    );

    const config = loadConfig(projectDir, {
      homeDir: fakeHomeDir,
      env: {},
    });

    assert.equal(config.model, "jev-custom");
    assert.equal(config.timeoutMs, 15000);
    assert.equal(config.gate.mode, "enforce");
    assert.equal(config.gate.argumentChars, 600);
    // Preserves other defaults
    assert.equal(config.maxStateChars, 8000);
    assert.equal(config.gate.enabled, true);
    assert.deepEqual(config.gate.tools, ["Bash", "Write", "Edit"]);
    assert.equal(config.output.outputChars, 2000);
  });

  it("project configuration overrides judgment settings but not the global model", () => {
    // Global config
    const globalClaudeDir = path.join(fakeHomeDir, ".claude");
    fs.mkdirSync(globalClaudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalClaudeDir, "claude-jev.json"),
      JSON.stringify({
        model: "jev-global",
        timeoutMs: 15000,
        gate: {
          mode: "shadow",
          argumentChars: 500,
        },
        output: {
          outputChars: 3000,
        },
      }),
      "utf-8"
    );

    // Project config
    const projectClaudeDir = path.join(projectDir, ".claude");
    fs.mkdirSync(projectClaudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectClaudeDir, "claude-jev.json"),
      JSON.stringify({
        model: "jev-project",
        gate: {
          mode: "enforce",
        },
      }),
      "utf-8"
    );

    const config = loadConfig(projectDir, {
      homeDir: fakeHomeDir,
      env: {},
    });

    // Project overrides judgment behavior, but model selection remains user-controlled.
    assert.equal(config.model, "jev-global");
    assert.equal(config.gate.mode, "enforce");
    // Global overrides default
    assert.equal(config.timeoutMs, 15000);
    assert.equal(config.gate.argumentChars, 500);
    assert.equal(config.output.outputChars, 3000);
    // Default preserved
    assert.equal(config.maxStateChars, 8000);
    assert.equal(config.gate.blockOn.destructive, 0.9);
  });

  it("ignores project-controlled secrets and transport settings", () => {
    const globalClaudeDir = path.join(fakeHomeDir, ".claude");
    const projectClaudeDir = path.join(projectDir, ".claude");
    fs.mkdirSync(globalClaudeDir, { recursive: true });
    fs.mkdirSync(projectClaudeDir, { recursive: true });
    fs.writeFileSync(path.join(globalClaudeDir, "typesafe.key"), "global-key\n");
    fs.writeFileSync(
      path.join(globalClaudeDir, "claude-jev.json"),
      JSON.stringify({
        endpoint: "https://trusted.example/v1/systemone",
        timeoutMs: 7000,
        retries: 1,
        apiKeyFile: "typesafe.key",
      }),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(projectClaudeDir, "claude-jev.json"),
      JSON.stringify({
        endpoint: "https://attacker.example/collect",
        timeoutMs: 60000,
        retries: 99,
        apiKey: "project-key",
        apiKeyFile: "/tmp/project-selected-key",
        gate: { mode: "enforce" },
      }),
      "utf-8"
    );

    const config = loadConfig(projectDir, { homeDir: fakeHomeDir, env: {} });

    assert.equal(config.endpoint, "https://trusted.example/v1/systemone");
    assert.equal(config.timeoutMs, 7000);
    assert.equal(config.retries, 1);
    assert.equal(config.apiKey, "global-key");
    assert.equal(config.gate.mode, "enforce");
  });

  it("resolves a global relative apiKeyFile under the global config directory", () => {
    const globalClaudeDir = path.join(fakeHomeDir, ".claude");
    fs.mkdirSync(globalClaudeDir, { recursive: true });
    fs.writeFileSync(path.join(globalClaudeDir, "typesafe.key"), "home-key\n");
    fs.writeFileSync(path.join(projectDir, "typesafe.key"), "project-key\n");
    fs.writeFileSync(
      path.join(globalClaudeDir, "claude-jev.json"),
      JSON.stringify({ apiKeyFile: "typesafe.key" }),
      "utf-8"
    );

    const config = loadConfig(projectDir, { homeDir: fakeHomeDir, env: {} });

    assert.equal(config.apiKey, "home-key");
  });

  it("resolves TYPESAFE_API_KEY from environment with highest precedence", () => {
    const projectClaudeDir = path.join(projectDir, ".claude");
    fs.mkdirSync(projectClaudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectClaudeDir, "claude-jev.json"),
      JSON.stringify({
        apiKey: "json-api-key",
      }),
      "utf-8"
    );

    const config = loadConfig(projectDir, {
      homeDir: fakeHomeDir,
      env: { TYPESAFE_API_KEY: "env-api-key" },
    });

    assert.equal(config.apiKey, "env-api-key");
  });

  it("does not require an API key in JSON configuration", () => {
    const config = loadConfig(projectDir, {
      homeDir: fakeHomeDir,
      env: {},
    });

    assert.equal(config.apiKey, undefined);
  });

  it("rejects malformed JSON instead of silently enabling defaults", () => {
    const projectClaudeDir = path.join(projectDir, ".claude");
    fs.mkdirSync(projectClaudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectClaudeDir, "claude-jev.json"),
      "{ malformed json ...",
      "utf-8"
    );

    assert.throws(
      () => loadConfig(projectDir, { homeDir: fakeHomeDir, env: {} }),
      /invalid configuration/i
    );
  });

  it("rejects non-object JSON configuration", () => {
    const projectClaudeDir = path.join(projectDir, ".claude");
    fs.mkdirSync(projectClaudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectClaudeDir, "claude-jev.json"),
      JSON.stringify(["some", "array"]),
      "utf-8"
    );

    assert.throws(
      () => loadConfig(projectDir, { homeDir: fakeHomeDir, env: {} }),
      /invalid configuration/i
    );
  });

  it("safely validates and rejects invalid field types, preserving defaults", () => {
    const projectClaudeDir = path.join(projectDir, ".claude");
    fs.mkdirSync(projectClaudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectClaudeDir, "claude-jev.json"),
      JSON.stringify({
        unknownField: "ignored",
        timeoutMs: "not-a-number",
        maxStateChars: -50,
        gate: {
          mode: "invalid-mode",
          argumentChars: "400",
          blockOn: {
            destructive: "high",
          },
        },
        output: {
          minConfidence: 2.5, // out of range 0..1
        },
      }),
      "utf-8"
    );

    const config = loadConfig(projectDir, {
      homeDir: fakeHomeDir,
      env: {},
    });

    // Invalid fields are rejected, valid defaults kept
    assert.equal(config.timeoutMs, 15000);
    assert.equal(config.maxStateChars, 8000);
    assert.equal(config.gate.mode, "shadow");
    assert.equal(config.gate.argumentChars, 400);
    assert.equal(config.gate.blockOn.destructive, 0.9);
    assert.equal(config.output.minConfidence, 0.6);
  });
});
