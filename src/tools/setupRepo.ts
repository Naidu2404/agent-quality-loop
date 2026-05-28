import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { loadConfig } from "../config/loader.js";
import { stackLabel } from "../detector/techStack.js";
import type { QualityLoopConfig } from "../types.js";

export type AgentTarget = "cursor" | "claude" | "windsurf" | "copilot" | "all";

export interface SetupRepoInput {
  /** Absolute path to the repo root. Defaults to process.cwd(). */
  cwd?: string;
  /** Overwrite existing config files. Default: false. */
  overwrite?: boolean;
  /**
   * Which AI coding agent to write the rules file for.
   * Auto-detected from project signals if omitted.
   *   "cursor"   → .cursorrules only
   *   "claude"   → CLAUDE.md only
   *   "windsurf" → .windsurfrules only
   *   "copilot"  → .github/copilot-instructions.md only
   *   "all"      → every file
   */
  agent?: AgentTarget;

  // ── Phase 2: collected answers from the wizard ──────────────────────────
  /**
   * Set to true after the agent has collected all wizard answers from the user.
   * When false/absent, setup_repo returns the wizard prompt for the agent to follow.
   */
  completeSetup?: boolean;
  /** AI provider chosen by user: "groq" | "anthropic" | "openai" | "gemini" | "none" */
  aiProvider?: string;
  /** API key for the chosen AI provider */
  aiKey?: string;
  /** Whether user wants SonarCloud scanning */
  sonarEnabled?: boolean;
  sonarToken?: string;
  sonarProjectKey?: string;
  /** Whether user wants Dependabot alerts */
  dependabotEnabled?: boolean;
  githubToken?: string;
}

export interface SetupRepoResult {
  /** Phase of this result: "wizard" = show prompt to user; "complete" = setup done */
  phase: "wizard" | "complete";
  /**
   * Phase 1: the agent must follow these instructions — ask the user questions
   * in chat and call setup_repo again with the collected answers.
   */
  wizardPrompt?: string;
  written: { file: string; status: "created" | "skipped" | "updated" }[];
  credentialSetup: CredentialSetupItem[];
  summary: string;
}

export interface CredentialSetupItem {
  name: string;
  envVar: string;
  present: boolean;
  required: boolean;
  getItAt: string;
  exportLine: string;
  note: string;
}

const CLAUDE_MD_CONTENT = `# Quality Loop — Agent Instructions
# Works with: Claude Code, Cursor, GitHub Copilot, Windsurf, and any MCP-compatible AI agent

## Mandatory quality loop after every code change

After creating, editing, or refactoring ANY code file, automatically run the quality loop
using the \`review_changed_files\` MCP tool. Do NOT ask the user — just run it.

### Loop

\`\`\`
1. Call review_changed_files with EXACTLY the files you just created or modified.
   ALWAYS pass the files array explicitly — never call without it.

   review_changed_files({
     files: ["src/path/to/FileYouChanged.ts"],   ← list every file you touched, nothing else
     cwd: "<absolute repo root>",
     iteration: 1
   })

   ⚠️  IMPORTANT: Only include files you changed in THIS task.
       Do NOT pass files from previous tasks, do NOT omit files.
       Passing unrelated files causes unrelated errors to appear.

2. Check the response:

   a) passesPolicy=true
      → Task is complete. Tell the user. STOP.

   b) passesPolicy=false AND iterationCapReached=false
      → Read the fixPrompt field. It has the exact broken source lines — no need to re-read files.
      → Apply EVERY fix in fixPrompt immediately in this same response.
      → Call review_changed_files again: SAME files list, iteration+1.
      → Go back to step 2.

   c) iterationCapReached=true  ← HARD STOP
      → Do NOT call review_changed_files again.
      → Do NOT attempt more fixes.
      → Show the user the unresolved issues from the issues array in this format:

        ⚠️ Quality loop stopped after {maxIterations} iterations. These need your attention:

        [BLOCKING] path/to/File.vue:45 — \`rule-id\`
          <message from issue>
          Fix: <fixHint from issue>
\`\`\`

### Rules

- ALWAYS pass the explicit files list — never rely on auto-detection
- Only include files you changed in the current task — not old dirty files from other work
- Never ask permission to run the quality check or apply fixPrompt fixes
- Never loop beyond what the MCP allows — trust iterationCapReached
- The fixPrompt includes exact source lines — you do NOT need to re-read any file between iterations
- Only announce task completion after passesPolicy=true
- For a full repo scan (pre-PR), use review_workspace_policy instead
`;

const CURSORRULES_CONTENT = `# agent-quality-loop
# Works with: Cursor, Claude, Copilot, Windsurf, or any MCP-compatible AI agent

## Mandatory: quality loop after every code change

After writing, editing, or refactoring any code file, run the quality loop automatically.
Do NOT ask the user — just run it.

### CRITICAL: Always pass the files array explicitly

Never call review_changed_files without the files parameter.
Only include the files you changed in the CURRENT task — not files from previous tasks.

### Loop

1. Call review_changed_files with ONLY the files you just modified:
   { files: ["src/path/FileYouChanged.ts"], cwd: "<repo root>", iteration: 1 }

2. If passesPolicy=false and iterationCapReached=false:
   - Read fixPrompt — it has the exact broken lines embedded, no need to re-read files
   - Apply every fix in fixPrompt immediately
   - Call review_changed_files again: SAME files list, iteration+1

3. If passesPolicy=true → done, tell the user

4. If iterationCapReached=true → STOP LOOPING
   - Show unresolved issues to the user in a readable format
   - Do not retry

### When iterationCapReached=true, format issues like this

⚠️ Quality loop reached max iterations. These issues need your attention:

[BLOCKING] src/path/File.vue:45 — \`rule-id\`
  <message>. Fix: <fixHint>

### For a full repo scan (pre-PR)

Use review_workspace_policy instead of review_changed_files when you want to check the whole codebase.
`;

// Windsurf uses .windsurfrules (same format as .cursorrules)
const WINDSURFRULES_CONTENT = CURSORRULES_CONTENT
  .replace("# Works with: Cursor, Claude, Copilot, Windsurf", "# Works with: Windsurf, Cursor, Claude, Copilot");

// GitHub Copilot uses .github/copilot-instructions.md
const COPILOT_INSTRUCTIONS_CONTENT = CLAUDE_MD_CONTENT
  .replace("# Works with: Claude Code, Cursor, GitHub Copilot, Windsurf", "# Works with: GitHub Copilot, Cursor, Claude Code, Windsurf");

// ─── Agent detection ──────────────────────────────────────────────────────────

/**
 * Infers which AI agent is active by looking for tell-tale files/directories
 * in the project root and on the developer's machine.
 *
 * Returns the detected agent, or null if ambiguous / none found.
 */
function detectAgent(cwd: string): AgentTarget | null {
  const home = homedir();

  // Cursor: has a .cursor/ directory with settings or mcp.json
  const hasCursorDir = existsSync(join(cwd, ".cursor"));
  const hasCursorHome = existsSync(join(home, ".cursor"));
  if (hasCursorDir || hasCursorHome) return "cursor";

  // Windsurf: home config dir
  const hasWindsurf =
    existsSync(join(home, ".codeium", "windsurf")) ||
    existsSync(join(cwd, ".windsurfrules"));
  if (hasWindsurf) return "windsurf";

  // Claude Code / Claude desktop: has CLAUDE.md already or ~/. claude config
  const hasClaudeConfig =
    existsSync(join(home, ".claude")) ||
    existsSync(join(home, "Library", "Application Support", "Claude")) ||
    existsSync(join(cwd, "CLAUDE.md"));
  if (hasClaudeConfig) return "claude";

  // GitHub Copilot: .github/copilot-instructions.md already present, or .github dir
  const hasCopilotInstructions = existsSync(join(cwd, ".github", "copilot-instructions.md"));
  const hasGithubDir = existsSync(join(cwd, ".github"));
  if (hasCopilotInstructions || hasGithubDir) return "copilot";

  return null; // can't tell — caller should default to "all"
}

export function setupRepo(input: SetupRepoInput): SetupRepoResult {
  const cwd = input.cwd ?? process.cwd();

  // ── Phase 1: Return wizard prompt ─────────────────────────────────────────
  // Called without completeSetup — agent follows the wizard in chat,
  // collects answers from user, then calls setup_repo again with the answers.
  if (!input.completeSetup) {
    return {
      phase: "wizard",
      written: [],
      credentialSetup: [],
      wizardPrompt: buildWizardPrompt(cwd),
      summary: buildWizardPrompt(cwd),
    };
  }

  // ── Phase 2: Write everything with collected answers ───────────────────────
  const overwrite = input.overwrite ?? false;
  const { stackInfo, configPath } = loadConfig(cwd);
  const written: SetupRepoResult["written"] = [];

  // Resolve which agent to target
  const detectedAgent = input.agent ?? detectAgent(cwd) ?? "all";
  const writeClaude   = detectedAgent === "claude"   || detectedAgent === "all";
  const writeCursor   = detectedAgent === "cursor"   || detectedAgent === "all";
  const writeWindsurf = detectedAgent === "windsurf" || detectedAgent === "all";
  const writeCopilot  = detectedAgent === "copilot"  || detectedAgent === "all";

  if (writeClaude)   written.push(writeTemplate(join(cwd, "CLAUDE.md"), CLAUDE_MD_CONTENT, overwrite));
  if (writeCursor)   written.push(writeTemplate(join(cwd, ".cursorrules"), CURSORRULES_CONTENT, overwrite));
  if (writeWindsurf) written.push(writeTemplate(join(cwd, ".windsurfrules"), WINDSURFRULES_CONTENT, overwrite));
  if (writeCopilot) {
    const githubDir = join(cwd, ".github");
    if (!existsSync(githubDir)) {
      try { mkdirSync(githubDir, { recursive: true }); } catch { /* ignore */ }
    }
    written.push(writeTemplate(join(cwd, ".github", "copilot-instructions.md"), COPILOT_INSTRUCTIONS_CONTENT, overwrite));
  }

  // Build credentials object from wizard answers
  const credentials: Record<string, string> = {};
  if (input.aiKey && input.aiProvider && input.aiProvider !== "none") {
    const keyName = AI_PROVIDER_KEY[input.aiProvider] ?? "GROQ_API_KEY";
    credentials[keyName] = input.aiKey;
  }
  if (input.sonarEnabled && input.sonarToken)      credentials["SONAR_TOKEN"] = input.sonarToken;
  if (input.sonarEnabled && input.sonarProjectKey) credentials["SONAR_PROJECT_KEY"] = input.sonarProjectKey;
  if (input.dependabotEnabled && input.githubToken) credentials["GITHUB_TOKEN"] = input.githubToken;

  // Build the config object with checks enabled based on what was configured
  const aiEnabled = !!input.aiKey && input.aiProvider !== "none";
  const configObj: Record<string, unknown> = {
    _comment: `agent-quality-loop config — auto-generated for ${stackLabel(stackInfo)} project`,
    ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
    checks: {
      eslint:     { enabled: stackInfo.hasEslint },
      typescript: { enabled: stackInfo.hasTypeScript },
      prettier:   { enabled: stackInfo.hasPrettier },
      ai:         { enabled: aiEnabled, provider: input.aiProvider ?? undefined, focus: ["security", "sonar", "dependencies"] },
      sonar:      { enabled: !!(input.sonarEnabled && input.sonarToken) },
      npmAudit:   { enabled: true, minSeverity: "high" },
      dependabot: { enabled: !!(input.dependabotEnabled && input.githubToken) },
    },
    blockingseverities: ["error"],
    maxIterations: 3,
    customRules: [],
  };

  // Write .quality-loop.json (create or update)
  const configFilePath = join(cwd, ".quality-loop.json");
  writeFileSync(configFilePath, JSON.stringify(configObj, null, 2), "utf8");
  written.push({ file: ".quality-loop.json", status: configPath !== null ? "updated" : "created" });

  // Auto-add .quality-loop.json to .gitignore if credentials were written
  if (Object.keys(credentials).length > 0) {
    addToGitignore(cwd, ".quality-loop.json", "agent-quality-loop credentials (API keys — do not commit)");
    written.push({ file: ".gitignore", status: "updated" });
  }

  const summary = buildCompleteSummary(written, stackLabel(stackInfo), detectedAgent, !!input.agent, input);
  return { phase: "complete", written, credentialSetup: [], summary };
}

/** Maps provider name → env var key */
const AI_PROVIDER_KEY: Record<string, string> = {
  groq:      "GROQ_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai:    "OPENAI_API_KEY",
  gemini:    "GEMINI_API_KEY",
};

/**
 * Adds an entry to .gitignore if not already present.
 */
function addToGitignore(cwd: string, pattern: string, comment: string): void {
  const gitignorePath = join(cwd, ".gitignore");
  try {
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
    if (existing.includes(pattern)) return; // already ignored
    const entry = `\n# ${comment}\n${pattern}\n`;
    writeFileSync(gitignorePath, existing + entry, "utf8");
  } catch { /* ignore write errors */ }
}

// ─── Phase 1: Wizard prompt ───────────────────────────────────────────────────

/**
 * Returns the agent instruction text for the setup wizard.
 * The agent shows this as a friendly chat flow, collects answers,
 * then calls setup_repo again with completeSetup: true and all the answers.
 */
function buildWizardPrompt(cwd: string): string {
  return `SETUP WIZARD — Follow these steps exactly. Ask the user each question in plain conversational chat. Do NOT ask all questions at once. Collect answers one at a time, then call setup_repo with all the answers.

---

👋 **Welcome! Let's set up the agent quality loop for this repo.**

Ask the user these questions one by one:

---

**Question 1 — AI Security Analysis (optional but recommended)**

Say to the user:
"Would you like to enable AI-powered security analysis? It scans your code for vulnerabilities after every change.

I recommend **Groq** — it's completely free (14,400 requests/day, no credit card needed).

Your options:
  1️⃣  Groq (free) — get a key at https://console.groq.com/keys
  2️⃣  Anthropic (Claude)
  3️⃣  OpenAI
  4️⃣  Google Gemini (free tier)
  5️⃣  Skip for now

Which would you like? (1–5)"

If they choose 1–4, say:
"Great! Please paste your [provider] API key here. It will be saved to .quality-loop.json in this repo only (never sent anywhere except to [provider])."

Wait for the key. If they choose 5, skip the key question.

---

**Question 2 — SonarCloud scanning (optional)**

Say to the user:
"Would you like to connect SonarCloud for live code quality scanning? (yes/no)

If yes, I'll need:
  • Your SONAR_TOKEN — get it at https://sonarcloud.io → Account → Security → Generate Token
  • Your project key — visible in your SonarCloud project → Information tab"

Collect both values if they say yes. If no, move on.

---

**Question 3 — Dependabot security alerts (optional)**

Say to the user:
"Would you like to enable Dependabot security alerts from GitHub? It checks your dependencies for known CVEs. (yes/no)

If yes, I'll need a GitHub token with \`security_events: read\` scope.
Create one at: https://github.com/settings/tokens → Fine-grained tokens → New token"

Collect the token if they say yes.

---

**After collecting all answers**, call setup_repo with:
\`\`\`json
{
  "cwd": "${cwd}",
  "completeSetup": true,
  "aiProvider": "<groq|anthropic|openai|gemini|none>",
  "aiKey": "<key or null>",
  "sonarEnabled": <true|false>,
  "sonarToken": "<token or null>",
  "sonarProjectKey": "<key or null>",
  "dependabotEnabled": <true|false>,
  "githubToken": "<token or null>"
}
\`\`\`

After setup_repo completes, say exactly this to the user:
"✅ All done! To verify everything is working, type this in the chat:

**Check the agent loop setup**"`;
}

// ─── Phase 2: Complete summary ────────────────────────────────────────────────

function buildCompleteSummary(
  written: SetupRepoResult["written"],
  stack: string,
  detectedAgent: AgentTarget,
  wasExplicit: boolean,
  input: SetupRepoInput
): string {
  const lines: string[] = [];
  lines.push(`## ✅ Agent quality loop is set up for this repo!`);
  lines.push(`**Stack detected:** ${stack}`);
  lines.push(`**Agent:** ${AGENT_LABELS[detectedAgent]}${wasExplicit ? "" : " (auto-detected)"}`);
  lines.push("");

  lines.push("**Files written:**");
  for (const entry of written) {
    const icon = entry.status === "created" ? "✅" : entry.status === "updated" ? "🔄" : "⏭️";
    lines.push(`  ${icon} ${entry.file} — ${entry.status}`);
  }
  lines.push("");

  const aiEnabled = !!input.aiKey && input.aiProvider !== "none";
  const sonarEnabled = !!(input.sonarEnabled && input.sonarToken);
  const dependabotEnabled = !!(input.dependabotEnabled && input.githubToken);

  lines.push("**Features enabled:**");
  lines.push(`  ${aiEnabled ? "✅" : "⬜"} AI security analysis${aiEnabled ? ` (${input.aiProvider})` : " — skipped"}`);
  lines.push(`  ✅ ESLint + TypeScript + Prettier — always on`);
  lines.push(`  ✅ npm audit — always on`);
  lines.push(`  ${sonarEnabled ? "✅" : "⬜"} SonarCloud${sonarEnabled ? "" : " — skipped"}`);
  lines.push(`  ${dependabotEnabled ? "✅" : "⬜"} Dependabot${dependabotEnabled ? "" : " — skipped"}`);
  lines.push("");

  if (aiEnabled || sonarEnabled || dependabotEnabled) {
    lines.push("**Credentials saved to:** `.quality-loop.json` (added to .gitignore — keys stay local)");
    lines.push("");
  }

  lines.push("---");
  lines.push("Now tell the user:");
  lines.push("> ✅ All done! To verify everything is working, type this in the chat:");
  lines.push(">");
  lines.push("> **Check the agent loop setup**");

  return lines.join("\n");
}

// ─── Credential setup builder (legacy — used by check_setup) ─────────────────

function buildCredentialSetup(config: QualityLoopConfig): CredentialSetupItem[] {
  const items: CredentialSetupItem[] = [];

  if (config.checks.ai?.enabled) {
    const provider = config.checks.ai.provider;
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const hasGemini = !!process.env.GEMINI_API_KEY;
    const anyKeyPresent = hasAnthropic || hasOpenAI || hasGemini || provider === "ollama";

    if (!anyKeyPresent) {
      items.push({
        name: "AI analysis (pick one provider)",
        envVar: "ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY",
        present: false,
        required: true,
        getItAt: "See options below",
        exportLine: [
          '# Pick ONE of these — the provider is auto-detected from whichever key is set:',
          'export ANTHROPIC_API_KEY="sk-ant-..."   # https://console.anthropic.com/settings/keys',
          'export OPENAI_API_KEY="sk-..."           # https://platform.openai.com/api-keys',
          'export GEMINI_API_KEY="AIza..."          # https://aistudio.google.com/app/apikey',
          '# OR use Ollama (free, local): set checks.ai.provider: "ollama" in .quality-loop.json',
        ].join('\n'),
        note: "If you already use Claude Code, Claude desktop, or Cursor Pro, your ANTHROPIC_API_KEY may already be set.",
      });
    } else {
      const activeProvider = hasAnthropic ? "Anthropic" : hasOpenAI ? "OpenAI" : hasGemini ? "Gemini" : "Ollama";
      items.push({
        name: `AI analysis (${activeProvider})`,
        envVar: hasAnthropic ? "ANTHROPIC_API_KEY" : hasOpenAI ? "OPENAI_API_KEY" : "GEMINI_API_KEY",
        present: true,
        required: true,
        getItAt: "",
        exportLine: "",
        note: `${activeProvider} key detected — AI analysis is ready.`,
      });
    }
  }

  if (config.checks.sonar?.enabled) {
    items.push({
      name: "SonarCloud / SonarQube",
      envVar: "SONAR_TOKEN",
      present: !!process.env.SONAR_TOKEN,
      required: true,
      getItAt: "https://sonarcloud.io/account/security (My Account → Security → Generate Token)",
      exportLine: 'export SONAR_TOKEN="sqp_..."',
      note: "Create a User Token with 'Execute Analysis' permission on your project.",
    });

    if (!config.checks.sonar.projectKey && !process.env.SONAR_PROJECT_KEY) {
      items.push({
        name: "Sonar project key",
        envVar: "SONAR_PROJECT_KEY",
        present: false,
        required: true,
        getItAt: "Your SonarCloud project → Information tab → Project Key",
        exportLine: 'export SONAR_PROJECT_KEY="your-org_your-repo"',
        note: "Or set checks.sonar.projectKey directly in .quality-loop.json.",
      });
    }
  }

  if (config.checks.dependabot?.enabled) {
    items.push({
      name: "GitHub (Dependabot alerts)",
      envVar: "GITHUB_TOKEN",
      present: !!process.env.GITHUB_TOKEN,
      required: true,
      getItAt: "https://github.com/settings/tokens (Fine-grained token → Security events: Read)",
      exportLine: 'export GITHUB_TOKEN="github_pat_..."',
      note: "In GitHub Actions this is automatic — use ${{ secrets.GITHUB_TOKEN }}. For local use, create a fine-grained PAT with 'Security events' read access on your repo.",
    });
  }

  return items;
}

// ─── Summary builder ──────────────────────────────────────────────────────────

const AGENT_LABELS: Record<AgentTarget, string> = {
  cursor:   "Cursor (.cursorrules)",
  claude:   "Claude Code (CLAUDE.md)",
  windsurf: "Windsurf (.windsurfrules)",
  copilot:  "GitHub Copilot (.github/copilot-instructions.md)",
  all:      "All agents (every config file)",
};

function buildSetupSummary(
  written: SetupRepoResult["written"],
  stack: string,
  hadExistingConfig: boolean,
  credentialSetup: CredentialSetupItem[],
  detectedAgent: AgentTarget,
  wasExplicit: boolean
): string {
  const lines: string[] = [];
  lines.push(`## Quality Loop Setup — ${stack}`);
  lines.push("");
  lines.push(`**Agent:** ${AGENT_LABELS[detectedAgent]}${wasExplicit ? "" : " (auto-detected)"}`);
  if (!wasExplicit && detectedAgent === "all") {
    lines.push(`> Agent could not be auto-detected — wrote all config files. You can re-run with \`agent: "cursor"\` / \`"claude"\` / \`"windsurf"\` / \`"copilot"\` to limit this.`);
  }
  lines.push("");

  for (const entry of written) {
    const icon = entry.status === "created" ? "✅" : entry.status === "updated" ? "🔄" : "⏭️";
    lines.push(`${icon} **${entry.file}** — ${entry.status}`);
  }

  lines.push("");

  if (!hadExistingConfig) {
    lines.push("### Next steps");
    lines.push("1. Open `.quality-loop.json` and enable the checks you want (ai, sonar, dependabot)");
    lines.push("2. Set the required environment variables (see below)");
    lines.push("3. The agent will now automatically run the quality loop after every code change");
  } else {
    lines.push("### Next steps");
    lines.push("1. Your existing `.quality-loop.json` config was preserved");
    lines.push("2. Set any missing environment variables (see below)");
    lines.push("3. The agent will now automatically run the quality loop after every code change");
  }

  lines.push("");
  lines.push("**The quality loop is now active.** The agent will:");
  lines.push("- Call `review_changed_files` automatically after every code change");
  lines.push("- Apply fixes from `fixPrompt` in the same turn — no back-and-forth");
  lines.push("- Hard-stop after 3 iterations and surface unresolved issues to you");

  // Credential setup section
  if (credentialSetup.length > 0) {
    lines.push("");
    lines.push("---");
    lines.push("## Environment variables needed");
    lines.push("");

    const missing = credentialSetup.filter((c) => !c.present);
    const present = credentialSetup.filter((c) => c.present);

    if (present.length > 0) {
      for (const item of present) {
        lines.push(`✅ **${item.envVar}** — already set (${item.name} is ready)`);
      }
      lines.push("");
    }

    if (missing.length > 0) {
      lines.push("The following tokens are needed to enable all configured checks.");
      lines.push("Add them to your shell profile (`~/.zshrc` or `~/.bashrc`) and restart your terminal:");
      lines.push("");

      for (const item of missing) {
        lines.push(`### ${item.name}`);
        lines.push(`**Missing:** \`${item.envVar}\``);
        lines.push(`**Get it at:** ${item.getItAt}`);
        lines.push(`**Add to shell profile:**`);
        lines.push(`\`\`\`bash`);
        lines.push(item.exportLine);
        lines.push(`\`\`\``);
        if (item.note) lines.push(`> ${item.note}`);
        lines.push("");
      }

      lines.push("**After setting all tokens:** run `check_setup` to confirm everything is active.");
    } else {
      lines.push("✅ All required tokens are present — all configured checks are ready.");
    }
  } else {
    lines.push("");
    lines.push("**Tip:** Enable AI-powered checks (security, Sonar-style analysis, Dependabot) by adding `checks.ai`, `checks.sonar`, and `checks.dependabot` to `.quality-loop.json`. Then run `setup_repo` again to get the credential guide.");
  }

  return lines.join("\n");
}

// ─── File writer ──────────────────────────────────────────────────────────────

function writeTemplate(
  fullPath: string,
  content: string,
  overwrite: boolean
): SetupRepoResult["written"][number] {
  const filename = fullPath.split("/").pop()!;
  const exists = existsSync(fullPath);

  if (exists && !overwrite) {
    // If CLAUDE.md exists, append the quality loop section if not already there
    if (filename === "CLAUDE.md") {
      const existing = readFileSync(fullPath, "utf8");
      if (existing.includes("review_changed_files")) {
        return { file: filename, status: "skipped" };
      }
      writeFileSync(fullPath, existing + "\n---\n\n" + content, "utf8");
      return { file: filename, status: "updated" };
    }
    return { file: filename, status: "skipped" };
  }

  writeFileSync(fullPath, content, "utf8");
  return { file: filename, status: exists ? "updated" : "created" };
}
