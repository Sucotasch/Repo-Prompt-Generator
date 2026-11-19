import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import zlib from "zlib";
import crypto from "crypto";
import { promisify } from "util";
import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  Type,
} from "@google/genai";

const PLACEHOLDER_GEMINI_KEYS = new Set([
  "MY_GEMINI_API_KEY",
  "YOUR_GEMINI_API_KEY_HERE",
]);
const ALLOWED_GEMINI_MODELS = new Set([
  "gemini-4-hydrogen",
  "gemini-4-argon",
  "gemini-4-carbon",
]);

function resolveServerGeminiKey(headerKey?: string): string {
  const cleanHeader = headerKey?.trim();
  if (cleanHeader && !PLACEHOLDER_GEMINI_KEYS.has(cleanHeader)) {
    return cleanHeader;
  }
  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (envKey && !PLACEHOLDER_GEMINI_KEYS.has(envKey)) {
    return envKey;
  }
  return "";
}

function resolveServerThinkingLevel(
  model: string,
  requested?: unknown,
): ThinkingLevel {
  const valid =
    requested === "LOW" ||
    requested === "MEDIUM" ||
    requested === "HIGH" ||
    requested === "XHIGH"
      ? requested
      : undefined;
  if (valid === "XHIGH" && model !== "gemini-4-hydrogen") {
    return ThinkingLevel.HIGH;
  }
  switch (valid) {
    case "LOW":
      return ThinkingLevel.LOW;
    case "MEDIUM":
      return ThinkingLevel.MEDIUM;
    case "HIGH":
      return ThinkingLevel.HIGH;
    case "XHIGH":
      return ThinkingLevel.XHIGH;
    default:
      return model === "gemini-4-hydrogen"
        ? ThinkingLevel.HIGH
        : ThinkingLevel.MEDIUM;
  }
}

function formatGeminiServerError(err: any): { status: number; message: string } {
  const raw = err?.message || String(err);
  const status =
    typeof err?.status === "number" && err.status >= 400 && err.status < 600
      ? err.status
      : 500;
  if (status === 403 || raw.includes("PERMISSION_DENIED")) {
    return {
      status,
      message:
        "Gemini API permission denied (403). Check your GEMINI_API_KEY in Settings > Secrets.",
    };
  }
  if (status === 429 || raw.includes("RESOURCE_EXHAUSTED")) {
    return {
      status,
      message:
        "Gemini API quota exceeded (429). If using a paid model (Argon/Carbon), select a billing-enabled API key in Settings > Secrets.",
    };
  }
  if (status === 404 || raw.includes("NOT_FOUND")) {
    return {
      status,
      message: `Gemini model not found or unavailable (404): ${raw}`,
    };
  }
  return { status, message: raw };
}

const GITHUB_IDENT_REGEX = /^[a-zA-Z0-9-._]+$/;
const HARD_IGNORE_DIRS = new Set([
  "venv",
  ".venv",
  "node_modules",
  ".git",
  "__pycache__",
  "dist",
  "build",
  "target",
]);
const SECRET_EXACT_NAMES = new Set([
  "secrets.json",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
]);
const SECRET_EXTENSIONS = [".pem", ".key", ".cert", ".p12"];

function sanitizeAndEncodeGitHubPath(filePath: string): string | null {
  if (typeof filePath !== "string") return null;
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) {
    return null;
  }
  return segments.map((s) => encodeURIComponent(s)).join("/");
}

function shouldIgnoreRepoPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const segments = lower.split("/").filter(Boolean);
  if (segments.length > 1) {
    for (let i = 0; i < segments.length - 1; i++) {
      if (HARD_IGNORE_DIRS.has(segments[i])) return true;
    }
  }
  const fileName = segments[segments.length - 1] || "";
  if (
    fileName === ".env" ||
    (fileName.startsWith(".env.") &&
      !fileName.endsWith(".example") &&
      !fileName.endsWith(".template") &&
      !fileName.endsWith(".sample"))
  ) {
    return true;
  }
  if (SECRET_EXTENSIONS.some((ext) => fileName.endsWith(ext))) {
    return true;
  }
  return SECRET_EXACT_NAMES.has(fileName);
}

function truncateContentWithMeta(
  content: string,
  maxChars: number,
  label: string,
): {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
} {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const totalLines = normalized.split("\n").length;
  if (normalized.length <= maxChars) {
    return {
      content,
      startLine: 1,
      endLine: totalLines,
      totalLines,
      truncated: false,
    };
  }
  const prefix = normalized.substring(0, maxChars);
  const lastNewline = prefix.lastIndexOf("\n");
  const singleLineCut = lastNewline <= 0;
  const cut = singleLineCut ? prefix : prefix.substring(0, lastNewline);
  const endLine = cut.split("\n").length;
  const body = singleLineCut ? `${cut} ... [LINE TRUNCATED]` : cut;
  return {
    content: `${body}\n\n... [TRUNCATED: File exceeds ${label} limit. Showing lines 1-${endLine} of ${totalLines}.]`,
    startLine: 1,
    endLine,
    totalLines,
    truncated: true,
  };
}

const RAW_FILE_CACHE_MAX_BYTES = 25 * 1024 * 1024;
const RAW_FILE_CACHE_MAX_ENTRIES = 300;
const RAW_FILE_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_RAW_GITHUB_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_RANGE_LINES = 250;
const MAX_RANGE_LINES = 400;
const MAX_RANGE_CHARS = 50_000;

function makeTokenScope(cleanToken: string): string {
  if (!cleanToken) return "public";
  return crypto.createHash("sha256").update(cleanToken).digest("hex").slice(0, 16);
}

interface ServerCachedRawFile {
  owner: string;
  repo: string;
  branch: string;
  treeSha: string;
  tokenScope: string;
  filePath: string;
  content: string;
  bytes: number;
  fetchedAt: number;
}

const rawFileCache = new Map<string, ServerCachedRawFile>();
let rawFileCacheBytes = 0;

function makeRawFileCacheKey(
  tokenScope: string,
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
  treeSha?: string,
): string {
  return `${tokenScope}\0${owner}/${repo}\0${branch}\0${treeSha?.trim() || ""}\0${filePath}`;
}

function getCachedRawFile(key: string): string | null {
  const entry = rawFileCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > RAW_FILE_CACHE_TTL_MS) {
    rawFileCache.delete(key);
    rawFileCacheBytes -= entry.bytes;
    return null;
  }
  rawFileCache.delete(key);
  rawFileCache.set(key, entry);
  return entry.content;
}

function setCachedRawFile(
  meta: {
    tokenScope: string;
    owner: string;
    repo: string;
    branch: string;
    treeSha?: string;
    filePath: string;
  },
  content: string,
): void {
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_RAW_GITHUB_FILE_BYTES) return;
  const cleanTreeSha = meta.treeSha?.trim() || "";
  const key = makeRawFileCacheKey(
    meta.tokenScope,
    meta.owner,
    meta.repo,
    meta.branch,
    meta.filePath,
    cleanTreeSha,
  );
  const existing = rawFileCache.get(key);
  if (existing) {
    rawFileCache.delete(key);
    rawFileCacheBytes -= existing.bytes;
  }
  rawFileCache.set(key, {
    owner: meta.owner,
    repo: meta.repo,
    branch: meta.branch,
    treeSha: cleanTreeSha,
    tokenScope: meta.tokenScope,
    filePath: meta.filePath,
    content,
    bytes,
    fetchedAt: Date.now(),
  });
  rawFileCacheBytes += bytes;
  while (
    rawFileCache.size > RAW_FILE_CACHE_MAX_ENTRIES ||
    rawFileCacheBytes > RAW_FILE_CACHE_MAX_BYTES
  ) {
    const oldestKey = rawFileCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = rawFileCache.get(oldestKey);
    rawFileCache.delete(oldestKey);
    if (oldest) rawFileCacheBytes -= oldest.bytes;
  }
}

function isLikelyBinaryContent(text: string): boolean {
  return text.slice(0, 8192).includes("\u0000");
}

function sliceServerTextByLines(
  filePath: string,
  rawContent: string,
  startLine?: number,
  endLine?: number,
): {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  outOfRange?: boolean;
  error?: string;
} {
  const normalized = rawContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const allLines = normalized.split("\n");
  const totalLines = allLines.length;

  const safeStart = Math.max(
    1,
    Math.floor(typeof startLine === "number" && Number.isFinite(startLine) ? startLine : 1),
  );

  if (safeStart > totalLines) {
    return {
      path: filePath,
      content: "",
      startLine: safeStart,
      endLine: totalLines,
      totalLines,
      truncated: false,
      outOfRange: true,
      error: `Requested startLine (${safeStart}) exceeds file length (${totalLines} lines).`,
    };
  }

  const requestedEnd =
    typeof endLine === "number" && Number.isFinite(endLine)
      ? Math.floor(endLine)
      : safeStart + DEFAULT_RANGE_LINES - 1;
  const clampedEnd = Math.min(
    totalLines,
    Math.max(safeStart, Math.min(requestedEnd, safeStart + MAX_RANGE_LINES - 1)),
  );

  const selected = allLines.slice(safeStart - 1, clampedEnd);
  const kept: string[] = [];
  let charCount = 0;
  let hitCharCap = false;

  for (const line of selected) {
    const addLen = line.length + (kept.length > 0 ? 1 : 0);
    if (kept.length > 0 && charCount + addLen > MAX_RANGE_CHARS) {
      hitCharCap = true;
      break;
    }
    if (kept.length === 0 && line.length > MAX_RANGE_CHARS) {
      kept.push(`${line.slice(0, MAX_RANGE_CHARS)} ... [LINE TRUNCATED]`);
      hitCharCap = true;
      break;
    }
    kept.push(line);
    charCount += addLen;
  }

  const actualEnd = safeStart + kept.length - 1;
  const truncated = safeStart > 1 || actualEnd < totalLines || hitCharCap;

  return {
    path: filePath,
    content: kept.join("\n"),
    startLine: safeStart,
    endLine: actualEnd,
    totalLines,
    truncated,
  };
}

const TARBALL_CACHE_MAX_REPOS = 2;
const TARBALL_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_TARBALL_COMPRESSED_BYTES = 25 * 1024 * 1024;
const MAX_TARBALL_UNCOMPRESSED_BYTES = 90 * 1024 * 1024;
const MAX_TARBALL_TEXT_BYTES = 60 * 1024 * 1024;
const MAX_TARBALL_SINGLE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_GREP_PATTERN_LEN = 200;
const MAX_GREP_MATCHES = 100;
const DEFAULT_GREP_MATCHES = 40;
const MAX_GREP_LINE_PREVIEW = 240;
const UNSAFE_REGEX_PATTERN = /(\([^)]*[+*][^)]*\))[+*?]|\{\d+,\}\s*[+*]/;

const gunzipAsync = promisify(zlib.gunzip);

interface TarballSnapshot {
  files: Map<string, string>;
  totalTextBytes: number;
  skippedOversizedFiles: number;
  fetchedAt: number;
}

const tarballCache = new Map<string, TarballSnapshot>();

function makeTarballCacheKey(
  tokenScope: string,
  owner: string,
  repo: string,
  branch: string,
  treeSha?: string,
): string {
  return `${tokenScope}\0${owner}/${repo}\0${branch}\0${treeSha?.trim() || ""}`;
}

function getCachedTarballSnapshot(key: string): TarballSnapshot | null {
  const entry = tarballCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TARBALL_CACHE_TTL_MS) {
    tarballCache.delete(key);
    return null;
  }
  tarballCache.delete(key);
  tarballCache.set(key, entry);
  return entry;
}

function setCachedTarballSnapshot(key: string, snapshot: TarballSnapshot): void {
  if (tarballCache.has(key)) {
    tarballCache.delete(key);
  }
  tarballCache.set(key, snapshot);
  while (tarballCache.size > TARBALL_CACHE_MAX_REPOS) {
    const oldestKey = tarballCache.keys().next().value;
    if (!oldestKey) break;
    tarballCache.delete(oldestKey);
  }
}

function readTarString(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const zeroIdx = slice.indexOf(0);
  return (zeroIdx === -1 ? slice : slice.subarray(0, zeroIdx)).toString("utf-8");
}

function parsePaxPath(paxBuf: Buffer): string | null {
  let pos = 0;
  while (pos < paxBuf.length) {
    const spaceIdx = paxBuf.indexOf(0x20, pos);
    if (spaceIdx === -1) break;
    const lenStr = paxBuf.subarray(pos, spaceIdx).toString("ascii");
    const recLen = parseInt(lenStr, 10);
    if (!Number.isFinite(recLen) || recLen <= 0 || pos + recLen > paxBuf.length) {
      break;
    }
    const record = paxBuf.subarray(spaceIdx + 1, pos + recLen).toString("utf-8");
    const cleaned = record.endsWith("\n") ? record.slice(0, -1) : record;
    if (cleaned.startsWith("path=")) {
      return cleaned.slice(5);
    }
    pos += recLen;
  }
  return null;
}

function extractTarTextFiles(tarBuf: Buffer): TarballSnapshot {
  const files = new Map<string, string>();
  let totalTextBytes = 0;
  let skippedOversizedFiles = 0;
  let offset = 0;
  let paxPath: string | null = null;
  let gnuLongPath: string | null = null;

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    if (header[0] === 0 && header.every((b) => b === 0)) {
      break;
    }

    const name = readTarString(header, 0, 100);
    const sizeStr = readTarString(header, 124, 12).trim();
    const size = parseInt(sizeStr, 8) || 0;
    const typeflag = String.fromCharCode(header[156] || 48);
    const prefix = readTarString(header, 345, 155);

    const dataStart = offset + 512;
    const dataEnd = Math.min(dataStart + size, tarBuf.length);
    const blocks = Math.ceil(size / 512);
    offset = dataStart + blocks * 512;

    if (typeflag === "g") {
      continue;
    }
    if (typeflag === "x") {
      paxPath = parsePaxPath(tarBuf.subarray(dataStart, dataEnd));
      continue;
    }
    if (typeflag === "L") {
      gnuLongPath = readTarString(tarBuf, dataStart, dataEnd - dataStart).replace(/\n+$/, "");
      continue;
    }

    const rawPath = paxPath || gnuLongPath || (prefix ? `${prefix}/${name}` : name);
    paxPath = null;
    gnuLongPath = null;

    if (typeflag !== "0" && typeflag !== "\0") {
      continue;
    }

    const relPath = rawPath.replace(/^\/+/, "").replace(/^[^/]+\//, "");
    if (!relPath || shouldIgnoreRepoPath(relPath)) {
      continue;
    }
    if (size > MAX_TARBALL_SINGLE_FILE_BYTES) {
      skippedOversizedFiles++;
      continue;
    }
    if (totalTextBytes + size > MAX_TARBALL_TEXT_BYTES) {
      skippedOversizedFiles++;
      continue;
    }

    const contentBuf = tarBuf.subarray(dataStart, dataEnd);
    const sampleEnd = Math.min(contentBuf.length, 8192);
    if (contentBuf.subarray(0, sampleEnd).includes(0)) {
      continue;
    }

    const text = contentBuf.toString("utf-8");
    files.set(relPath, text);
    totalTextBytes += contentBuf.length;
  }

  return {
    files,
    totalTextBytes,
    skippedOversizedFiles,
    fetchedAt: Date.now(),
  };
}

async function getOrFetchTarballSnapshot(
  owner: string,
  repo: string,
  branch: string,
  treeSha: string | undefined,
  cleanToken: string,
): Promise<{ snapshot?: TarballSnapshot; fallbackReason?: string }> {
  const tokenScope = makeTokenScope(cleanToken);
  const key = makeTarballCacheKey(tokenScope, owner, repo, branch, treeSha);
  const cached = getCachedTarballSnapshot(key);
  if (cached) {
    return { snapshot: cached };
  }

  const headers: Record<string, string> = {
    "User-Agent": "repo-prompt-generator/1.0.0",
    "Accept": "application/vnd.github+json",
  };
  if (cleanToken) {
    headers["Authorization"] = `Bearer ${cleanToken}`;
  }

  const encodedBranch = encodeURIComponent(branch);
  const url = `https://api.github.com/repos/${owner}/${repo}/tarball/${encodedBranch}`;

  try {
    const res = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(25000),
    });

    if (!res.ok) {
      return { fallbackReason: `GitHub tarball returned HTTP ${res.status}` };
    }

    const contentLength = Number(res.headers.get("content-length") || "0");
    if (contentLength > MAX_TARBALL_COMPRESSED_BYTES) {
      return {
        fallbackReason: `Repository archive exceeds 25MB limit (${Math.round(contentLength / (1024 * 1024))}MB)`,
      };
    }

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    if (!res.body) {
      return { fallbackReason: "Empty tarball response body" };
    }

    const reader = res.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          receivedBytes += value.byteLength;
          if (receivedBytes > MAX_TARBALL_COMPRESSED_BYTES) {
            await reader.cancel().catch(() => {});
            return { fallbackReason: "Repository archive exceeded 25MB compressed limit" };
          }
          chunks.push(Buffer.from(value));
        }
      }
    } finally {
      reader.releaseLock();
    }

    const gzBuf = Buffer.concat(chunks, receivedBytes);
    const tarBuf = await gunzipAsync(gzBuf, {
      maxOutputLength: MAX_TARBALL_UNCOMPRESSED_BYTES,
    });

    const snapshot = extractTarTextFiles(tarBuf);
    setCachedTarballSnapshot(key, snapshot);
    return { snapshot };
  } catch (err: any) {
    return {
      fallbackReason: err?.message || "Failed to download or unpack repository tarball",
    };
  }
}

function buildSafeServerMatcher(
  pattern: string,
  caseSensitive: boolean,
): { testLine: (line: string) => boolean; literalFallback: boolean } {
  const trimmed = pattern.slice(0, MAX_GREP_PATTERN_LEN);
  if (!UNSAFE_REGEX_PATTERN.test(trimmed)) {
    try {
      const re = new RegExp(trimmed, caseSensitive ? "" : "i");
      return {
        testLine: (line: string) => re.test(line),
        literalFallback: false,
      };
    } catch {
      // Fallback to literal substring
    }
  }
  const needle = caseSensitive ? trimmed : trimmed.toLowerCase();
  return {
    testLine: (line: string) =>
      (caseSensitive ? line : line.toLowerCase()).includes(needle),
    literalFallback: true,
  };
}

function grepFileEntriesMap(
  entries: Iterable<[string, string]>,
  pattern: string,
  pathPrefix: string | undefined,
  caseSensitive: boolean,
  maxMatches: number,
): {
  matches: { path: string; line: number; preview: string }[];
  filesScanned: number;
  truncated: boolean;
  literalFallback: boolean;
} {
  const normalizedPrefix = pathPrefix
    ? pathPrefix.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase()
    : "";
  const { testLine, literalFallback } = buildSafeServerMatcher(pattern, caseSensitive);

  const matches: { path: string; line: number; preview: string }[] = [];
  let filesScanned = 0;
  let truncated = false;

  for (const [relPath, content] of entries) {
    if (normalizedPrefix && !relPath.toLowerCase().startsWith(normalizedPrefix)) {
      continue;
    }
    filesScanned++;
    const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      if (testLine(lineText)) {
        matches.push({
          path: relPath,
          line: i + 1,
          preview:
            lineText.length > MAX_GREP_LINE_PREVIEW
              ? `${lineText.slice(0, MAX_GREP_LINE_PREVIEW)}...`
              : lineText,
        });
        if (matches.length >= maxMatches) {
          truncated = true;
          break;
        }
      }
    }
    if (truncated) break;
  }

  return { matches, filesScanned, truncated, literalFallback };
}

async function fetchGitHubRawFile(
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
  cleanToken: string,
  treeSha?: string,
): Promise<{ content?: string; status?: number; error?: string }> {
  const encodedFile = sanitizeAndEncodeGitHubPath(filePath);
  if (!encodedFile || shouldIgnoreRepoPath(filePath)) {
    return { status: 400, error: `Blocked invalid or sensitive file path: '${filePath}'.` };
  }

  const tokenScope = makeTokenScope(cleanToken);

  // 1. Check in-memory tarball snapshot first (0 GitHub API calls, scoped by token)
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const tarballSnap =
    getCachedTarballSnapshot(makeTarballCacheKey(tokenScope, owner, repo, branch, treeSha)) ||
    getCachedTarballSnapshot(makeTarballCacheKey(tokenScope, owner, repo, branch));
  if (tarballSnap) {
    const fromTar = tarballSnap.files.get(normalizedPath);
    if (fromTar !== undefined) {
      return { content: fromTar };
    }
  }

  // 2. Check per-file LRU cache (scoped by token)
  const cacheKey = makeRawFileCacheKey(tokenScope, owner, repo, branch, normalizedPath, treeSha);
  const cached =
    getCachedRawFile(cacheKey) ??
    (treeSha
      ? getCachedRawFile(makeRawFileCacheKey(tokenScope, owner, repo, branch, normalizedPath))
      : null);
  if (cached !== null) {
    return { content: cached };
  }

  const headers: Record<string, string> = {
    "User-Agent": "repo-prompt-generator/1.0.0",
    "Accept": "application/vnd.github.v3+json",
  };
  if (cleanToken) {
    headers["Authorization"] = `Bearer ${cleanToken}`;
  }

  const encodedBranch = encodeURIComponent(branch);
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedFile}?ref=${encodedBranch}`;

  const fileRes = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!fileRes.ok) {
    return {
      status: fileRes.status,
      error: `GitHub API returned ${fileRes.status} for '${filePath}'.`,
    };
  }

  const fileData = await fileRes.json();
  let decoded: string | null = null;

  if (fileData && typeof fileData.content === "string" && fileData.content.length > 0) {
    decoded = Buffer.from(fileData.content, "base64").toString("utf-8");
  } else if (fileData?.type === "file") {
    if (typeof fileData.size === "number" && fileData.size > MAX_RAW_GITHUB_FILE_BYTES) {
      return {
        status: 413,
        error: `File '${filePath}' exceeds 5MB range-read limit (${fileData.size} bytes).`,
      };
    }
    const rawRes = await fetch(url, {
      headers: { ...headers, Accept: "application/vnd.github.raw" },
      signal: AbortSignal.timeout(20000),
    });
    if (!rawRes.ok) {
      return {
        status: rawRes.status,
        error: `GitHub raw download failed (${rawRes.status}) for '${filePath}'.`,
      };
    }
    const contentLength = Number(rawRes.headers.get("content-length") || "0");
    if (contentLength > MAX_RAW_GITHUB_FILE_BYTES) {
      return {
        status: 413,
        error: `File '${filePath}' exceeds 5MB range-read limit.`,
      };
    }
    const buf = Buffer.from(await rawRes.arrayBuffer());
    if (buf.length > MAX_RAW_GITHUB_FILE_BYTES) {
      return {
        status: 413,
        error: `File '${filePath}' exceeds 5MB range-read limit.`,
      };
    }
    decoded = buf.toString("utf-8");
  }

  if (decoded === null) {
    return { status: 422, error: `File '${filePath}' is not a readable text file.` };
  }
  if (isLikelyBinaryContent(decoded)) {
    return { status: 422, error: `File '${filePath}' appears to be binary.` };
  }

  setCachedRawFile(
    {
      tokenScope,
      owner,
      repo,
      branch,
      treeSha,
      filePath: normalizedPath,
    },
    decoded,
  );
  return { content: decoded };
}

function validateProxyBaseUrl(baseUrl: unknown): string | null {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;
  try {
    const parsed = new URL(baseUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return baseUrl.trim().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // Health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // API route to fetch GitHub data
  app.post("/api/repo", async (req, res) => {
    try {
      const { owner, repo, branch, token, maxFiles = 5 } = req.body;

      if (
        !owner ||
        !repo ||
        typeof owner !== "string" ||
        typeof repo !== "string"
      ) {
        return res
          .status(400)
          .json({ error: "Invalid request. Owner and repo are required." });
      }

      if (branch && typeof branch !== "string") {
        return res
          .status(400)
          .json({ error: "Invalid request. Branch must be a string." });
      }

      const cleanToken = typeof token === "string" ? token.trim() : "";
      const headers: Record<string, string> = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "repo-prompt-generator/1.0.0",
      };
      if (cleanToken) {
        headers["Authorization"] = `Bearer ${cleanToken}`;
      }

      // Strict validation to prevent SSRF and injection
      if (!GITHUB_IDENT_REGEX.test(owner) || !GITHUB_IDENT_REGEX.test(repo)) {
        return res.status(400).json({ error: "Invalid owner or repo format." });
      }

      // Fetch basic info
      const infoRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}`,
        { headers, signal: AbortSignal.timeout(15000) },
      );
      if (!infoRes.ok) {
        if (infoRes.status === 401) {
          return res.status(401).json({
            error:
              "GitHub authentication failed (401 Unauthorized): your GitHub Token appears invalid, expired, or browser-autofilled. Clear the GitHub Token field to fetch public repositories without authentication, or provide a valid token.",
          });
        } else if (infoRes.status === 403) {
          return res.status(403).json({
            error:
              "GitHub API rate limit exceeded. Please try again later or provide a GitHub token.",
          });
        } else if (infoRes.status === 404) {
          return res.status(404).json({
            error:
              "Repository not found. Please check the URL or provide a token for private repos.",
          });
        }
        return res.status(infoRes.status).json({
          error: `Failed to fetch repository info: ${infoRes.statusText}`,
        });
      }

      const infoData = await infoRes.json();
      const defaultBranch = infoData.default_branch;
      const description = infoData.description || "No description provided.";
      const stargazersCount = infoData.stargazers_count;
      const topics = infoData.topics || [];
      const language = infoData.language;

      const targetBranch = (branch && branch.trim()) || defaultBranch;
      const encodedBranch = encodeURIComponent(targetBranch);

      // Fetch tree
      const treeRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodedBranch}?recursive=1`,
        { headers, signal: AbortSignal.timeout(20000) },
      );
      let treePaths: string[] = [];
      let treeSha: string | undefined;

      if (treeRes.ok) {
        const treeData = await treeRes.json();
        treeSha = typeof treeData.sha === "string" ? treeData.sha : undefined;
        treePaths = (treeData.tree || [])
          .filter((item: any) => item.type === "blob")
          .map((item: any) => item.path)
          .filter((filePath: string) => !shouldIgnoreRepoPath(filePath));
      } else {
        if (treeRes.status === 401) {
          return res.status(401).json({
            error:
              "GitHub authentication failed (401 Unauthorized) while reading repository tree. Clear the GitHub Token field for public repositories or update it.",
          });
        }
        if (treeRes.status === 404) {
          return res.status(404).json({
            error: `Branch, tag, or commit '${targetBranch}' not found in repository.`,
          });
        }
        return res.status(treeRes.status).json({
          error: `Failed to fetch repository tree: ${treeRes.statusText}`,
        });
      }

      const depFiles = [
        "package.json",
        "requirements.txt",
        "go.mod",
        "Cargo.toml",
        "pom.xml",
        "build.gradle",
      ];

      // Fetch README and dependencies concurrently
      const [readmeResult, depResults] = await Promise.all([
        (async () => {
          try {
            const readmeRes = await fetch(
              `https://api.github.com/repos/${owner}/${repo}/readme?ref=${encodedBranch}`,
              { headers, signal: AbortSignal.timeout(15000) },
            );
            if (readmeRes.ok) {
              const readmeData = await readmeRes.json();
              if (readmeData.content) {
                return Buffer.from(readmeData.content, "base64").toString("utf-8");
              }
            }
          } catch (e) {
            console.warn("Failed to fetch README:", e);
          }
          return "";
        })(),
        Promise.all(
          depFiles
            .filter((file) => treePaths.includes(file))
            .map(async (file) => {
              const encodedFile = sanitizeAndEncodeGitHubPath(file);
              if (!encodedFile) return "";
              try {
                const fileRes = await fetch(
                  `https://api.github.com/repos/${owner}/${repo}/contents/${encodedFile}?ref=${encodedBranch}`,
                  { headers, signal: AbortSignal.timeout(15000) },
                );
                if (fileRes.ok) {
                  const fileData = await fileRes.json();
                  if (fileData.content) {
                    return `\n--- ${file} ---\n${Buffer.from(fileData.content, "base64").toString("utf-8")}\n`;
                  }
                }
              } catch (e) {
                console.warn(`Failed to fetch dep ${file}:`, e);
              }
              return "";
            }),
        ),
      ]);

      const readme = readmeResult;
      const dependencies = depResults.join("");

      // Fetch top source files
      const sourceFiles: {
        path: string;
        content: string;
        startLine: number;
        endLine: number;
        totalLines: number;
        truncated: boolean;
      }[] = [];
      const sourceExtensions = [
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".vue",
        ".svelte",
        ".py",
        ".go",
        ".rs",
        ".java",
        ".cpp",
        ".c",
        ".h",
        ".cs",
        ".sql",
        ".prisma",
        ".css",
        ".scss",
        ".html",
        ".md",
        ".mdx",
      ];

      let filesToFetch = treePaths
        .filter((p) => sourceExtensions.some((ext) => p.toLowerCase().endsWith(ext)))
        .filter(
          (p) => !depFiles.includes(p) && p.toLowerCase() !== "readme.md",
        );

      // Intelligent scoring system for file selection
      const getFileScore = (filePath: string): number => {
        let score = 0;
        const lowerPath = filePath.toLowerCase();
        const parts = lowerPath.split("/");
        const fileName = parts[parts.length - 1];
        const depth = parts.length;

        // 1. De-prioritize tests
        if (
          lowerPath.includes("/test/") ||
          lowerPath.includes("/tests/") ||
          lowerPath.includes("__tests__") ||
          fileName.includes(".test.") ||
          fileName.includes(".spec.") ||
          fileName.startsWith("test_") ||
          fileName.endsWith("_test.go")
        ) {
          score -= 50;
        }

        // 2. De-prioritize build/config/auxiliary scripts and docs
        const auxKeywords = [
          "build",
          "setup",
          "config",
          "webpack",
          "vite",
          "rollup",
          "gulpfile",
          "backup",
          "manage.py",
          "scripts/",
          "tools/",
          "docs/",
          "example",
          "demo",
          "migrations/",
        ];
        if (auxKeywords.some((k) => lowerPath.includes(k))) {
          score -= 30;
        }

        // 3. Prioritize core directories
        const coreDirs = ["src/", "lib/", "app/", "core/", "pkg/", "internal/"];
        if (
          coreDirs.some(
            (d) => lowerPath.startsWith(d) || lowerPath.includes(`/${d}`),
          )
        ) {
          score += 20;
        }

        // 4. Prioritize important filenames
        const importantNames = [
          "main",
          "index",
          "app",
          "server",
          "core",
          "manager",
          "parser",
          "api",
          "router",
          "handler",
          "controller",
          "service",
          "model",
          "database",
        ];
        if (importantNames.some((n) => fileName.includes(n))) {
          score += 10;
        }

        // 5. Depth penalty (slight, to prefer shallower files *within* the same score tier)
        score -= depth;

        return score;
      };

      // Sort by score descending (highest score first)
      filesToFetch.sort((a, b) => getFileScore(b) - getFileScore(a));

      // Limit to requested maxFiles (dynamic based on token)
      const absoluteMax = cleanToken ? 200 : 10;
      const limit = Math.min(Math.max(1, Number(maxFiles) || 5), absoluteMax);
      filesToFetch = filesToFetch.slice(0, limit);

      const BATCH_SIZE = 10;
      for (let i = 0; i < filesToFetch.length; i += BATCH_SIZE) {
        const batch = filesToFetch.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (file) => {
            const encodedFile = sanitizeAndEncodeGitHubPath(file);
            if (!encodedFile) return null;
            try {
              const fileRes = await fetch(
                `https://api.github.com/repos/${owner}/${repo}/contents/${encodedFile}?ref=${encodedBranch}`,
                { headers, signal: AbortSignal.timeout(15000) },
              );
              if (fileRes.ok) {
                const fileData = await fileRes.json();
                if (fileData.content) {
                  const decoded = Buffer.from(fileData.content, "base64").toString("utf-8");
                  if (!isLikelyBinaryContent(decoded)) {
                    setCachedRawFile(
                      {
                        tokenScope: makeTokenScope(cleanToken),
                        owner,
                        repo,
                        branch: targetBranch,
                        treeSha,
                        filePath: file,
                      },
                      decoded,
                    );
                  }
                  const meta = truncateContentWithMeta(decoded, 100000, "100KB");
                  return {
                    path: file,
                    ...meta,
                  };
                }
              }
            } catch (e) {
              console.warn(`Failed to fetch file ${file}:`, e);
            }
            return null;
          }),
        );
        for (const item of batchResults) {
          if (item) sourceFiles.push(item);
        }
      }

      // Truncate the tree representation for the LLM context if it's extremely large
      const totalTreeFiles = treePaths.length;
      let isTruncated = false;
      if (treePaths.length > 1000) {
        treePaths = treePaths.slice(0, 1000);
        isTruncated = true;
      }

      res.json({
        info: { 
          owner, 
          repo, 
          defaultBranch, 
          branch: targetBranch, 
          description,
          stargazersCount,
          topics,
          language,
          treeSha,
          fetchedAt: new Date().toISOString(),
        },
        tree: treePaths,
        totalTreeFiles,
        readme,
        dependencies,
        sourceFiles,
        isTruncated,
      });
    } catch (error: any) {
      console.error("Error fetching repo data:", error);
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  });

  // API route to fetch specific files from GitHub
  app.post("/api/repo/files", async (req, res) => {
    try {
      const {
        owner,
        repo,
        branch,
        treeSha,
        commitSha,
        token,
        filePaths,
        maxFiles = 10,
      } = req.body;

      if (
        !owner ||
        !repo ||
        typeof owner !== "string" ||
        typeof repo !== "string" ||
        !filePaths ||
        !Array.isArray(filePaths)
      ) {
        return res.status(400).json({ error: "Missing required parameters" });
      }

      if (!GITHUB_IDENT_REGEX.test(owner) || !GITHUB_IDENT_REGEX.test(repo)) {
        return res.status(400).json({ error: "Invalid owner or repo format." });
      }

      if (branch && typeof branch !== "string") {
        return res.status(400).json({ error: "Branch must be a string." });
      }

      const cleanToken = typeof token === "string" ? token.trim() : "";
      const targetBranch = (branch && branch.trim()) || "main";
      const cleanSha =
        typeof treeSha === "string" && treeSha.trim()
          ? treeSha.trim()
          : typeof commitSha === "string" && commitSha.trim()
            ? commitSha.trim()
            : undefined;
      const safeMax = Math.min(Math.max(1, Number(maxFiles) || 10), 20);
      const fetchedFiles: {
        path: string;
        content: string;
        startLine: number;
        endLine: number;
        totalLines: number;
        truncated: boolean;
      }[] = [];

      const pathsToFetch = filePaths.slice(0, safeMax);

      const fileResults = await Promise.all(
        pathsToFetch.map(async (file) => {
          if (typeof file !== "string") return null;
          try {
            const fetched = await fetchGitHubRawFile(
              owner,
              repo,
              targetBranch,
              file.trim(),
              cleanToken,
              cleanSha,
            );
            if (fetched.content !== undefined) {
              const meta = truncateContentWithMeta(fetched.content, 50000, "50KB");
              return {
                path: file,
                ...meta,
              };
            }
          } catch (e) {
            console.warn(`Failed to fetch file ${file}:`, e);
          }
          return null;
        }),
      );

      for (const item of fileResults) {
        if (item) fetchedFiles.push(item);
      }

      res.json({ files: fetchedFiles });
    } catch (error: any) {
      console.error("Error fetching specific files:", error);
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  });

  // API route to fetch a specific 1-indexed line range from a GitHub file (cached in memory)
  app.post("/api/repo/file-range", async (req, res) => {
    try {
      const {
        owner,
        repo,
        branch,
        treeSha,
        commitSha,
        token,
        path: filePath,
        startLine,
        endLine,
      } = req.body || {};

      if (
        !owner ||
        !repo ||
        typeof owner !== "string" ||
        typeof repo !== "string" ||
        typeof filePath !== "string" ||
        !filePath.trim()
      ) {
        return res.status(400).json({ error: "Missing required parameters (owner, repo, path)." });
      }

      if (!GITHUB_IDENT_REGEX.test(owner) || !GITHUB_IDENT_REGEX.test(repo)) {
        return res.status(400).json({ error: "Invalid owner or repo format." });
      }

      if (branch && typeof branch !== "string") {
        return res.status(400).json({ error: "Branch must be a string." });
      }

      const targetBranch = (branch && branch.trim()) || "main";
      const cleanToken = typeof token === "string" ? token.trim() : "";
      const cleanSha =
        typeof treeSha === "string" && treeSha.trim()
          ? treeSha.trim()
          : typeof commitSha === "string" && commitSha.trim()
            ? commitSha.trim()
            : undefined;

      const fetched = await fetchGitHubRawFile(
        owner,
        repo,
        targetBranch,
        filePath.trim(),
        cleanToken,
        cleanSha,
      );

      if (fetched.error || fetched.content === undefined) {
        return res.status(fetched.status || 404).json({
          error: fetched.error || `Failed to fetch '${filePath}'.`,
        });
      }

      const parsedStart =
        startLine !== undefined && startLine !== null ? Number(startLine) : undefined;
      const parsedEnd =
        endLine !== undefined && endLine !== null ? Number(endLine) : undefined;

      const sliced = sliceServerTextByLines(
        filePath.trim(),
        fetched.content,
        parsedStart,
        parsedEnd,
      );

      res.json({ file: sliced });
    } catch (error: any) {
      console.error("Error fetching file range:", error);
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  });

  // API route to grep across a GitHub repository via bounded tarball snapshot cache (+ fallback)
  app.post("/api/repo/grep", async (req, res) => {
    try {
      const {
        owner,
        repo,
        branch,
        treeSha,
        commitSha,
        token,
        pattern,
        pathPrefix,
        caseSensitive = false,
        maxMatches = DEFAULT_GREP_MATCHES,
      } = req.body || {};

      if (
        !owner ||
        !repo ||
        typeof owner !== "string" ||
        typeof repo !== "string" ||
        typeof pattern !== "string" ||
        !pattern.trim()
      ) {
        return res
          .status(400)
          .json({ error: "Missing required parameters (owner, repo, pattern)." });
      }

      if (!GITHUB_IDENT_REGEX.test(owner) || !GITHUB_IDENT_REGEX.test(repo)) {
        return res.status(400).json({ error: "Invalid owner or repo format." });
      }

      if (branch && typeof branch !== "string") {
        return res.status(400).json({ error: "Branch must be a string." });
      }

      const targetBranch = (branch && branch.trim()) || "main";
      const cleanToken = typeof token === "string" ? token.trim() : "";
      const cleanSha =
        typeof treeSha === "string" && treeSha.trim()
          ? treeSha.trim()
          : typeof commitSha === "string" && commitSha.trim()
            ? commitSha.trim()
            : undefined;
      const cleanPattern = pattern.trim();
      const safeMaxMatches = Math.min(
        Math.max(1, Math.floor(Number(maxMatches) || DEFAULT_GREP_MATCHES)),
        MAX_GREP_MATCHES,
      );
      const cleanPrefix =
        typeof pathPrefix === "string" && pathPrefix.trim() ? pathPrefix.trim() : undefined;

      const tarballResult = await getOrFetchTarballSnapshot(
        owner,
        repo,
        targetBranch,
        cleanSha,
        cleanToken,
      );

      if (tarballResult.snapshot) {
        const result = grepFileEntriesMap(
          tarballResult.snapshot.files.entries(),
          cleanPattern,
          cleanPrefix,
          Boolean(caseSensitive),
          safeMaxMatches,
        );
        return res.json({
          matches: result.matches,
          filesScanned: result.filesScanned,
          truncated: result.truncated,
          scope: "tarball",
          literalFallback: result.literalFallback || undefined,
          note:
            tarballResult.snapshot.skippedOversizedFiles > 0
              ? `Full tarball snapshot searched (${tarballResult.snapshot.skippedOversizedFiles} oversized file(s) skipped).`
              : undefined,
        });
      }

      // Fallback 1: search server-side cached files for this repository and auth scope
      const tokenScope = makeTokenScope(cleanToken);
      const cachedEntries = new Map<string, string>();
      const now = Date.now();
      for (const v of rawFileCache.values()) {
        if (now - v.fetchedAt > RAW_FILE_CACHE_TTL_MS) continue;
        if (
          v.tokenScope !== tokenScope ||
          v.owner !== owner ||
          v.repo !== repo ||
          v.branch !== targetBranch
        ) {
          continue;
        }
        if (cleanSha && v.treeSha && v.treeSha !== cleanSha) {
          continue;
        }
        if (v.treeSha === (cleanSha || "") || !cachedEntries.has(v.filePath)) {
          cachedEntries.set(v.filePath, v.content);
        }
      }

      const cachedScan = grepFileEntriesMap(
        cachedEntries.entries(),
        cleanPattern,
        cleanPrefix,
        Boolean(caseSensitive),
        safeMaxMatches,
      );

      if (cachedScan.matches.length > 0 || !cleanToken) {
        return res.json({
          matches: cachedScan.matches,
          filesScanned: cachedScan.filesScanned,
          truncated: cachedScan.truncated,
          scope: "loaded_files",
          literalFallback: cachedScan.literalFallback || undefined,
          note: `Tarball unavailable (${tarballResult.fallbackReason}); searched ${cachedScan.filesScanned} cached file(s).`,
        });
      }

      // Fallback 2: GitHub Code Search API (authenticated)
      try {
        const qParts = [cleanPattern.slice(0, 120), `repo:${owner}/${repo}`];
        if (cleanPrefix) {
          qParts.push(`path:${cleanPrefix}`);
        }
        const searchRes = await fetch(
          `https://api.github.com/search/code?q=${encodeURIComponent(qParts.join(" "))}&per_page=25`,
          {
            headers: {
              "Accept": "application/vnd.github.v3+json",
              "User-Agent": "repo-prompt-generator/1.0.0",
              "Authorization": `Bearer ${cleanToken}`,
            },
            signal: AbortSignal.timeout(15000),
          },
        );
        if (searchRes.ok) {
          const data = await searchRes.json().catch(() => ({}));
          const items: any[] = Array.isArray(data?.items) ? data.items : [];
          return res.json({
            matches: items.slice(0, safeMaxMatches).map((it) => ({
              path: String(it.path || ""),
              line: 1,
              preview: "(matched via GitHub Code Search; call request_file_range to inspect lines)",
            })),
            filesScanned: items.length,
            truncated: items.length > safeMaxMatches,
            scope: "github_search",
            note: `Tarball unavailable (${tarballResult.fallbackReason}); used GitHub Code Search API.`,
          });
        }
      } catch {
        // Return cachedScan below
      }

      return res.json({
        matches: cachedScan.matches,
        filesScanned: cachedScan.filesScanned,
        truncated: cachedScan.truncated,
        scope: "loaded_files",
        literalFallback: cachedScan.literalFallback || undefined,
        note: `Tarball unavailable (${tarballResult.fallbackReason}); searched cached files only.`,
      });
    } catch (error: any) {
      console.error("Error in /api/repo/grep:", error);
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  });

  // Verify GitHub token validity without consuming API core quota
  app.post("/api/repo/verify-token", async (req, res) => {
    try {
      const cleanToken =
        typeof req.body?.token === "string" ? req.body.token.trim() : "";
      if (!cleanToken) {
        return res.status(400).json({
          valid: false,
          error: "GitHub token is empty.",
        });
      }

      const ghRes = await fetch("https://api.github.com/rate_limit", {
        headers: {
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "repo-prompt-generator/1.0.0",
          "Authorization": `Bearer ${cleanToken}`,
        },
        signal: AbortSignal.timeout(10000),
      });

      if (ghRes.status === 401) {
        return res.status(401).json({
          valid: false,
          error: "Invalid or expired token (401 Unauthorized).",
        });
      }

      if (!ghRes.ok) {
        return res.status(ghRes.status).json({
          valid: false,
          error: `GitHub API returned ${ghRes.status} ${ghRes.statusText}`,
        });
      }

      const data = await ghRes.json().catch(() => ({}));
      const core = data?.resources?.core || data?.rate || {};
      const scopes = ghRes.headers.get("x-oauth-scopes") || "";

      return res.json({
        valid: true,
        limit: typeof core.limit === "number" ? core.limit : undefined,
        remaining: typeof core.remaining === "number" ? core.remaining : undefined,
        scopes,
      });
    } catch (error: any) {
      res.status(500).json({
        valid: false,
        error: error?.message || "Failed to contact GitHub API.",
      });
    }
  });

  // Proxy for OpenAI-compatible /models
  app.post("/api/openai-compatible/models", async (req, res) => {
    try {
      const { baseUrl, apiKey } = req.body;
      const cleanBaseUrl = validateProxyBaseUrl(baseUrl);
      if (!cleanBaseUrl) {
        return res
          .status(400)
          .json({ error: "A valid http/https baseUrl is required" });
      }
      const headers: Record<string, string> = {
        "HTTP-Referer": "https://ais-dev.run.app",
        "X-Title": "AI Studio Applet",
        "User-Agent": "AI-Studio-Applet/1.0",
      };
      if (typeof apiKey === "string" && apiKey.trim()) {
        headers["Authorization"] = `Bearer ${apiKey.trim()}`;
      }
      const response = await fetch(`${cleanBaseUrl}/models`, {
        headers,
        signal: AbortSignal.timeout(30000),
      });
      const text = await response.text();
      res
        .status(response.status)
        .type(response.headers.get("content-type") || "application/json")
        .send(text);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Proxy for OpenAI-compatible /chat/completions
  app.post("/api/openai-compatible/chat", async (req, res) => {
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ac.abort();
    });
    try {
      const { baseUrl, apiKey, payload } = req.body;
      const cleanBaseUrl = validateProxyBaseUrl(baseUrl);
      if (!cleanBaseUrl || !payload) {
        return res
          .status(400)
          .json({ error: "A valid http/https baseUrl and payload are required" });
      }
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "HTTP-Referer": "https://ais-dev.run.app",
        "X-Title": "AI Studio Applet",
        "User-Agent": "AI-Studio-Applet/1.0",
      };
      if (typeof apiKey === "string" && apiKey.trim()) {
        headers["Authorization"] = `Bearer ${apiKey.trim()}`;
      }
      const response = await fetch(`${cleanBaseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      const text = await response.text();
      res
        .status(response.status)
        .type(response.headers.get("content-type") || "application/json")
        .send(text);
    } catch (error: any) {
      if (error?.name === "AbortError" || ac.signal.aborted) {
        return res.status(499).json({ error: "Request aborted" });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Server-side Gemini query rewrite endpoint
  app.post("/api/gemini/rewrite", async (req, res) => {
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ac.abort();
    });
    try {
      const apiKey = resolveServerGeminiKey(req.header("x-gemini-api-key"));
      if (!apiKey) {
        return res.status(400).json({
          error:
            "Gemini API key is missing. Set GEMINI_API_KEY in Settings > Secrets or provide a key.",
        });
      }
      const { prompt } = req.body || {};
      if (typeof prompt !== "string" || !prompt.trim()) {
        return res.status(400).json({ error: "Prompt is required." });
      }
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });
      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          abortSignal: ac.signal,
        },
      });
      res.json({ text: response.text || "{}" });
    } catch (error: any) {
      if (error?.name === "AbortError" || ac.signal.aborted) {
        return res.status(499).json({ error: "Request aborted" });
      }
      const formatted = formatGeminiServerError(error);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // Server-side Gemini generation & Agentic RAG multi-turn endpoint
  app.post("/api/gemini/generate", async (req, res) => {
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ac.abort();
    });
    try {
      const apiKey = resolveServerGeminiKey(req.header("x-gemini-api-key"));
      if (!apiKey) {
        return res.status(400).json({
          error:
            "Gemini API key is missing. Set GEMINI_API_KEY in Settings > Secrets or provide a key.",
        });
      }
      const {
        model,
        contents,
        enableDeepAnalysis,
        functionCallingMode,
        thinkingLevel,
        systemInstruction,
      } = req.body || {};

      if (!Array.isArray(contents) || contents.length === 0) {
        return res.status(400).json({ error: "contents array is required." });
      }

      const resolvedModel =
        typeof model === "string" && ALLOWED_GEMINI_MODELS.has(model)
          ? model
          : "gemini-4-hydrogen";

      const resolvedThinkingLevel = resolveServerThinkingLevel(
        resolvedModel,
        thinkingLevel,
      );

      const config: Record<string, any> = {
        thinkingConfig: { thinkingLevel: resolvedThinkingLevel },
        abortSignal: ac.signal,
      };

      if (typeof systemInstruction === "string" && systemInstruction.trim()) {
        config.systemInstruction = systemInstruction;
      }

      if (enableDeepAnalysis) {
        config.tools = [
          {
            functionDeclarations: [
              {
                name: "grep_repository",
                description:
                  "Search repository text files for a literal string or regex pattern, returning matching file paths, 1-indexed line numbers, and line previews. Use this to locate symbols, identifiers, or references before reading code with request_file_range.",
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    pattern: {
                      type: Type.STRING,
                      description:
                        "Regex or plain-text pattern to search for (max 200 chars; invalid regex falls back to literal match).",
                    },
                    pathPrefix: {
                      type: Type.STRING,
                      description:
                        "Optional directory or file path prefix filter (e.g., 'src/services/').",
                    },
                    caseSensitive: {
                      type: Type.BOOLEAN,
                      description: "Whether matching is case-sensitive (default false).",
                    },
                    maxMatches: {
                      type: Type.INTEGER,
                      description: "Maximum matches to return (default 40, max 100).",
                    },
                    repo: {
                      type: Type.STRING,
                      description:
                        "Optional repository target when both target and reference repos exist: 'target' or 'reference'.",
                    },
                  },
                  required: ["pattern"],
                },
              },
              {
                name: "request_file_range",
                description:
                  "Read a specific 1-indexed line range (up to 400 lines per call) from a repository file, including sections omitted by truncation or files not included in initial context. Preferred for inspecting truncated files or targeted line ranges.",
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    path: {
                      type: Type.STRING,
                      description: "Exact repository file path from the File Tree.",
                    },
                    startLine: {
                      type: Type.INTEGER,
                      description: "1-indexed start line number (inclusive, default 1).",
                    },
                    endLine: {
                      type: Type.INTEGER,
                      description:
                        "1-indexed end line number (inclusive, max 400 lines per call; defaults to startLine + 249).",
                    },
                    repo: {
                      type: Type.STRING,
                      description:
                        "Optional repository target when both target and reference repos exist: 'target' or 'reference'.",
                    },
                  },
                  required: ["path"],
                },
              },
              {
                name: "request_additional_files",
                description:
                  "Request initial slices of multiple repository files at once (batch cap scales dynamically with context budget, up to 20 files per call). For large or truncated files, prefer request_file_range to inspect specific line windows.",
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    filePaths: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                      description: "List of repository file paths to fetch.",
                    },
                  },
                  required: ["filePaths"],
                },
              },
            ],
          },
        ];
        config.toolConfig = {
          functionCallingConfig: {
            mode:
              functionCallingMode === "NONE"
                ? FunctionCallingConfigMode.NONE
                : FunctionCallingConfigMode.AUTO,
          },
        };
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });

      const response = await ai.models.generateContent({
        model: resolvedModel,
        contents,
        config,
      });

      if (
        (!response.candidates || response.candidates.length === 0) &&
        response.promptFeedback?.blockReason
      ) {
        return res.status(400).json({
          error: `Gemini blocked response: ${response.promptFeedback.blockReason}`,
        });
      }

      res.json({
        candidates: response.candidates || [],
        promptFeedback: response.promptFeedback,
      });
    } catch (error: any) {
      if (error?.name === "AbortError" || ac.signal.aborted) {
        return res.status(499).json({ error: "Request aborted" });
      }
      const formatted = formatGeminiServerError(error);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // Vite middleware for development
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  if (process.env.NODE_ENV !== "production") {
    let resolvedVite: Awaited<ReturnType<typeof createViteServer>> | null = null;
    const vitePromise = createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
      root: __dirname,
    }).then((vite) => {
      resolvedVite = vite;
      return vite;
    });
    vitePromise.catch((err) => {
      console.error("Failed to initialize Vite dev server:", err);
      process.exit(1);
    });
    app.use(async (req, res, next) => {
      try {
        const vite = resolvedVite ?? (await vitePromise);
        vite.middlewares(req, res, next);
      } catch (err) {
        next(err);
      }
    });
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
