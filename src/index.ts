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
import type { ReviewResult } from "./types.js";

const server = new McpServer({
  name: "agent-quality-loop",
  version: "1.0.0",
});

// ─── Tool 1: review_changed_files ────────────────────────────────────────────

server.tool(
  "review_changed_files",
  "Review a set of files (or auto-detect git-changed files) against ESLint, TypeScript, Prettier and repo-specific rules. Returns structured issues with severity, location and fix hints. Call this after writing or editing code to check quality before committing.",
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
  },
  async ({ files, cwd }) => {
    try {
      const result: ReviewResult = await reviewChangedFiles({ files, cwd });
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

// ─── Start server ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
