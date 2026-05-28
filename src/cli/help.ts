/**
 * CLI help, version, and startup banner for agent-quality-loop.
 *
 * All output goes to stderr — stdout is reserved for the MCP stdio protocol.
 *
 * Usage:
 *   npx agent-quality-loop --help
 *   npx agent-quality-loop --version
 *   npx agent-quality-loop          ← starts MCP server, prints startup banner to stderr
 */

import { existsSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

function getVersion(): string {
  try {
    // Walk up from dist/cli/ to find package.json
    const pkg = require("../../package.json") as { version: string };
    return pkg.version;
  } catch {
    return "unknown";
  }
}

// ─── --help ──────────────────────────────────────────────────────────────────

export function printHelp(): void {
  const version = getVersion();
  const out = (s = "") => process.stderr.write(s + "\n");

  out();
  out(`  agent-quality-loop  v${version}`);
  out(`  AI-native code quality loop for any coding agent`);
  out(`  Works with: Cursor · Claude Code · GitHub Copilot · Windsurf · any MCP-compatible agent`);
  out();
  out(`─────────────────────────────────────────────────────────────────────`);
  out();
  out(`  QUICK START`);
  out();
  out(`  1. Add to your agent's MCP config:`);
  out();
  out(`     {`);
  out(`       "mcpServers": {`);
  out(`         "quality-loop": {`);
  out(`           "command": "npx",`);
  out(`           "args": ["-y", "agent-quality-loop"]`);
  out(`         }`);
  out(`       }`);
  out(`     }`);
  out();
  out(`     Cursor    → .cursor/mcp.json  (or Settings → MCP)`);
  out(`     Claude    → claude_desktop_config.json`);
  out(`     Windsurf  → ~/.codeium/windsurf/mcp_config.json`);
  out();
  out(`  2. (Optional) Add tokens to unlock AI and scanning:`);
  out();
  out(`     npx agent-quality-loop --configure`);
  out();
  out(`     3-step wizard — paste your tokens, they're tested and saved:`);
  out(`       • Groq API key  — free AI security analysis (https://console.groq.com/keys)`);
  out(`       • SonarCloud    — live issue scanning`);
  out(`       • GitHub token  — Dependabot security alerts`);
  out();
  out(`  3. Tell your agent to run setup_repo for your project:`);
  out(`     "Call setup_repo with cwd: /path/to/your/repo"`);
  out();
  out(`  4. Done. The agent now runs the quality loop automatically after`);
  out(`     every code change — no manual intervention needed.`);
  out();
  out(`─────────────────────────────────────────────────────────────────────`);
  out();
  out(`  MCP TOOLS`);
  out();
  out(`  review_changed_files`);
  out(`    Reviews files you just edited against ESLint, TypeScript, Prettier,`);
  out(`    file-size limits, AI security analysis, Sonar, and custom rules.`);
  out(`    Returns a fixPrompt with the exact broken source lines embedded —`);
  out(`    the agent applies all fixes in the same turn, then loops until clean.`);
  out();
  out(`  review_workspace_policy`);
  out(`    Full scan of all source files — useful for pre-PR or onboarding a repo.`);
  out();
  out(`  explain_blockers`);
  out(`    Human-readable breakdown of blocking issues, grouped by rule, with`);
  out(`    an ordered action plan. Call when iterationCapReached=true.`);
  out();
  out(`  setup_repo`);
  out(`    One-time setup. Writes CLAUDE.md + .cursorrules into your repo so`);
  out(`    the quality loop triggers automatically. Also creates a starter`);
  out(`    .quality-loop.json and prints the exact env vars you need to set.`);
  out();
  out(`  check_setup`);
  out(`    Live status of every check — active, disabled, or misconfigured.`);
  out(`    Shows exactly which tokens are missing and where to get them.`);
  out(`    Run this after setup_repo to confirm everything is working.`);
  out();
  out(`  identify_trace_code`);
  out(`    Finds unused imports, variables, functions, types, classes, exports,`);
  out(`    class/enum members, duplicate imports/exports, unnecessary/missing`);
  out(`    dependencies, unused files, dead code, and empty functions.`);
  out(`    Returns a removePrompt — agent applies all safe removals immediately,`);
  out(`    then calls verify_trace_removal.`);
  out();
  out(`  verify_trace_removal`);
  out(`    Verifies trace code removals didn't break anything. Runs tsc + ESLint`);
  out(`    and returns a revertPrompt if any removal introduced new errors.`);
  out();
  out(`─────────────────────────────────────────────────────────────────────`);
  out();
  out(`  AI ANALYSIS — pick any one provider`);
  out();
  out(`  Groq is recommended — free tier, no install, generous daily limits.`);
  out();
  out(`  Provider       Key                   Free?   Default model`);
  out(`  ──────────     ───────────────────   ──────  ─────────────────────`);
  out(`  Groq           GROQ_API_KEY          Yes‡   llama-3.1-8b-instant`);
  out(`  Anthropic      ANTHROPIC_API_KEY     No*    claude-haiku-4-5-20251001`);
  out(`  OpenAI         OPENAI_API_KEY        No*    gpt-4o-mini`);
  out(`  Google Gemini  GEMINI_API_KEY        Yes†   gemini-1.5-flash`);
  out(`  Ollama         (none — runs locally) Yes    llama3.2`);
  out();
  out(`  ‡ Groq: 14,400 free requests/day — more than enough for any team`);
  out(`  * Both have free tiers / very low cost (~$0.001 per review)`);
  out(`  † Gemini has a free tier generous enough for most teams`);
  out();
  out(`  The provider is auto-detected from whichever key is in your environment.`);
  out(`  To use Ollama: set checks.ai.provider: "ollama" in .quality-loop.json`);
  out(`  then run: ollama pull llama3.2`);
  out();
  out(`─────────────────────────────────────────────────────────────────────`);
  out();
  out(`  CONFIGURATION (.quality-loop.json in your repo root)`);
  out();
  out(`  {`);
  out(`    "checks": {`);
  out(`      "eslint":    { "enabled": true },`);
  out(`      "typescript": { "enabled": true },`);
  out(`      "prettier":  { "enabled": true },`);
  out(`      "ai":        { "enabled": true, "focus": ["security","sonar","dependencies"] },`);
  out(`      "sonar":     { "enabled": true, "projectKey": "org_repo" },`);
  out(`      "npmAudit":  { "enabled": true, "minSeverity": "high" },`);
  out(`      "dependabot": { "enabled": true }`);
  out(`    },`);
  out(`    "fileSizeLimits": [`);
  out(`      { "glob": "**/*.vue", "maxLines": 500, "severity": "error" }`);
  out(`    ],`);
  out(`    "customRules": [`);
  out(`      {`);
  out(`        "id": "no-any-type",`);
  out(`        "severity": "error",`);
  out(`        "pattern": ":\\\\s*any[\\\\s,;)]",`);
  out(`        "message": "Avoid any type",`);
  out(`        "fixHint": "Use a specific interface",`);
  out(`        "glob": "**/*.{ts,vue}"`);
  out(`      }`);
  out(`    ],`);
  out(`    "maxIterations": 3,`);
  out(`    "blockingseverities": ["error"]`);
  out(`  }`);
  out();
  out(`─────────────────────────────────────────────────────────────────────`);
  out();
  out(`  ENVIRONMENT VARIABLES`);
  out();
  out(`  GROQ_API_KEY        → console.groq.com/keys  (free — recommended)`);
  out(`  ANTHROPIC_API_KEY   → console.anthropic.com/settings/keys`);
  out(`  OPENAI_API_KEY      → platform.openai.com/api-keys`);
  out(`  GEMINI_API_KEY      → aistudio.google.com/app/apikey`);
  out(`  SONAR_TOKEN         → sonarcloud.io/account/security`);
  out(`  SONAR_PROJECT_KEY   → your SonarCloud project → Information tab`);
  out(`  GITHUB_TOKEN        → github.com/settings/tokens (security_events: read)`);
  out();
  out(`  Add to ~/.zshrc or ~/.bashrc, then: source ~/.zshrc`);
  out();
  out(`─────────────────────────────────────────────────────────────────────`);
  out();
  out(`  npm    https://www.npmjs.com/package/agent-quality-loop`);
  out(`  GitHub https://github.com/Naidu2404/agent-quality-loop`);
  out();
}

// ─── --version ───────────────────────────────────────────────────────────────

export function printVersion(): void {
  process.stderr.write(`agent-quality-loop v${getVersion()}\n`);
}

// ─── Startup banner ───────────────────────────────────────────────────────────

export function printStartupBanner(cwd: string): void {
  const version = getVersion();
  const out = (s = "") => process.stderr.write(s + "\n");

  const hasConfig =
    existsSync(`${cwd}/.quality-loop.json`) ||
    existsSync(`${cwd}/quality-loop.config.json`) ||
    existsSync(`${cwd}/.qualityloop.json`);

  out();
  out(`  agent-quality-loop v${version} — MCP server started`);
  out(`  Working directory: ${cwd}`);
  out(`  Config: ${hasConfig ? ".quality-loop.json found" : "no .quality-loop.json — using auto-detected defaults"}`);
  out();

  // Show which AI provider is active (if any)
  const aiProvider = detectAiProvider();
  if (aiProvider) {
    out(`  AI analysis: ✓ ${aiProvider}`);
  } else {
    out(`  AI analysis: — no key detected (run --configure to add a free Groq key)`);
  }

  const hasSonar = !!process.env.SONAR_TOKEN;
  const hasGitHub = !!process.env.GITHUB_TOKEN;
  out(`  Sonar:        ${hasSonar ? "✓ SONAR_TOKEN present" : "— SONAR_TOKEN not set"}`);
  out(`  Dependabot:   ${hasGitHub ? "✓ GITHUB_TOKEN present" : "— GITHUB_TOKEN not set"}`);

  if (!hasConfig) {
    out();
    out(`  Tip: Ask your agent to call setup_repo to configure this repo.`);
    out(`       Or run: npx agent-quality-loop --help`);
  }

  out();
}

function detectAiProvider(): string | null {
  if (process.env.ANTHROPIC_API_KEY) return "Anthropic (Claude Haiku)";
  if (process.env.OPENAI_API_KEY) return "OpenAI (GPT-4o-mini)";
  if (process.env.GEMINI_API_KEY) return "Google Gemini (1.5 Flash)";
  if (process.env.GROQ_API_KEY)   return "Groq (llama-3.1-8b-instant, free tier)";
  return null;
}
