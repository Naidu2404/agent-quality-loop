import { execSync } from "child_process";
import { existsSync } from "fs";
import { join, relative } from "path";
import type { CheckConfig, Issue } from "../types.js";

interface ESLintMessage {
  ruleId: string | null;
  severity: number; // 1=warn, 2=error
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  fix?: unknown;
  suggestions?: unknown[];
}

interface ESLintFileResult {
  filePath: string;
  messages: ESLintMessage[];
  errorCount: number;
  warningCount: number;
}

/**
 * Runs ESLint on the given files and returns normalized Issues.
 * Returns null if ESLint is not available or not applicable.
 */
export function runEslint(
  files: string[],
  cwd: string,
  config: CheckConfig
): { issues: Issue[]; skipped: boolean; skipReason?: string } {
  // Check ESLint is installed
  const eslintBin = resolveEslintBin(cwd);
  if (!eslintBin) {
    return { issues: [], skipped: true, skipReason: "ESLint binary not found (run npm install)" };
  }

  if (files.length === 0) {
    return { issues: [], skipped: false };
  }

  // Filter to JS/TS-like files only
  const supportedExts = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".vue", ".svelte"];
  const eligible = files.filter((f) =>
    supportedExts.some((ext) => f.endsWith(ext))
  );

  if (eligible.length === 0) {
    return { issues: [], skipped: true, skipReason: "No JS/TS files in the provided list" };
  }

  const configFlag = config.configPath ? `--config ${config.configPath}` : "";
  const extraArgs = (config.extraArgs ?? []).join(" ");
  const fileList = eligible.map((f) => `"${f}"`).join(" ");

  let stdout = "";
  try {
    stdout = execSync(
      `"${eslintBin}" --format json ${configFlag} ${extraArgs} ${fileList}`,
      { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
  } catch (err: unknown) {
    // ESLint exits non-zero when there are errors — capture stdout from the error
    const execError = err as { stdout?: string; status?: number };
    if (execError.stdout) {
      stdout = execError.stdout;
    } else {
      return {
        issues: [],
        skipped: true,
        skipReason: `ESLint execution failed: ${String(err)}`,
      };
    }
  }

  let results: ESLintFileResult[] = [];
  try {
    results = JSON.parse(stdout) as ESLintFileResult[];
  } catch {
    return { issues: [], skipped: true, skipReason: "Failed to parse ESLint JSON output" };
  }

  const issues: Issue[] = [];
  for (const file of results) {
    const relPath = relative(cwd, file.filePath);
    for (const msg of file.messages) {
      issues.push({
        path: relPath,
        line: msg.line ?? 1,
        endLine: msg.endLine,
        column: msg.column,
        endColumn: msg.endColumn,
        severity: msg.severity === 2 ? "error" : "warning",
        category: "lint",
        ruleId: msg.ruleId ?? "eslint/unknown",
        message: msg.message,
        fixHint: msg.suggestions?.length
          ? `ESLint has ${(msg.suggestions as unknown[]).length} auto-fix suggestion(s) — run eslint --fix`
          : undefined,
      });
    }
  }

  return { issues, skipped: false };
}

function resolveEslintBin(cwd: string): string | null {
  // Local node_modules/.bin first
  const local = join(cwd, "node_modules", ".bin", "eslint");
  if (existsSync(local)) return local;

  // Fall back to global
  try {
    const globalPath = execSync("which eslint", { encoding: "utf8" }).trim();
    if (globalPath) return globalPath;
  } catch {
    // not found
  }
  return null;
}
