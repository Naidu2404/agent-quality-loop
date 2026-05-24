// ─── Issue shape ────────────────────────────────────────────────────────────

export type Severity = "error" | "warning" | "info";
export type Category = "lint" | "types" | "formatting" | "custom" | "policy";

export interface Issue {
  /** Relative path from cwd */
  path: string;
  line: number;
  endLine?: number;
  column?: number;
  endColumn?: number;
  severity: Severity;
  category: Category;
  /** Stable rule identifier, e.g. "no-unused-vars", "TS2322", "prettier/prettier" */
  ruleId: string;
  message: string;
  /** Optional one-line hint the agent can use to fix this issue */
  fixHint?: string;
}

// ─── Review result ──────────────────────────────────────────────────────────

export interface ReviewResult {
  /** Total issues found */
  totalIssues: number;
  /** Blocking issues (severity === "error") */
  blockingCount: number;
  /** Advisory issues (severity === "warning" | "info") */
  advisoryCount: number;
  /** Whether the review is clean enough to proceed (no blockers) */
  passesPolicy: boolean;
  issues: Issue[];
  /** Human-readable summary for the agent */
  summary: string;
  /** Which checks ran */
  checksRun: string[];
  /** Which checks were skipped and why */
  checksSkipped: { check: string; reason: string }[];
}

// ─── Config ─────────────────────────────────────────────────────────────────

export interface CustomRule {
  id: string;
  description: string;
  severity: Severity;
  /** Regex pattern to match in file content (optional — purely textual check) */
  pattern?: string;
  /** File glob this rule applies to, e.g. "src/&#42;&#42;/*.ts" (default: all files) */
  glob?: string;
  /** Message shown when this rule fires */
  message: string;
  fixHint?: string;
}

export interface CheckConfig {
  enabled: boolean;
  /** Path to config file, relative to repo root */
  configPath?: string;
  /** Extra CLI args to pass to the tool */
  extraArgs?: string[];
}

export interface QualityLoopConfig {
  /** Which checks to run */
  checks: {
    eslint?: CheckConfig;
    typescript?: CheckConfig;
    prettier?: CheckConfig;
  };
  /** Custom rules evaluated by the MCP itself */
  customRules?: CustomRule[];
  /** Severities that must be zero for passesPolicy=true (default: ["error"]) */
  blockingseverities?: Severity[];
  /** Max review iterations an agent should attempt (informational) */
  maxIterations?: number;
  /** Free-text notes passed back to the agent as context */
  notes?: string;
}

// ─── Tech stack detection ────────────────────────────────────────────────────

export type TechStack =
  | "vue"
  | "react"
  | "nextjs"
  | "angular"
  | "nuxt"
  | "node"
  | "java"
  | "python"
  | "go"
  | "rust"
  | "generic";

export interface DetectedStack {
  primary: TechStack;
  hasTypeScript: boolean;
  hasPrettier: boolean;
  hasEslint: boolean;
  packageManager: "npm" | "yarn" | "pnpm" | "bun" | "unknown";
}
