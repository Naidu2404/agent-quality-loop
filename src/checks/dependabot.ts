/**
 * GitHub Dependabot alert integration.
 * Fetches open security alerts from the GitHub Security API.
 *
 * Requires:
 *   GITHUB_TOKEN — PAT or Actions token with `security_events` read scope
 *
 * Owner and repo are auto-detected from `git remote get-url origin` if not set in config.
 */

import { execSync } from "child_process";
import type { Issue, DependabotCheckConfig } from "../types.js";

interface CheckResult {
  issues: Issue[];
  skipped: boolean;
  skipReason?: string;
}

type DependabotSeverity = "critical" | "high" | "medium" | "low";

interface DependabotAlert {
  number: number;
  state: "open" | "dismissed" | "fixed" | "auto_dismissed";
  dependency: {
    package: { ecosystem: string; name: string };
    manifest_path: string;
    scope: "runtime" | "development" | null;
  };
  security_advisory: {
    ghsa_id: string;
    cve_id: string | null;
    summary: string;
    description: string;
    severity: DependabotSeverity;
    cvss: { score: number; vector_string: string | null };
    references: { url: string }[];
  };
  security_vulnerability: {
    package: { ecosystem: string; name: string };
    severity: DependabotSeverity;
    vulnerable_version_range: string;
    first_patched_version: { identifier: string } | null;
  };
  html_url: string;
}

const SEVERITY_ORDER: DependabotSeverity[] = ["critical", "high", "medium", "low"];
const GITHUB_API = "https://api.github.com";

export async function runDependabotCheck(
  cwd: string,
  config: DependabotCheckConfig
): Promise<CheckResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { issues: [], skipped: true, skipReason: "GITHUB_TOKEN not set in environment" };
  }

  // Auto-detect owner/repo from git remote if not in config
  let owner = config.owner;
  let repo = config.repo;

  if (!owner || !repo) {
    const detected = detectGitHubRemote(cwd);
    if (!detected) {
      return { issues: [], skipped: true, skipReason: "Could not detect GitHub owner/repo from git remote. Set checks.dependabot.owner and .repo in .quality-loop.json" };
    }
    owner = owner ?? detected.owner;
    repo = repo ?? detected.repo;
  }

  const minSeverity = config.minSeverity ?? "high";
  const minIndex = SEVERITY_ORDER.indexOf(minSeverity);

  try {
    const url = `${GITHUB_API}/repos/${owner}/${repo}/dependabot/alerts?state=open&per_page=100`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return { issues: [], skipped: true, skipReason: "GITHUB_TOKEN is invalid or expired" };
      }
      if (response.status === 403) {
        return { issues: [], skipped: true, skipReason: "GITHUB_TOKEN lacks 'security_events' read scope — regenerate with that permission" };
      }
      if (response.status === 404) {
        return { issues: [], skipped: true, skipReason: `GitHub repo "${owner}/${repo}" not found or Dependabot alerts not enabled` };
      }
      return { issues: [], skipped: true, skipReason: `GitHub API error: HTTP ${response.status}` };
    }

    const alerts = await response.json() as DependabotAlert[];
    const issues: Issue[] = [];

    for (const alert of alerts) {
      if (alert.state !== "open") continue;

      const sev = alert.security_vulnerability.severity;
      const sevIndex = SEVERITY_ORDER.indexOf(sev);
      if (sevIndex > minIndex) continue; // below threshold

      const advisory = alert.security_advisory;
      const vuln = alert.security_vulnerability;
      const dep = alert.dependency;

      const patchedVersion = vuln.first_patched_version?.identifier;
      const pkgName = dep.package.name;
      const manifestPath = dep.manifest_path || "package.json";
      const cvssScore = advisory.cvss?.score ? ` (CVSS ${advisory.cvss.score})` : "";
      const cveId = advisory.cve_id ? ` ${advisory.cve_id}` : "";

      const fixHint = patchedVersion
        ? `Upgrade ${pkgName} to ≥ ${patchedVersion}. Run: npm install ${pkgName}@${patchedVersion}`
        : `No patch available yet for ${pkgName}. Monitor ${advisory.ghsa_id} for updates or consider an alternative package.`;

      issues.push({
        path: manifestPath,
        line: 1,
        severity: sev === "critical" || sev === "high" ? "error" : "warning",
        category: "policy",
        ruleId: `dependabot/${advisory.ghsa_id}`,
        message: `[${sev.toUpperCase()}${cveId}] ${advisory.summary} in ${pkgName}@${vuln.vulnerable_version_range}${cvssScore}. ${alert.html_url}`,
        fixHint,
      });
    }

    return { issues, skipped: false };
  } catch (err) {
    return { issues: [], skipped: true, skipReason: `GitHub Dependabot API unreachable: ${String(err).slice(0, 200)}` };
  }
}

// ─── Auto-detect GitHub remote ────────────────────────────────────────────────

function detectGitHubRemote(cwd: string): { owner: string; repo: string } | null {
  try {
    const remoteUrl = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // HTTPS: https://github.com/owner/repo.git
    const httpsMatch = remoteUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

    // SSH: git@github.com:owner/repo.git
    const sshMatch = remoteUrl.match(/git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

    return null;
  } catch {
    return null;
  }
}
