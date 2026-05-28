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
  /** The actual source line(s) from the file so the agent doesn't need to re-read it */
  sourceLine?: string;
  /** 1-2 lines of surrounding context (line before + after) */
  sourceContext?: string;
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
  /**
   * Compact, token-efficient prompt the agent should execute immediately to fix all blocking issues.
   * Includes the exact source lines so the agent does not need to re-read any file.
   * After applying all fixes, call review_changed_files again with the same files.
   * Only present when passesPolicy=false.
   */
  fixPrompt?: string;
  /**
   * Present only when the iteration cap is reached and issues still remain.
   * The agent must STOP iterating and surface this to the user as a human task.
   */
  iterationCapReached?: boolean;
  /** Which iteration this result is from (1-based) */
  iteration?: number;
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

export interface FileSizeRule {
  /** Glob for files this limit applies to, e.g. "**&#47;*.vue" */
  glob: string;
  /** Max allowed lines (default 500) */
  maxLines: number;
  /** Severity when exceeded */
  severity: Severity;
  /** What to do hint */
  fixHint?: string;
}

export type AiProvider = "anthropic" | "openai" | "gemini" | "groq" | "ollama";

export interface AiCheckConfig {
  enabled: boolean;
  /**
   * Which AI provider to use for analysis.
   * • groq      — GROQ_API_KEY (free tier!)   (default model: llama-3.1-8b-instant)
   * • anthropic — ANTHROPIC_API_KEY            (default model: claude-haiku-4-5-20251001)
   * • openai    — OPENAI_API_KEY               (default model: gpt-4o-mini)
   * • gemini    — GEMINI_API_KEY (free tier)   (default model: gemini-1.5-flash)
   * • ollama    — no key, runs locally         (default model: llama3.2)
   * Default: auto-detect from env vars. Set GROQ_API_KEY for free cloud AI.
   */
  provider?: AiProvider;
  /**
   * Model override. If omitted, the provider's recommended cheap/fast model is used.
   * anthropic: claude-haiku-4-5-20251001 | openai: gpt-4o-mini | gemini: gemini-1.5-flash | ollama: llama3.2
   */
  model?: string;
  /** Ollama base URL. Default: http://localhost:11434 */
  ollamaBaseUrl?: string;
  /** Which categories to analyse. Default: all */
  focus?: ("security" | "sonar" | "dependencies")[];
  /** Max KB of file content to send per file. Default: 40 */
  maxFileSizeKb?: number;
  /** Only run AI analysis on this iteration number (avoids re-analysing on retries). Default: 1 */
  runOnIteration?: number | "all";
}

export interface SonarCheckConfig {
  enabled: boolean;
  /** SonarCloud or SonarQube server URL. Default: https://sonarcloud.io */
  serverUrl?: string;
  /**
   * Project key in Sonar. If omitted, reads SONAR_PROJECT_KEY env var.
   * In SonarCloud this is usually "org_repo-name".
   */
  projectKey?: string;
  /** SonarCloud organisation slug (required for SonarCloud, not SonarQube) */
  organization?: string;
}

export interface DependabotCheckConfig {
  enabled: boolean;
  /** GitHub repo owner. Auto-detected from git remote if omitted. */
  owner?: string;
  /** GitHub repo name. Auto-detected from git remote if omitted. */
  repo?: string;
  /** Minimum alert severity to report: critical | high | medium | low. Default: high */
  minSeverity?: "critical" | "high" | "medium" | "low";
}

export interface NpmAuditCheckConfig {
  enabled: boolean;
  /** Minimum vulnerability severity to treat as an issue. Default: high */
  minSeverity?: "critical" | "high" | "moderate" | "low";
}

/**
 * Repo-level credentials stored in .quality-loop.json (which is auto-gitignored).
 * The config loader injects these into process.env at startup so all checks
 * find them without requiring any ~/.zshrc edits.
 */
export interface RepoCredentials {
  /** Groq API key — free tier, 14,400 req/day. Get one at console.groq.com/keys */
  GROQ_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  SONAR_TOKEN?: string;
  SONAR_PROJECT_KEY?: string;
  GITHUB_TOKEN?: string;
}

export interface QualityLoopConfig {
  /**
   * API keys stored at repo level — auto-injected into process.env.
   * .quality-loop.json is added to .gitignore automatically when credentials are written.
   */
  credentials?: RepoCredentials;
  /** Which checks to run */
  checks: {
    eslint?: CheckConfig;
    typescript?: CheckConfig;
    prettier?: CheckConfig;
    /** AI-powered security + Sonar-style analysis via Claude Haiku */
    ai?: AiCheckConfig;
    /** Fetch real issues from SonarCloud / SonarQube */
    sonar?: SonarCheckConfig;
    /** Run npm audit for known CVEs in dependencies */
    npmAudit?: NpmAuditCheckConfig;
    /** Fetch open Dependabot alerts from GitHub */
    dependabot?: DependabotCheckConfig;
  };
  /** File size limits — files exceeding these trigger issues */
  fileSizeLimits?: FileSizeRule[];
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
