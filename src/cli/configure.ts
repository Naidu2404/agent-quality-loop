/**
 * Interactive configuration wizard for agent-quality-loop.
 *
 * Usage:
 *   npx agent-quality-loop --configure
 *
 * AI analysis works out of the box — the MCP downloads and manages Ollama
 * internally. This wizard only collects the two optional tokens that connect
 * to external services: SonarCloud and GitHub Dependabot.
 *
 * All output goes to stderr — stdout is reserved for MCP stdio protocol.
 */

import * as readline from "readline";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GlobalConfig {
  GROQ_API_KEY?: string;
  SONAR_TOKEN?: string;
  SONAR_PROJECT_KEY?: string;
  GITHUB_TOKEN?: string;
  /** Legacy AI key fields — kept for backward compat, still injected into env */
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".agent-quality-loop.json");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const out = (s = "") => process.stderr.write(s + "\n");
const outNoNl = (s: string) => process.stderr.write(s);

function readGlobalConfig(): GlobalConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as GlobalConfig;
  } catch {
    return {};
  }
}

function saveGlobalConfig(config: GlobalConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function createReadline(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
}

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

// ─── Token testers ────────────────────────────────────────────────────────────

async function testGroqKey(key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) return { ok: false, error: "Key rejected by Groq — check it was copied correctly" };
    return { ok: res.ok };
  } catch {
    return { ok: false, error: "Could not reach api.groq.com — check your connection" };
  }
}

async function testSonarToken(token: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("https://sonarcloud.io/api/authentication/validate", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json() as { valid?: boolean };
    if (data.valid === false) return { ok: false, error: "SonarCloud rejected the token" };
    return { ok: res.ok };
  } catch {
    return { ok: false, error: "Could not reach sonarcloud.io — check your connection" };
  }
}

async function testGithubToken(token: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.github.com/rate_limit", {
      headers: { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) return { ok: false, error: "Token rejected by GitHub" };
    if (res.status === 403) return { ok: false, error: "Token lacks required scope (security_events: read)" };
    return { ok: res.ok };
  } catch {
    return { ok: false, error: "Could not reach api.github.com — check your connection" };
  }
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

export async function runConfigure(): Promise<void> {
  const rl = createReadline();
  const existing = readGlobalConfig();

  out();
  out(`  ╔═══════════════════════════════════════════════════╗`);
  out(`  ║   agent-quality-loop — Quick Setup Wizard         ║`);
  out(`  ╚═══════════════════════════════════════════════════╝`);
  out();
  out(`  This wizard configures three optional integrations:`);
  out(`    • Groq API key    — free AI security analysis (recommended)`);
  out(`    • SonarCloud      — live issue scanning`);
  out(`    • GitHub          — Dependabot security alerts`);
  out();
  out(`  Config saved to: ${CONFIG_PATH}`);
  out(`  No shell profile editing needed.`);
  out();

  // ── Step 1: GROQ_API_KEY ──────────────────────────────────────────────────
  out(`  ─── Step 1: Groq AI (recommended — free) ──────────`);
  out();
  out(`  Enables AI-powered security analysis (no download, no installation).`);
  out(`  Groq's free tier has generous limits — enough for continuous reviews.`);
  out();
  out(`  How to get it:`);
  out(`    1. Open: https://console.groq.com/keys`);
  out(`    2. Sign up free — no credit card needed`);
  out(`    3. Click "Create API Key"`);
  out(`    4. Copy the key (starts with gsk_)`);
  out();

  const existingGroq = existing.GROQ_API_KEY;
  const groqHint = existingGroq
    ? ` (Enter to keep ${existingGroq.slice(0, 8)}...)`
    : " (Enter to skip)";

  const groqInput = await prompt(rl, `  Paste GROQ_API_KEY${groqHint}: `);
  const groqKey = groqInput || existingGroq || null;

  if (groqInput) {
    outNoNl(`  Verifying... `);
    const { ok, error } = await testGroqKey(groqInput);
    out(ok ? "✓ Connected to Groq! AI analysis is ready." : `⚠  ${error ?? "Could not verify"} — saving anyway`);
  } else if (!groqKey) {
    out(`  Skipped — AI security analysis will not run.`);
  } else {
    out(`  → Keeping existing key.`);
  }

  out();

  // ── Step 2: SONAR_TOKEN ───────────────────────────────────────────────────
  out(`  ─── Step 2: SonarCloud (optional) ─────────────────`);
  out();
  out(`  Enables live SonarCloud issue fetching on every review.`);
  out();
  out(`  How to get it:`);
  out(`    1. Open: https://sonarcloud.io/account/security`);
  out(`    2. Click "Generate Token" → choose "User Token"`);
  out(`    3. Copy the token (starts with sqp_)`);
  out();

  const existingSonar = existing.SONAR_TOKEN;
  const sonarHint = existingSonar
    ? ` (Enter to keep ${existingSonar.slice(0, 8)}...)`
    : " (Enter to skip)";

  const sonarInput = await prompt(rl, `  Paste SONAR_TOKEN${sonarHint}: `);
  const sonarToken = sonarInput || existingSonar || null;

  if (sonarInput) {
    outNoNl(`  Verifying... `);
    const { ok, error } = await testSonarToken(sonarInput);
    out(ok ? "✓ Connected to SonarCloud!" : `⚠  ${error ?? "Could not verify"} — saving anyway`);
  } else if (!sonarToken) {
    out(`  Skipped — SonarCloud scanning will not run.`);
  } else {
    out(`  → Keeping existing token.`);
  }

  out();

  // ── Step 3: GITHUB_TOKEN ──────────────────────────────────────────────────
  out(`  ─── Step 3: GitHub Dependabot (optional) ──────────`);
  out();
  out(`  Enables Dependabot security alert fetching from your GitHub repo.`);
  out();
  out(`  How to get it:`);
  out(`    1. Open: https://github.com/settings/tokens`);
  out(`    2. Click "Fine-grained tokens" → "Generate new token"`);
  out(`    3. Under Permissions → Repository → Security events: Read-only`);
  out(`    4. Copy the token (starts with github_pat_)`);
  out();

  const existingGH = existing.GITHUB_TOKEN;
  const ghHint = existingGH
    ? ` (Enter to keep ${existingGH.slice(0, 12)}...)`
    : " (Enter to skip)";

  const ghInput = await prompt(rl, `  Paste GITHUB_TOKEN${ghHint}: `);
  const githubToken = ghInput || existingGH || null;

  if (ghInput) {
    outNoNl(`  Verifying... `);
    const { ok, error } = await testGithubToken(ghInput);
    out(ok ? "✓ Connected to GitHub API!" : `⚠  ${error ?? "Could not verify"} — saving anyway`);
  } else if (!githubToken) {
    out(`  Skipped — Dependabot alerts will not be fetched.`);
  } else {
    out(`  → Keeping existing token.`);
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  const updated: GlobalConfig = { ...existing };
  if (groqKey)      updated.GROQ_API_KEY = groqKey;
  if (sonarToken)   updated.SONAR_TOKEN  = sonarToken;
  if (githubToken)  updated.GITHUB_TOKEN = githubToken;
  saveGlobalConfig(updated);

  out();
  out(`  ─── Done ───────────────────────────────────────────`);
  out();
  out(`  ✅ Config saved to: ${CONFIG_PATH}`);
  out();
  out(`  GROQ_API_KEY : ${groqKey    ? "✓ active — AI security analysis enabled" : "— skipped (AI analysis disabled)"}`);
  out(`  SONAR_TOKEN  : ${sonarToken ? "✓ active" : "— skipped"}`);
  out(`  GITHUB_TOKEN : ${githubToken ? "✓ active" : "— skipped"}`);
  out();
  out(`  Run "check_setup" via your agent any time to see full live status.`);
  out();

  rl.close();
}
