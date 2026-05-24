import { execSync } from "child_process";
import { existsSync } from "fs";
import { join, relative } from "path";
import type { CheckConfig, Issue } from "../types.js";

/**
 * Runs Prettier --check and returns one Issue per unformatted file.
 */
export function runPrettier(
  files: string[],
  cwd: string,
  _config: CheckConfig
): { issues: Issue[]; skipped: boolean; skipReason?: string } {
  const prettierBin = resolvePrettierBin(cwd);
  if (!prettierBin) {
    return { issues: [], skipped: true, skipReason: "Prettier binary not found (run npm install)" };
  }

  if (files.length === 0) {
    return { issues: [], skipped: false };
  }

  // Prettier supports most file types
  const ignoredExts = [".lock", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2"];
  const eligible = files.filter((f) => !ignoredExts.some((ext) => f.endsWith(ext)));

  if (eligible.length === 0) {
    return { issues: [], skipped: true, skipReason: "No formattable files in the provided list" };
  }

  const issues: Issue[] = [];

  for (const file of eligible) {
    const absPath = join(cwd, file);
    if (!existsSync(absPath)) continue;

    try {
      execSync(`"${prettierBin}" --check "${absPath}"`, {
        cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      // exit 0 = formatted correctly
    } catch {
      // exit non-zero = file needs formatting
      const relPath = relative(cwd, absPath);
      issues.push({
        path: relPath,
        line: 1,
        severity: "warning",
        category: "formatting",
        ruleId: "prettier/prettier",
        message: `File is not formatted according to Prettier rules.`,
        fixHint: `Run: npx prettier --write "${relPath}"`,
      });
    }
  }

  return { issues, skipped: false };
}

function resolvePrettierBin(cwd: string): string | null {
  const local = join(cwd, "node_modules", ".bin", "prettier");
  if (existsSync(local)) return local;

  try {
    const globalPath = execSync("which prettier", { encoding: "utf8" }).trim();
    if (globalPath) return globalPath;
  } catch {
    // not found
  }
  return null;
}
