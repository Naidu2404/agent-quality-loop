/**
 * SonarCloud / SonarQube integration.
 * Fetches open issues for the changed files from Sonar's REST API.
 *
 * Requires:
 *   SONAR_TOKEN   — user/service token with project browse permission
 *   SONAR_PROJECT_KEY — project key in Sonar (or set in .quality-loop.json checks.sonar.projectKey)
 *
 * Optional:
 *   SONAR_SERVER_URL — defaults to https://sonarcloud.io
 *   SONAR_ORGANIZATION — SonarCloud org slug (required for SonarCloud, not SonarQube)
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { Issue, SonarCheckConfig } from "../types.js";

interface CheckResult {
  issues: Issue[];
  skipped: boolean;
  skipReason?: string;
}

interface SonarIssue {
  key: string;
  rule: string;
  severity: "BLOCKER" | "CRITICAL" | "MAJOR" | "MINOR" | "INFO";
  component: string;
  line?: number;
  message: string;
  type: "BUG" | "VULNERABILITY" | "CODE_SMELL" | "SECURITY_HOTSPOT";
  textRange?: { startLine: number };
}

interface SonarResponse {
  issues: SonarIssue[];
  paging: { total: number };
}

export async function runSonarCheck(
  files: string[],
  cwd: string,
  config: SonarCheckConfig
): Promise<CheckResult> {
  const token = process.env.SONAR_TOKEN;
  if (!token) {
    return { issues: [], skipped: true, skipReason: "SONAR_TOKEN not set in environment" };
  }

  const projectKey = config.projectKey ?? process.env.SONAR_PROJECT_KEY;
  if (!projectKey) {
    return { issues: [], skipped: true, skipReason: "Sonar projectKey not configured (set checks.sonar.projectKey in .quality-loop.json or SONAR_PROJECT_KEY env var)" };
  }

  const serverUrl = (config.serverUrl ?? process.env.SONAR_SERVER_URL ?? "https://sonarcloud.io").replace(/\/$/, "");
  const organization = config.organization ?? process.env.SONAR_ORGANIZATION;

  // Build Sonar component paths from our relative file paths
  // Sonar uses "projectKey:src/path/to/file.ts" format
  const componentPaths = files
    .filter((f) => /\.(ts|tsx|vue|js|jsx|java|py|go|cs|rb|php)$/.test(f))
    .map((f) => `${projectKey}:${f}`);

  if (componentPaths.length === 0) {
    return { issues: [], skipped: true, skipReason: "No eligible files to check against Sonar" };
  }

  try {
    const allIssues: Issue[] = [];
    // Sonar API allows max 20 component paths per request — batch them
    const batches = chunk(componentPaths, 20);

    for (const batch of batches) {
      const params = new URLSearchParams({
        componentKeys: batch.join(","),
        resolved: "false",
        statuses: "OPEN,CONFIRMED,REOPENED",
        ps: "100", // page size
      });
      if (organization) params.set("organization", organization);

      const url = `${serverUrl}/api/issues/search?${params}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          return { issues: [], skipped: true, skipReason: "SONAR_TOKEN is invalid or expired" };
        }
        if (response.status === 404) {
          return { issues: [], skipped: true, skipReason: `Sonar project "${projectKey}" not found on ${serverUrl}` };
        }
        return { issues: [], skipped: true, skipReason: `Sonar API error: HTTP ${response.status}` };
      }

      const data = await response.json() as SonarResponse;

      for (const si of data.issues ?? []) {
        const line = si.line ?? si.textRange?.startLine ?? 1;
        const relPath = si.component.replace(`${projectKey}:`, "");
        allIssues.push({
          path: relPath,
          line,
          severity: mapSonarSeverity(si.severity, si.type),
          category: mapSonarType(si.type),
          ruleId: `sonar/${si.rule}`,
          message: si.message,
          fixHint: buildSonarFixHint(si),
          sourceLine: getSourceLine(relPath, cwd, line),
        });
      }
    }

    return { issues: allIssues, skipped: false };
  } catch (err) {
    return { issues: [], skipped: true, skipReason: `Sonar API unreachable: ${String(err).slice(0, 200)}` };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mapSonarSeverity(
  severity: SonarIssue["severity"],
  type: SonarIssue["type"]
): Issue["severity"] {
  if (type === "VULNERABILITY" || type === "SECURITY_HOTSPOT") return "error";
  if (severity === "BLOCKER" || severity === "CRITICAL") return "error";
  if (severity === "MAJOR") return "warning";
  return "info";
}

function mapSonarType(type: SonarIssue["type"]): Issue["category"] {
  if (type === "VULNERABILITY" || type === "SECURITY_HOTSPOT") return "policy";
  if (type === "BUG") return "lint";
  return "custom";
}

function buildSonarFixHint(si: SonarIssue): string {
  if (si.type === "VULNERABILITY") return `Fix this vulnerability (${si.rule}). Review Sonar's remediation guidance.`;
  if (si.type === "SECURITY_HOTSPOT") return `Verify this security hotspot (${si.rule}) — it may require human review.`;
  if (si.type === "BUG") return `Fix this bug (${si.rule}) — it may cause incorrect behaviour at runtime.`;
  return `Address this code smell (${si.rule}) to improve maintainability.`;
}

function getSourceLine(relPath: string, cwd: string, line: number): string | undefined {
  try {
    const abs = relPath.startsWith("/") ? relPath : join(cwd, relPath);
    if (!existsSync(abs)) return undefined;
    const lines = readFileSync(abs, "utf8").split("\n");
    return lines[line - 1] ?? undefined;
  } catch {
    return undefined;
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}
