import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, relative, basename, extname } from "path";
import { globSync } from "glob";
import type { DetectedStack } from "../types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type TraceKind =
  | "unused-import"
  | "unused-variable"
  | "unused-function"
  | "unused-type"
  | "unused-class"
  | "unused-export"
  | "commented-code"
  | "empty-function"
  | "dead-code-after-return"
  | "duplicate-import"
  | "unused-file"
  | "unused-dep"
  | "missing-dep"
  | "unused-class-member"
  | "unused-enum-member"
  | "duplicate-export";

export type RemovalSafety = "safe" | "review-required";

export interface TraceItem {
  path: string;
  line: number;
  endLine?: number;
  kind: TraceKind;
  /** The symbol name, if applicable */
  symbol?: string;
  /** The actual source line(s) */
  sourceLine: string;
  /** Context: 1 line before and after */
  sourceContext: string;
  safety: RemovalSafety;
  /** Why removal might be risky */
  safetyNote?: string;
  /** Exact action the agent should take */
  removeInstruction: string;
}

export interface TraceCodeResult {
  totalItems: number;
  safeToRemoveCount: number;
  reviewRequiredCount: number;
  items: TraceItem[];
  checksRun: string[];
  checksSkipped: { check: string; reason: string }[];
}

// ─── Main runner ─────────────────────────────────────────────────────────────

export function runTraceCodeAnalysis(
  files: string[],
  cwd: string,
  stack: DetectedStack,
  options?: { workspaceWide?: boolean }
): TraceCodeResult {
  const items: TraceItem[] = [];
  const checksRun: string[] = [];
  const checksSkipped: { check: string; reason: string }[] = [];
  const workspaceWide = options?.workspaceWide ?? false;

  // 1. TypeScript unused locals/parameters
  if (stack.hasTypeScript) {
    const tsResult = detectUnusedViaTypeScript(files, cwd);
    if (tsResult.skipped) {
      checksSkipped.push({ check: "tsc-unused", reason: tsResult.reason ?? "skipped" });
    } else {
      checksRun.push("tsc-unused");
      items.push(...tsResult.items);
    }
  }

  // 2. ESLint unused-vars / unused-imports
  const eslintResult = detectUnusedViaEslint(files, cwd);
  if (eslintResult.skipped) {
    checksSkipped.push({ check: "eslint-unused", reason: eslintResult.reason ?? "skipped" });
  } else {
    checksRun.push("eslint-unused");
    items.push(...eslintResult.items);
  }

  // 3. Pattern-based checks (all stacks) — includes class members, enum members, duplicate exports
  const patternResult = detectViaPatterns(files, cwd, stack);
  checksRun.push("patterns");
  items.push(...patternResult);

  // 4. Workspace-level: unused deps + missing deps (always run — uses package.json)
  const hasPkgJson = existsSync(join(cwd, "package.json"));
  if (hasPkgJson) {
    const allWorkspaceFiles = getWorkspaceSourceFiles(cwd);
    detectUnusedDeps(cwd, allWorkspaceFiles, items);
    detectMissingDeps(cwd, allWorkspaceFiles, items);
    checksRun.push("deps");
  } else {
    checksSkipped.push({ check: "deps", reason: "no package.json" });
  }

  // 5. Unused files — only run when doing a workspace-wide scan
  if (workspaceWide) {
    const allWorkspaceFiles = getWorkspaceSourceFiles(cwd);
    detectUnusedFiles(cwd, allWorkspaceFiles, items);
    checksRun.push("unused-files");
  }

  // Deduplicate by path+line+kind
  const seen = new Set<string>();
  const unique = items.filter((item) => {
    const key = `${item.path}:${item.line}:${item.kind}:${item.symbol ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort: safe removals first, then by file+line
  unique.sort((a, b) => {
    if (a.safety !== b.safety) return a.safety === "safe" ? -1 : 1;
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.line - b.line;
  });

  return {
    totalItems: unique.length,
    safeToRemoveCount: unique.filter((i) => i.safety === "safe").length,
    reviewRequiredCount: unique.filter((i) => i.safety === "review-required").length,
    items: unique,
    checksRun,
    checksSkipped,
  };
}

// ─── TypeScript unused detection ─────────────────────────────────────────────

function detectUnusedViaTypeScript(
  _files: string[],
  cwd: string
): { items: TraceItem[]; skipped: boolean; reason?: string } {
  const tscBin = findBin(cwd, "tsc");
  if (!tscBin) return { items: [], skipped: true, reason: "tsc not found" };

  const tsconfigPath = join(cwd, "tsconfig.json");
  if (!existsSync(tsconfigPath)) return { items: [], skipped: true, reason: "tsconfig.json not found" };

  let output = "";
  try {
    execSync(
      `"${tscBin}" --noEmit --pretty false --noUnusedLocals --noUnusedParameters -p "${tsconfigPath}"`,
      { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return { items: [], skipped: false };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    output = [e.stdout, e.stderr].filter(Boolean).join("\n");
  }

  const items: TraceItem[] = [];
  const lineRe = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;
  const unusedCodes = new Set(["TS6133", "TS6196", "TS6192", "TS6205", "TS6198"]);

  for (const line of output.split("\n")) {
    const match = line.trim().match(lineRe);
    if (!match) continue;
    const [, filePath, lineStr, , code, message] = match;
    if (!unusedCodes.has(code)) continue;

    const lineNum = parseInt(lineStr, 10);
    const relPath = toRelative(cwd, filePath.trim());
    const ctx = getLines(relPath, cwd, lineNum);
    if (!ctx) continue;

    const kind = inferTsKind(message);
    const symbol = extractSymbol(message);

    items.push({
      path: relPath,
      line: lineNum,
      kind,
      symbol,
      sourceLine: ctx.line.trim(),
      sourceContext: ctx.context,
      safety: "safe",
      removeInstruction: buildRemoveInstruction(kind, symbol, relPath, lineNum, ctx.line),
    });
  }

  return { items, skipped: false };
}

// ─── ESLint unused detection ──────────────────────────────────────────────────

function detectUnusedViaEslint(
  files: string[],
  cwd: string
): { items: TraceItem[]; skipped: boolean; reason?: string } {
  const eslintBin = findBin(cwd, "eslint");
  if (!eslintBin) return { items: [], skipped: true, reason: "eslint not found" };

  const eligible = files.filter((f) =>
    [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".vue"].some((ext) => f.endsWith(ext))
  );
  if (eligible.length === 0) return { items: [], skipped: true, reason: "no eligible files" };

  const rule = JSON.stringify({
    "no-unused-vars": ["warn", { vars: "all", args: "none", ignoreRestSiblings: true }],
    "@typescript-eslint/no-unused-vars": ["warn", { vars: "all", args: "none", ignoreRestSiblings: true }],
  });

  let stdout = "";
  try {
    stdout = execSync(
      `"${eslintBin}" --format json --rule '${rule}' ${eligible.map((f) => `"${f}"`).join(" ")}`,
      { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
  } catch (err: unknown) {
    const e = err as { stdout?: string };
    if (e.stdout) stdout = e.stdout;
    else return { items: [], skipped: true, reason: "eslint failed" };
  }

  let results: { filePath: string; messages: { ruleId: string | null; message: string; line: number }[] }[] = [];
  try { results = JSON.parse(stdout); } catch { return { items: [], skipped: true, reason: "eslint parse error" }; }

  const items: TraceItem[] = [];
  for (const file of results) {
    const relPath = relative(cwd, file.filePath);
    for (const msg of file.messages) {
      if (!msg.ruleId?.includes("no-unused-vars")) continue;
      const ctx = getLines(relPath, cwd, msg.line);
      if (!ctx) continue;
      const symbol = extractSymbol(msg.message);
      const kind = inferKindFromLine(ctx.line);
      items.push({
        path: relPath,
        line: msg.line,
        kind,
        symbol,
        sourceLine: ctx.line.trim(),
        sourceContext: ctx.context,
        safety: "safe",
        removeInstruction: buildRemoveInstruction(kind, symbol, relPath, msg.line, ctx.line),
      });
    }
  }
  return { items, skipped: false };
}

// ─── Pattern-based detection ──────────────────────────────────────────────────

function detectViaPatterns(
  files: string[],
  cwd: string,
  stack: DetectedStack
): TraceItem[] {
  const items: TraceItem[] = [];

  for (const file of files) {
    const absPath = join(cwd, file);
    if (!existsSync(absPath)) continue;

    let content: string;
    try { content = readFileSync(absPath, "utf8"); } catch { continue; }

    const lines = content.split("\n");

    lines.forEach((line, idx) => {
      const lineNum = idx + 1;
      const trimmed = line.trim();
      const ctx = buildContext(lines, idx);

      // Commented-out code blocks (not doc comments)
      if (
        /^\/\/\s*(const|let|var|function|import|export|return|if|for|class)\s/.test(trimmed) ||
        /^\/\/\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*[=(]/.test(trimmed)
      ) {
        items.push({
          path: file,
          line: lineNum,
          kind: "commented-code",
          sourceLine: trimmed,
          sourceContext: ctx,
          safety: "safe",
          removeInstruction: `L${lineNum}: Delete commented-out code: \`${trimmed.slice(0, 80)}\``,
        });
      }

      // Dead code after return (simple single-line check)
      if (idx > 0 && /^\s*return\b/.test(lines[idx - 1]) && trimmed && !trimmed.startsWith("}") && !trimmed.startsWith("//")) {
        const prevTrimmed = lines[idx - 1].trim();
        if (!prevTrimmed.includes("=>") && prevTrimmed !== "return") {
          items.push({
            path: file,
            line: lineNum,
            kind: "dead-code-after-return",
            sourceLine: trimmed,
            sourceContext: ctx,
            safety: "safe",
            removeInstruction: `L${lineNum}: Dead code after return — delete this line.`,
          });
        }
      }

      // Empty functions (Vue/TS/JS)
      if (/\)\s*\{\s*\}$/.test(trimmed) || /\)\s*=>\s*\{\s*\}/.test(trimmed)) {
        if (/\bfunction\b|\bconst\s+\w+\s*=/.test(trimmed)) {
          items.push({
            path: file,
            line: lineNum,
            kind: "empty-function",
            sourceLine: trimmed,
            sourceContext: ctx,
            safety: "review-required",
            safetyNote: "Empty function may be a placeholder or interface implementation.",
            removeInstruction: `L${lineNum}: Empty function — verify it's not required by an interface or lifecycle hook, then delete.`,
          });
        }
      }

      // Duplicate imports (same module imported twice)
      if (/^import\s/.test(trimmed)) {
        const fromMatch = trimmed.match(/from\s+['"](.+?)['"]/);
        if (fromMatch) {
          const importedFrom = fromMatch[1];
          const restOfFile = lines.slice(idx + 1).join("\n");
          const dupPattern = new RegExp(`import[^;]+from\\s+['"]${importedFrom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`);
          if (dupPattern.test(restOfFile)) {
            items.push({
              path: file,
              line: lineNum,
              kind: "duplicate-import",
              symbol: importedFrom,
              sourceLine: trimmed,
              sourceContext: ctx,
              safety: "safe",
              removeInstruction: `L${lineNum}: Duplicate import from '${importedFrom}' — merge with the later import and delete this line.`,
            });
          }
        }
      }

      // Vue-specific: unused registered components
      if (file.endsWith(".vue") && stack.primary === "vue") {
        if (/components\s*:\s*\{/.test(trimmed)) {
          for (let j = idx + 1; j < Math.min(idx + 20, lines.length); j++) {
            const compLine = lines[j].trim();
            const compMatch = compLine.match(/^\s*([A-Z][a-zA-Z0-9]+)\s*[,}]/);
            if (compMatch) {
              const compName = compMatch[1];
              const templateContent = content.slice(content.indexOf("<template>"));
              if (!templateContent.includes(`<${compName}`) && !templateContent.includes(`<${toKebab(compName)}`)) {
                const compCtx = buildContext(lines, j);
                items.push({
                  path: file,
                  line: j + 1,
                  kind: "unused-export",
                  symbol: compName,
                  sourceLine: compLine,
                  sourceContext: compCtx,
                  safety: "safe",
                  removeInstruction: `L${j + 1}: Component '${compName}' registered but never used in template — remove from components:{} and delete the import.`,
                });
              }
            }
            if (compLine.includes("}")) break;
          }
        }
      }
    });

    // Detect unused exported symbols by checking if they're referenced anywhere in the workspace
    if (stack.hasTypeScript && (file.endsWith(".ts") || file.endsWith(".vue"))) {
      detectUnusedExports(file, cwd, content, items);
    }

    // NEW: Unused private class members
    if (file.endsWith(".ts") || file.endsWith(".tsx") || file.endsWith(".vue")) {
      detectUnusedClassMembers(file, content, items);
    }

    // NEW: Unused enum members
    if (file.endsWith(".ts") || file.endsWith(".tsx")) {
      detectUnusedEnumMembers(file, cwd, content, items);
    }

    // NEW: Duplicate exports
    if (file.endsWith(".ts") || file.endsWith(".tsx") || file.endsWith(".js") || file.endsWith(".mjs")) {
      detectDuplicateExports(file, content, items);
    }
  }

  return items;
}

// ─── Unused export detection ──────────────────────────────────────────────────

function detectUnusedExports(
  file: string,
  cwd: string,
  content: string,
  items: TraceItem[]
): void {
  const lines = content.split("\n");

  lines.forEach((line, idx) => {
    const trimmed = line.trim();

    const exportMatch = trimmed.match(
      /^export\s+(?:const|function|class|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/
    );
    if (!exportMatch) return;

    const symbol = exportMatch[1];
    if (["default", "setup", "defineComponent"].includes(symbol)) return;

    const searchFiles = globSync("src/**/*.{ts,tsx,vue,js}", { cwd, nodir: true });
    let refCount = 0;
    for (const f of searchFiles) {
      if (f === file) continue;
      try {
        const fc = readFileSync(join(cwd, f), "utf8");
        if (fc.includes(symbol)) { refCount++; break; }
      } catch { /* skip */ }
    }

    if (refCount === 0) {
      const ctx = buildContext(lines, idx);
      items.push({
        path: file,
        line: idx + 1,
        kind: "unused-export",
        symbol,
        sourceLine: trimmed,
        sourceContext: ctx,
        safety: "review-required",
        safetyNote: `'${symbol}' is exported but no references found in src/. Verify it's not consumed by tests or external packages before removing.`,
        removeInstruction: `L${idx + 1}: Exported '${symbol}' has no references in src/ — verify it's not used in tests/external, then delete.`,
      });
    }
  });
}

// ─── NEW: Unused private class members ───────────────────────────────────────

function detectUnusedClassMembers(
  file: string,
  content: string,
  items: TraceItem[]
): void {
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // private field: private foo = / private readonly foo: / private foo!:
    const fieldMatch = trimmed.match(/^private\s+(?:readonly\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[=:!;]/);
    // private method: private foo( / private async foo(
    const methodMatch = trimmed.match(/^private\s+(?:async\s+)?(?:static\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/);

    const name = fieldMatch?.[1] ?? methodMatch?.[1];
    if (!name || name === "constructor") continue;

    // Count this.name references excluding the declaration line
    const refRe = new RegExp(`\\bthis\\.${name}\\b`);
    let refCount = 0;
    for (let j = 0; j < lines.length; j++) {
      if (j === i) continue;
      if (refRe.test(lines[j])) { refCount++; break; }
    }

    if (refCount === 0) {
      const ctx = buildContext(lines, i);
      items.push({
        path: file,
        line: i + 1,
        kind: "unused-class-member",
        symbol: name,
        sourceLine: trimmed,
        sourceContext: ctx,
        safety: "safe",
        removeInstruction: `${file}:${i + 1}: Private member '${name}' is never referenced (no this.${name} found) — delete the declaration.`,
      });
    }
  }
}

// ─── NEW: Unused enum members ─────────────────────────────────────────────────

function detectUnusedEnumMembers(
  file: string,
  cwd: string,
  content: string,
  items: TraceItem[]
): void {
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const enumMatch = lines[i].trim().match(/^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\{/);
    if (!enumMatch) continue;

    const enumName = enumMatch[1];
    const members: { name: string; lineIdx: number }[] = [];

    for (let j = i + 1; j < lines.length; j++) {
      const memberLine = lines[j].trim();
      if (memberLine.startsWith("}")) break;
      // Match enum member names (allow string/numeric values)
      const memberMatch = memberLine.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*[=,}]?/);
      if (memberMatch && memberMatch[1] !== "") {
        members.push({ name: memberMatch[1], lineIdx: j });
      }
    }

    const searchFiles = globSync("src/**/*.{ts,tsx,vue,js}", { cwd, nodir: true });

    for (const member of members) {
      const refPattern = new RegExp(`${enumName}\\.${member.name}\\b`);
      let found = false;

      for (const f of searchFiles) {
        try {
          const fc = readFileSync(join(cwd, f), "utf8");
          if (refPattern.test(fc)) { found = true; break; }
        } catch {}
      }

      if (!found) {
        const ctx = buildContext(lines, member.lineIdx);
        items.push({
          path: file,
          line: member.lineIdx + 1,
          kind: "unused-enum-member",
          symbol: `${enumName}.${member.name}`,
          sourceLine: lines[member.lineIdx].trim(),
          sourceContext: ctx,
          safety: "review-required",
          safetyNote: `Enum member '${enumName}.${member.name}' has no references in src/. May be used externally or in tests.`,
          removeInstruction: `${file}:${member.lineIdx + 1}: Enum member '${enumName}.${member.name}' has no references — verify it's not used in tests/external, then delete.`,
        });
      }
    }
  }
}

// ─── NEW: Duplicate exports ───────────────────────────────────────────────────

function detectDuplicateExports(
  file: string,
  content: string,
  items: TraceItem[]
): void {
  const lines = content.split("\n");
  const exportedSymbols = new Map<string, number>(); // symbol → first export line (1-based)

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Named export declaration: export const/function/class/type/interface/enum Foo
    const namedMatch = trimmed.match(
      /^export\s+(?:const|function|async\s+function|class|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/
    );
    if (namedMatch) {
      const sym = namedMatch[1];
      if (exportedSymbols.has(sym)) {
        const ctx = buildContext(lines, i);
        items.push({
          path: file,
          line: i + 1,
          kind: "duplicate-export",
          symbol: sym,
          sourceLine: trimmed,
          sourceContext: ctx,
          safety: "safe",
          safetyNote: `'${sym}' was first exported at line ${exportedSymbols.get(sym)}.`,
          removeInstruction: `${file}:${i + 1}: '${sym}' duplicate export (first at L${exportedSymbols.get(sym)}) — remove this declaration.`,
        });
      } else {
        exportedSymbols.set(sym, i + 1);
      }
    }

    // Re-export list: export { Foo, Bar as Baz }
    const reExportMatch = trimmed.match(/^export\s*\{([^}]+)\}/);
    if (reExportMatch) {
      const symbols = reExportMatch[1].split(",").map((s) => {
        const parts = s.trim().split(/\s+as\s+/);
        return (parts[1] ?? parts[0]).trim();
      }).filter(Boolean);

      for (const sym of symbols) {
        if (exportedSymbols.has(sym)) {
          const ctx = buildContext(lines, i);
          items.push({
            path: file,
            line: i + 1,
            kind: "duplicate-export",
            symbol: sym,
            sourceLine: trimmed,
            sourceContext: ctx,
            safety: "safe",
            safetyNote: `'${sym}' was first exported at line ${exportedSymbols.get(sym)}.`,
            removeInstruction: `${file}:${i + 1}: '${sym}' duplicate re-export (first at L${exportedSymbols.get(sym)}) — remove from this export list.`,
          });
        } else {
          exportedSymbols.set(sym, i + 1);
        }
      }
    }
  }
}

// ─── NEW: Workspace source files ─────────────────────────────────────────────

/**
 * Returns all source files across the workspace (including monorepo packages).
 */
function getWorkspaceSourceFiles(cwd: string): string[] {
  const patterns = [
    "src/**/*.{ts,tsx,vue,js,jsx,mjs}",
    "lib/**/*.{ts,js}",
    "app/**/*.{ts,vue,js}",
    "packages/*/src/**/*.{ts,tsx,vue,js,jsx}",
    "apps/*/src/**/*.{ts,tsx,vue,js,jsx}",
  ];
  return globSync(patterns, {
    cwd,
    nodir: true,
    ignore: ["node_modules/**", "dist/**", "**/*.d.ts", "**/*.spec.*", "**/*.test.*"],
  });
}

/**
 * Detects monorepo workspace roots (npm/yarn workspaces + pnpm).
 * Returns all workspace package paths (relative to cwd).
 */
function getWorkspacePackageDirs(cwd: string): string[] {
  const dirs: string[] = [];

  // npm / yarn workspaces in package.json
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
      const ws = pkg.workspaces;
      const patterns: string[] = Array.isArray(ws)
        ? ws as string[]
        : (ws as { packages?: string[] } | undefined)?.packages ?? [];
      for (const pattern of patterns) {
        // Find package.json files to discover workspace package directories
        const pkgJsonFiles = globSync(`${pattern.replace(/\/?$/, "")}/package.json`, { cwd, ignore: ["node_modules/**"] });
        dirs.push(...pkgJsonFiles.map((f) => f.replace(/\/package\.json$/, "")));
      }
    } catch {}
  }

  // pnpm workspaces
  const pnpmWs = join(cwd, "pnpm-workspace.yaml");
  if (existsSync(pnpmWs)) {
    try {
      const content = readFileSync(pnpmWs, "utf8");
      const packageLines = content.match(/- ['"]?([^'"\n]+)['"]?/g) ?? [];
      for (const line of packageLines) {
        const pattern = line.replace(/- ['"]?([^'"\n]+)['"]?/, "$1").trim();
        if (!pattern) continue;
        const pkgJsonFiles = globSync(`${pattern.replace(/\/?$/, "")}/package.json`, { cwd, ignore: ["node_modules/**"] });
        dirs.push(...pkgJsonFiles.map((f) => f.replace(/\/package\.json$/, "")));
      }
    } catch {}
  }

  return dirs;
}

// ─── NEW: Unused files ────────────────────────────────────────────────────────

function detectUnusedFiles(
  cwd: string,
  allSourceFiles: string[],
  items: TraceItem[]
): void {
  // Entry points and patterns that are never "imported" in the traditional sense
  const ENTRY_PATTERNS = [
    /\bindex\.(ts|tsx|js|jsx|vue)$/i,
    /\bmain\.(ts|tsx|js|jsx)$/i,
    /\bApp\.(vue|tsx|jsx|ts)$/i,
    /\bapp\.(ts|tsx|js|jsx|vue)$/i,
    /\.config\.(ts|js|mjs|cjs)$/i,
    /\.d\.ts$/i,
    /\bRouter\.(ts|js)$/i,
    /\brouter\/(index|routes)\.(ts|js)$/i,
    /\bstore\/(index|pinia)\.(ts|js)$/i,
    /\bplugins\//i,
  ];

  // Build a set of all imported path fragments from all source files
  const importedFragments = new Set<string>();

  for (const file of allSourceFiles) {
    try {
      const content = readFileSync(join(cwd, file), "utf8");
      // Static imports: import X from '...' / export { X } from '...'
      const staticRe = /(?:import|export)\s+(?:.+?\s+from\s+)?['"]([^'"]+)['"]/g;
      // Dynamic imports: import('...')
      const dynamicRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      // Require: require('...')
      const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

      for (const re of [staticRe, dynamicRe, requireRe]) {
        for (const match of content.matchAll(re)) {
          importedFragments.add(match[1]);
        }
      }
    } catch {}
  }

  for (const file of allSourceFiles) {
    if (ENTRY_PATTERNS.some((p) => p.test(file))) continue;

    // Build candidate paths for this file (without extension, with/without subpath)
    const withoutExt = file.replace(/\.(ts|tsx|js|jsx|vue|mjs)$/, "");
    const fileStem = basename(file, extname(file));

    let isImported = false;
    for (const fragment of importedFragments) {
      // The import might use: './Foo', '../bar/Baz', '@/components/Foo', 'Foo' etc.
      if (
        fragment.endsWith("/" + fileStem) ||
        fragment.endsWith("/" + fileStem + ".vue") ||
        fragment.endsWith("/" + fileStem + ".ts") ||
        fragment.includes(withoutExt) ||
        fragment === `./${fileStem}` ||
        fragment === fileStem
      ) {
        isImported = true;
        break;
      }
    }

    if (!isImported) {
      items.push({
        path: file,
        line: 1,
        kind: "unused-file",
        sourceLine: `// ${file}`,
        sourceContext: `→ 1: (entire file — no imports found in workspace)`,
        safety: "review-required",
        safetyNote: `File has no imports from other source files. May be a route component, lazy-loaded module, or test fixture.`,
        removeInstruction: `FILE '${file}': No other source file imports it. Verify it's not a route, dynamic import target, or fixture — then delete the file.`,
      });
    }
  }
}

// ─── NEW: Unnecessary dependencies ───────────────────────────────────────────

/**
 * Packages that are legitimately used without direct imports (build tools, type packages, etc.)
 */
const SKIP_DEP_CHECK = new Set([
  "typescript", "ts-node", "ts-jest",
  "@types/node", "@types/vue", "@types/react", "@types/react-dom",
  "eslint", "prettier", "husky", "lint-staged", "commitlint",
  "@commitlint/cli", "@commitlint/config-conventional",
  "vite", "webpack", "rollup", "esbuild", "parcel",
  "vitest", "jest", "mocha", "chai", "jasmine", "karma",
  "@vue/test-utils", "@testing-library/vue", "@testing-library/react",
  "vue-tsc", "nodemon", "concurrently", "cross-env",
  "@vitejs/plugin-vue", "@vitejs/plugin-react",
  "postcss", "autoprefixer", "tailwindcss", "sass",
]);

function detectUnusedDeps(
  cwd: string,
  allSourceFiles: string[],
  items: TraceItem[]
): void {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return;

  let pkg: Record<string, unknown>;
  try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); } catch { return; }

  const deps: Record<string, string> = {
    ...(pkg.dependencies as Record<string, string> | undefined ?? {}),
    ...(pkg.devDependencies as Record<string, string> | undefined ?? {}),
  };

  // Also scan config files and root-level JS files for require/import
  const configFiles = globSync("*.{ts,js,mjs,cjs}", { cwd, nodir: true, ignore: ["node_modules/**"] });
  const filesToScan = [...allSourceFiles, ...configFiles];

  // Build set of all imported package names
  const importedPkgs = new Set<string>();
  for (const file of filesToScan) {
    try {
      const content = readFileSync(join(cwd, file), "utf8");
      const importRe = /from\s+['"]([^'"./][^'"]*)['"]/g;
      const requireRe = /require\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g;
      for (const re of [importRe, requireRe]) {
        for (const match of content.matchAll(re)) {
          const raw = match[1];
          // Normalise to package root: '@org/pkg/subpath' → '@org/pkg'
          const pkgRoot = raw.startsWith("@")
            ? raw.split("/").slice(0, 2).join("/")
            : raw.split("/")[0];
          importedPkgs.add(pkgRoot);
        }
      }
    } catch {}
  }

  const pkgLines = readFileSync(pkgPath, "utf8").split("\n");

  for (const [depName, version] of Object.entries(deps)) {
    if (SKIP_DEP_CHECK.has(depName)) continue;
    if (depName.startsWith("@types/")) continue;
    if (depName.startsWith("eslint-")) continue;
    if (depName.startsWith("@typescript-eslint/")) continue;
    if (depName.startsWith("@eslint/")) continue;
    if (depName.startsWith("babel-")) continue;
    if (depName.startsWith("@babel/")) continue;
    if (importedPkgs.has(depName)) continue;

    // Find line number in package.json
    const lineIdx = pkgLines.findIndex((l) => l.includes(`"${depName}"`));
    const lineNum = lineIdx >= 0 ? lineIdx + 1 : 1;
    const sourceLine = pkgLines[lineIdx]?.trim() ?? `"${depName}": "${version}"`;

    items.push({
      path: "package.json",
      line: lineNum,
      kind: "unused-dep",
      symbol: depName,
      sourceLine,
      sourceContext: `→ ${lineNum}: ${sourceLine}`,
      safety: "review-required",
      safetyNote: `'${depName}' is in package.json but no source file imports it. May be used in config files or scripts not scanned.`,
      removeInstruction: `package.json:${lineNum}: '${depName}' appears unused in source files — verify then run: npm uninstall ${depName}`,
    });
  }
}

// ─── NEW: Missing dependencies ────────────────────────────────────────────────

/** Node.js built-in module names */
const NODE_BUILTINS = new Set([
  "fs", "path", "os", "child_process", "http", "https", "net", "stream",
  "events", "util", "crypto", "buffer", "url", "querystring", "readline",
  "module", "assert", "zlib", "dns", "cluster", "worker_threads", "vm",
  "perf_hooks", "inspector", "tls", "dgram", "v8", "process", "timers",
  "string_decoder", "domain", "punycode", "constants",
]);

function detectMissingDeps(
  cwd: string,
  allSourceFiles: string[],
  items: TraceItem[]
): void {
  const pkgPath = join(cwd, "package.json");
  let allKnownDeps = new Set<string>();

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
      const allDeps: Record<string, string> = {
        ...(pkg.dependencies as Record<string, string> ?? {}),
        ...(pkg.devDependencies as Record<string, string> ?? {}),
        ...(pkg.peerDependencies as Record<string, string> ?? {}),
        ...(pkg.optionalDependencies as Record<string, string> ?? {}),
      };
      allKnownDeps = new Set(Object.keys(allDeps));
    } catch {}
  }

  // Also grab workspace packages so cross-package imports aren't flagged
  const workspacePkgDirs = getWorkspacePackageDirs(cwd);
  for (const dir of workspacePkgDirs) {
    const wpPkg = join(cwd, dir, "package.json");
    if (existsSync(wpPkg)) {
      try {
        const p = JSON.parse(readFileSync(wpPkg, "utf8")) as { name?: string };
        if (p.name) allKnownDeps.add(p.name);
      } catch {}
    }
  }

  // Track missing packages (first occurrence only)
  const missing = new Map<string, { file: string; line: number; importLine: string }>();

  for (const file of allSourceFiles) {
    try {
      const content = readFileSync(join(cwd, file), "utf8");
      const lines = content.split("\n");

      lines.forEach((line, idx) => {
        // Match top-level imports only (not dynamic, not require inside functions)
        const importMatch = line.match(/^import\s+.+\s+from\s+['"]([^'"./][^'"]*)['"]/);
        const requireMatch = line.match(/^(?:const|let|var)\s+.+\s*=\s*require\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/);
        const raw = importMatch?.[1] ?? requireMatch?.[1];
        if (!raw) return;

        const pkgRoot = raw.startsWith("@")
          ? raw.split("/").slice(0, 2).join("/")
          : raw.split("/")[0];

        if (
          !allKnownDeps.has(pkgRoot) &&
          !NODE_BUILTINS.has(pkgRoot) &&
          !missing.has(pkgRoot)
        ) {
          missing.set(pkgRoot, { file, line: idx + 1, importLine: line.trim() });
        }
      });
    } catch {}
  }

  for (const [pkgName, { file, line, importLine }] of missing) {
    items.push({
      path: file,
      line,
      kind: "missing-dep",
      symbol: pkgName,
      sourceLine: importLine,
      sourceContext: `→ ${line}: ${importLine}`,
      safety: "review-required",
      safetyNote: `'${pkgName}' is imported but not listed in package.json.`,
      removeInstruction: `${file}:${line}: '${pkgName}' is imported but missing from package.json — run: npm install ${pkgName}`,
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findBin(cwd: string, name: string): string | null {
  const local = join(cwd, "node_modules", ".bin", name);
  if (existsSync(local)) return local;
  try {
    const g = execSync(`which ${name}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    return g || null;
  } catch { return null; }
}

function toRelative(cwd: string, filePath: string): string {
  try { return relative(cwd, join(cwd, filePath)); } catch { return filePath; }
}

function getLines(
  relPath: string,
  cwd: string,
  lineNum: number
): { line: string; context: string } | undefined {
  const absPath = join(cwd, relPath);
  if (!existsSync(absPath)) return undefined;
  try {
    const lines = readFileSync(absPath, "utf8").split("\n");
    const idx = lineNum - 1;
    return { line: lines[idx] ?? "", context: buildContext(lines, idx) };
  } catch { return undefined; }
}

function buildContext(lines: string[], idx: number): string {
  const parts: string[] = [];
  if (idx > 0) parts.push(`  ${idx}: ${lines[idx - 1]?.trimEnd() ?? ""}`);
  parts.push(`→ ${idx + 1}: ${lines[idx]?.trimEnd() ?? ""}`);
  if (idx < lines.length - 1) parts.push(`  ${idx + 2}: ${lines[idx + 1]?.trimEnd() ?? ""}`);
  return parts.join("\n");
}

function inferTsKind(message: string): TraceKind {
  if (/is declared but|declared but never read/i.test(message)) return "unused-variable";
  if (/is defined but never used/i.test(message)) return "unused-function";
  if (/import .+ is never used/i.test(message)) return "unused-import";
  if (/type .+ is declared but/i.test(message)) return "unused-type";
  if (/class .+ is declared but/i.test(message)) return "unused-class";
  return "unused-variable";
}

function inferKindFromLine(line: string): TraceKind {
  const t = line.trim();
  if (/^import\s/.test(t)) return "unused-import";
  if (/\bfunction\b/.test(t)) return "unused-function";
  if (/\bclass\b/.test(t)) return "unused-class";
  if (/\btype\b|\binterface\b/.test(t)) return "unused-type";
  return "unused-variable";
}

function extractSymbol(message: string): string | undefined {
  const match = message.match(/'([^']+)'/) ?? message.match(/"([^"]+)"/);
  return match?.[1];
}

function buildRemoveInstruction(
  kind: TraceKind,
  symbol: string | undefined,
  path: string,
  line: number,
  sourceLine: string
): string {
  const loc = `${path}:${line}`;
  const sym = symbol ? `'${symbol}'` : "this";
  switch (kind) {
    case "unused-import":
      return `${loc}: Remove unused import ${sym} — delete the entire import line or remove ${sym} from the import list.`;
    case "unused-variable":
      return `${loc}: Remove unused variable ${sym} — delete the declaration${sourceLine.includes("const") || sourceLine.includes("let") ? " (entire line)" : ""}.`;
    case "unused-function":
      return `${loc}: Remove unused function ${sym} — delete the entire function definition.`;
    case "unused-type":
      return `${loc}: Remove unused type/interface ${sym} — delete the type declaration.`;
    case "unused-class":
      return `${loc}: Remove unused class ${sym} — delete the class definition.`;
    case "unused-class-member":
      return `${loc}: Remove unused private class member ${sym} — delete the declaration.`;
    case "unused-enum-member":
      return `${loc}: Remove unused enum member ${sym} — delete the enum member line.`;
    case "duplicate-export":
      return `${loc}: Remove duplicate export of ${sym} — keep one export declaration and delete this.`;
    case "unused-dep":
      return `${loc}: Remove unused dependency ${sym} — run: npm uninstall ${symbol ?? ""}`;
    case "missing-dep":
      return `${loc}: Add missing dependency ${sym} — run: npm install ${symbol ?? ""}`;
    case "unused-file":
      return `FILE ${path}: No imports found — verify it's not a route/dynamic import, then delete the file.`;
    default:
      return `${loc}: Remove ${sym}.`;
  }
}

function toKebab(str: string): string {
  return str.replace(/([A-Z])/g, (m, l, i) => (i ? "-" : "") + l.toLowerCase());
}
