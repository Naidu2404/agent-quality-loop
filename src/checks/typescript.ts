import { execSync } from "child_process";
import { existsSync } from "fs";
import { join, relative } from "path";
import type { CheckConfig, Issue } from "../types.js";
import { getSourceContext } from "./sourceContext.js";

/**
 * Runs tsc --noEmit and parses the diagnostic output into normalized Issues.
 * Results are filtered to only the files passed in — pre-existing errors in
 * unrelated files are deliberately excluded so review_changed_files stays
 * scoped to what the agent actually changed.
 */
export function runTypecheck(
  files: string[],
  cwd: string,
  config: CheckConfig
): { issues: Issue[]; skipped: boolean; skipReason?: string } {
  const tscBin = resolveTscBin(cwd);
  if (!tscBin) {
    return { issues: [], skipped: true, skipReason: "TypeScript binary not found (run npm install)" };
  }

  const tsconfigPath = config.configPath
    ? join(cwd, config.configPath)
    : join(cwd, "tsconfig.json");

  if (!existsSync(tsconfigPath)) {
    return { issues: [], skipped: true, skipReason: `No tsconfig.json found at ${tsconfigPath}` };
  }

  const extraArgs = (config.extraArgs ?? []).join(" ");

  let output = "";
  try {
    execSync(`"${tscBin}" --noEmit --pretty false ${extraArgs} -p "${tsconfigPath}"`, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Exit 0 means no errors
    return { issues: [], skipped: false };
  } catch (err: unknown) {
    const execError = err as { stdout?: string; stderr?: string };
    output = [execError.stdout, execError.stderr].filter(Boolean).join("\n");
  }

  const allIssues = parseTscOutput(output, cwd);

  // Filter to only the files being reviewed.
  // tsc runs project-wide so it surfaces pre-existing errors in untouched files —
  // we only want errors in the files the agent actually changed.
  const filteredIssues = files.length > 0
    ? allIssues.filter((issue) => filesContainPath(files, issue.path))
    : allIssues;

  return { issues: filteredIssues, skipped: false };
}

/**
 * Parses tsc diagnostic lines of the form:
 *   src/file.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.
 */
function parseTscOutput(output: string, cwd: string): Issue[] {
  const issues: Issue[] = [];
  // Matches:  path(line,col): severity TScode: message
  const lineRe = /^(.+?)\((\d+),(\d+)\):\s+(error|warning|message)\s+(TS\d+):\s+(.+)$/;

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(lineRe);
    if (!match) continue;

    const [, filePath, lineStr, colStr, tscSeverity, code, message] = match;

    // Normalize path relative to cwd
    let relPath = filePath.trim();
    try {
      relPath = relative(cwd, join(cwd, relPath));
    } catch {
      // leave as-is
    }

    const lineNum = parseInt(lineStr, 10);
    const ctx = getSourceContext(relPath, cwd, lineNum);
    issues.push({
      path: relPath,
      line: lineNum,
      column: parseInt(colStr, 10),
      severity: tscSeverity === "error" ? "error" : "warning",
      category: "types",
      ruleId: code,
      message: message.trim(),
      fixHint: getTypeScriptHint(code),
      sourceLine: ctx?.sourceLine,
      sourceContext: ctx?.sourceContext,
    });
  }

  return issues;
}

function resolveTscBin(cwd: string): string | null {
  const local = join(cwd, "node_modules", ".bin", "tsc");
  if (existsSync(local)) return local;

  try {
    const globalPath = execSync("which tsc", { encoding: "utf8" }).trim();
    if (globalPath) return globalPath;
  } catch {
    // not found
  }
  return null;
}

/**
 * Returns true if any file in the list matches issuePath.
 * Normalises separators and handles both relative and absolute paths.
 */
function filesContainPath(files: string[], issuePath: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const ip = norm(issuePath);
  return files.some((f) => {
    const fp = norm(f);
    return ip === fp || ip.endsWith("/" + fp) || fp.endsWith("/" + ip);
  });
}

/** Common TypeScript error code → fix hint mapping */
function getTypeScriptHint(code: string): string | undefined {
  const hints: Record<string, string> = {
    TS2322: "Check that the assigned value's type matches the declared type.",
    TS2345: "The argument type doesn't match the parameter type — add a type assertion or fix the value.",
    TS2339: "Property doesn't exist on this type — check for typos or extend the interface.",
    TS2304: "Cannot find name — ensure the variable/type is imported or declared.",
    TS2307: "Cannot find module — check the import path and that the package is installed.",
    TS7006: "Parameter implicitly has 'any' type — add an explicit type annotation.",
    TS2554: "Wrong number of arguments — verify the function signature.",
    TS2531: "Object is possibly null — add a null check or use optional chaining.",
    TS2532: "Object is possibly undefined — add an undefined check or use optional chaining.",
    TS2366: "Not all code paths return a value — add a return statement or use a union return type.",
  };
  return hints[code];
}
