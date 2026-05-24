import { existsSync, readFileSync } from "fs";
import { join, relative } from "path";
import { minimatch } from "minimatch";
import type { CustomRule, Issue } from "../types.js";
import { getSourceContext } from "./sourceContext.js";

/**
 * Evaluates the custom rule set against a list of files.
 * Each rule can optionally have a regex `pattern` (textual match) and a `glob` filter.
 */
export function runCustomRules(
  files: string[],
  cwd: string,
  rules: CustomRule[]
): { issues: Issue[]; skipped: boolean; skipReason?: string } {
  if (rules.length === 0) {
    return { issues: [], skipped: true, skipReason: "No custom rules configured" };
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

    const relPath = relative(cwd, absPath);
    const lines = content.split("\n");

    for (const rule of rules) {
      // Glob filter
      if (rule.glob) {
        const matches = minimatch(relPath, rule.glob, { matchBase: false });
        // Also try with leading ./ stripped
        const matchesAlt = minimatch(relPath.replace(/^\.\//, ""), rule.glob, { matchBase: true });
        if (!matches && !matchesAlt) continue;
      }

      // Pattern-based textual check
      if (rule.pattern) {
        const regex = new RegExp(rule.pattern, "gim");

        lines.forEach((line, idx) => {
          const lineMatches = [...line.matchAll(regex)];
          for (const m of lineMatches) {
            const lineNum = idx + 1;
            const ctx = getSourceContext(relPath, cwd, lineNum);
            issues.push({
              path: relPath,
              line: lineNum,
              column: (m.index ?? 0) + 1,
              severity: rule.severity,
              category: "custom",
              ruleId: rule.id,
              message: rule.message,
              fixHint: rule.fixHint,
              sourceLine: ctx?.sourceLine,
              sourceContext: ctx?.sourceContext,
            });
          }
        });
      } else {
        // Rule without a pattern is a policy reminder — emit once per file
        issues.push({
          path: relPath,
          line: 1,
          severity: rule.severity,
          category: "policy",
          ruleId: rule.id,
          message: `[Policy] ${rule.description}: ${rule.message}`,
          fixHint: rule.fixHint,
        });
      }
    }
  }

  return { issues, skipped: false };
}
