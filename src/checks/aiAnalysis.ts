/**
 * AI-powered analysis check — calls your chosen LLM to detect:
 *   • Security vulnerabilities (OWASP Top 10, injection, XSS, insecure crypto, etc.)
 *   • Sonar-style quality issues (cognitive complexity, resource leaks, code smells)
 *   • Dependency misuse patterns (unsafe eval, prototype pollution, command injection)
 *
 * Supported providers (set checks.ai.provider in .quality-loop.json):
 *   • groq      — GROQ_API_KEY       — llama-3.1-8b-instant (free tier, cloud, no download)
 *   • anthropic — ANTHROPIC_API_KEY  — claude-haiku-4-5-20251001
 *   • openai    — OPENAI_API_KEY     — gpt-4o-mini
 *   • gemini    — GEMINI_API_KEY     — gemini-1.5-flash (free tier)
 *   • ollama    — no key needed      — llama3.2 (runs locally, explicit only)
 *
 * The provider auto-detects which key is present if none is explicitly configured.
 * With no key set, AI analysis is gracefully skipped with a setup hint.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { Issue, AiCheckConfig, AiProvider } from "../types.js";
import { ensureOllamaReady, DEFAULT_OLLAMA_MODEL } from "./ollamaManager.js";

interface CheckResult {
  issues: Issue[];
  skipped: boolean;
  skipReason?: string;
  providerUsed?: string;
}

interface AiIssue {
  path: string;
  line: number;
  severity: "error" | "warning" | "info";
  category: "security" | "sonar" | "dependencies";
  ruleId: string;
  message: string;
  fixHint: string;
}

// Default cheap/fast models per provider
const DEFAULT_MODELS: Record<AiProvider, string> = {
  groq:      "llama-3.1-8b-instant",
  anthropic: "claude-haiku-4-5-20251001",
  openai:    "gpt-4o-mini",
  gemini:    "gemini-1.5-flash",
  ollama:    "llama3.2",
};

const DEFAULT_MAX_FILE_KB = 40;

// Groq free tier: llama-3.1-8b-instant has ~8K token context window.
// ~1 token per 4 chars — keep total prompt under 28K chars (~7K tokens) to leave room for output.
const GROQ_SAFE_PROMPT_CHARS = 28_000;

/**
 * High-risk patterns that warrant targeted AI analysis even when the file is too large
 * to send in full. Each pattern captures dangerous constructs that AI should see in context.
 */
const HIGH_RISK_PATTERNS: RegExp[] = [
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /innerHTML\s*=/,
  /outerHTML\s*=/,
  /document\.write\s*\(/,
  /dangerouslySetInnerHTML/,
  /v-html\s*=/,
  /\bexec\s*\(/,
  /child_process/,
  /\.query\s*\(\s*[`'"].*\$\{/,            // template-literal SQL
  /require\s*\(\s*[^'"]/,                   // dynamic require
  /Math\.random\s*\(\s*\).*(?:token|secret|key|password|salt)/i,
  // Hardcoded credentials — name-based
  /(?:password|passwd|secret|api[_\-]?key|apikey|token|auth[_\-]?token|credential|private[_\-]?key|access[_\-]?key|client[_\-]?secret|bearer)\s*[:=]\s*['"`][^'"`\s]{8,}/i,
  // Hardcoded credentials — value-based (known API key patterns)
  /['"`](?:sk-[a-zA-Z0-9]{20,}|sk-ant-|gsk_[a-zA-Z0-9]{20,}|gh[pors]_[a-zA-Z0-9]{20,}|npm_[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16}|AIza[0-9A-Za-z\-_]{20,}|xox[baprs]-|sk_live_|pk_live_)/,
  /\bmd5\b|\bsha1\b/i,
  /crypto\.createHash\s*\(\s*['"](?:md5|sha1)['"]/,
  /res\.redirect\s*\(.*req\./,
  /window\.location\s*=.*(?:req\.|query\.|params\.)/,
  /JSON\.parse\s*\(.*req\./,
  /prototype\[/,
  /\.__proto__\s*=/,
];

export async function runAiAnalysis(
  files: string[],
  cwd: string,
  config: AiCheckConfig,
  iteration: number
): Promise<CheckResult> {
  // Honour runOnIteration — skip on retries by default
  const runOnIteration = config.runOnIteration ?? 1;
  if (runOnIteration !== "all" && iteration !== runOnIteration) {
    return {
      issues: [],
      skipped: true,
      skipReason: `AI analysis runs on iteration ${runOnIteration} only (current: ${iteration})`,
    };
  }

  // Resolve which provider to use (null = no key configured, skip gracefully)
  const provider = resolveProvider(config.provider);
  if (provider === null) {
    return {
      issues: [],
      skipped: true,
      skipReason:
        "No AI provider configured. Get a free Groq key for AI security analysis: " +
        "https://console.groq.com/keys — then set GROQ_API_KEY in your environment, " +
        "or run: npx agent-quality-loop --configure",
    };
  }

  const model = config.model ?? DEFAULT_MODELS[provider];
  const maxKb = config.maxFileSizeKb ?? DEFAULT_MAX_FILE_KB;
  const focus = config.focus ?? ["security", "sonar", "dependencies"];

  // Build file content map
  const fileContents: { path: string; content: string }[] = [];
  const eligible = files.filter((f) =>
    /\.(ts|tsx|vue|js|jsx|mjs|py|java|go|rb|php|cs)$/.test(f)
  );

  for (const relPath of eligible) {
    const absPath = relPath.startsWith("/") ? relPath : join(cwd, relPath);
    if (!existsSync(absPath)) continue;
    try {
      const raw = readFileSync(absPath, "utf8");
      fileContents.push({ path: relPath, content: truncateToKb(raw, maxKb) });
    } catch {
      // skip unreadable files
    }
  }

  if (fileContents.length === 0) {
    return { issues: [], skipped: true, skipReason: "No eligible source files to analyse" };
  }

  const systemPrompt = buildSystemPrompt();

  // Apply smart chunking for Groq (token-limited free tier)
  const optimisedContents = buildFileContentsForPrompt(
    fileContents,
    systemPrompt,
    focus,
    provider === "groq"
  );

  if (optimisedContents.length === 0) {
    return {
      issues: [],
      skipped: true,
      skipReason: "AI analysis skipped: files are too large and contain no high-risk patterns (safe to proceed)",
    };
  }

  const userPrompt = buildUserPrompt(optimisedContents, focus);

  try {
    let responseText: string;

    switch (provider) {
      case "groq":
        responseText = await callGroq(model, systemPrompt, userPrompt);
        break;
      case "anthropic":
        responseText = await callAnthropic(model, systemPrompt, userPrompt);
        break;
      case "openai":
        responseText = await callOpenAI(model, systemPrompt, userPrompt);
        break;
      case "gemini":
        responseText = await callGemini(model, systemPrompt, userPrompt);
        break;
      case "ollama":
        responseText = await callOllama(model, systemPrompt, userPrompt, config.ollamaBaseUrl);
        break;
    }

    const aiIssues = parseAiResponse(responseText);
    const issues: Issue[] = aiIssues.map((ai) => ({
      path: ai.path,
      line: ai.line ?? 1,
      severity: ai.severity ?? "warning",
      category: mapCategory(ai.category),
      ruleId: ai.ruleId ?? "ai/unknown",
      message: ai.message,
      fixHint: ai.fixHint,
      sourceLine: getSourceLine(ai.path, cwd, ai.line ?? 1),
    }));

    return { issues, skipped: false, providerUsed: `${provider}/${model}` };
  } catch (err) {
    const errMsg = String(err);

    // Groq 413: payload still too large even after chunking — retry with risk-only snippets
    if (provider === "groq" && (errMsg.includes("413") || errMsg.includes("413-payload-too-large"))) {
      try {
        const riskOnly = fileContents
          .map((fc) => {
            const s = extractRiskSnippets(fc.content, fc.path, 8);
            return s ? { path: fc.path, content: s } : null;
          })
          .filter(Boolean) as { path: string; content: string }[];

        if (riskOnly.length === 0) {
          return {
            issues: [],
            skipped: true,
            skipReason: "AI analysis skipped: files exceed token limit and no high-risk patterns detected",
          };
        }

        const fallbackPrompt = buildUserPrompt(riskOnly, focus);
        const responseText = await callGroq(model, systemPrompt, fallbackPrompt);
        const aiIssues = parseAiResponse(responseText);
        const issues: Issue[] = aiIssues.map((ai) => ({
          path: ai.path,
          line: ai.line ?? 1,
          severity: ai.severity ?? "warning",
          category: mapCategory(ai.category),
          ruleId: ai.ruleId ?? "ai/unknown",
          message: ai.message,
          fixHint: ai.fixHint,
          sourceLine: getSourceLine(ai.path, cwd, ai.line ?? 1),
        }));
        return { issues, skipped: false, providerUsed: `${provider}/${model} (risk-scan)` };
      } catch (retryErr) {
        return {
          issues: [],
          skipped: true,
          skipReason: `AI analysis failed after risk-scan retry (${provider}/${model}): ${String(retryErr).slice(0, 200)}`,
        };
      }
    }

    return {
      issues: [],
      skipped: true,
      skipReason: `AI analysis failed (${provider}/${model}): ${errMsg.slice(0, 200)}`,
    };
  }
}

// ─── Provider resolution ──────────────────────────────────────────────────────

/**
 * Resolves the provider to use, or null if no key is configured.
 *
 * Priority:
 *   1. Explicitly configured provider in .quality-loop.json
 *   2. API key auto-detection: anthropic → openai → gemini → groq
 *   3. null — AI analysis is skipped; user sees a setup hint pointing to Groq (free)
 *
 * Note: ollama is only used when explicitly configured — it is NOT an auto-fallback.
 */
function resolveProvider(configured?: AiProvider): AiProvider | null {
  if (configured) return configured;
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY)    return "openai";
  if (process.env.GEMINI_API_KEY)    return "gemini";
  if (process.env.GROQ_API_KEY)      return "groq";
  return null; // No key — skip AI analysis gracefully
}

// ─── Provider API calls ───────────────────────────────────────────────────────

async function callAnthropic(model: string, system: string, user: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${err.slice(0, 200)}`);
  }

  const data = await response.json() as { content: { type: string; text: string }[] };
  return data.content?.find((b) => b.type === "text")?.text ?? "[]";
}

async function callOpenAI(model: string, system: string, user: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY!;
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${err.slice(0, 200)}`);
  }

  const data = await response.json() as { choices: { message: { content: string } }[] };
  const content = data.choices?.[0]?.message?.content ?? "[]";
  // OpenAI json_object mode wraps in an object — unwrap if needed
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return content;
    // Some models return { issues: [...] }
    const arr = parsed.issues ?? parsed.results ?? parsed.findings ?? Object.values(parsed)[0];
    return Array.isArray(arr) ? JSON.stringify(arr) : "[]";
  } catch {
    return content;
  }
}

async function callGemini(model: string, system: string, user: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY!;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        maxOutputTokens: 4096,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API ${response.status}: ${err.slice(0, 200)}`);
  }

  const data = await response.json() as {
    candidates: { content: { parts: { text: string }[] } }[];
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
}

async function callGroq(model: string, system: string, user: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY!;
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API ${response.status}: ${err.slice(0, 200)}${response.status === 413 ? " [413-payload-too-large]" : ""}`);
  }

  const data = await response.json() as { choices: { message: { content: string } }[] };
  const content = data.choices?.[0]?.message?.content ?? "[]";
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return content;
    const arr = parsed.issues ?? parsed.results ?? parsed.findings ?? Object.values(parsed)[0];
    return Array.isArray(arr) ? JSON.stringify(arr) : "[]";
  } catch {
    return content;
  }
}

async function callOllama(
  model: string,
  system: string,
  user: string,
  baseUrl?: string
): Promise<string> {
  // ensureOllamaReady downloads, starts, and pulls the model automatically.
  // If baseUrl is overridden (pointing at a remote Ollama), skip managed startup.
  const base = baseUrl
    ? baseUrl.replace(/\/$/, "")
    : await ensureOllamaReady(model);

  const url = `${base}/api/chat`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    if (response.status === 404) {
      throw new Error(`Ollama model "${model}" not found — re-run the quality check and it will be pulled automatically`);
    }
    throw new Error(`Ollama API ${response.status}: ${err.slice(0, 200)}`);
  }

  const data = await response.json() as { message: { content: string } };
  return data.message?.content ?? "[]";
}

// ─── Smart chunking helpers ───────────────────────────────────────────────────

/** Rough token estimate: 1 token ≈ 4 chars */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Extracts lines around every HIGH_RISK_PATTERNS match with `contextLines` of context.
 * Returns a condensed version of the file that focuses on dangerous code sections.
 * If no patterns match, returns null (caller should send full/truncated file instead).
 */
function extractRiskSnippets(
  content: string,
  filePath: string,
  contextLines = 12
): string | null {
  const lines = content.split("\n");
  const matchedLineNums = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    for (const pattern of HIGH_RISK_PATTERNS) {
      if (pattern.test(lines[i])) {
        // Add context window around the match
        for (
          let j = Math.max(0, i - contextLines);
          j <= Math.min(lines.length - 1, i + contextLines);
          j++
        ) {
          matchedLineNums.add(j);
        }
        break; // one pattern match per line is enough
      }
    }
  }

  if (matchedLineNums.size === 0) return null;

  // Build snippet: emit numbered lines, insert "..." between gaps
  const sortedNums = [...matchedLineNums].sort((a, b) => a - b);
  const snippetLines: string[] = [
    `// [SMART SCAN: showing ${sortedNums.length}/${lines.length} lines matching high-risk patterns]`,
  ];
  let prev = -2;
  for (const num of sortedNums) {
    if (num > prev + 1) snippetLines.push(`// ... (lines ${prev + 2}–${num} omitted)`);
    snippetLines.push(`${num + 1}: ${lines[num]}`);
    prev = num;
  }
  if (prev < lines.length - 1) {
    snippetLines.push(`// ... (lines ${prev + 2}–${lines.length} omitted)`);
  }

  return snippetLines.join("\n");
}

/**
 * Builds file content array, switching to risk-snippet mode for files that would
 * push the total prompt over the Groq-safe limit.
 */
function buildFileContentsForPrompt(
  fileContents: { path: string; content: string }[],
  systemPrompt: string,
  focus: string[],
  isGroq: boolean
): { path: string; content: string }[] {
  if (!isGroq) return fileContents; // other providers have higher limits

  const systemTokens = estimateTokens(systemPrompt);
  const focusTokens = estimateTokens(buildFocusInstructions(focus));
  const overhead = systemTokens + focusTokens + 200; // header/footer overhead

  let budgetChars = GROQ_SAFE_PROMPT_CHARS - overhead * 4;
  const result: { path: string; content: string }[] = [];

  for (const fc of fileContents) {
    const fullChars = fc.content.length + fc.path.length + 20; // "=== FILE: ... ===\n"

    if (fullChars <= budgetChars) {
      result.push(fc);
      budgetChars -= fullChars;
    } else {
      // File is too large — try risk-snippet mode first
      const snippets = extractRiskSnippets(fc.content, fc.path);
      if (snippets !== null) {
        const snippetChars = snippets.length + fc.path.length + 20;
        if (snippetChars <= budgetChars) {
          result.push({ path: fc.path, content: snippets });
          budgetChars -= snippetChars;
        } else {
          // Even snippets are too large — truncate the snippets
          const truncated = snippets.slice(0, budgetChars - fc.path.length - 20);
          result.push({ path: fc.path, content: truncated + "\n// [TRUNCATED]" });
          budgetChars = 0;
        }
      }
      // If no high-risk patterns found in oversized file, skip it (clean bill of health for risky patterns)
    }

    if (budgetChars <= 0) break;
  }

  return result;
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are a senior code security and quality reviewer with deep knowledge of OWASP Top 10, SonarQube rules, and dependency security.
Analyse the provided source files and return ONLY a JSON array of issues — no prose, no markdown fences, just the raw JSON array.
Each issue must follow this exact shape:
{"path":"relative/file.ts","line":45,"severity":"error"|"warning"|"info","category":"security"|"sonar"|"dependencies","ruleId":"security/sql-injection","message":"Clear description","fixHint":"Specific one-line fix instruction"}

Rules:
- path must exactly match the === FILE: header
- line must be the actual line number where the issue starts (1-based)
- severity: error = must fix, warning = should fix, info = consider
- ruleId format: category/short-kebab-name (e.g. security/xss-risk, sonar/cognitive-complexity)
- message: be specific — include the variable/function name involved
- fixHint: one concrete actionable instruction
- If no issues found, return []
- Do NOT flag issues already caught by TypeScript compiler or ESLint (type errors, unused vars, formatting)`;
}

function buildUserPrompt(
  fileContents: { path: string; content: string }[],
  focus: string[]
): string {
  const focusInstructions = buildFocusInstructions(focus);
  const fileBlock = fileContents
    .map((f) => `=== FILE: ${f.path} ===\n${f.content}`)
    .join("\n\n");

  return `Analyse these files for:${focusInstructions}\n\n${fileBlock}`;
}

function buildFocusInstructions(focus: string[]): string {
  const parts: string[] = [];

  if (focus.includes("security")) {
    parts.push(`
SECURITY — look for:
  • Injection: SQL, NoSQL, command, LDAP injection via user-controlled input
  • XSS: unescaped user input in v-html/innerHTML/dangerouslySetInnerHTML without sanitization
  • Insecure crypto: MD5/SHA1 for passwords, Math.random() for tokens, hardcoded secrets/keys
  • Path traversal: user input used in file paths without sanitization
  • Insecure deserialization: JSON.parse of untrusted input without schema validation
  • Sensitive data exposure: passwords/tokens logged or returned in API error messages
  • Prototype pollution: recursive object merge without hasOwnProperty or Object.create(null) check`);
  }

  if (focus.includes("sonar")) {
    parts.push(`
SONAR-QUALITY — look for:
  • Cognitive complexity: functions with deeply nested conditionals (>3 levels) or >15 branches
  • Long methods: functions over 50 lines doing too many things (suggest splitting)
  • Magic numbers/strings: unexplained literals not assigned to named constants
  • Empty catch blocks that swallow errors silently (catch blocks with no handling)
  • Resource leaks: event listeners added but never removed, subscriptions not unsubscribed
  • Duplicated logic: same block of 5+ lines appearing more than once
  • Boolean trap: functions taking multiple boolean parameters with no labels`);
  }

  if (focus.includes("dependencies")) {
    parts.push(`
DEPENDENCY MISUSE — look for:
  • eval() or new Function() with user-controlled or dynamic input
  • Prototype pollution via obj[userKey] = value where key is not validated
  • Regex DoS: unbounded .* or .+ patterns in regex applied to user input
  • Timing attacks: comparing secrets/tokens with === instead of crypto.timingSafeEqual
  • Unvalidated redirects: res.redirect() or window.location set from user-supplied URL`);
  }

  return parts.join("\n");
}

// ─── Response parsing ─────────────────────────────────────────────────────────

function parseAiResponse(text: string): AiIssue[] {
  const cleaned = text.replace(/^```[a-z]*\n?/gm, "").replace(/```$/gm, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          typeof item.path === "string" &&
          typeof item.message === "string"
      );
    }
    // Some models wrap in { issues: [...] }
    const arr =
      parsed.issues ?? parsed.results ?? parsed.findings ?? Object.values(parsed)[0];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapCategory(cat: string): Issue["category"] {
  if (cat === "security" || cat === "dependencies") return "policy";
  return "lint";
}

function truncateToKb(content: string, maxKb: number): string {
  const maxBytes = maxKb * 1024;
  if (Buffer.byteLength(content, "utf8") <= maxBytes) return content;
  const lines = content.split("\n");
  let size = 0;
  const kept: string[] = [];
  for (const line of lines) {
    size += Buffer.byteLength(line + "\n", "utf8");
    if (size > maxBytes) break;
    kept.push(line);
  }
  return kept.join("\n") + `\n// [TRUNCATED — file exceeds ${maxKb}KB analysis limit]`;
}

function getSourceLine(relPath: string, cwd: string, line: number): string | undefined {
  try {
    const abs = relPath.startsWith("/") ? relPath : join(cwd, relPath);
    if (!existsSync(abs)) return undefined;
    const lines = readFileSync(abs, "utf8").split("\n");
    return lines[line - 1] ?? undefined;
  } catch {
    return undefined;
  }
}
