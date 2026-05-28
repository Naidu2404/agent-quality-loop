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

// ─── Live API verifiers ───────────────────────────────────────────────────────

async function verifyAiKey(
  provider: string,
  key: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 401) return { ok: false, error: "Invalid API key — check the key and try again" };
      return { ok: res.ok || res.status === 529 }; // 529 = overloaded but key is valid
    }

    if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 401) return { ok: false, error: "Invalid API key" };
      return { ok: res.ok };
    }

    if (provider === "gemini") {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (res.status === 400 || res.status === 403) return { ok: false, error: "Invalid API key" };
      return { ok: res.ok };
    }

    if (provider === "groq") {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 401) return { ok: false, error: "Invalid API key" };
      return { ok: res.ok };
    }

    if (provider === "ollama") {
      const res = await fetch("http://localhost:11434/api/tags", {
        signal: AbortSignal.timeout(3000),
      });
      return { ok: res.ok, error: res.ok ? undefined : "Ollama is not running — start with: ollama serve" };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: `Could not reach ${provider} API — check network connection` };
  }
}

async function verifySonarToken(
  token: string,
  serverUrl: string
): Promise<{ ok: boolean; error?: string }> {
  // SonarCloud/SonarQube uses HTTP Basic auth — token as username, empty password.
  // Bearer auth is NOT accepted by /api/authentication/validate and returns valid:false.
  const basicCredentials = Buffer.from(`${token}:`).toString("base64");
  try {
    const res = await fetch(`${serverUrl}/api/authentication/validate`, {
      headers: { Authorization: `Basic ${basicCredentials}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) return { ok: false, error: "Token rejected (401) — regenerate at sonarcloud.io/account/security" };
    const data = await res.json() as { valid?: boolean };
    if (data.valid === false) return { ok: false, error: "SonarCloud reports token as invalid — regenerate at sonarcloud.io/account/security" };
    return { ok: true };
  } catch {
    return { ok: false, error: `Could not reach ${serverUrl} — check network or server URL` };
  }
}

async function verifyGithubToken(
  token: string
): Promise<{ ok: boolean; error?: string; rateLimit?: string }> {
  try {
    const res = await fetch("https://api.github.com/rate_limit", {
      headers: { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) return { ok: false, error: "Invalid token — regenerate at github.com/settings/tokens" };
    if (res.status === 403) return { ok: false, error: "Token lacks required permissions (need: security_events: read)" };
    const data = await res.json() as { resources?: { core?: { remaining: number; limit: number } } };
    const core = data.resources?.core;
    const rateLimit = core ? `${core.remaining}/${core.limit} requests remaining` : undefined;
    return { ok: res.ok, rateLimit };
  } catch {
    return { ok: false, error: "Could not reach api.github.com — check network connection" };
  }
}

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

export async function checkSetup(input: CheckSetupInput): Promise<CheckSetupResult> {
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
        'Then set an API key (Groq is free — recommended):',
        '  export GROQ_API_KEY="gsk_..."         # https://console.groq.com/keys (free tier)',
        '  export ANTHROPIC_API_KEY="sk-ant-..."  # https://console.anthropic.com/settings/keys',
        '  export OPENAI_API_KEY="sk-..."          # https://platform.openai.com/api-keys',
        '  export GEMINI_API_KEY="AIza..."         # https://aistudio.google.com/app/apikey (free)',
        '  — or run: npx agent-quality-loop --configure',
      ].join('\n'),
    });
  } else {
    const aiStatus = await resolveAiStatus(aiProvider);
    checks.push({
      check: `ai [${aiStatus.resolvedProvider ?? "built-in ollama"}]`,
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
    const sonarVerify = await verifySonarToken(process.env.SONAR_TOKEN!, serverUrl);
    if (sonarVerify.ok) {
      checks.push({ check: "sonar", state: "active", enabledInConfig: true, reason: `✓ Token verified — connected to ${serverUrl}` });
    } else {
      checks.push({
        check: "sonar", state: "misconfigured", enabledInConfig: true,
        reason: `SONAR_TOKEN present but verification failed: ${sonarVerify.error}`,
        action: `1. Go to ${serverUrl}/account/security and generate a new token\n   2. Update the SONAR_TOKEN value in .quality-loop.json under "credentials"`,
      });
    }
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
    const ghVerify = await verifyGithubToken(process.env.GITHUB_TOKEN!);
    if (ghVerify.ok) {
      const rl = ghVerify.rateLimit ? ` (${ghVerify.rateLimit})` : "";
      checks.push({ check: "dependabot", state: "active", enabledInConfig: true, reason: `✓ Token verified — connected to GitHub API${rl}` });
    } else {
      checks.push({
        check: "dependabot", state: "misconfigured", enabledInConfig: true,
        reason: `GITHUB_TOKEN present but verification failed: ${ghVerify.error}`,
        action: '1. Go to https://github.com/settings/tokens → Fine-grained tokens → New token\n   2. Set permissions: Security events = Read-only\n   3. export GITHUB_TOKEN="github_pat_..."\n   4. source ~/.zshrc',
      });
    }
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

async function resolveAiStatus(configuredProvider?: string): Promise<{
  state: "active" | "misconfigured";
  resolvedProvider: string | null;
  reason: string;
  action?: string;
}> {
  // Helper: verify + build result for a key-based provider
  async function checkKeyed(
    provider: "anthropic" | "openai" | "gemini" | "groq",
    envVar: string,
    label: string,
    link: string,
    exportExample: string
  ) {
    const key = process.env[envVar];
    if (!key) {
      return {
        state: "misconfigured" as const, resolvedProvider: provider,
        reason: `provider set to "${provider}" but ${envVar} is not in environment`,
        action: `1. Get your key at ${link}\n   2. export ${envVar}="${exportExample}"\n   3. source ~/.zshrc`,
      };
    }
    const v = await verifyAiKey(provider, key);
    if (!v.ok) {
      return {
        state: "misconfigured" as const, resolvedProvider: provider,
        reason: `${envVar} is set but API rejected it: ${v.error}`,
        action: `1. Get a new key at ${link}\n   2. export ${envVar}="${exportExample}"\n   3. source ~/.zshrc`,
      };
    }
    return { state: "active" as const, resolvedProvider: provider, reason: `✓ ${envVar} verified — ${label} ready` };
  }

  // Explicitly configured provider
  if (configuredProvider) {
    if (configuredProvider === "anthropic") {
      return checkKeyed("anthropic", "ANTHROPIC_API_KEY", "Claude Haiku", "https://console.anthropic.com/settings/keys", "sk-ant-...");
    }
    if (configuredProvider === "openai") {
      return checkKeyed("openai", "OPENAI_API_KEY", "GPT-4o-mini", "https://platform.openai.com/api-keys", "sk-...");
    }
    if (configuredProvider === "gemini") {
      return checkKeyed("gemini", "GEMINI_API_KEY", "Gemini 1.5 Flash", "https://aistudio.google.com/app/apikey", "AIza...");
    }
    if (configuredProvider === "groq") {
      return checkKeyed("groq", "GROQ_API_KEY", "Groq llama-3.1-8b-instant", "https://console.groq.com/keys", "gsk_...");
    }
    if (configuredProvider === "ollama") {
      const v = await verifyAiKey("ollama", "");
      return {
        state: v.ok ? "active" : "misconfigured",
        resolvedProvider: "ollama",
        reason: v.ok
          ? "✓ Ollama is running locally — llama3.2 will be used"
          : "Ollama not running — start it with: ollama serve",
        action: v.ok ? undefined : "1. Install Ollama: https://ollama.com/download\n   2. Run: ollama pull llama3.2\n   3. Run: ollama serve",
      };
    }
  }

  // Auto-detect: try each key in priority order, live-verify each one
  if (process.env.ANTHROPIC_API_KEY) {
    const v = await verifyAiKey("anthropic", process.env.ANTHROPIC_API_KEY);
    if (v.ok) return { state: "active", resolvedProvider: "anthropic (auto-detected)", reason: "✓ ANTHROPIC_API_KEY verified — Claude Haiku will be used" };
    return { state: "misconfigured", resolvedProvider: "anthropic", reason: `ANTHROPIC_API_KEY set but invalid: ${v.error}`, action: "Get a new key at https://console.anthropic.com/settings/keys" };
  }
  if (process.env.OPENAI_API_KEY) {
    const v = await verifyAiKey("openai", process.env.OPENAI_API_KEY);
    if (v.ok) return { state: "active", resolvedProvider: "openai (auto-detected)", reason: "✓ OPENAI_API_KEY verified — GPT-4o-mini will be used" };
    return { state: "misconfigured", resolvedProvider: "openai", reason: `OPENAI_API_KEY set but invalid: ${v.error}`, action: "Get a new key at https://platform.openai.com/api-keys" };
  }
  if (process.env.GEMINI_API_KEY) {
    const v = await verifyAiKey("gemini", process.env.GEMINI_API_KEY);
    if (v.ok) return { state: "active", resolvedProvider: "gemini (auto-detected)", reason: "✓ GEMINI_API_KEY verified — Gemini 1.5 Flash will be used" };
    return { state: "misconfigured", resolvedProvider: "gemini", reason: `GEMINI_API_KEY set but invalid: ${v.error}`, action: "Get a new key at https://aistudio.google.com/app/apikey" };
  }
  if (process.env.GROQ_API_KEY) {
    const v = await verifyAiKey("groq", process.env.GROQ_API_KEY);
    if (v.ok) return { state: "active", resolvedProvider: "groq (auto-detected)", reason: "✓ GROQ_API_KEY verified — llama-3.1-8b-instant (free tier) will be used" };
    return { state: "misconfigured", resolvedProvider: "groq", reason: `GROQ_API_KEY set but invalid: ${v.error}`, action: "Get a new free key at https://console.groq.com/keys" };
  }

  // No key configured — AI analysis will be skipped
  return {
    state: "misconfigured",
    resolvedProvider: null,
    reason: "No AI provider key set — AI security analysis is disabled",
    action: [
      "Get a free Groq API key (no installation, generous free tier):",
      "  1. Sign up at https://console.groq.com",
      "  2. Go to https://console.groq.com/keys → Create API Key",
      '  3. export GROQ_API_KEY="gsk_..."',
      "  4. source ~/.zshrc",
      "  — or run: npx agent-quality-loop --configure",
    ].join("\n"),
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
