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
    {
      id: "vue-no-any-type",
      description: "Avoid TypeScript any type",
      severity: "warning",
      pattern: ":\\s*any[\\s,;)<>|&]",
      message: "Avoid using 'any' — use a specific type, 'unknown', or a generic.",
      fixHint: "Replace with a specific type. Use 'unknown' + type guard if the shape is truly dynamic.",
      glob: "**/*.{ts,vue}",
    },
    {
      id: "vue-no-as-any",
      description: "Avoid 'as any' type casts",
      severity: "warning",
      pattern: "as any[\\s,;)<>]",
      message: "'as any' bypasses type safety. Use a proper type assertion or narrow the type.",
      fixHint: "Use 'as SpecificType' with a correct interface, or narrow with a type guard.",
      glob: "**/*.{ts,vue}",
    },
    {
      id: "vue-deep-watcher-review",
      description: "Deep watchers are expensive — justify or replace",
      severity: "warning",
      pattern: "deep:\\s*true",
      message: "Deep watcher detected. Deep watchers traverse entire object trees on every change — expensive in large components.",
      fixHint: "Consider: (1) watch a specific nested property instead, (2) use a computed property, or (3) restructure state to avoid deep observation.",
      glob: "**/*.{ts,vue}",
    },
    {
      id: "vue-immediate-watcher-check",
      description: "Watchers with immediate:true often replace a computed property",
      severity: "info",
      pattern: "immediate:\\s*true",
      message: "immediate:true watcher may be replaceable with a computed property.",
      fixHint: "If this watcher only derives/transforms data, use computed() instead. Reserve immediate watchers for side effects that must run on mount.",
      glob: "**/*.{ts,vue}",
    },
    {
      id: "vue-untyped-defineemits",
      description: "defineEmits should use TypeScript generic syntax",
      severity: "warning",
      pattern: "defineEmits\\(\\[",
      message: "defineEmits uses untyped array syntax. Use the generic form for type safety.",
      fixHint: "Replace defineEmits(['update:modelValue']) with defineEmits<{ 'update:modelValue': [value: string] }>()",
      glob: "**/*.vue",
    },
    {
      id: "vue-inline-style",
      description: "Avoid inline styles — use Tailwind classes or scoped CSS",
      severity: "info",
      pattern: "\\bstyle=\"[^\"]{1,}\"",
      message: "Inline style detected. Use Tailwind utility classes or scoped CSS instead.",
      fixHint: "Move styles to Tailwind classes or a <style scoped> block.",
      glob: "**/*.vue",
    },
    {
      id: "vue-nonnull-assertion",
      description: "Non-null assertion (!) hides potential null errors",
      severity: "warning",
      pattern: "[a-zA-Z0-9_\\]\\)]\\.value![^=]|[a-zA-Z0-9_\\]\\)]![.\\[]",
      message: "Non-null assertion (!) used. This suppresses TypeScript null checking.",
      fixHint: "Use optional chaining (?.) or an explicit null check (if (x)) instead.",
      glob: "**/*.{ts,vue}",
    },
    {
      id: "vue-prop-default-object",
      description: "Object/array prop defaults cause shared reference bugs",
      severity: "warning",
      pattern: "default:\\s*[\\[{]",
      message: "Object or array used directly as prop default. Each component instance shares the same reference.",
      fixHint: "Wrap in a factory function: default: () => ([]) or default: () => ({})",
      glob: "**/*.{ts,vue}",
    },
    {
      id: "vue-direct-store-mutation",
      description: "Mutate store state via actions, not direct assignment",
      severity: "warning",
      pattern: "Store\\.[a-zA-Z][a-zA-Z0-9]*\\s*=\\s",
      message: "Direct store state mutation detected. Mutate state only through Pinia actions.",
      fixHint: "Move the mutation into a store action and call the action from the component.",
      glob: "**/*.{ts,vue}",
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
