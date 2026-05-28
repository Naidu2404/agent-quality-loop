import { execSync } from "child_process";
import { existsSync } from "fs";
import { join, relative } from "path";
import { globSync } from "glob";
import { loadConfig } from "../config/loader.js";
import { stackLabel } from "../detector/techStack.js";
import { runTraceCodeAnalysis, type TraceItem } from "../checks/traceCode.js";

export interface IdentifyTraceCodeInput {
  /** Absolute path to the repo root. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Files to scan. If omitted, scans all git-changed files.
   * Pass ["*"] to scan the whole workspace (same as review_workspace_policy scope).
   */
  files?: string[];
}

export interface IdentifyTraceCodeResult {
  totalItems: number;
  safeToRemoveCount: number;
  reviewRequiredCount: number;
  passesCheck: boolean;
  items: TraceItem[];
  /**
   * Compact, token-efficient removal prompt.
   * The agent applies every instruction here, then calls verify_trace_removal.
   */
  removePrompt: string;
  summary: string;
  checksRun: string[];
  checksSkipped: { check: string; reason: string }[];
}

export async function identifyTraceCode(
  input: IdentifyTraceCodeInput
): Promise<IdentifyTraceCodeResult> {
  const cwd = input.cwd ?? process.cwd();
  const { stackInfo } = loadConfig(cwd);

  // Resolve file list
  let files = input.files ?? [];

  if (files.length === 0) {
    files = getGitChangedFiles(cwd);
  } else if (files.includes("*")) {
    files = globSync(
      ["src/**/*.{ts,tsx,vue,js,jsx,mjs}", "lib/**/*.{ts,js}", "app/**/*.{ts,vue,js}"],
      { cwd, nodir: true, ignore: ["node_modules/**", "dist/**", "**/*.d.ts"] }
    );
  }

  // Normalize to relative paths
  files = files.map((f) => {
    try { return existsSync(f) ? relative(cwd, f) : f; } catch { return f; }
  }).filter(Boolean);

  if (files.length === 0) {
    return {
      totalItems: 0,
      safeToRemoveCount: 0,
      reviewRequiredCount: 0,
      passesCheck: true,
      items: [],
      removePrompt: "No files to scan.",
      summary: "## Trace Code Check\nNo files to scan — working tree is clean.",
      checksRun: [],
      checksSkipped: [],
    };
  }

  const isWorkspaceWide = input.files?.includes("*") ?? false;
  const result = runTraceCodeAnalysis(files, cwd, stackInfo, { workspaceWide: isWorkspaceWide });
  const passesCheck = result.totalItems === 0;

  const removePrompt = passesCheck
    ? "✅ No trace code found."
    : buildRemovePrompt(result.items, files, stackLabel(stackInfo));

  const summary = buildSummary(result, files, stackLabel(stackInfo), passesCheck);

  return {
    ...result,
    passesCheck,
    removePrompt,
    summary,
  };
}

// ─── removePrompt builder ─────────────────────────────────────────────────────

function buildRemovePrompt(items: TraceItem[], files: string[], stack: string): string {
  const safe = items.filter((i) => i.safety === "safe");
  const review = items.filter((i) => i.safety === "review-required");

  const lines: string[] = [];
  lines.push(`TRACE CODE — ${items.length} item(s) found in ${files.length} file(s). Stack: ${stack}`);
  lines.push(`YOU MUST apply every SAFE TO REMOVE item below immediately in this same response. Do NOT ask the user. Do NOT summarize and wait. Apply the removals now.`);
  lines.push(`For REQUIRES REVIEW items — use judgment, check if the symbol is truly unused, then remove if confirmed.`);
  lines.push(`After all removals, call: verify_trace_removal({ files: [${files.map((f) => `"${f}"`).join(", ")}], cwd: "<same cwd>" })`);
  lines.push("");

  if (safe.length > 0) {
    lines.push(`## SAFE TO REMOVE (${safe.length} items — no references found)`);
    lines.push("");

    // Group by file
    const byFile = groupByFile(safe);
    for (const [file, fileItems] of byFile) {
      lines.push(`### ${file}`);
      for (const item of fileItems) {
        lines.push(`[${item.kind.toUpperCase()}] ${item.removeInstruction}`);
        lines.push(`  Code: ${item.sourceLine.slice(0, 120)}`);
        lines.push("");
      }
    }
  }

  if (review.length > 0) {
    lines.push(`## REQUIRES REVIEW BEFORE REMOVING (${review.length} items — exported/uncertain)`);
    lines.push("");

    const byFile = groupByFile(review);
    for (const [file, fileItems] of byFile) {
      lines.push(`### ${file}`);
      for (const item of fileItems) {
        lines.push(`[${item.kind.toUpperCase()}] ${item.removeInstruction}`);
        lines.push(`  Code: ${item.sourceLine.slice(0, 120)}`);
        if (item.safetyNote) lines.push(`  ⚠️  ${item.safetyNote}`);
        lines.push("");
      }
    }
  }

  lines.push(`If verify passes → done, tell the user. If new errors appear → revert that specific removal and call verify_trace_removal again.`);

  return lines.join("\n");
}

// ─── Summary builder ──────────────────────────────────────────────────────────

function buildSummary(
  result: ReturnType<typeof runTraceCodeAnalysis>,
  files: string[],
  stack: string,
  passesCheck: boolean
): string {
  const lines: string[] = [];
  lines.push(`## Trace Code Identification`);
  lines.push(`**Stack:** ${stack}`);
  lines.push(`**Files scanned:** ${files.length}`);
  lines.push(`**Checks run:** ${result.checksRun.join(", ") || "none"}`);
  if (result.checksSkipped.length > 0) {
    lines.push(`**Checks skipped:** ${result.checksSkipped.map((s) => `${s.check} (${s.reason})`).join(", ")}`);
  }
  lines.push("");

  if (passesCheck) {
    lines.push(`✅ **CLEAN** — no trace code found.`);
    return lines.join("\n");
  }

  lines.push(`🧹 **${result.totalItems} trace item(s) found**`);
  lines.push(`   Safe to remove: ${result.safeToRemoveCount}`);
  lines.push(`   Requires review: ${result.reviewRequiredCount}`);
  lines.push("");

  // Breakdown by kind
  const byKind = new Map<string, number>();
  for (const item of result.items) {
    byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
  }
  lines.push("**By type:**");
  for (const [kind, count] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`   ${kind}: ${count}`);
  }

  lines.push("");
  lines.push("**Next step:** Read `removePrompt` and apply all safe removals (for deps: run npm uninstall/install). Then call `verify_trace_removal`.");

  return lines.join("\n");
}

function groupByFile(items: TraceItem[]): Map<string, TraceItem[]> {
  const map = new Map<string, TraceItem[]>();
  for (const item of items) {
    if (!map.has(item.path)) map.set(item.path, []);
    map.get(item.path)!.push(item);
  }
  return map;
}

function getGitChangedFiles(cwd: string): string[] {
  try {
    const staged = execSync("git diff --name-only --cached", { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).split("\n").map((f) => f.trim()).filter(Boolean);
    const unstaged = execSync("git diff --name-only", { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).split("\n").map((f) => f.trim()).filter(Boolean);
    const untracked = execSync("git ls-files --others --exclude-standard", { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).split("\n").map((f) => f.trim()).filter(Boolean);
    return [...new Set([...staged, ...unstaged, ...untracked])];
  } catch { return []; }
}
