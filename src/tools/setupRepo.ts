import { existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { loadConfig } from "../config/loader.js";
import { stackLabel } from "../detector/techStack.js";

export interface SetupRepoInput {
  /** Absolute path to the repo root. Defaults to process.cwd(). */
  cwd?: string;
  /** Overwrite existing CLAUDE.md / .cursorrules if they already exist. Default: false. */
  overwrite?: boolean;
}

export interface SetupRepoResult {
  written: { file: string; status: "created" | "skipped" | "updated" }[];
  summary: string;
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
  const { stackInfo, configPath } = loadConfig(cwd);

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

  const summary = buildSetupSummary(written, stackLabel(stackInfo), hasConfig);

  return { written, summary };
}

function writeTemplate(
  fullPath: string,
  content: string,
  overwrite: boolean
): SetupRepoResult["written"][number] {
  const filename = fullPath.split("/").pop()!;
  const exists = existsSync(fullPath);

  if (exists && !overwrite) {
    return { file: filename, status: "skipped" };
  }

  // If CLAUDE.md exists, append the quality loop section rather than overwrite
  if (exists && filename === "CLAUDE.md" && !overwrite) {
    const existing = readFileSync(fullPath, "utf8");
    if (existing.includes("review_changed_files")) {
      return { file: filename, status: "skipped" };
    }
    writeFileSync(fullPath, existing + "\n---\n\n" + content, "utf8");
    return { file: filename, status: "updated" };
  }

  writeFileSync(fullPath, content, "utf8");
  return { file: filename, status: exists ? "updated" : "created" };
}

function buildSetupSummary(
  written: SetupRepoResult["written"],
  stack: string,
  hadExistingConfig: boolean
): string {
  const lines: string[] = [];
  lines.push(`## Quality Loop Setup — ${stack}`);
  lines.push("");

  for (const entry of written) {
    const icon = entry.status === "created" ? "✅" : entry.status === "updated" ? "🔄" : "⏭️";
    lines.push(`${icon} **${entry.file}** — ${entry.status}`);
  }

  lines.push("");
  lines.push("### Next steps");

  if (!hadExistingConfig) {
    lines.push("1. Open `.quality-loop.json` and add your project-specific custom rules");
    lines.push("2. The agent will now automatically run the quality loop after every code change");
  } else {
    lines.push("1. Your existing `.quality-loop.json` config was preserved");
    lines.push("2. The agent will now automatically run the quality loop after every code change");
  }

  lines.push("");
  lines.push("**The loop is now active.** The agent will:");
  lines.push("- Call `review_changed_files` automatically after every code change");
  lines.push("- Fix issues from `fixPrompt` in the same turn");
  lines.push("- Hard-stop after 3 iterations and surface any unresolved issues to you");

  return lines.join("\n");
}
