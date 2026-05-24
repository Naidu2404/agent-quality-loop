import { execSync } from "child_process";
import { existsSync } from "fs";
import { relative } from "path";
import { globSync } from "glob";

export interface VerifyTraceRemovalInput {
  /** Absolute path to the repo root. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Files that were modified during trace removal.
   * Pass ["*"] to verify the whole workspace.
   */
  files?: string[];
}

export interface VerifyTraceRemovalResult {
  passesVerification: boolean;
  newErrorCount: number;
  newWarningCount: number;
  errors: VerifyIssue[];
  warnings: VerifyIssue[];
  summary: string;
  /** Compact prompt for the agent if new errors were introduced */
  revertPrompt?: string;
}

export interface VerifyIssue {
  path: string;
  line: number;
  column?: number;
  severity: "error" | "warning";
  ruleId: string;
  message: string;
  sourceLine?: string;
}

export function verifyTraceRemoval(
  input: VerifyTraceRemovalInput
): VerifyTraceRemovalResult {
  const cwd = input.cwd ?? process.cwd();
  let files = input.files ?? [];

  if (files.includes("*")) {
    files = globSync(
      ["src/**/*.{ts,tsx,vue,js,jsx,mjs}", "lib/**/*.{ts,js}", "app/**/*.{ts,vue,js}"],
      { cwd, nodir: true, ignore: ["node_modules/**", "dist/**", "**/*.d.ts"] }
    );
  }

  if (files.length === 0) {
    files = getGitChangedFiles(cwd);
  }

  // Normalize to relative paths
  files = files
    .map((f) => {
      try {
        return existsSync(f) ? relative(cwd, f) : f;
      } catch {
        return f;
      }
    })
    .filter(Boolean);

  const errors: VerifyIssue[] = [];
  const warnings: VerifyIssue[] = [];

  // Run TypeScript check
  const tsIssues = runTypeScriptVerify(files, cwd);
  for (const issue of tsIssues) {
    if (issue.severity === "error") errors.push(issue);
    else warnings.push(issue);
  }

  // Run ESLint check (errors only — we don't want to revert for warnings)
  const eslintIssues = runEslintVerify(files, cwd);
  for (const issue of eslintIssues) {
    if (issue.severity === "error") errors.push(issue);
    else warnings.push(issue);
  }

  const passesVerification = errors.length === 0;

  const revertPrompt = passesVerification
    ? undefined
    : buildRevertPrompt(errors, files);

  const summary = buildSummary(errors, warnings, files, passesVerification);

  return {
    passesVerification,
    newErrorCount: errors.length,
    newWarningCount: warnings.length,
    errors,
    warnings,
    summary,
    revertPrompt,
  };
}

// ─── TypeScript verify ────────────────────────────────────────────────────────

function runTypeScriptVerify(files: string[], cwd: string): VerifyIssue[] {
  const issues: VerifyIssue[] = [];

  // Check if tsconfig exists
  const hasTsConfig =
    existsSync(`${cwd}/tsconfig.json`) ||
    existsSync(`${cwd}/tsconfig.app.json`);
  if (!hasTsConfig) return issues;

  try {
    execSync("npx tsc --noEmit --pretty false 2>&1", {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e: unknown) {
    const output = (e as { stdout?: string; stderr?: string; message?: string })
      .stdout ?? String(e);
    const lines = output.split("\n");

    for (const line of lines) {
      // Format: path(line,col): error TS1234: message
      const m = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/);
      if (!m) continue;

      const [, rawPath, lineStr, colStr, sev, code, msg] = m;
      const relPath = rawPath.trim();

      // Only report issues in files we modified
      if (files.length > 0 && !files.some((f) => relPath.endsWith(f) || f.endsWith(relPath))) {
        continue;
      }

      issues.push({
        path: relPath,
        line: parseInt(lineStr, 10),
        column: parseInt(colStr, 10),
        severity: sev === "error" ? "error" : "warning",
        ruleId: code,
        message: msg.trim(),
        sourceLine: getSourceLine(relPath, cwd, parseInt(lineStr, 10)),
      });
    }
  }

  return issues;
}

// ─── ESLint verify ────────────────────────────────────────────────────────────

function runEslintVerify(files: string[], cwd: string): VerifyIssue[] {
  const issues: VerifyIssue[] = [];

  const eslintBin = existsSync(`${cwd}/node_modules/.bin/eslint`)
    ? `${cwd}/node_modules/.bin/eslint`
    : "npx eslint";

  const hasEslintConfig =
    existsSync(`${cwd}/.eslintrc.js`) ||
    existsSync(`${cwd}/.eslintrc.cjs`) ||
    existsSync(`${cwd}/.eslintrc.json`) ||
    existsSync(`${cwd}/.eslintrc.yml`) ||
    existsSync(`${cwd}/eslint.config.js`) ||
    existsSync(`${cwd}/eslint.config.mjs`);

  if (!hasEslintConfig) return issues;

  // Filter to ESLint-eligible files
  const eligible = files.filter((f) => /\.(ts|tsx|vue|js|jsx|mjs)$/.test(f));
  if (eligible.length === 0) return issues;

  try {
    const fileArgs = eligible.map((f) => `"${f}"`).join(" ");
    const cmd = `${eslintBin} --format json ${fileArgs} 2>/dev/null`;
    const output = execSync(cmd, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

    const parsed = JSON.parse(output);
    for (const fileResult of parsed) {
      const relPath = relative(cwd, fileResult.filePath);
      for (const msg of fileResult.messages ?? []) {
        if (msg.severity === 0) continue; // off
        issues.push({
          path: relPath,
          line: msg.line ?? 1,
          column: msg.column,
          severity: msg.severity === 2 ? "error" : "warning",
          ruleId: msg.ruleId ?? "eslint",
          message: msg.message,
          sourceLine: getSourceLine(relPath, cwd, msg.line ?? 1),
        });
      }
    }
  } catch (e: unknown) {
    // ESLint exits with non-zero on lint errors — output is in stdout
    const stdout = (e as { stdout?: string }).stdout ?? "";
    try {
      const parsed = JSON.parse(stdout);
      for (const fileResult of parsed) {
        const relPath = relative(cwd, fileResult.filePath);
        for (const msg of fileResult.messages ?? []) {
          if (msg.severity === 0) continue;
          issues.push({
            path: relPath,
            line: msg.line ?? 1,
            column: msg.column,
            severity: msg.severity === 2 ? "error" : "warning",
            ruleId: msg.ruleId ?? "eslint",
            message: msg.message,
            sourceLine: getSourceLine(relPath, cwd, msg.line ?? 1),
          });
        }
      }
    } catch {
      // ESLint not available or parse failed — skip
    }
  }

  return issues;
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildRevertPrompt(errors: VerifyIssue[], files: string[]): string {
  const lines: string[] = [];
  lines.push(`⚠️  TRACE REMOVAL VERIFICATION FAILED — ${errors.length} new error(s) introduced.`);
  lines.push(`These errors did not exist before the removal. You must revert the specific removal(s) that caused them.`);
  lines.push("");
  lines.push(`## New errors introduced by trace removal`);
  lines.push("");

  // Group by file
  const byFile = new Map<string, VerifyIssue[]>();
  for (const err of errors) {
    if (!byFile.has(err.path)) byFile.set(err.path, []);
    byFile.get(err.path)!.push(err);
  }

  for (const [file, fileErrors] of byFile) {
    lines.push(`### ${file}`);
    for (const err of fileErrors) {
      lines.push(`[${err.severity.toUpperCase()}] L${err.line} \`${err.ruleId}\` — ${err.message}`);
      if (err.sourceLine) lines.push(`  Code: ${err.sourceLine.trim().slice(0, 120)}`);
      lines.push("");
    }
  }

  lines.push(`## How to fix`);
  lines.push(`1. Identify which trace removal caused each error above (check the line numbers and symbols).`);
  lines.push(`2. Revert ONLY that specific removal — restore the symbol/import that caused the break.`);
  lines.push(`3. Call verify_trace_removal again with the same files to confirm the errors are gone.`);
  lines.push(`4. If all errors are resolved → trace removal is complete.`);

  return lines.join("\n");
}

function buildSummary(
  errors: VerifyIssue[],
  warnings: VerifyIssue[],
  files: string[],
  passes: boolean
): string {
  const lines: string[] = [];
  lines.push(`## Trace Removal Verification`);
  lines.push(`**Files checked:** ${files.length}`);
  lines.push("");

  if (passes) {
    lines.push(`✅ **PASSED** — no new errors introduced by trace removal.`);
    if (warnings.length > 0) {
      lines.push(`ℹ️  ${warnings.length} warning(s) present (non-blocking).`);
    }
    lines.push("");
    lines.push("Trace code removal is complete and safe.");
  } else {
    lines.push(`❌ **FAILED** — ${errors.length} new error(s) were introduced.`);
    if (warnings.length > 0) lines.push(`ℹ️  ${warnings.length} additional warning(s).`);
    lines.push("");
    lines.push("**Next step:** Read `revertPrompt` and revert the specific removals that caused these errors.");
  }

  return lines.join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSourceLine(relPath: string, cwd: string, line: number): string | undefined {
  try {
    const { readFileSync } = require("fs");
    const { join } = require("path");
    const abs = relPath.startsWith("/") ? relPath : join(cwd, relPath);
    if (!existsSync(abs)) return undefined;
    const lines = readFileSync(abs, "utf8").split("\n");
    return lines[line - 1] ?? undefined;
  } catch {
    return undefined;
  }
}

function getGitChangedFiles(cwd: string): string[] {
  try {
    const staged = execSync("git diff --name-only --cached", {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    const unstaged = execSync("git diff --name-only", {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    return [...new Set([...staged, ...unstaged])];
  } catch {
    return [];
  }
}
