/**
 * npm audit integration.
 * Runs `npm audit --json` in the project root and maps known CVEs to Issues.
 * Works for any project that has a package-lock.json or yarn.lock.
 *
 * No tokens required — uses the public npm registry vulnerability database.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import type { Issue, NpmAuditCheckConfig } from "../types.js";

interface CheckResult {
  issues: Issue[];
  skipped: boolean;
  skipReason?: string;
}

type AuditSeverity = "critical" | "high" | "moderate" | "low" | "info";

interface NpmAuditVulnerability {
  name: string;
  severity: AuditSeverity;
  isDirect: boolean;
  via: (string | { source: number; name: string; dependency: string; title: string; url: string; severity: AuditSeverity; range: string })[];
  effects: string[];
  range: string;
  fixAvailable: boolean | { name: string; version: string; isSemVerMajor: boolean };
}

interface NpmAuditOutput {
  auditReportVersion: number;
  vulnerabilities: Record<string, NpmAuditVulnerability>;
  metadata: {
    vulnerabilities: {
      critical: number;
      high: number;
      moderate: number;
      low: number;
      info: number;
      total: number;
    };
  };
}

const SEVERITY_ORDER: AuditSeverity[] = ["critical", "high", "moderate", "low", "info"];

export function runNpmAudit(
  cwd: string,
  config: NpmAuditCheckConfig
): CheckResult {
  // Check if this is a Node.js project
  if (!existsSync(`${cwd}/package.json`)) {
    return { issues: [], skipped: true, skipReason: "No package.json found — not a Node.js project" };
  }

  const lockExists =
    existsSync(`${cwd}/package-lock.json`) ||
    existsSync(`${cwd}/yarn.lock`) ||
    existsSync(`${cwd}/pnpm-lock.yaml`) ||
    existsSync(`${cwd}/bun.lockb`);

  if (!lockExists) {
    return { issues: [], skipped: true, skipReason: "No lockfile found — run npm install first" };
  }

  const minSeverity = config.minSeverity ?? "high";
  const minIndex = SEVERITY_ORDER.indexOf(minSeverity);

  try {
    const raw = execSync("npm audit --json 2>/dev/null || true", {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    });

    let audit: NpmAuditOutput;
    try {
      audit = JSON.parse(raw);
    } catch {
      return { issues: [], skipped: true, skipReason: "Could not parse npm audit output" };
    }

    if (!audit.vulnerabilities || Object.keys(audit.vulnerabilities).length === 0) {
      return { issues: [], skipped: false };
    }

    const issues: Issue[] = [];

    for (const [pkgName, vuln] of Object.entries(audit.vulnerabilities)) {
      const sevIndex = SEVERITY_ORDER.indexOf(vuln.severity);
      if (sevIndex > minIndex) continue; // below threshold

      // Extract CVE/advisory details from `via`
      const viaDetails = vuln.via
        .filter((v): v is Exclude<typeof v, string> => typeof v === "object")
        .slice(0, 2); // cap at 2 advisories per package for brevity

      for (const advisory of viaDetails.length > 0 ? viaDetails : [{ title: `Vulnerability in ${pkgName}`, url: "", severity: vuln.severity }]) {
        const title = "title" in advisory ? advisory.title : `Vulnerability in ${pkgName}`;
        const url = "url" in advisory ? advisory.url : "";

        const fixInfo = typeof vuln.fixAvailable === "object"
          ? `Run: npm install ${vuln.fixAvailable.name}@${vuln.fixAvailable.version}${vuln.fixAvailable.isSemVerMajor ? " (major version bump — review breaking changes)" : ""}`
          : vuln.fixAvailable
          ? `Run: npm audit fix`
          : `No automatic fix available — consider replacing ${pkgName} or adding a manual patch`;

        issues.push({
          path: "package.json",
          line: 1,
          severity: vuln.severity === "critical" || vuln.severity === "high" ? "error" : "warning",
          category: "policy",
          ruleId: `npm-audit/${pkgName}`,
          message: `[${vuln.severity.toUpperCase()}] ${title} in ${pkgName}@${vuln.range}${url ? ` — ${url}` : ""}`,
          fixHint: fixInfo,
        });
      }

      // If no via details, emit one issue for the package itself
      if (viaDetails.length === 0 && vuln.via.every((v) => typeof v === "string")) {
        issues.push({
          path: "package.json",
          line: 1,
          severity: vuln.severity === "critical" || vuln.severity === "high" ? "error" : "warning",
          category: "policy",
          ruleId: `npm-audit/${pkgName}`,
          message: `[${vuln.severity.toUpperCase()}] ${pkgName}@${vuln.range} is vulnerable (via: ${(vuln.via as string[]).join(", ")})`,
          fixHint: typeof vuln.fixAvailable === "object"
            ? `Run: npm install ${vuln.fixAvailable.name}@${vuln.fixAvailable.version}`
            : vuln.fixAvailable ? "Run: npm audit fix" : `No automatic fix — review ${pkgName} usage`,
        });
      }
    }

    return { issues, skipped: false };
  } catch (err) {
    return { issues: [], skipped: true, skipReason: `npm audit failed: ${String(err).slice(0, 200)}` };
  }
}
