import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, relative } from "path";
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
  | "duplicate-import";

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
  stack: DetectedStack
): TraceCodeResult {
  const items: TraceItem[] = [];
  const checksRun: string[] = [];
  const checksSkipped: { check: string; reason: string }[] = [];

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

  // 3. Pattern-based checks (all stacks)
  const patternResult = detectViaPatterns(files, cwd, stack);
  checksRun.push("patterns");
  items.push(...patternResult);

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
    // Run with noUnusedLocals + noUnusedParameters overrides
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
          // Check next lines for component registrations
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

    // Find named exports that are not re-exports
    const exportMatch = trimmed.match(
      /^export\s+(?:const|function|class|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/
    );
    if (!exportMatch) return;

    const symbol = exportMatch[1];
    // Skip default exports and common entry-point names
    if (["default", "setup", "defineComponent"].includes(symbol)) return;

    // Search the rest of the codebase for references
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
    default:
      return `${loc}: Remove ${sym}.`;
  }
}

function toKebab(str: string): string {
  return str.replace(/([A-Z])/g, (m, l, i) => (i ? "-" : "") + l.toLowerCase());
}
