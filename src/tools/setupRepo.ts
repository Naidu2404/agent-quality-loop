import { existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { loadConfig } from "../config/loader.js";
import { stackLabel } from "../detector/techStack.js";
import type { QualityLoopConfig } from "../types.js";

export interface SetupRepoInput {
  /** Absolute path to the repo root. Defaults to process.cwd(). */
  cwd?: string;
  /** Overwrite existing CLAUDE.md / .cursorrules if they already exist. Default: false. */
  overwrite?: boolean;
}

export interface SetupRepoResult {
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
1. Call review_changed_files({ files: ["<every file you touched>"], cwd: "<repo root>", iteration: 1 })

2. Check the response:

   a) passesPolicy=true
      → Task is complete. Tell the user. STOP.

   b) passesPolicy=false AND iterationCapReached=false
      → Read the fixPrompt field. It has the exact broken source lines — no need to re-read files.
      → Apply EVERY fix in fixPrompt immediately in this same response.
      → Call review_changed_files again: same files, iteration+1.
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

- Never ask permission to run the quality check or apply fixPrompt fixes
- Never loop beyond what the MCP allows — trust iterationCapReached
- The fixPrompt includes exact source lines — you do NOT need to re-read any file between iterations
- Only announce task completion after passesPolicy=true
`;

const CURSORRULES_CONTENT = `# agent-quality-loop
# Works with: Cursor, Claude, Copilot, Windsurf, or any MCP-compatible AI agent

## Mandatory: quality loop after every code change

After writing, editing, or refactoring any code file, run the quality loop automatically.
Do NOT ask the user — just run it.

### Loop

1. Call review_changed_files with every file you just touched, cwd = repo root, iteration: 1
2. If passesPolicy=false and iterationCapReached=false:
   - Read fixPrompt — it has the exact broken lines embedded, no need to re-read files
   - Apply every fix in fixPrompt immediately
   - Call review_changed_files again: same files, iteration+1
3. If passesPolicy=true → done, tell the user
4. If iterationCapReached=true → STOP LOOPING
   - Show unresolved issues to the user in a readable format
   - Ask them to fix manually — do not retry

### When iterationCapReached=true, format issues like this

⚠️ Quality loop reached max iterations. These issues need your attention:

[BLOCKING] src/path/File.vue:45 — \`rule-id\`
  <message>. Fix: <fixHint>
`;

export function setupRepo(input: SetupRepoInput): SetupRepoResult {
  const cwd = input.cwd ?? process.cwd();
  const overwrite = input.overwrite ?? false;
  const { stackInfo, configPath, config } = loadConfig(cwd);

  const written: SetupRepoResult["written"] = [];

  // Write CLAUDE.md
  const claudeMdPath = join(cwd, "CLAUDE.md");
  written.push(writeTemplate(claudeMdPath, CLAUDE_MD_CONTENT, overwrite));

  // Write .cursorrules
  const cursorrulesPath = join(cwd, ".cursorrules");
  written.push(writeTemplate(cursorrulesPath, CURSORRULES_CONTENT, overwrite));

  // Write .quality-loop.json only if none exists yet
  const hasConfig = configPath !== null;
  if (!hasConfig) {
    const defaultConfigPath = join(cwd, ".quality-loop.json");
    const defaultConfig = JSON.stringify(
      {
        _comment: `agent-quality-loop config — auto-generated for ${stackLabel(stackInfo)} project`,
        checks: {
          eslint: { enabled: stackInfo.hasEslint },
          typescript: { enabled: stackInfo.hasTypeScript },
          prettier: { enabled: stackInfo.hasPrettier },
          ai: { enabled: false, model: "claude-haiku-4-5-20251001", focus: ["security", "sonar", "dependencies"] },
          sonar: { enabled: false },
          npmAudit: { enabled: true, minSeverity: "high" },
          dependabot: { enabled: false },
        },
        blockingseverities: ["error"],
        maxIterations: 3,
        notes: "Add project-specific rules and notes here.",
        customRules: [],
      },
      null,
      2
    );
    written.push(writeTemplate(defaultConfigPath, defaultConfig, false));
  } else {
    written.push({ file: ".quality-loop.json", status: "skipped" });
  }

  // Build credential setup guide based on which checks are enabled
  const credentialSetup = buildCredentialSetup(config);
  const summary = buildSetupSummary(written, stackLabel(stackInfo), hasConfig, credentialSetup);

  return { written, credentialSetup, summary };
}

// ─── Credential setup builder ─────────────────────────────────────────────────

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

function buildSetupSummary(
  written: SetupRepoResult["written"],
  stack: string,
  hadExistingConfig: boolean,
  credentialSetup: CredentialSetupItem[]
): string {
  const lines: string[] = [];
  lines.push(`## Quality Loop Setup — ${stack}`);
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
