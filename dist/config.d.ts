/**
 * Configuration loading and validation for claude-jev.
 *
 * Implements strict config loading with precedence:
 * defaults -> ~/.claude/claude-jev.json -> <cwd>/.claude/claude-jev.json -> TYPESAFE_API_KEY env.
 */
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
export interface ConfigOptions {
    homeDir?: string;
    env?: Record<string, string | undefined>;
}
export declare const DEFAULT_CONFIG: LoadedConfig;
/**
 * Loads and validates configuration with standard precedence:
 * defaults -> ~/.claude/claude-jev.json -> <cwd>/.claude/claude-jev.json -> apiKeyFile -> env.TYPESAFE_API_KEY
 */
export declare function loadConfig(cwd?: string, options?: ConfigOptions): LoadedConfig;
