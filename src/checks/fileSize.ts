import { existsSync, readFileSync } from "fs";
import { join, relative } from "path";
import { minimatch } from "minimatch";
import type { FileSizeRule, Issue } from "../types.js";

const DEFAULT_FILE_SIZE_RULES: FileSizeRule[] = [
  {
    glob: "**/*.vue",
    maxLines: 500,
    severity: "error",
    fixHint:
      "Extract logic into a composable (src/composables/). If a composable already exists for this domain, update it instead of adding to the component script.",
  },
  {
    glob: "**/*.ts",
    maxLines: 400,
    severity: "warning",
    fixHint:
      "Split this file by responsibility — extract utility functions, types, or sub-services into separate files.",
  },
];

/**
 * Checks each file against configured line-count limits.
 * Returns one Issue per file that exceeds its limit.
 */
export function runFileSizeCheck(
  files: string[],
  cwd: string,
  rules?: FileSizeRule[]
): { issues: Issue[]; skipped: boolean; skipReason?: string } {
  const effectiveRules = rules ?? DEFAULT_FILE_SIZE_RULES;

  if (effectiveRules.length === 0) {
    return { issues: [], skipped: true, skipReason: "No file size rules configured" };
  }

  const issues: Issue[] = [];

  for (const file of files) {
    const absPath = join(cwd, file);
    if (!existsSync(absPath)) continue;

    let content: string;
    try {
      content = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }

    const lineCount = content.split("\n").length;
    const relPath = relative(cwd, absPath);

    for (const rule of effectiveRules) {
      const matches =
        minimatch(relPath, rule.glob, { matchBase: false }) ||
        minimatch(relPath.replace(/^\.\//, ""), rule.glob, { matchBase: true });

      if (!matches) continue;

      if (lineCount > rule.maxLines) {
        const overage = lineCount - rule.maxLines;
        issues.push({
          path: relPath,
          line: 1,
          severity: rule.severity,
          category: "custom",
          ruleId: "file-too-large",
          message: `File has ${lineCount} lines — exceeds the ${rule.maxLines}-line limit by ${overage} lines.`,
          fixHint: rule.fixHint,
        });
      }

      break; // first matching rule wins
    }
  }

  return { issues, skipped: false };
}
