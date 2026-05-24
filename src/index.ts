#!/usr/bin/env node
/**
 * agent-quality-loop — MCP server
 *
 * Exposes three tools to AI agents:
 *   1. review_changed_files      — review a specific set of files (or git-changed files)
 *   2. review_workspace_policy   — scan the whole workspace against the quality policy
 *   3. explain_blockers          — get a structured, agent-actionable breakdown of blocking issues
 *
 * Usage (Claude / Cursor MCP config):
 *   {
 *     "mcpServers": {
 *       "quality-loop": {
 *         "command": "npx",
 *         "args": ["-y", "agent-quality-loop"]
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { reviewChangedFiles } from "./tools/reviewChangedFiles.js";
import { reviewWorkspacePolicy } from "./tools/reviewWorkspacePolicy.js";
import { explainBlockers } from "./tools/explainBlockers.js";
import { setupRepo } from "./tools/setupRepo.js";
import { identifyTraceCode } from "./tools/identifyTraceCode.js";
import { verifyTraceRemoval } from "./tools/verifyTraceRemoval.js";
import type { ReviewResult } from "./types.js";

const server = new McpServer({
  name: "agent-quality-loop",
  version: "1.0.0",
});

// ─── Tool 1: review_changed_files ────────────────────────────────────────────

server.tool(
  "review_changed_files",
  "ALWAYS call this after writing or editing any code files. Works with any AI agent (Cursor, Claude, Copilot, etc). Reviews files against ESLint, TypeScript, Prettier, file-size limits, and repo-specific .quality-loop.json rules. Returns structured issues AND a ready-to-execute fixPrompt with the exact source lines embedded. AGENT LOOP INSTRUCTIONS: (1) Call with the files you just created or modified, iteration=1. (2) If passesPolicy=false AND iterationCapReached=false: read fixPrompt, apply every fix listed (source lines are in the response — do NOT re-read files), then call this tool again with iteration incremented by 1. (3) If passesPolicy=true: task is complete — tell the user. (4) If iterationCapReached=true: STOP — do NOT call again — show the remaining issues from the 'issues' array to the user in a readable format and ask them to resolve manually.",
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
            text: JSON.stringify({
              error: true,
              message: String(error),
            }),
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
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: true, message: String(error) }) }],
        isError: true,
      };
    }
  }
);

// ─── Tool 5: identify_trace_code ─────────────────────────────────────────────

server.tool(
  "identify_trace_code",
  "Scans source files for trace code — unused imports, variables, functions, types, classes, duplicate imports, dead code after return, empty functions, and commented-out code. Returns a compact removePrompt that tells the agent exactly what to delete (grouped by file, safe vs review-required). AGENT LOOP INSTRUCTIONS: (1) Call this tool with the files you want to scan (or omit files to scan git-changed files, or pass [\"*\"] to scan the whole workspace). (2) Read removePrompt — it lists every item to remove with the exact source line embedded. (3) Apply ALL safe removals immediately. (4) For review-required items, use judgment — check if the symbol is truly unused before removing. (5) After all removals, call verify_trace_removal with the same files. (6) If verify passes → done. If new errors appear → read revertPrompt and revert the specific removal that broke something.",
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
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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

// ─── Tool 6: verify_trace_removal ────────────────────────────────────────────

server.tool(
  "verify_trace_removal",
  "Verifies that trace code removals did not introduce new errors. Runs TypeScript type-checking and ESLint on the modified files and checks for any new errors. Call this immediately after applying removals from identify_trace_code. If passesVerification=true → removal is complete and safe. If passesVerification=false → read revertPrompt and revert the specific removal(s) that caused the errors, then call this tool again.",
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
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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

const transport = new StdioServerTransport();
await server.connect(transport);
