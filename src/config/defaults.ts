import type { CustomRule, QualityLoopConfig, TechStack } from "../types.js";

/** Default custom rules that apply to every project */
const universalRules: CustomRule[] = [
  {
    id: "no-debug-console",
    description: "No console.log / console.debug left in code",
    severity: "warning",
    pattern: "console\\.(log|debug|info|warn|error)\\(",
    message: "Remove debug console statement before committing.",
    fixHint: "Delete the console statement or replace with a proper logger.",
    glob: "**/*.{js,ts,jsx,tsx,vue,mjs,cjs}",
  },
  {
    id: "no-todo-fixme",
    description: "TODO / FIXME comments must be tracked in a ticket",
    severity: "info",
    pattern: "//\\s*(TODO|FIXME|HACK|XXX):",
    message: "TODO/FIXME found — ensure this is tracked in a Jira ticket.",
    fixHint: "Add a ticket reference (e.g. // TODO BNP-1234: ...) or resolve now.",
    glob: "**/*.{js,ts,jsx,tsx,vue,java,py,go,rs}",
  },
  {
    id: "no-hardcoded-secrets",
    description: "Detect obvious hardcoded secrets/tokens",
    severity: "error",
    pattern:
      "(password|secret|api_key|apikey|token|auth_token)\\s*=\\s*['\"][^'\"]{6,}['\"]",
    message: "Possible hardcoded secret detected.",
    fixHint: "Move secrets to environment variables or a secrets manager.",
    glob: "**/*.{js,ts,jsx,tsx,vue,py,java,go,env}",
  },
];

/** Stack-specific default rules */
const stackRules: Partial<Record<TechStack, CustomRule[]>> = {
  vue: [
    {
      id: "vue-no-v-html",
      description: "Avoid v-html to prevent XSS",
      severity: "warning",
      pattern: "v-html=",
      message: "v-html can introduce XSS vulnerabilities. Use v-text or sanitize the value.",
      fixHint: "Replace v-html with v-text if plain text suffices, or sanitize via DOMPurify.",
      glob: "**/*.vue",
    },
    {
      id: "vue-script-setup",
      description: "Prefer <script setup> in Vue 3 SFCs",
      severity: "info",
      pattern: "<script(?!\\s+setup)[^>]*lang=[\"']ts[\"'][^>]*>",
      message: "Consider using <script setup lang=\"ts\"> for cleaner Vue 3 SFCs.",
      fixHint: "Refactor to <script setup> syntax for better performance and readability.",
      glob: "**/*.vue",
    },
  ],
  react: [
    {
      id: "react-no-index-key",
      description: "Avoid using array index as React key",
      severity: "warning",
      pattern: "key=\\{[^}]*index[^}]*\\}",
      message: "Using array index as key can cause rendering issues with reordered lists.",
      fixHint: "Use a stable unique identifier from the data instead of the array index.",
      glob: "**/*.{jsx,tsx}",
    },
  ],
  nextjs: [
    {
      id: "nextjs-no-img-element",
      description: "Use Next.js Image component instead of <img>",
      severity: "warning",
      pattern: "<img\\s",
      message: "Use next/image instead of <img> for automatic optimization.",
      fixHint: "Import Image from 'next/image' and replace <img> tags.",
      glob: "**/*.{jsx,tsx}",
    },
  ],
  java: [
    {
      id: "java-no-system-out",
      description: "No System.out.println in production code",
      severity: "warning",
      pattern: "System\\.out\\.print",
      message: "Use a proper logger (SLF4J, Log4j) instead of System.out.println.",
      fixHint: "Replace with logger.info(), logger.debug(), etc.",
      glob: "**/*.java",
    },
    {
      id: "java-no-e-printstacktrace",
      description: "No e.printStackTrace() — use a logger",
      severity: "warning",
      pattern: "\\.printStackTrace\\(\\)",
      message: "Avoid e.printStackTrace(); use a logger to record exceptions properly.",
      fixHint: "Replace with logger.error(\"message\", e);",
      glob: "**/*.java",
    },
  ],
  python: [
    {
      id: "python-no-bare-except",
      description: "No bare except clauses",
      severity: "warning",
      pattern: "except\\s*:",
      message: "Bare except catches all exceptions including SystemExit. Specify exception types.",
      fixHint: "Replace with `except Exception as e:` or a more specific exception type.",
      glob: "**/*.py",
    },
    {
      id: "python-no-print",
      description: "No print() statements in production code",
      severity: "info",
      pattern: "^\\s*print\\(",
      message: "Replace print() with proper logging.",
      fixHint: "Use the logging module: import logging; logging.info('...')",
      glob: "**/*.py",
    },
  ],
  go: [
    {
      id: "go-no-ignored-error",
      description: "Do not ignore errors with _",
      severity: "warning",
      pattern: ",\\s*_\\s*:?=",
      message: "Ignoring errors with _ can hide bugs. Handle or wrap the error.",
      fixHint: "Replace _ with err and handle: if err != nil { return err }",
      glob: "**/*.go",
    },
  ],
};

/** Build the effective default config for a given tech stack */
export function buildDefaultConfig(stack: TechStack, detected: {
  hasEslint: boolean;
  hasTypeScript: boolean;
  hasPrettier: boolean;
}): QualityLoopConfig {
  const stackSpecific = stackRules[stack] ?? [];
  const customRules = [...universalRules, ...stackSpecific];

  return {
    checks: {
      eslint: { enabled: detected.hasEslint },
      typescript: { enabled: detected.hasTypeScript },
      prettier: { enabled: detected.hasPrettier },
    },
    customRules,
    blockingseverities: ["error"],
    maxIterations: 3,
  };
}
