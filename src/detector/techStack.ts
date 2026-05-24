import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { DetectedStack, TechStack } from "../types.js";

/**
 * Detects the primary tech stack and available tooling for a given project root.
 */
export function detectTechStack(cwd: string): DetectedStack {
  const pkgPath = join(cwd, "package.json");
  const hasPkgJson = existsSync(pkgPath);

  let pkg: Record<string, unknown> = {};
  if (hasPkgJson) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    } catch {
      // ignore parse errors
    }
  }

  const allDeps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
    ...(pkg.peerDependencies as Record<string, string> | undefined),
  };

  const has = (name: string) => name in allDeps;

  // Primary stack detection (order matters — more specific first)
  let primary: TechStack = "generic";

  if (existsSync(join(cwd, "pom.xml")) || existsSync(join(cwd, "build.gradle"))) {
    primary = "java";
  } else if (
    existsSync(join(cwd, "requirements.txt")) ||
    existsSync(join(cwd, "pyproject.toml")) ||
    existsSync(join(cwd, "setup.py"))
  ) {
    primary = "python";
  } else if (existsSync(join(cwd, "go.mod"))) {
    primary = "go";
  } else if (existsSync(join(cwd, "Cargo.toml"))) {
    primary = "rust";
  } else if (hasPkgJson) {
    if (has("nuxt") || has("nuxt3") || has("@nuxt/core")) {
      primary = "nuxt";
    } else if (has("next")) {
      primary = "nextjs";
    } else if (has("@angular/core")) {
      primary = "angular";
    } else if (has("vue") || has("@vue/core")) {
      primary = "vue";
    } else if (has("react") || has("react-dom")) {
      primary = "react";
    } else {
      primary = "node";
    }
  }

  // Tool detection
  const hasTypeScript =
    existsSync(join(cwd, "tsconfig.json")) ||
    has("typescript") ||
    has("@types/node");

  const hasEslint =
    existsSync(join(cwd, ".eslintrc.js")) ||
    existsSync(join(cwd, ".eslintrc.cjs")) ||
    existsSync(join(cwd, ".eslintrc.json")) ||
    existsSync(join(cwd, ".eslintrc.yaml")) ||
    existsSync(join(cwd, ".eslintrc.yml")) ||
    existsSync(join(cwd, "eslint.config.js")) ||
    existsSync(join(cwd, "eslint.config.mjs")) ||
    has("eslint");

  const hasPrettier =
    existsSync(join(cwd, ".prettierrc")) ||
    existsSync(join(cwd, ".prettierrc.js")) ||
    existsSync(join(cwd, ".prettierrc.json")) ||
    existsSync(join(cwd, "prettier.config.js")) ||
    has("prettier");

  // Package manager detection
  let packageManager: DetectedStack["packageManager"] = "unknown";
  if (existsSync(join(cwd, "bun.lockb"))) packageManager = "bun";
  else if (existsSync(join(cwd, "pnpm-lock.yaml"))) packageManager = "pnpm";
  else if (existsSync(join(cwd, "yarn.lock"))) packageManager = "yarn";
  else if (existsSync(join(cwd, "package-lock.json"))) packageManager = "npm";

  return { primary, hasTypeScript, hasEslint, hasPrettier, packageManager };
}

/** Returns a human-readable label for the detected stack */
export function stackLabel(stack: DetectedStack): string {
  const labels: Record<TechStack, string> = {
    vue: "Vue.js",
    react: "React",
    nextjs: "Next.js",
    angular: "Angular",
    nuxt: "Nuxt",
    node: "Node.js",
    java: "Java",
    python: "Python",
    go: "Go",
    rust: "Rust",
    generic: "Generic",
  };
  const ts = stack.hasTypeScript ? " + TypeScript" : "";
  return `${labels[stack.primary]}${ts}`;
}
