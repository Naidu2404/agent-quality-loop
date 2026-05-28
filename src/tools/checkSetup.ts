/**
 * check_setup — reports the live status of every quality check.
 *
 * For each check, reports:
 *   • Whether it is enabled in .quality-loop.json
 *   • Whether its required token/tool is present
 *   • Its current state: active | disabled | misconfigured
 *   • Exactly what the user needs to do to enable it (if anything)
 *
 * Shows a clear, colour-coded summary and a `setupPrompt` the agent
 * surfaces to the user so they know precisely what's missing.
 */

import { existsSync } from "fs";
import { execSync } from "child_process";
import { loadConfig } from "../config/loader.js";
import { stackLabel } from "../detector/techStack.js";

export interface CheckSetupInput {
  /** Absolute path to the repo root. Defaults to process.cwd(). */
  cwd?: string;
}

export interface CheckStatusItem {
  check: string;
  state: "active" | "disabled" | "misconfigured";
  enabledInConfig: boolean;
  reason: string;
  action?: string;
}

export interface CheckSetupResult {
  activeCount: number;
  disabledCount: number;
  misconfiguredCount: number;
  checks: CheckStatusItem[];
  /** Compact, agent-surfaceable guide for fixing misconfigured checks */
  setupPrompt: string;
  summary: string;
}

export function checkSetup(input: CheckSetupInput): CheckSetupResult {
  const cwd = input.cwd ?? process.cwd();
  const { config, configPath, stackInfo } = loadConfig(cwd);

  const checks: CheckStatusItem[] = [];

  // ── ESLint ──────────────────────────────────────────────────────────────────
  const eslintEnabled = config.checks.eslint?.enabled !== false;
  const hasEslintConfig =
    existsSync(`${cwd}/.eslintrc.js`) ||
    existsSync(`${cwd}/.eslintrc.cjs`) ||
    existsSync(`${cwd}/.eslintrc.json`) ||
    existsSync(`${cwd}/.eslintrc.yml`) ||
    existsSync(`${cwd}/eslint.config.js`) ||
    existsSync(`${cwd}/eslint.config.mjs`);
  const eslintBinExists = existsSync(`${cwd}/node_modules/.bin/eslint`);

  if (!eslintEnabled) {
    checks.push({ check: "eslint", state: "disabled", enabledInConfig: false, reason: "Disabled in .quality-loop.json" });
  } else if (!hasEslintConfig) {
    checks.push({ check: "eslint", state: "misconfigured", enabledInConfig: true, reason: "No ESLint config found in repo root", action: "Run: npm init @eslint/config — or add .eslintrc.json to the repo root" });
  } else if (!eslintBinExists) {
    checks.push({ check: "eslint", state: "misconfigured", enabledInConfig: true, reason: "ESLint not installed in node_modules", action: "Run: npm install eslint --save-dev" });
  } else {
    checks.push({ check: "eslint", state: "active", enabledInConfig: true, reason: "ESLint config and binary found" });
  }

  // ── TypeScript ──────────────────────────────────────────────────────────────
  const tsEnabled = config.checks.typescript?.enabled !== false && stackInfo.hasTypeScript;
  const hasTsConfig = existsSync(`${cwd}/tsconfig.json`) || existsSync(`${cwd}/tsconfig.app.json`);
  const tsBinExists = existsSync(`${cwd}/node_modules/.bin/tsc`) || existsSync(`${cwd}/node_modules/typescript/bin/tsc`);

  if (!tsEnabled) {
    checks.push({ check: "typescript", state: "disabled", enabledInConfig: false, reason: !stackInfo.hasTypeScript ? "No TypeScript detected in this project" : "Disabled in .quality-loop.json" });
  } else if (!hasTsConfig) {
    checks.push({ check: "typescript", state: "misconfigured", enabledInConfig: true, reason: "No tsconfig.json found", action: "Run: npx tsc --init to generate a tsconfig.json" });
  } else if (!tsBinExists) {
    checks.push({ check: "typescript", state: "misconfigured", enabledInConfig: true, reason: "TypeScript not installed in node_modules", action: "Run: npm install typescript --save-dev" });
  } else {
    checks.push({ check: "typescript", state: "active", enabledInConfig: true, reason: "tsconfig.json and tsc found" });
  }

  // ── Prettier ────────────────────────────────────────────────────────────────
  const prettierEnabled = config.checks.prettier?.enabled !== false && stackInfo.hasPrettier;
  const hasPrettierConfig =
    existsSync(`${cwd}/.prettierrc`) ||
    existsSync(`${cwd}/.prettierrc.json`) ||
    existsSync(`${cwd}/.prettierrc.js`) ||
    existsSync(`${cwd}/.prettierrc.cjs`) ||
    existsSync(`${cwd}/prettier.config.js`);
  const prettierBinExists = existsSync(`${cwd}/node_modules/.bin/prettier`);

  if (!prettierEnabled) {
    checks.push({ check: "prettier", state: "disabled", enabledInConfig: false, reason: !stackInfo.hasPrettier ? "No Prettier detected in this project" : "Disabled in .quality-loop.json" });
  } else if (!hasPrettierConfig) {
    checks.push({ check: "prettier", state: "misconfigured", enabledInConfig: true, reason: "No Prettier config found", action: 'Create a .prettierrc.json with your formatting preferences. Minimal: echo "{}" > .prettierrc.json' });
  } else if (!prettierBinExists) {
    checks.push({ check: "prettier", state: "misconfigured", enabledInConfig: true, reason: "Prettier not installed in node_modules", action: "Run: npm install prettier --save-dev" });
  } else {
    checks.push({ check: "prettier", state: "active", enabledInConfig: true, reason: "Prettier config and binary found" });
  }

  // ── AI analysis ─────────────────────────────────────────────────────────────
  const aiEnabled = config.checks.ai?.enabled === true;
  const aiProvider = config.checks.ai?.provider;

  if (!aiEnabled) {
    checks.push({
      check: "ai (security + sonar-style)",
      state: "disabled",
      enabledInConfig: false,
      reason: "Not enabled in .quality-loop.json",
      action: [
        'Add to .quality-loop.json checks:',
        '"ai": { "enabled": true, "focus": ["security","sonar","dependencies"] }',
        '',
        'Then set ONE of these environment variables depending on which service you use:',
        '  Anthropic (Claude) → export ANTHROPIC_API_KEY="sk-ant-..."   https://console.anthropic.com/settings/keys',
        '  OpenAI             → export OPENAI_API_KEY="sk-..."           https://platform.openai.com/api-keys',
        '  Google Gemini      → export GEMINI_API_KEY="AIza..."          https://aistudio.google.com/app/apikey',
        '  Ollama (local)     → set provider: "ollama" — no key needed, run: ollama pull llama3.2',
        '',
        'The provider is auto-detected from whichever key you set (or set checks.ai.provider explicitly).',
      ].join('\n'),
    });
  } else {
    const aiStatus = resolveAiStatus(aiProvider);
    checks.push({
      check: `ai (security + sonar-style) [${aiStatus.resolvedProvider ?? "auto-detect"}]`,
      state: aiStatus.state,
      enabledInConfig: true,
      reason: aiStatus.reason,
      action: aiStatus.action,
    });
  }

  // ── SonarCloud ──────────────────────────────────────────────────────────────
  const sonarEnabled = config.checks.sonar?.enabled === true;
  const hasSonarToken = !!process.env.SONAR_TOKEN;
  const hasSonarProjectKey = !!(config.checks.sonar?.projectKey ?? process.env.SONAR_PROJECT_KEY);

  if (!sonarEnabled) {
    checks.push({
      check: "sonar",
      state: "disabled",
      enabledInConfig: false,
      reason: "Not enabled in .quality-loop.json",
      action: 'Add to .quality-loop.json checks: "sonar": { "enabled": true, "serverUrl": "https://sonarcloud.io", "projectKey": "your-org_your-repo", "organization": "your-org" }',
    });
  } else if (!hasSonarToken) {
    checks.push({
      check: "sonar",
      state: "misconfigured",
      enabledInConfig: true,
      reason: "SONAR_TOKEN not set in environment",
      action: '1. Go to https://sonarcloud.io/account/security\n   2. Generate a User Token (Execute Analysis permission)\n   3. Add to shell profile: export SONAR_TOKEN="sqp_..."\n   4. Restart your terminal',
    });
  } else if (!hasSonarProjectKey) {
    checks.push({
      check: "sonar",
      state: "misconfigured",
      enabledInConfig: true,
      reason: "Sonar project key not configured",
      action: 'Add projectKey to .quality-loop.json: "sonar": { "enabled": true, "projectKey": "your-org_your-repo" }\n   Or: export SONAR_PROJECT_KEY="your-org_your-repo"',
    });
  } else {
    const serverUrl = config.checks.sonar?.serverUrl ?? "https://sonarcloud.io";
    checks.push({ check: "sonar", state: "active", enabledInConfig: true, reason: `SONAR_TOKEN present, project key configured — fetching from ${serverUrl}` });
  }

  // ── npm audit ───────────────────────────────────────────────────────────────
  const npmAuditEnabled = config.checks.npmAudit?.enabled === true;
  const hasPackageJson = existsSync(`${cwd}/package.json`);
  const hasLockfile =
    existsSync(`${cwd}/package-lock.json`) ||
    existsSync(`${cwd}/yarn.lock`) ||
    existsSync(`${cwd}/pnpm-lock.yaml`) ||
    existsSync(`${cwd}/bun.lockb`);

  if (!npmAuditEnabled) {
    checks.push({
      check: "npm audit",
      state: "disabled",
      enabledInConfig: false,
      reason: "Not enabled in .quality-loop.json",
      action: 'Add to .quality-loop.json checks: "npmAudit": { "enabled": true, "minSeverity": "high" }',
    });
  } else if (!hasPackageJson) {
    checks.push({ check: "npm audit", state: "disabled", enabledInConfig: true, reason: "No package.json — not a Node.js project" });
  } else if (!hasLockfile) {
    checks.push({ check: "npm audit", state: "misconfigured", enabledInConfig: true, reason: "No lockfile found", action: "Run: npm install (to generate package-lock.json) — npm audit requires a lockfile" });
  } else {
    const minSev = config.checks.npmAudit?.minSeverity ?? "high";
    checks.push({ check: "npm audit", state: "active", enabledInConfig: true, reason: `No tokens needed — will report ${minSev}+ CVEs from the npm registry` });
  }

  // ── Dependabot ──────────────────────────────────────────────────────────────
  const dependabotEnabled = config.checks.dependabot?.enabled === true;
  const hasGithubToken = !!process.env.GITHUB_TOKEN;
  const remoteIsGitHub = detectIsGitHub(cwd);

  if (!dependabotEnabled) {
    checks.push({
      check: "dependabot",
      state: "disabled",
      enabledInConfig: false,
      reason: "Not enabled in .quality-loop.json",
      action: 'Add to .quality-loop.json checks: "dependabot": { "enabled": true, "minSeverity": "high" }\n   Owner/repo are auto-detected from git remote — no need to set them manually.',
    });
  } else if (!remoteIsGitHub) {
    checks.push({ check: "dependabot", state: "disabled", enabledInConfig: true, reason: "Git remote is not GitHub — Dependabot alerts are a GitHub feature" });
  } else if (!hasGithubToken) {
    checks.push({
      check: "dependabot",
      state: "misconfigured",
      enabledInConfig: true,
      reason: "GITHUB_TOKEN not set in environment",
      action: '1. Go to https://github.com/settings/tokens (Fine-grained tokens → New token)\n   2. Set permissions: Security events = Read-only\n   3. Add to shell profile: export GITHUB_TOKEN="github_pat_..."\n   4. Restart your terminal\n   Note: In GitHub Actions, use ${{ secrets.GITHUB_TOKEN }} — no setup needed.',
    });
  } else {
    checks.push({ check: "dependabot", state: "active", enabledInConfig: true, reason: "GITHUB_TOKEN present — will fetch open Dependabot alerts from GitHub" });
  }

  // ── Compute totals ──────────────────────────────────────────────────────────
  const activeCount = checks.filter((c) => c.state === "active").length;
  const disabledCount = checks.filter((c) => c.state === "disabled").length;
  const misconfiguredCount = checks.filter((c) => c.state === "misconfigured").length;

  const setupPrompt = buildSetupPrompt(checks, configPath, stackLabel(stackInfo));
  const summary = buildSummary(checks, activeCount, disabledCount, misconfiguredCount, configPath, stackLabel(stackInfo));

  return { activeCount, disabledCount, misconfiguredCount, checks, setupPrompt, summary };
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildSetupPrompt(checks: CheckStatusItem[], configPath: string | null, stack: string): string {
  const misconfigured = checks.filter((c) => c.state === "misconfigured");
  const disabled = checks.filter((c) => c.state === "disabled");

  if (misconfigured.length === 0 && disabled.length === 0) {
    return "✅ All checks are active — no setup needed.";
  }

  const lines: string[] = [];
  lines.push(`SETUP REQUIRED — ${misconfigured.length} check(s) misconfigured, ${disabled.length} check(s) disabled. Stack: ${stack}`);
  lines.push(`Config: ${configPath ?? "auto-detected defaults (no .quality-loop.json found)"}`);
  lines.push("");

  if (misconfigured.length > 0) {
    lines.push("## ACTION REQUIRED — fix these to enable the checks");
    lines.push("");
    for (const item of misconfigured) {
      lines.push(`### ${item.check}`);
      lines.push(`Problem: ${item.reason}`);
      if (item.action) {
        lines.push(`Fix:`);
        for (const line of item.action.split("\n")) lines.push(`  ${line}`);
      }
      lines.push("");
    }
  }

  if (disabled.length > 0) {
    lines.push("## OPTIONAL — enable these checks for broader coverage");
    lines.push("");
    for (const item of disabled) {
      lines.push(`### ${item.check}`);
      lines.push(`Status: ${item.reason}`);
      if (item.action) {
        lines.push(`To enable:`);
        for (const line of item.action.split("\n")) lines.push(`  ${line}`);
      }
      lines.push("");
    }
  }

  lines.push("After making changes, call check_setup again to confirm all checks are active.");
  return lines.join("\n");
}

function buildSummary(
  checks: CheckStatusItem[],
  activeCount: number,
  disabledCount: number,
  misconfiguredCount: number,
  configPath: string | null,
  stack: string
): string {
  const lines: string[] = [];
  lines.push(`## Quality Loop — Check Status`);
  lines.push(`**Stack:** ${stack}`);
  lines.push(`**Config:** ${configPath ?? "auto-detected defaults"}`);
  lines.push("");
  lines.push(`**${activeCount} active · ${misconfiguredCount} misconfigured · ${disabledCount} disabled**`);
  lines.push("");

  for (const item of checks) {
    const icon = item.state === "active" ? "✅" : item.state === "misconfigured" ? "⚠️ " : "○ ";
    const label = item.state === "active" ? "ACTIVE" : item.state === "misconfigured" ? "NEEDS SETUP" : "DISABLED";
    lines.push(`${icon} **${item.check}** — ${label}`);
    lines.push(`   ${item.reason}`);
    if (item.action && item.state === "misconfigured") {
      lines.push(`   → Fix: ${item.action.split("\n")[0]}`);
    }
  }

  if (misconfiguredCount > 0) {
    lines.push("");
    lines.push("**Next step:** Read `setupPrompt` — it has the exact commands to fix each misconfigured check.");
  } else if (disabledCount > 0) {
    lines.push("");
    lines.push("**Tip:** Some checks are disabled. Read `setupPrompt` to see how to enable them.");
  } else {
    lines.push("");
    lines.push("**All configured checks are active.** The quality loop is fully operational.");
  }

  return lines.join("\n");
}

// ─── AI provider status helper ────────────────────────────────────────────────

function resolveAiStatus(configuredProvider?: string): {
  state: "active" | "misconfigured";
  resolvedProvider: string | null;
  reason: string;
  action?: string;
} {
  // If a provider is explicitly configured, check only that one
  if (configuredProvider) {
    switch (configuredProvider) {
      case "anthropic":
        if (process.env.ANTHROPIC_API_KEY) {
          return { state: "active", resolvedProvider: "anthropic", reason: "ANTHROPIC_API_KEY present — Claude Haiku will analyse on iteration 1" };
        }
        return {
          state: "misconfigured", resolvedProvider: "anthropic",
          reason: 'provider set to "anthropic" but ANTHROPIC_API_KEY is not in environment',
          action: '1. Get your key at https://console.anthropic.com/settings/keys\n   2. export ANTHROPIC_API_KEY="sk-ant-..."\n   3. source ~/.zshrc',
        };

      case "openai":
        if (process.env.OPENAI_API_KEY) {
          return { state: "active", resolvedProvider: "openai", reason: "OPENAI_API_KEY present — GPT-4o-mini will analyse on iteration 1" };
        }
        return {
          state: "misconfigured", resolvedProvider: "openai",
          reason: 'provider set to "openai" but OPENAI_API_KEY is not in environment',
          action: '1. Get your key at https://platform.openai.com/api-keys\n   2. export OPENAI_API_KEY="sk-..."\n   3. source ~/.zshrc',
        };

      case "gemini":
        if (process.env.GEMINI_API_KEY) {
          return { state: "active", resolvedProvider: "gemini", reason: "GEMINI_API_KEY present — Gemini 1.5 Flash will analyse on iteration 1" };
        }
        return {
          state: "misconfigured", resolvedProvider: "gemini",
          reason: 'provider set to "gemini" but GEMINI_API_KEY is not in environment',
          action: '1. Get your key at https://aistudio.google.com/app/apikey\n   2. export GEMINI_API_KEY="AIza..."\n   3. source ~/.zshrc',
        };

      case "ollama":
        return {
          state: "active", resolvedProvider: "ollama",
          reason: 'Using Ollama (local) — no API key needed. Ensure Ollama is running: ollama serve',
        };
    }
  }

  // Auto-detect from environment
  if (process.env.ANTHROPIC_API_KEY) {
    return { state: "active", resolvedProvider: "anthropic (auto-detected)", reason: "ANTHROPIC_API_KEY found — Claude Haiku will be used" };
  }
  if (process.env.OPENAI_API_KEY) {
    return { state: "active", resolvedProvider: "openai (auto-detected)", reason: "OPENAI_API_KEY found — GPT-4o-mini will be used" };
  }
  if (process.env.GEMINI_API_KEY) {
    return { state: "active", resolvedProvider: "gemini (auto-detected)", reason: "GEMINI_API_KEY found — Gemini 1.5 Flash will be used" };
  }

  return {
    state: "misconfigured", resolvedProvider: null,
    reason: "No AI provider key found in environment",
    action: [
      'Set ONE of these in your shell profile (~/.zshrc or ~/.bashrc):',
      '  Anthropic (Claude) → export ANTHROPIC_API_KEY="sk-ant-..."   https://console.anthropic.com/settings/keys',
      '  OpenAI             → export OPENAI_API_KEY="sk-..."           https://platform.openai.com/api-keys',
      '  Google Gemini      → export GEMINI_API_KEY="AIza..."          https://aistudio.google.com/app/apikey',
      '  Ollama (local, free) → set checks.ai.provider: "ollama" in .quality-loop.json, then: ollama pull llama3.2',
      '',
      'The provider is auto-detected from whichever key you set first.',
    ].join('\n'),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function detectIsGitHub(cwd: string): boolean {
  try {
    const remoteUrl = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return remoteUrl.includes("github.com");
  } catch {
    return false;
  }
}
