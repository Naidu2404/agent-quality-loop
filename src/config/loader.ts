import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { QualityLoopConfig } from "../types.js";
import { detectTechStack } from "../detector/techStack.js";
import { buildDefaultConfig } from "./defaults.js";

const CONFIG_FILENAMES = [
  ".quality-loop.json",
  "quality-loop.config.json",
  ".qualityloop.json",
];

/**
 * Loads the quality loop config for a given project root.
 *
 * Resolution order:
 *  1. Look for a .quality-loop.json (or variant) in cwd
 *  2. Auto-detect tech stack and merge in defaults
 *  3. Falls back to all-defaults if no config file exists
 */
export function loadConfig(cwd: string): {
  config: QualityLoopConfig;
  configPath: string | null;
  stackInfo: ReturnType<typeof detectTechStack>;
} {
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
