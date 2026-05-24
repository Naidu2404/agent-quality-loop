import { execSync } from "child_process";
import { existsSync } from "fs";
import { relative } from "path";
import { runEslint } from "../checks/eslint.js";
import { runTypecheck } from "../checks/typescript.js";
import { runPrettier } from "../checks/prettier.js";
import { runCustomRules } from "../checks/customRules.js";
import { runFileSizeCheck } from "../checks/fileSize.js";
import { loadConfig } from "../config/loader.js";
import { stackLabel } from "../detector/techStack.js";
import type { Issue, ReviewResult } from "../types.js";

export interface ReviewChangedFilesInput {
  /** Absolute or relative file paths to review. If omitted, auto-detects git-changed files. */
  files?: string[];
  /** Working directory (repo root). Defaults to process.cwd(). */
  cwd?: string;
}

export async function reviewChangedFiles(
  input: ReviewChangedFilesInput
): Promise<ReviewResult> {
  const cwd = input.cwd ?? process.cwd();
  const { config, configPath, stackInfo } = loadConfig(cwd);

  // Resolve file list
  let files: string[] = input.files ?? [];
  if (files.length === 0) {
    files = getGitChangedFiles(cwd);
  }

  // Normalize to relative paths
  files = files.map((f) => {
    try {
      return existsSync(f) ? relative(cwd, f) : f;
    } catch {
      return f;
    }
  });

  const allIssues: Issue[] = [];
  const checksRun: string[] = [];
  const checksSkipped: { check: string; reason: string }[] = [];

  // ESLint
  if (config.checks.eslint?.enabled !== false) {
    const result = runEslint(files, cwd, config.checks.eslint ?? { enabled: true });
    if (result.skipped) {
      checksSkipped.push({ check: "eslint", reason: result.skipReason ?? "skipped" });
    } else {
      checksRun.push("eslint");
      allIssues.push(...result.issues);
    }
  }

  // TypeScript
  if (config.checks.typescript?.enabled !== false && stackInfo.hasTypeScript) {
    const result = runTypecheck(files, cwd, config.checks.typescript ?? { enabled: true });
    if (result.skipped) {
      checksSkipped.push({ check: "typescript", reason: result.skipReason ?? "skipped" });
    } else {
      checksRun.push("typescript");
      allIssues.push(...result.issues);
    }
  }

  // Prettier
  if (config.checks.prettier?.enabled !== false && stackInfo.hasPrettier) {
    const result = runPrettier(files, cwd, config.checks.prettier ?? { enabled: true });
    if (result.skipped) {
      checksSkipped.push({ check: "prettier", reason: result.skipReason ?? "skipped" });
    } else {
      checksRun.push("prettier");
      allIssues.push(...result.issues);
    }
  }

  // Custom rules
  if (config.customRules && config.customRules.length > 0) {
    const result = runCustomRules(files, cwd, config.customRules);
    if (result.skipped) {
      checksSkipped.push({ check: "customRules", reason: result.skipReason ?? "skipped" });
    } else {
      checksRun.push("customRules");
      allIssues.push(...result.issues);
    }
  }

  // File size limits
  const fileSizeResult = runFileSizeCheck(files, cwd, config.fileSizeLimits);
  if (fileSizeResult.skipped) {
    checksSkipped.push({ check: "fileSize", reason: fileSizeResult.skipReason ?? "skipped" });
  } else {
    checksRun.push("fileSize");
    allIssues.push(...fileSizeResult.issues);
  }

  // Compute summary
  const blockingSeverities = config.blockingseverities ?? ["error"];
  const blockingIssues = allIssues.filter((i) => blockingSeverities.includes(i.severity));
  const advisoryIssues = allIssues.filter((i) => !blockingSeverities.includes(i.severity));
  const passesPolicy = blockingIssues.length === 0;

  const summary = buildSummary({
    stack: stackLabel(stackInfo),
    configPath,
    files,
    checksRun,
    checksSkipped,
    allIssues,
    blockingIssues,
    advisoryIssues,
    passesPolicy,
    maxIterations: config.maxIterations ?? 3,
    notes: config.notes,
  });

  return {
    totalIssues: allIssues.length,
    blockingCount: blockingIssues.length,
    advisoryCount: advisoryIssues.length,
    passesPolicy,
    issues: allIssues,
    summary,
    checksRun,
    checksSkipped,
  };
}

function getGitChangedFiles(cwd: string): string[] {
  try {
    // Staged + unstaged changes against HEAD
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

    const untracked = execSync("git ls-files --others --exclude-standard", {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);

    return [...new Set([...staged, ...unstaged, ...untracked])];
  } catch {
    return [];
  }
}

function buildSummary(opts: {
  stack: string;
  configPath: string | null;
  files: string[];
  checksRun: string[];
  checksSkipped: { check: string; reason: string }[];
  allIssues: Issue[];
  blockingIssues: Issue[];
  advisoryIssues: Issue[];
  passesPolicy: boolean;
  maxIterations: number;
  notes?: string;
}): string {
  const {
    stack,
    configPath,
    files,
    checksRun,
    checksSkipped,
    allIssues,
    blockingIssues,
    advisoryIssues,
    passesPolicy,
    maxIterations,
    notes,
  } = opts;

  const lines: string[] = [];

  lines.push(`## Quality Loop Review`);
  lines.push(`**Stack:** ${stack}`);
  lines.push(`**Config:** ${configPath ?? "auto-detected defaults"}`);
  lines.push(`**Files reviewed:** ${files.length}`);
  lines.push(`**Checks run:** ${checksRun.join(", ") || "none"}`);
  if (checksSkipped.length > 0) {
    lines.push(
      `**Checks skipped:** ${checksSkipped.map((s) => `${s.check} (${s.reason})`).join(", ")}`
    );
  }
  lines.push("");

  if (passesPolicy) {
    lines.push(`✅ **PASSES POLICY** — no blocking issues found.`);
    if (advisoryIssues.length > 0) {
      lines.push(
        `   ${advisoryIssues.length} advisory issue(s) exist — review but not blocking.`
      );
    }
  } else {
    lines.push(
      `❌ **FAILS POLICY** — ${blockingIssues.length} blocking issue(s) must be fixed.`
    );
    lines.push(`   (max ${maxIterations} fix iterations recommended)`);
  }

  if (allIssues.length > 0) {
    lines.push("");
    lines.push("### Issues by file");

    const byFile = new Map<string, Issue[]>();
    for (const issue of allIssues) {
      if (!byFile.has(issue.path)) byFile.set(issue.path, []);
      byFile.get(issue.path)!.push(issue);
    }

    for (const [file, fileIssues] of byFile.entries()) {
      lines.push(`\n**${file}** (${fileIssues.length} issue(s))`);
      for (const issue of fileIssues) {
        const loc = `L${issue.line}${issue.column ? `:${issue.column}` : ""}`;
        const sev = issue.severity.toUpperCase();
        lines.push(`  - [${sev}] ${loc} \`${issue.ruleId}\` — ${issue.message}`);
        if (issue.fixHint) {
          lines.push(`    → Fix: ${issue.fixHint}`);
        }
      }
    }
  }

  if (notes) {
    lines.push("");
    lines.push("### Repo notes");
    lines.push(notes);
  }

  return lines.join("\n");
}
