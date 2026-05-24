import { globSync } from "glob";
import { reviewChangedFiles } from "./reviewChangedFiles.js";
import type { ReviewResult } from "../types.js";

export interface ReviewWorkspacePolicyInput {
  /** Working directory (repo root). Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Glob patterns for files to include (default: common source dirs).
   * Example: ["src/**\/*.ts", "lib/**\/*.ts"]
   */
  include?: string[];
  /**
   * Glob patterns to exclude (default: node_modules, dist, build, etc.)
   */
  exclude?: string[];
}

const DEFAULT_INCLUDE = [
  "src/**/*.{ts,tsx,js,jsx,vue,mjs,cjs}",
  "lib/**/*.{ts,tsx,js,jsx}",
  "app/**/*.{ts,tsx,js,jsx,vue}",
  "pages/**/*.{ts,tsx,js,jsx,vue}",
  "components/**/*.{ts,tsx,js,jsx,vue}",
  "composables/**/*.{ts,tsx,js,jsx}",
  "utils/**/*.{ts,tsx,js,jsx}",
  "hooks/**/*.{ts,tsx,js,jsx}",
  "stores/**/*.{ts,tsx,js,jsx}",
  "services/**/*.{ts,tsx,js,jsx}",
];

const DEFAULT_EXCLUDE = [
  "node_modules/**",
  "dist/**",
  "build/**",
  ".nuxt/**",
  ".next/**",
  "coverage/**",
  "**/*.min.js",
  "**/*.d.ts",
];

/**
 * Runs the quality policy over the whole workspace (or a configured subset of files).
 * Useful for a full repo scan rather than just changed files.
 */
export async function reviewWorkspacePolicy(
  input: ReviewWorkspacePolicyInput
): Promise<ReviewResult> {
  const cwd = input.cwd ?? process.cwd();
  const include = input.include ?? DEFAULT_INCLUDE;
  const exclude = input.exclude ?? DEFAULT_EXCLUDE;

  const files = globSync(include, {
    cwd,
    ignore: exclude,
    nodir: true,
  });

  return reviewChangedFiles({ files, cwd });
}
