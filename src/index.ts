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

const server = new McpServer({
  name: "agent-quality-loop",
  version: "1.0.0",
});

// ─── Tool 1: review_changed_files ────────────────────────────────────────────

server.tool(
  "review_changed_files",
  "ALWAYS call this after writing or editing any code files. Reviews files against ESLint, TypeScript, Prettier, file-size limits, and repo-specific .quality-loop.json rules. THE RESPONSE TEXT IS YOUR INSTRUCTION SET — read it and act on it immediately without asking the user. AGENT LOOP: (1) Call with files you just created/modified, iteration=1. (2) The response will begin with either '✅ PASSES' (task done — tell user) OR a FIX PROMPT starting with 'QUALITY LOOP'. If you see a FIX PROMPT: apply EVERY fix listed right now in this same turn — source lines are embedded so you do NOT need to re-read any file. Then call this tool again with iteration+1. (3) If the response begins with '🛑 STOP': do NOT call again — copy the issue list to the user verbatim and ask them to fix manually. Never ask permission to apply fixes. Never skip a fix. Never loop after a STOP signal.",
  {
    files: z
      .array(z.string())
      .optional()
      .describe(
        "List of file paths to review (relative or absolute). If omitted, auto-detects files changed in the current git working tree."
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
  "One-time setup for a repo. Writes CLAUDE.md and .cursorrules directly into the repo root so the quality loop runs automatically after every code change — no manual template copying needed. Also creates a starter .quality-loop.json if none exists. Call this once when adding the quality loop to a new project.",
  {
    cwd: z
      .string()
      .optional()
      .describe("Absolute path to the repo root. Defaults to current working directory."),
    overwrite: z
      .boolean()
      .optional()
      .describe("Overwrite existing CLAUDE.md / .cursorrules files. Default: false (safe merge)."),
  },
  async ({ cwd, overwrite }) => {
    try {
      const result = setupRepo({ cwd, overwrite });
      // Surface the summary (which includes the credential guide) as primary text
      return {
        content: [
          { type: "text", text: result.summary },
          { type: "text", text: `---\nFULL RESULT (reference):\n${JSON.stringify(result, null, 2)}` },
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
  "Reports the live status of every quality check — active, disabled, or misconfigured. Shows exactly which environment variables are missing, where to get each token, and the exact shell commands to add to the user's profile. Call this after setup_repo to confirm everything is working, or any time a check seems to be skipping unexpectedly. THE RESPONSE TEXT IS YOUR INSTRUCTION SET — read setupPrompt and show it to the user verbatim so they know what to do.",
  {
    cwd: z
      .string()
      .optional()
      .describe("Absolute path to the repo root. Defaults to current working directory."),
  },
  async ({ cwd }) => {
    try {
      const result = await checkSetup({ cwd });
      return {
        content: [
          { type: "text", text: result.setupPrompt },
          { type: "text", text: `---\nFULL STATUS:\n${result.summary}` },
          { type: "text", text: `---\nFULL RESULT (reference):\n${JSON.stringify(result, null, 2)}` },
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
