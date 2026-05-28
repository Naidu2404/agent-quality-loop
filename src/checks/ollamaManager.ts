/**
 * OllamaManager — runs Ollama entirely inside the MCP.
 *
 * Users never install, start, or configure Ollama manually.
 * On first use this module:
 *   1. Downloads the Ollama binary for the current OS/arch into ~/.agent-quality-loop/bin/
 *   2. Spawns it as a background process (detached, unref'd)
 *   3. Pulls the default model (llama3.2:1b — ~600 MB, fast, code-capable)
 *
 * Every subsequent call is a no-op — the server is already running
 * and the model is already local.
 */

import { existsSync, mkdirSync, chmodSync, createWriteStream } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";
import { get as httpsGet } from "https";
import { get as httpGet } from "http";

// ─── Config ───────────────────────────────────────────────────────────────────

/** Pinned Ollama release — update when a newer stable ships */
const OLLAMA_VERSION = "0.4.7";

/** Default model: llama3.2:1b is ~600 MB, fast, and code-capable */
export const DEFAULT_OLLAMA_MODEL = "llama3.2:1b";

const DATA_DIR = join(homedir(), ".agent-quality-loop");
const BIN_DIR  = join(DATA_DIR, "bin");
const BIN_PATH = join(BIN_DIR, process.platform === "win32" ? "ollama.exe" : "ollama");

const OLLAMA_BASE_URL = "http://127.0.0.1:11434";

// ─── Platform detection ───────────────────────────────────────────────────────

function getDownloadUrl(): string | null {
  const base = `https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}`;
  const { platform, arch } = process;

  if (platform === "darwin")                     return `${base}/ollama-darwin`;
  if (platform === "linux" && arch === "x64")    return `${base}/ollama-linux-amd64`;
  if (platform === "linux" && arch === "arm64")  return `${base}/ollama-linux-arm64`;

  // Windows — binary available but Invoke-WebRequest is needed; skip for now
  return null;
}

// ─── Binary download ──────────────────────────────────────────────────────────

async function downloadOllamaBinary(): Promise<void> {
  const url = getDownloadUrl();
  if (!url) throw new Error("No pre-built Ollama binary for this platform. Install Ollama manually from https://ollama.com/download");

  mkdirSync(BIN_DIR, { recursive: true });
  await downloadWithRedirects(url, BIN_PATH);
  chmodSync(BIN_PATH, 0o755);
}

/** Downloads a URL to a file path, following up to 10 redirects. */
function downloadWithRedirects(url: string, dest: string, redirectsLeft = 10): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirectsLeft === 0) return reject(new Error("Too many redirects"));

    const mod = url.startsWith("https") ? httpsGet : httpGet;
    const req = mod(url, { timeout: 120_000 }, (res) => {
      // Follow redirects
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
        res.resume(); // drain
        resolve(downloadWithRedirects(res.headers.location, dest, redirectsLeft - 1));
        return;
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`Download failed: HTTP ${res.statusCode} from ${url}`));
      }
      const writer = createWriteStream(dest);
      res.pipe(writer);
      writer.on("finish", () => { writer.close(); resolve(); });
      writer.on("error", reject);
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Download timed out")); });
  });
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

async function isServerReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function startServer(binPath: string): Promise<void> {
  const proc = spawn(binPath, ["serve"], {
    detached: true,
    stdio:    "ignore",
    env:      { ...process.env, OLLAMA_HOME: DATA_DIR },
  });
  proc.unref();

  // Poll until ready — up to 30 s
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await isServerReachable()) return;
  }
  throw new Error("Ollama server started but did not respond within 30 s — try running the quality check again");
}

// ─── Model management ─────────────────────────────────────────────────────────

async function isModelAvailable(model: string): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const data = await res.json() as { models?: { name: string }[] };
    const tag = model.includes(":") ? model : `${model}:latest`;
    return (data.models ?? []).some((m) => m.name === tag || m.name.startsWith(model));
  } catch {
    return false;
  }
}

async function pullModel(model: string): Promise<void> {
  // Pull is streamed — we fire it and wait for completion (status: "success")
  const res = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ name: model, stream: false }),
    signal:  AbortSignal.timeout(300_000), // 5 min — first pull can be slow
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Failed to pull model "${model}": ${err.slice(0, 200)}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensures the internal Ollama server is running and the model is available.
 *
 * Call this before making any inference request.
 * Idempotent — safe to call on every review iteration.
 *
 * @returns baseUrl to use for Ollama API calls
 */
export async function ensureOllamaReady(model: string = DEFAULT_OLLAMA_MODEL): Promise<string> {
  // 1. If a system-wide Ollama is already running, use it directly
  if (await isServerReachable()) {
    if (!(await isModelAvailable(model))) await pullModel(model);
    return OLLAMA_BASE_URL;
  }

  // 2. Download binary if not already present
  if (!existsSync(BIN_PATH)) {
    await downloadOllamaBinary();
  }

  // 3. Start the server
  await startServer(BIN_PATH);

  // 4. Pull model on first run (no-op if already cached in ~/.agent-quality-loop)
  if (!(await isModelAvailable(model))) {
    await pullModel(model);
  }

  return OLLAMA_BASE_URL;
}

/**
 * Quick reachability check without starting anything.
 * Used by check_setup for status reporting.
 */
export async function probeOllama(): Promise<{ running: boolean; binaryPresent: boolean }> {
  return {
    running:       await isServerReachable(),
    binaryPresent: existsSync(BIN_PATH),
  };
}
