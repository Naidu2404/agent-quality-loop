import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { QualityLoopConfig } from "../types.js";
import { detectTechStack } from "../detector/techStack.js";
import { buildDefaultConfig } from "./defaults.js";
import type { GlobalConfig } from "../cli/configure.js";

const CONFIG_FILENAMES = [
  ".quality-loop.json",
  "quality-loop.config.json",
  ".qualityloop.json",
];

const GLOBAL_CONFIG_PATH = join(homedir(), ".agent-quality-loop.json");

/**
 * Loads keys saved by `--configure` from ~/.agent-quality-loop.json and
 * injects them into process.env so all existing checks find them unchanged.
 * Env vars already set in the shell always take precedence.
 */
function loadGlobalKeys(): void {
  if (!existsSync(GLOBAL_CONFIG_PATH)) return;
  try {
    const global = JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf8")) as GlobalConfig;
    const keysToInject: Array<keyof GlobalConfig> = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "SONAR_TOKEN",
      "SONAR_PROJECT_KEY",
      "GITHUB_TOKEN",
    ];
    for (const key of keysToInject) {
      if (global[key] && !process.env[key]) {
        process.env[key] = global[key] as string;
      }
    }
  } catch {
    // Silently ignore malformed global config
  }
}

/**
 * Loads the quality loop config for a given project root.
 *
 * Resolution order:
 *  1. Inject keys from ~/.agent-quality-loop.json (saved by --configure) if not already in env
 *  2. Look for a .quality-loop.json (or variant) in cwd
 *  3. Auto-detect tech stack and merge in defaults
 *  4. Falls back to all-defaults if no config file exists
 */
export function loadConfig(cwd: string): {
  config: QualityLoopConfig;
  configPath: string | null;
  stackInfo: ReturnType<typeof detectTechStack>;
} {
  // Inject saved keys first so all subsequent checks can find them
  loadGlobalKeys();

  const stackInfo = detectTechStack(cwd);
  const defaults = buildDefaultConfig(stackInfo.primary, stackInfo);

  // Find config file
  let configPath: string | null = null;
  let userConfig: Partial<QualityLoopConfig> = {};

  for (const filename of CONFIG_FILENAMES) {
    const candidate = join(cwd, filename);
    if (existsSync(candidate)) {
      configPath = candidate;
      try {
        userConfig = JSON.parse(readFileSync(candidate, "utf8")) as Partial<QualityLoopConfig>;
      } catch (e) {
        console.error(`[quality-loop] Failed to parse config at ${candidate}:`, e);
      }
      break;
    }
  }

  // Deep-merge: user config overrides defaults, custom rules are concatenated
  const merged: QualityLoopConfig = {
    ...defaults,
    ...userConfig,
    checks: {
      ...defaults.checks,
      ...userConfig.checks,
    },
    customRules: [
      ...(defaults.customRules ?? []),
      ...(userConfig.customRules ?? []),
    ],
  };

  return { config: merged, configPath, stackInfo };
}
