import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { QualityLoopConfig, RepoCredentials } from "../types.js";
import { detectTechStack } from "../detector/techStack.js";
import { buildDefaultConfig } from "./defaults.js";
import type { GlobalConfig } from "../cli/configure.js";

const CONFIG_FILENAMES = [
  ".quality-loop.json",
  "quality-loop.config.json",
  ".qualityloop.json",
];

const GLOBAL_CONFIG_PATH = join(homedir(), ".agent-quality-loop.json");

/** Credential keys we know how to inject */
const CREDENTIAL_KEYS: Array<keyof RepoCredentials> = [
  "GROQ_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "SONAR_TOKEN",
  "SONAR_PROJECT_KEY",
  "GITHUB_TOKEN",
];

/**
 * Loads legacy global keys from ~/.agent-quality-loop.json (written by --configure).
 * Shell env vars always take precedence.
 */
function loadGlobalKeys(): void {
  if (!existsSync(GLOBAL_CONFIG_PATH)) return;
  try {
    const global = JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf8")) as GlobalConfig;
    for (const key of CREDENTIAL_KEYS) {
      const val = (global as Record<string, string | undefined>)[key];
      if (val && !process.env[key]) process.env[key] = val;
    }
  } catch { /* ignore malformed file */ }
}

/**
 * Injects credentials from the repo-level .quality-loop.json into process.env.
 * Priority: shell env > repo credentials > global file.
 */
function injectRepoCredentials(creds: RepoCredentials): void {
  for (const key of CREDENTIAL_KEYS) {
    const val = creds[key];
    if (val && !process.env[key]) process.env[key] = val;
  }
}

/**
 * Loads the quality loop config for a given project root.
 *
 * Credential resolution order (highest priority first):
 *  1. Shell environment variables (GROQ_API_KEY etc. in ~/.zshrc)
 *  2. credentials section in .quality-loop.json  ← primary path for new users
 *  3. Legacy ~/.agent-quality-loop.json (written by old --configure wizard)
 */
export function loadConfig(cwd: string): {
  config: QualityLoopConfig;
  configPath: string | null;
  stackInfo: ReturnType<typeof detectTechStack>;
} {
  // Lowest priority first — later injections skip keys already in env
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

  // Inject repo-level credentials (higher priority than global file, lower than shell env)
  if (userConfig.credentials) {
    injectRepoCredentials(userConfig.credentials);
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
