#!/usr/bin/env node
/**
 * agent-quality-loop — MCP server
 *
 * Run `npx agent-quality-loop --help` for the full usage guide.
 */

// ─── CLI flags — handle before anything else ──────────────────────────────────
import { printHelp, printVersion, printStartupBanner } from "./cli/help.js";
import { runConfigure } from "./cli/configure.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}
if (args.includes("--version") || args.includes("-v")) {
  printVersion();
  process.exit(0);
}
if (args.includes("--configure") || args.includes("-c")) {
  await runConfigure();
  process.exit(0);
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { reviewChangedFiles } from "./tools/reviewChangedFiles.js";
import { reviewWorkspacePolicy } from "./tools/reviewWorkspacePolicy.js";
import { explainBlockers } from "./tools/explainBlockers.js";
import { setupRepo } from "./tools/setupRepo.js";
import { identifyTraceCode } from "./tools/identifyTraceCode.js";
import { verifyTraceRemoval } from "./tools/verifyTraceRemoval.js";
import { checkSetup } from "./tools/checkSetup.js";
import type { ReviewResult } from "./types.js";
import type { CheckSetupResult } from "./tools/checkSetup.js";

// ─── Friendly check_setup report builder ─────────────────────────────────────

function buildFriendlySetupReport(result: CheckSetupResult): string {
  const lines: string[] = [];
  lines.push("## 🔍 Agent Quality Loop — Setup Status");
  lines.push("");

  const allChecks = result.checks ?? [];
  const active    = allChecks.filter((c) => c.state === "active");
  const disabled  = allChecks.filter((c) => c.state === "disabled");
  const misconfig = allChecks.filter((c) => c.state === "misconfigured");

  if (misconfig.length === 0 && active.length > 0) {
    lines.push(`✅ **Everything looks good!** ${active.length} check(s) are active and verified.`);
  } else if (misconfig.length > 0) {
    lines.push(`⚠️ **${misconfig.length} check(s) need attention** — details below.`);
  } else {
    lines.push(`ℹ️ No checks are active yet — type "setup agent loop" to configure.`);
  }
  lines.push("");

  if (active.length > 0) {
    lines.push("**✅ Active and working:**");
    for (const c of active) {
      lines.push(`  • **${c.check}** — ${c.reason}`);
    }
    lines.push("");
  }

  if (misconfig.length > 0) {
    lines.push("**⚠️ Needs attention:**");
    for (const c of misconfig) {
      lines.push(`  • **${c.check}** — ${c.reason}`);
      if (c.action) lines.push(`    → How to fix: ${c.action}`);
    }
    lines.push("");
  }

  if (disabled.length > 0) {
    lines.push("**⬜ Not enabled (optional):**");
    for (const c of disabled) {
      lines.push(`  • ${c.check} — ${c.reason}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("The quality loop runs automatically after every code change — no manual action needed.");
  if (misconfig.length > 0) {
    lines.push("To fix the issues above, edit `.quality-loop.json` directly or ask me to re-run the setup wizard.");
  }

  return lines.join("\n");
}

const server = new McpServer({
  name: "agent-quality-loop",
  version: "1.0.0",
});

// ─── Tool 1: review_changed_files ────────────────────────────────────────────

server.tool(
  "review_changed_files",
  "ALWAYS call this after writing or editing any code files. ALWAYS pass the explicit files you just changed — do NOT omit the files parameter. Reviews only the specified files against ESLint, TypeScript, Prettier, file-size limits, and repo-specific .quality-loop.json rules. Results are scoped to only the files you pass — unrelated pre-existing errors in other files are excluded. THE RESPONSE TEXT IS YOUR INSTRUCTION SET — read it and act on it immediately without asking the user. AGENT LOOP: (1) Call with ONLY the files you just created/modified in this task, iteration=1. (2) The response will begin with either '✅ PASSES' (task done — tell user) OR a FIX PROMPT starting with 'QUALITY LOOP'. If you see a FIX PROMPT: apply EVERY fix listed right now in this same turn — source lines are embedded so you do NOT need to re-read any file. Then call this tool again with the SAME files, iteration+1. (3) If the response begins with '🛑 STOP': do NOT call again — copy the issue list to the user verbatim. Never ask permission to apply fixes. Never skip a fix. Never loop after a STOP signal. For a full codebase scan, use review_workspace_policy instead.",
  {
    files: z
      .array(z.string())
      .optional()
      .describe(
        "REQUIRED in practice: List of file paths you just created or modified in this task (relative or absolute). Only pass files from the CURRENT task — do not include files from previous edits. Results are scoped to these files only. If omitted, falls back to git-detected source file changes (staged + unstaged vs HEAD) which may include unrelated dirty files."
      ),
    cwd: z
      .string()
      .optional()
      .describe(
        "Absolute path to the project root / repo directory. Defaults to the current working directory."
      ),
    iteration: z
      .number()
      .optional()
      .describe(
        "Current iteration number (1-based). Start at 1, increment by 1 on each retry. When this reaches maxIterations and issues remain, iterationCapReached=true is returned and the loop must stop."
      ),
  },
  async ({ files, cwd, iteration }) => {
    try {
      const result: ReviewResult = await reviewChangedFiles({ files, cwd, iteration });

      // Surface the actionable text first so the agent treats it as instructions,
      // not as data. JSON is appended second for reference only.
      let primaryText: string;
      if (result.passesPolicy) {
        primaryText = `✅ PASSES — quality check passed. All ${result.checksRun?.join(", ") || "checks"} are clean. Task is complete — tell the user.`;
      } else if (result.iterationCapReached) {
        primaryText = [
          `🛑 STOP — iteration cap reached. Do NOT call review_changed_files again.`,
          `Show these unresolved issues to the user and ask them to fix manually:`,
          ``,
          ...result.issues
            .filter((i) => i.severity === "error")
            .map((i) => `[BLOCKING] ${i.path}:${i.line} — \`${i.ruleId}\`\n  ${i.message}${i.fixHint ? `\n  Fix: ${i.fixHint}` : ""}`),
        ].join("\n");
      } else {
        // fixPrompt is the instruction set — put it front and centre
        primaryText = result.fixPrompt ?? result.summary;
      }

      return {
        content: [
          { type: "text", text: primaryText },
          { type: "text", text: `---\nFULL RESULT (reference):\n${JSON.stringify(result, null, 2)}` },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: true,
              message: String(error),
              hint: "Ensure you are running this from a valid project directory with npm dependencies installed.",
            }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Tool 2: review_workspace_policy ────────────────────────────────────────

server.tool(
  "review_workspace_policy",
  "Run the full quality policy scan across the entire workspace (all source files). Useful for a comprehensive pre-commit or pre-PR check. Returns the same structured issue format as review_changed_files.",
  {
    cwd: z
      .string()
      .optional()
      .describe("Absolute path to the project root. Defaults to current working directory."),
    include: z
      .array(z.string())
      .optional()
      .describe(
        "Glob patterns for files to include (e.g. [\"src/**/*.ts\"]). Defaults to common source directories."
      ),
    exclude: z
      .array(z.string())
      .optional()
      .describe(
        "Glob patterns to exclude (e.g. [\"node_modules/**\", \"dist/**\"]). Defaults to standard ignore patterns."
      ),
  },
  async ({ cwd, include, exclude }) => {
    try {
      const result: ReviewResult = await reviewWorkspacePolicy({ cwd, include, exclude });

      let primaryText: string;
      if (result.passesPolicy) {
        primaryText = `✅ PASSES — full workspace scan clean. ${result.totalIssues === 0 ? "No issues found." : ""} Task is complete.`;
      } else {
        primaryText = result.fixPrompt ?? result.summary;
      }

      return {
        content: [
          { type: "text", text: primaryText },
          { type: "text", text: `---\nFULL RESULT (reference):\n${JSON.stringify(result, null, 2)}` },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: true, message: String(error) }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Tool 3: explain_blockers ────────────────────────────────────────────────

server.tool(
  "explain_blockers",
  "Takes a review result and produces a human-readable, agent-actionable explanation of all blocking issues grouped by rule, with concrete fix instructions and an ordered action plan. Call this when review_changed_files returns passesPolicy=false to get clear guidance on what to fix.",
  {
    reviewResult: z
      .object({
        totalIssues: z.number(),
        blockingCount: z.number(),
        advisoryCount: z.number(),
        passesPolicy: z.boolean(),
        issues: z.array(
          z.object({
            path: z.string(),
            line: z.number(),
            endLine: z.number().optional(),
            column: z.number().optional(),
            endColumn: z.number().optional(),
            severity: z.enum(["error", "warning", "info"]),
            category: z.enum(["lint", "types", "formatting", "custom", "policy"]),
            ruleId: z.string(),
            message: z.string(),
            fixHint: z.string().optional(),
          })
        ),
        summary: z.string(),
        checksRun: z.array(z.string()),
        checksSkipped: z.array(
          z.object({ check: z.string(), reason: z.string() })
        ),
      })
      .describe("The ReviewResult object returned by review_changed_files or review_workspace_policy."),
    severities: z
      .array(z.enum(["error", "warning", "info"]))
      .optional()
      .describe(
        "Which severities to explain. Defaults to [\"error\"] (blocking issues only). Pass [\"error\",\"warning\"] to include advisories."
      ),
  },
  async ({ reviewResult, severities }) => {
    try {
      const result = explainBlockers({ reviewResult, severities });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: true, message: String(error) }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Tool 4: setup_repo ──────────────────────────────────────────────────────

server.tool(
  "setup_repo",
  "Sets up the agent quality loop for a repo. Call this whenever the user says 'setup agent loop', 'setup quality loop', or similar. " +
  "PHASE 1 (first call — no completeSetup): Returns a wizard prompt — follow it exactly: ask the user each question in chat one at a time (AI provider, API key, Sonar, Dependabot), collect all answers, then call setup_repo again with completeSetup=true and the collected values. " +
  "PHASE 2 (second call — completeSetup=true): Writes .quality-loop.json with credentials, writes the correct agent rules file (.cursorrules / CLAUDE.md / etc.), adds .quality-loop.json to .gitignore. After completing, tell the user to type 'Check the agent loop setup'.",
  {
    cwd: z.string().optional().describe("Absolute path to the repo root. Defaults to current working directory."),
    completeSetup: z.boolean().optional().describe("Set to true on the second call after collecting all wizard answers from the user."),
    agent: z.enum(["cursor", "claude", "windsurf", "copilot", "all"]).optional().describe("Which agent to write rules for. Auto-detected if omitted."),
    overwrite: z.boolean().optional().describe("Overwrite existing config files. Default: false."),
    aiProvider: z.string().optional().describe("AI provider chosen by user: 'groq' | 'anthropic' | 'openai' | 'gemini' | 'none'"),
    aiKey: z.string().optional().describe("API key for the chosen AI provider"),
    sonarEnabled: z.boolean().optional().describe("Whether user wants SonarCloud scanning enabled"),
    sonarToken: z.string().optional().describe("SonarCloud token (SONAR_TOKEN)"),
    sonarProjectKey: z.string().optional().describe("SonarCloud project key (SONAR_PROJECT_KEY)"),
    dependabotEnabled: z.boolean().optional().describe("Whether user wants Dependabot alerts enabled"),
    githubToken: z.string().optional().describe("GitHub token with security_events:read scope"),
  },
  async ({ cwd, completeSetup, agent, overwrite, aiProvider, aiKey, sonarEnabled, sonarToken, sonarProjectKey, dependabotEnabled, githubToken }) => {
    try {
      const result = setupRepo({ cwd, completeSetup, agent, overwrite, aiProvider, aiKey, sonarEnabled, sonarToken, sonarProjectKey, dependabotEnabled, githubToken });
      return {
        content: [
          { type: "text", text: result.summary },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: true, message: String(error) }) }],
        isError: true,
      };
    }
  }
);

// ─── Tool 5: check_setup ─────────────────────────────────────────────────────

server.tool(
  "check_setup",
  "Call this when the user says 'Check the agent loop setup' or asks to verify the setup. Runs a live check of every quality feature — verifies API keys actually work (not just present), shows what's active and what's not. Present the result to the user in a friendly, readable way — use the friendlyReport field as the primary message to show them.",
  {
    cwd: z
      .string()
      .optional()
      .describe("Absolute path to the repo root. Defaults to current working directory."),
  },
  async ({ cwd }) => {
    try {
      const result = await checkSetup({ cwd });
      // Build a user-friendly report from the check results
      const friendlyReport = buildFriendlySetupReport(result);
      return {
        content: [
          { type: "text", text: friendlyReport },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: true, message: String(error) }) }],
        isError: true,
      };
    }
  }
);

// ─── Tool 7: identify_trace_code ─────────────────────────────────────────────

server.tool(
  "identify_trace_code",
  "Scans source files for trace code — unused imports, variables, functions, types, classes, duplicate imports, dead code after return, empty functions, and commented-out code. THE RESPONSE TEXT IS YOUR INSTRUCTION SET — act on it immediately without asking the user. AGENT INSTRUCTIONS: The response will begin with either '✅ No trace code found' (done, tell user) OR a removal prompt starting with 'TRACE CODE'. If you see a TRACE CODE prompt: (1) Apply every SAFE TO REMOVE item immediately — the exact source lines are embedded, do NOT re-read files. (2) For REQUIRES REVIEW items, use judgment before removing. (3) After all removals, call verify_trace_removal with the same files. Never ask permission to remove safe items.",
  {
    cwd: z
      .string()
      .optional()
      .describe("Absolute path to the repo root. Defaults to current working directory."),
    files: z
      .array(z.string())
      .optional()
      .describe(
        "Files to scan. Omit to scan git-changed files. Pass [\"*\"] to scan the whole workspace."
      ),
  },
  async ({ cwd, files }) => {
    try {
      const result = await identifyTraceCode({ cwd, files });

      // removePrompt is the instruction set — surface it as primary content
      const primaryText = result.removePrompt ?? result.summary;

      return {
        content: [
          { type: "text", text: primaryText },
          { type: "text", text: `---\nFULL RESULT (reference):\n${JSON.stringify(result, null, 2)}` },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: true, message: String(error) }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Tool 8: verify_trace_removal ────────────────────────────────────────────

server.tool(
  "verify_trace_removal",
  "Verifies that trace code removals did not introduce new errors. THE RESPONSE TEXT IS YOUR INSTRUCTION SET — act on it immediately. The response will begin with either '✅ PASSED' (trace removal is complete and safe — tell the user) OR a revert prompt starting with '⚠️ TRACE REMOVAL VERIFICATION FAILED'. If you see a FAILED prompt: revert ONLY the specific removal(s) that caused each listed error (do not revert everything), then call verify_trace_removal again with the same files. Never ask permission to revert.",
  {
    cwd: z
      .string()
      .optional()
      .describe("Absolute path to the repo root. Defaults to current working directory."),
    files: z
      .array(z.string())
      .optional()
      .describe(
        "Files that were modified during trace removal. Omit to use git-changed files. Pass [\"*\"] to verify the whole workspace."
      ),
  },
  async ({ cwd, files }) => {
    try {
      const result = verifyTraceRemoval({ cwd, files });

      // Surface actionable text first — revertPrompt when failed, success msg when passed
      let primaryText: string;
      if (result.passesVerification) {
        primaryText = `✅ PASSED — trace removal verified. No new errors introduced. ${result.newWarningCount > 0 ? `(${result.newWarningCount} warning(s) present, non-blocking.)` : ""} Trace code removal is complete — tell the user.`;
      } else {
        primaryText = result.revertPrompt ?? result.summary;
      }

      return {
        content: [
          { type: "text", text: primaryText },
          { type: "text", text: `---\nFULL RESULT (reference):\n${JSON.stringify(result, null, 2)}` },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: true, message: String(error) }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Start server ─────────────────────────────────────────────────────────────

printStartupBanner(process.cwd());

const transport = new StdioServerTransport();
await server.connect(transport);
