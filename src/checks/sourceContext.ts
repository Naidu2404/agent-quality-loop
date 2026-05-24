import { existsSync, readFileSync } from "fs";
import { join } from "path";

/** Cache file contents per path to avoid re-reading within a single review run */
const fileCache = new Map<string, string[]>();

export function clearCache() {
  fileCache.clear();
}

/**
 * Returns the source line at a given 1-based line number, and 1 line of surrounding context.
 */
export function getSourceContext(
  relPath: string,
  cwd: string,
  line: number
): { sourceLine: string; sourceContext: string } | undefined {
  const absPath = join(cwd, relPath);
  if (!existsSync(absPath)) return undefined;

  let lines = fileCache.get(absPath);
  if (!lines) {
    try {
      lines = readFileSync(absPath, "utf8").split("\n");
      fileCache.set(absPath, lines);
    } catch {
      return undefined;
    }
  }

  const idx = line - 1; // convert to 0-based
  const sourceLine = (lines[idx] ?? "").trimEnd();

  const contextLines: string[] = [];
  if (idx > 0) contextLines.push(`  ${line - 1}: ${lines[idx - 1]?.trimEnd() ?? ""}`);
  contextLines.push(`→ ${line}: ${sourceLine}`);
  if (idx < lines.length - 1) contextLines.push(`  ${line + 1}: ${lines[idx + 1]?.trimEnd() ?? ""}`);

  return { sourceLine: sourceLine.trim(), sourceContext: contextLines.join("\n") };
}
