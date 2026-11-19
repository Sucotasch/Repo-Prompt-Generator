import { isTauri, tauriInvoke } from "../utils/tauriAdapter.ts";
import {
  shouldIgnoreRepoPath,
  stripTrailingTruncationNotice,
  truncateAtLineBoundary,
} from "../utils/pathFilters.ts";

export interface RepoInfo {
  owner: string;
  repo: string;
  defaultBranch: string;
  branch?: string;
  description: string;
  stargazersCount?: number;
  topics?: string[];
  language?: string | null;
  commitSha?: string;
  treeSha?: string;
  fetchedAt?: string;
}

export interface RepoSourceFile {
  path: string;
  content: string;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  truncated?: boolean;
  ragScore?: number;
  isSummary?: boolean;
  zone?: string;
}

export interface FileRangeResult extends RepoSourceFile {
  outOfRange?: boolean;
  error?: string;
}

export interface RepoData {
  info: RepoInfo;
  tree: string[];
  totalTreeFiles?: number;
  readme: string;
  dependencies: string;
  sourceFiles?: RepoSourceFile[];
  isTruncated?: boolean;
  localRootPath?: string;
}

function withTimeoutSignal(ms: number, externalSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(ms);
  if (!externalSignal) return timeoutSignal;
  if (typeof (AbortSignal as any).any === "function") {
    return (AbortSignal as any).any([timeoutSignal, externalSignal]);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (externalSignal.aborted || timeoutSignal.aborted) {
    controller.abort();
  } else {
    externalSignal.addEventListener("abort", onAbort, { once: true });
    timeoutSignal.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

export async function fetchRepoData(
  url: string,
  token?: string,
  maxFiles: number = 5,
  signal?: AbortSignal,
): Promise<RepoData> {
  try {
    if (signal?.aborted) {
      throw new DOMException("Generation cancelled", "AbortError");
    }

    let owner = "";
    let repo = "";
    let branch = undefined;

    try {
      const urlObj = new URL(url);
      if (urlObj.hostname !== "github.com") {
        throw new Error("Only github.com URLs are supported.");
      }
      const pathParts = urlObj.pathname.split("/").filter(Boolean);
      if (pathParts.length < 2) {
        throw new Error(
          "Invalid GitHub URL format. Please provide owner and repo name.",
        );
      }
      owner = pathParts[0];
      repo = pathParts[1].replace(/\.git$/, "");
      if (pathParts.length >= 4 && pathParts[2] === "tree") {
        branch = pathParts.slice(3).join("/");
      }
    } catch (e: any) {
      // Fallback for non-URL strings if owner/repo provided directly
      const githubRegex =
        /^https:\/\/github\.com\/([a-zA-Z0-9-._]+)\/([a-zA-Z0-9-._]+)/;
      const match = url.match(githubRegex);
      if (match) {
        owner = match[1];
        repo = match[2].replace(/\.git$/, "");
      } else {
        throw new Error("Invalid GitHub URL format.");
      }
    }

    if (isTauri()) {
      const res = await tauriInvoke<RepoData>("fetch_github_repo", {
        owner,
        repo,
        branch,
        token,
        maxFiles,
      });
      if (signal?.aborted) {
        throw new DOMException("Generation cancelled", "AbortError");
      }
      return res;
    }

    const response = await fetch("/api/repo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: withTimeoutSignal(60000, signal), // 60s timeout + cancel support
      body: JSON.stringify({ owner, repo, branch, token, maxFiles }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Failed to fetch repository data");
    }

    return await response.json();
  } catch (err: any) {
    if (err.name === "TypeError" && err.message === "Failed to fetch") {
      throw new Error(
        "Network error: Failed to reach the server. Please check your connection.",
      );
    }
    throw err;
  }
}

export function sanitizeAndEncodeGitHubPath(filePath: string): string | null {
  if (typeof filePath !== "string") return null;
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) {
    return null;
  }
  return segments.map((s) => encodeURIComponent(s)).join("/");
}

async function fetchFilesFromRepo(
  info: RepoInfo,
  filePaths: string[],
  token?: string,
  signal?: AbortSignal,
  maxFiles: number = 10,
): Promise<RepoSourceFile[]> {
  if (filePaths.length === 0) return [];
  if (signal?.aborted) {
    throw new DOMException("Generation cancelled", "AbortError");
  }
  const safeMax = Math.min(Math.max(1, Math.floor(maxFiles)), 20);

  try {
    const owner = info.owner;
    const repo = info.repo;
    const branch = info.branch || info.defaultBranch;

    if (isTauri()) {
      const fetchedFiles: RepoSourceFile[] = [];
      const encodedBranch = encodeURIComponent(branch);
      const headers: Record<string, string> = {
        "User-Agent": "AI-Studio-Applet/1.0",
        "Accept": "application/vnd.github.v3+json",
      };
      const cleanToken = token?.trim();
      if (cleanToken) {
        headers["Authorization"] = `Bearer ${cleanToken}`;
      }

      for (const file of filePaths.slice(0, safeMax)) {
        if (signal?.aborted) {
          throw new DOMException("Generation cancelled", "AbortError");
        }
        const encodedFile = sanitizeAndEncodeGitHubPath(file);
        if (!encodedFile) {
          console.warn(`Skipped invalid GitHub path in Tauri: ${file}`);
          continue;
        }
        try {
          const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedFile}?ref=${encodedBranch}`;
          const response = await tauriInvoke<{ status: number; text: string }>("ai_network_request", {
            method: "GET",
            url,
            headers,
            body: null,
          });

          if (response && response.status >= 200 && response.status < 300 && response.text) {
            const fileData = JSON.parse(response.text);
            if (fileData && typeof fileData.content === "string") {
              const cleanBase64 = fileData.content.replace(/\s/g, "");
              const binaryString = atob(cleanBase64);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              const rawNormalized = new TextDecoder("utf-8")
                .decode(bytes)
                .replace(/\r\n/g, "\n")
                .replace(/\r/g, "\n");
              const totalLines = rawNormalized.split("\n").length;
              const cut = truncateAtLineBoundary(rawNormalized, 50000);
              let content = cut.text;
              const truncated = cut.truncated;
              const endLine = content.split("\n").length;
              if (truncated) {
                content += `\n\n... [TRUNCATED: File exceeds 50KB limit. Showing lines 1-${endLine} of ${totalLines}.]`;
              }
              fetchedFiles.push({ path: file, content, startLine: 1, endLine, totalLines, truncated });
            }
          }
        } catch (e) {
          console.warn(`Failed to fetch specific file ${file} in Tauri:`, e);
        }
      }
      return fetchedFiles;
    }

    const response = await fetch("/api/repo/files", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: withTimeoutSignal(30000, signal),
      body: JSON.stringify({
        owner,
        repo,
        branch,
        treeSha: info.treeSha ?? info.commitSha,
        token,
        maxFiles: safeMax,
        filePaths: filePaths.slice(0, safeMax),
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Failed to fetch specific files");
    }

    const data = await response.json();
    return data.files || [];
  } catch (err: any) {
    if (err?.name === "AbortError" || signal?.aborted) {
      throw new DOMException("Generation cancelled", "AbortError");
    }
    console.error("Error fetching specific files:", err);
    return [];
  }
}

export async function fetchSpecificFiles(
  repoData: RepoData,
  filePaths: string[],
  token?: string,
  referenceRepoData?: RepoData,
  localFiles?: FileList | null,
  referenceLocalFiles?: FileList | null,
  signal?: AbortSignal,
  maxFiles: number = 10,
): Promise<RepoSourceFile[]> {
  if (signal?.aborted) {
    throw new DOMException("Generation cancelled", "AbortError");
  }
  const targetFiles = filePaths.filter(f => repoData.tree.includes(f));
  const refFiles = referenceRepoData ? filePaths.filter(f => referenceRepoData.tree.includes(f) && !repoData.tree.includes(f)) : [];
  const unknownFiles = filePaths.filter(f => !repoData.tree.includes(f) && !(referenceRepoData && referenceRepoData.tree.includes(f)));

  const finalTargetFiles = [...targetFiles, ...unknownFiles];

  let results: RepoSourceFile[] = [];

  if (finalTargetFiles.length > 0) {
    if (repoData.info.owner === "local") {
      const localResults = await fetchLocalFiles(finalTargetFiles, localFiles, repoData, maxFiles);
      results = results.concat(localResults);
    } else {
      const targetResults = await fetchFilesFromRepo(repoData.info, finalTargetFiles, token, signal, maxFiles);
      results = results.concat(targetResults);
    }
  }

  if (signal?.aborted) {
    throw new DOMException("Generation cancelled", "AbortError");
  }

  if (refFiles.length > 0 && referenceRepoData) {
    if (referenceRepoData.info.owner === "local") {
      const refLocalResults = await fetchLocalFiles(refFiles, referenceLocalFiles, referenceRepoData, maxFiles);
      results = results.concat(refLocalResults);
    } else {
      const refResults = await fetchFilesFromRepo(referenceRepoData.info, refFiles, token, signal, maxFiles);
      results = results.concat(refResults);
    }
  }

  return results;
}

async function fetchLocalFiles(
  filePaths: string[],
  localFiles: FileList | null | undefined,
  repoData: RepoData,
  maxFiles: number = 10,
): Promise<RepoSourceFile[]> {
  const safeMax = Math.min(Math.max(1, Math.floor(maxFiles)), 20);
  const results: RepoSourceFile[] = [];
  const missingNativePaths: string[] = [];

  for (const filePath of filePaths.slice(0, safeMax)) {
    const existing = repoData.sourceFiles?.find((f) => f.path === filePath);
    if (existing) {
      results.push(existing);
      continue;
    }

    if (localFiles) {
      const file = Array.from(localFiles).find(
        (f) => (f.webkitRelativePath || f.name) === filePath,
      );
      if (file) {
        try {
          const rawNormalized = (await file.text()).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
          const totalLines = rawNormalized.split("\n").length;
          const cut = truncateAtLineBoundary(rawNormalized, 50000);
          let content = cut.text;
          const truncated = cut.truncated;
          const endLine = content.split("\n").length;
          if (truncated) {
            content += `\n\n... [TRUNCATED: File exceeds 50KB limit. Showing lines 1-${endLine} of ${totalLines}.]`;
          }
          results.push({ path: filePath, content, startLine: 1, endLine, totalLines, truncated });
        } catch (e) {
          console.error(`Failed to read local file ${filePath}:`, e);
        }
      }
    } else if (isTauri() && repoData.localRootPath) {
      missingNativePaths.push(filePath);
    }
  }

  if (missingNativePaths.length > 0 && isTauri() && repoData.localRootPath) {
    try {
      const nativeFiles = await tauriInvoke<RepoSourceFile[]>(
        "read_local_repo_files",
        {
          root_path: repoData.localRootPath,
          file_paths: missingNativePaths,
          max_files: safeMax,
        },
      );
      if (Array.isArray(nativeFiles)) {
        results.push(...nativeFiles);
      }
    } catch (e) {
      console.error("Failed to read local files via Tauri:", e);
    }
  }

  return results;
}

const DEFAULT_RANGE_LINES = 250;
const MAX_RANGE_LINES = 400;
const MAX_RANGE_CHARS = 50_000;
const MAX_RAW_FILE_BYTES = 5 * 1024 * 1024;
const TAURI_RAW_CACHE_MAX_BYTES = 15 * 1024 * 1024;
const TAURI_RAW_CACHE_MAX_ENTRIES = 60;
const TAURI_RAW_CACHE_TTL_MS = 15 * 60 * 1000;

interface CachedRawFile {
  content: string;
  bytes: number;
  fetchedAt: number;
}

const tauriRawFileCache = new Map<string, CachedRawFile>();
let tauriRawFileCacheBytes = 0;

function getTauriCachedRawFile(key: string): string | null {
  const entry = tauriRawFileCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TAURI_RAW_CACHE_TTL_MS) {
    tauriRawFileCache.delete(key);
    tauriRawFileCacheBytes -= entry.bytes;
    return null;
  }
  tauriRawFileCache.delete(key);
  tauriRawFileCache.set(key, entry);
  return entry.content;
}

function setTauriCachedRawFile(key: string, content: string): void {
  const bytes = content.length * 2;
  if (bytes > MAX_RAW_FILE_BYTES * 2) return;
  const existing = tauriRawFileCache.get(key);
  if (existing) {
    tauriRawFileCache.delete(key);
    tauriRawFileCacheBytes -= existing.bytes;
  }
  tauriRawFileCache.set(key, { content, bytes, fetchedAt: Date.now() });
  tauriRawFileCacheBytes += bytes;
  while (
    tauriRawFileCache.size > TAURI_RAW_CACHE_MAX_ENTRIES ||
    tauriRawFileCacheBytes > TAURI_RAW_CACHE_MAX_BYTES
  ) {
    const oldestKey = tauriRawFileCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = tauriRawFileCache.get(oldestKey);
    tauriRawFileCache.delete(oldestKey);
    if (oldest) tauriRawFileCacheBytes -= oldest.bytes;
  }
}

function isLikelyBinaryText(content: string): boolean {
  const sample = content.slice(0, 8192);
  return sample.includes("\u0000");
}

export function sliceFileContentByLines(
  path: string,
  rawContent: string,
  startLine?: number,
  endLine?: number,
  maxLines: number = MAX_RANGE_LINES,
  maxChars: number = MAX_RANGE_CHARS,
): FileRangeResult {
  const normalized = rawContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const allLines = normalized.split("\n");
  const totalLines = allLines.length;

  const safeStart = Math.max(
    1,
    Math.floor(typeof startLine === "number" && Number.isFinite(startLine) ? startLine : 1),
  );

  if (safeStart > totalLines) {
    return {
      path,
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
  const effectiveMaxLines = Math.max(1, Math.min(maxLines, MAX_RANGE_LINES));
  const clampedEnd = Math.min(
    totalLines,
    Math.max(safeStart, Math.min(requestedEnd, safeStart + effectiveMaxLines - 1)),
  );

  const selected = allLines.slice(safeStart - 1, clampedEnd);
  const kept: string[] = [];
  let charCount = 0;
  let hitCharCap = false;

  for (const line of selected) {
    const addLen = line.length + (kept.length > 0 ? 1 : 0);
    if (kept.length > 0 && charCount + addLen > maxChars) {
      hitCharCap = true;
      break;
    }
    if (kept.length === 0 && line.length > maxChars) {
      kept.push(`${line.slice(0, maxChars)} ... [LINE TRUNCATED]`);
      hitCharCap = true;
      break;
    }
    kept.push(line);
    charCount += addLen;
  }

  const actualEnd = safeStart + kept.length - 1;
  const truncated = safeStart > 1 || actualEnd < totalLines || hitCharCap;

  return {
    path,
    content: kept.join("\n"),
    startLine: safeStart,
    endLine: actualEnd,
    totalLines,
    truncated,
  };
}

async function fetchGithubRawFileTauri(
  info: RepoInfo,
  filePath: string,
  token?: string,
  signal?: AbortSignal,
): Promise<{ content?: string; error?: string }> {
  if (signal?.aborted) {
    throw new DOMException("Generation cancelled", "AbortError");
  }
  const encodedFile = sanitizeAndEncodeGitHubPath(filePath);
  if (!encodedFile) {
    return { error: `Invalid file path: '${filePath}'.` };
  }
  const branch = info.branch || info.defaultBranch;
  const cacheKey = `${info.owner}/${info.repo}@${branch}:${filePath}`;
  const cached = getTauriCachedRawFile(cacheKey);
  if (cached !== null) {
    return { content: cached };
  }

  const encodedBranch = encodeURIComponent(branch);
  const baseHeaders: Record<string, string> = {
    "User-Agent": "AI-Studio-Applet/1.0",
    "Accept": "application/vnd.github.v3+json",
  };
  const cleanToken = token?.trim();
  if (cleanToken) {
    baseHeaders["Authorization"] = `Bearer ${cleanToken}`;
  }

  const url = `https://api.github.com/repos/${info.owner}/${info.repo}/contents/${encodedFile}?ref=${encodedBranch}`;
  const response = await tauriInvoke<{ status: number; text: string }>("ai_network_request", {
    method: "GET",
    url,
    headers: baseHeaders,
    body: null,
  });

  if (signal?.aborted) {
    throw new DOMException("Generation cancelled", "AbortError");
  }

  if (!response || response.status < 200 || response.status >= 300) {
    return { error: `GitHub returned status ${response?.status ?? "unknown"} for '${filePath}'.` };
  }

  const fileData = JSON.parse(response.text || "{}");
  let rawContent: string | null = null;

  if (fileData && typeof fileData.content === "string" && fileData.content.length > 0) {
    const cleanBase64 = fileData.content.replace(/\s/g, "");
    const binaryString = atob(cleanBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    rawContent = new TextDecoder("utf-8").decode(bytes);
  } else if (fileData?.type === "file") {
    if (typeof fileData.size === "number" && fileData.size > MAX_RAW_FILE_BYTES) {
      return { error: `File '${filePath}' exceeds 5MB range-read limit (${fileData.size} bytes).` };
    }
    const rawRes = await tauriInvoke<{ status: number; text: string }>("ai_network_request", {
      method: "GET",
      url,
      headers: { ...baseHeaders, Accept: "application/vnd.github.raw" },
      body: null,
    });
    if (signal?.aborted) {
      throw new DOMException("Generation cancelled", "AbortError");
    }
    if (rawRes && rawRes.status >= 200 && rawRes.status < 300 && typeof rawRes.text === "string") {
      if (rawRes.text.length > MAX_RAW_FILE_BYTES) {
        return { error: `File '${filePath}' exceeds 5MB range-read limit.` };
      }
      rawContent = rawRes.text;
    }
  }

  if (rawContent === null) {
    return { error: `File '${filePath}' has no readable text content.` };
  }
  if (isLikelyBinaryText(rawContent)) {
    return { error: `File '${filePath}' appears to be binary.` };
  }

  setTauriCachedRawFile(cacheKey, rawContent);
  return { content: rawContent };
}

export async function fetchFileRange(
  repoData: RepoData,
  filePath: string,
  startLine?: number,
  endLine?: number,
  token?: string,
  referenceRepoData?: RepoData,
  localFiles?: FileList | null,
  referenceLocalFiles?: FileList | null,
  signal?: AbortSignal,
  repoHint?: "target" | "reference",
): Promise<FileRangeResult> {
  if (signal?.aborted) {
    throw new DOMException("Generation cancelled", "AbortError");
  }

  let selectedRepo = repoData;
  let selectedLocalFiles = localFiles;

  if (repoHint === "reference" && referenceRepoData) {
    selectedRepo = referenceRepoData;
    selectedLocalFiles = referenceLocalFiles;
  } else if (repoHint !== "target" && referenceRepoData) {
    const inTarget = repoData.tree.includes(filePath);
    const inRef = referenceRepoData.tree.includes(filePath);
    if (!inTarget && inRef) {
      selectedRepo = referenceRepoData;
      selectedLocalFiles = referenceLocalFiles;
    }
  }

  if (selectedRepo.info.owner === "local") {
    if (selectedLocalFiles) {
      const file = Array.from(selectedLocalFiles).find(
        (f) => (f.webkitRelativePath || f.name) === filePath,
      );
      if (file) {
        if (file.size > MAX_RAW_FILE_BYTES) {
          return {
            path: filePath,
            content: "",
            error: `Local file '${filePath}' exceeds 5MB range-read limit.`,
          };
        }
        const raw = await file.text();
        if (isLikelyBinaryText(raw)) {
          return {
            path: filePath,
            content: "",
            error: `Local file '${filePath}' appears to be binary.`,
          };
        }
        return sliceFileContentByLines(filePath, raw, startLine, endLine);
      }
    }

    if (isTauri() && selectedRepo.localRootPath) {
      try {
        const res = await tauriInvoke<FileRangeResult>("read_local_repo_range", {
          root_path: selectedRepo.localRootPath,
          file_path: filePath,
          start_line: startLine ?? 1,
          end_line: endLine ?? null,
        });
        return res;
      } catch (e: any) {
        return {
          path: filePath,
          content: "",
          error: typeof e === "string" ? e : e?.message || `Failed to read '${filePath}'.`,
        };
      }
    }

    const existing = selectedRepo.sourceFiles?.find(
      (f) => f.path === filePath && !f.truncated && !f.isSummary,
    );
    if (existing) {
      return sliceFileContentByLines(filePath, existing.content, startLine, endLine);
    }

    return {
      path: filePath,
      content: "",
      error: `Local file '${filePath}' not found.`,
    };
  }

  // GitHub repository
  if (isTauri()) {
    try {
      const fetched = await fetchGithubRawFileTauri(selectedRepo.info, filePath, token, signal);
      if (fetched.error || fetched.content === undefined) {
        return {
          path: filePath,
          content: "",
          error: fetched.error || `Failed to fetch '${filePath}'.`,
        };
      }
      return sliceFileContentByLines(filePath, fetched.content, startLine, endLine);
    } catch (err: any) {
      if (err?.name === "AbortError" || signal?.aborted) {
        throw new DOMException("Generation cancelled", "AbortError");
      }
      return {
        path: filePath,
        content: "",
        error: err?.message || `Failed to fetch '${filePath}'.`,
      };
    }
  }

  try {
    const response = await fetch("/api/repo/file-range", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: withTimeoutSignal(30000, signal),
      body: JSON.stringify({
        owner: selectedRepo.info.owner,
        repo: selectedRepo.info.repo,
        branch: selectedRepo.info.branch || selectedRepo.info.defaultBranch,
        treeSha: selectedRepo.info.treeSha ?? selectedRepo.info.commitSha,
        token,
        path: filePath,
        startLine,
        endLine,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        path: filePath,
        content: "",
        error: data?.error || `Failed to fetch range for '${filePath}' (${response.status}).`,
      };
    }

    return data.file as FileRangeResult;
  } catch (err: any) {
    if (err?.name === "AbortError" || signal?.aborted) {
      throw new DOMException("Generation cancelled", "AbortError");
    }
    return {
      path: filePath,
      content: "",
      error: err?.message || `Network error while reading '${filePath}'.`,
    };
  }
}

export interface GrepMatch {
  path: string;
  line: number;
  preview: string;
}

export interface GrepRepositoryResult {
  matches: GrepMatch[];
  filesScanned: number;
  truncated: boolean;
  scope: "tarball" | "local_fs" | "local_files" | "loaded_files" | "github_search";
  literalFallback?: boolean;
  note?: string;
  error?: string;
}

const MAX_GREP_PATTERN_LEN = 200;
const MAX_GREP_MATCHES = 100;
const DEFAULT_GREP_MATCHES = 40;
const MAX_GREP_LINE_PREVIEW = 240;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
const UNSAFE_REGEX_PATTERN = /(\([^)]*[+*][^)]*\))[+*?]|\{\d+,\}\s*[+*]/;

function buildSafeMatcher(
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
      // Fall through to literal substring match
    }
  }
  const needle = caseSensitive ? trimmed : trimmed.toLowerCase();
  return {
    testLine: (line: string) =>
      (caseSensitive ? line : line.toLowerCase()).includes(needle),
    literalFallback: true,
  };
}

export function grepTextFiles(
  files: { path: string; content: string; startLine?: number }[],
  pattern: string,
  options: {
    pathPrefix?: string;
    caseSensitive?: boolean;
    maxMatches?: number;
    scope: GrepRepositoryResult["scope"];
    note?: string;
  },
): GrepRepositoryResult {
  const cleanPattern = pattern.trim();
  if (!cleanPattern) {
    return {
      matches: [],
      filesScanned: 0,
      truncated: false,
      scope: options.scope,
      error: "Search pattern cannot be empty.",
    };
  }

  const maxMatches = Math.min(
    Math.max(1, Math.floor(options.maxMatches ?? DEFAULT_GREP_MATCHES)),
    MAX_GREP_MATCHES,
  );
  const normalizedPrefix = options.pathPrefix
    ? options.pathPrefix.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase()
    : "";
  const { testLine, literalFallback } = buildSafeMatcher(
    cleanPattern,
    Boolean(options.caseSensitive),
  );

  const matches: GrepMatch[] = [];
  let filesScanned = 0;
  let truncated = false;

  for (const file of files) {
    const normPath = file.path.replace(/\\/g, "/");
    if (normalizedPrefix && !normPath.toLowerCase().startsWith(normalizedPrefix)) {
      continue;
    }
    if (isLikelyBinaryText(file.content)) continue;
    filesScanned++;

    const cleanContent = stripTrailingTruncationNotice(
      file.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
    ).cleanText;
    const baseLine = file.startLine ?? 1;
    const lines = cleanContent.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      if (testLine(lineText)) {
        const preview =
          lineText.length > MAX_GREP_LINE_PREVIEW
            ? `${lineText.slice(0, MAX_GREP_LINE_PREVIEW)}...`
            : lineText;
        matches.push({
          path: normPath,
          line: baseLine + i,
          preview,
        });
        if (matches.length >= maxMatches) {
          truncated = true;
          break;
        }
      }
    }
    if (truncated) break;
  }

  return {
    matches,
    filesScanned,
    truncated,
    scope: options.scope,
    literalFallback: literalFallback || undefined,
    note: options.note,
  };
}

export async function grepRepository(
  repoData: RepoData,
  pattern: string,
  options?: {
    pathPrefix?: string;
    caseSensitive?: boolean;
    maxMatches?: number;
    repoHint?: "target" | "reference";
  },
  token?: string,
  referenceRepoData?: RepoData,
  localFiles?: FileList | null,
  referenceLocalFiles?: FileList | null,
  signal?: AbortSignal,
): Promise<GrepRepositoryResult> {
  if (signal?.aborted) {
    throw new DOMException("Generation cancelled", "AbortError");
  }

  const cleanPattern = pattern.trim();
  if (!cleanPattern) {
    return {
      matches: [],
      filesScanned: 0,
      truncated: false,
      scope: "loaded_files",
      error: "Parameter 'pattern' must be a non-empty string.",
    };
  }

  const selectedRepo =
    options?.repoHint === "reference" && referenceRepoData ? referenceRepoData : repoData;
  const selectedLocalFiles =
    options?.repoHint === "reference" && referenceRepoData ? referenceLocalFiles : localFiles;
  const maxMatches = Math.min(
    Math.max(1, Math.floor(options?.maxMatches ?? DEFAULT_GREP_MATCHES)),
    MAX_GREP_MATCHES,
  );

  // 1. Local repository modes
  if (selectedRepo.info.owner === "local") {
    if (selectedLocalFiles) {
      const normalizedPrefix = options?.pathPrefix
        ? options.pathPrefix.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase()
        : "";
      const { testLine, literalFallback } = buildSafeMatcher(
        cleanPattern,
        Boolean(options?.caseSensitive),
      );

      const matches: GrepMatch[] = [];
      let filesScanned = 0;
      let truncated = false;

      for (const file of Array.from(selectedLocalFiles)) {
        if (signal?.aborted) {
          throw new DOMException("Generation cancelled", "AbortError");
        }
        const relPath = (file.webkitRelativePath || file.name).replace(/\\/g, "/");
        if (shouldIgnoreRepoPath(relPath)) continue;
        if (normalizedPrefix && !relPath.toLowerCase().startsWith(normalizedPrefix)) continue;
        if (file.size > MAX_GREP_FILE_BYTES) continue;

        try {
          const text = await file.text();
          if (isLikelyBinaryText(text)) continue;
          filesScanned++;
          const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
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
        } catch {
          // skip unreadable file
        }
      }

      return {
        matches,
        filesScanned,
        truncated,
        scope: "local_files",
        literalFallback: literalFallback || undefined,
      };
    }

    if (isTauri() && selectedRepo.localRootPath) {
      try {
        return await tauriInvoke<GrepRepositoryResult>("grep_local_repository", {
          root_path: selectedRepo.localRootPath,
          pattern: cleanPattern,
          path_prefix: options?.pathPrefix || null,
          case_sensitive: Boolean(options?.caseSensitive),
          max_matches: maxMatches,
        });
      } catch (e: any) {
        return {
          matches: [],
          filesScanned: 0,
          truncated: false,
          scope: "local_fs",
          error: typeof e === "string" ? e : e?.message || "Local grep failed.",
        };
      }
    }

    const loaded = (selectedRepo.sourceFiles || []).filter((f) => !f.isSummary);
    return grepTextFiles(loaded, cleanPattern, {
      pathPrefix: options?.pathPrefix,
      caseSensitive: options?.caseSensitive,
      maxMatches,
      scope: "loaded_files",
      note: "Searched only files loaded in initial context.",
    });
  }

  // 2. GitHub repository in Tauri (search loaded/cached files, optional GitHub Code Search with token)
  if (isTauri()) {
    const mergedMap = new Map<string, { path: string; content: string; startLine?: number }>();
    for (const f of selectedRepo.sourceFiles || []) {
      if (!f.isSummary) {
        mergedMap.set(f.path, { path: f.path, content: f.content, startLine: f.startLine });
      }
    }
    const branch = selectedRepo.info.branch || selectedRepo.info.defaultBranch;
    const cachePrefix = `${selectedRepo.info.owner}/${selectedRepo.info.repo}@${branch}:`;
    for (const [k, v] of tauriRawFileCache.entries()) {
      if (k.startsWith(cachePrefix)) {
        const rel = k.slice(cachePrefix.length);
        mergedMap.set(rel, { path: rel, content: v.content, startLine: 1 });
      }
    }

    const localScan = grepTextFiles(Array.from(mergedMap.values()), cleanPattern, {
      pathPrefix: options?.pathPrefix,
      caseSensitive: options?.caseSensitive,
      maxMatches,
      scope: "loaded_files",
      note: "Searched loaded and cached files in Tauri session.",
    });

    const cleanToken = token?.trim();
    if (localScan.matches.length === 0 && cleanToken) {
      try {
        const qParts = [
          cleanPattern.slice(0, 120),
          `repo:${selectedRepo.info.owner}/${selectedRepo.info.repo}`,
        ];
        if (options?.pathPrefix) {
          qParts.push(`path:${options.pathPrefix}`);
        }
        const searchUrl = `https://api.github.com/search/code?q=${encodeURIComponent(qParts.join(" "))}&per_page=20`;
        const res = await tauriInvoke<{ status: number; text: string }>("ai_network_request", {
          method: "GET",
          url: searchUrl,
          headers: {
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "AI-Studio-Applet/1.0",
            "Authorization": `Bearer ${cleanToken}`,
          },
          body: null,
        });
        if (res && res.status >= 200 && res.status < 300) {
          const parsed = JSON.parse(res.text || "{}");
          const items: any[] = Array.isArray(parsed?.items) ? parsed.items : [];
          return {
            matches: items.slice(0, maxMatches).map((it) => ({
              path: String(it.path || ""),
              line: 1,
              preview: "(matched via GitHub Code Search; call request_file_range to inspect lines)",
            })),
            filesScanned: items.length,
            truncated: items.length > maxMatches,
            scope: "github_search",
            note: "Matched file paths via GitHub Code Search API (default branch).",
          };
        }
      } catch {
        // Keep loaded_files result
      }
    }

    return localScan;
  }

  // 3. GitHub repository in Web (Express server tarball snapshot cache + fallback)
  try {
    const response = await fetch("/api/repo/grep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: withTimeoutSignal(45000, signal),
      body: JSON.stringify({
        owner: selectedRepo.info.owner,
        repo: selectedRepo.info.repo,
        branch: selectedRepo.info.branch || selectedRepo.info.defaultBranch,
        treeSha: selectedRepo.info.treeSha ?? selectedRepo.info.commitSha,
        token,
        pattern: cleanPattern,
        pathPrefix: options?.pathPrefix,
        caseSensitive: Boolean(options?.caseSensitive),
        maxMatches,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        matches: [],
        filesScanned: 0,
        truncated: false,
        scope: "loaded_files",
        error: data?.error || `Repository grep failed (${response.status}).`,
      };
    }

    return data as GrepRepositoryResult;
  } catch (err: any) {
    if (err?.name === "AbortError" || signal?.aborted) {
      throw new DOMException("Generation cancelled", "AbortError");
    }
    return {
      matches: [],
      filesScanned: 0,
      truncated: false,
      scope: "loaded_files",
      error: err?.message || "Network error during grep_repository.",
    };
  }
}

export interface GithubTokenVerificationResult {
  valid: boolean;
  limit?: number;
  remaining?: number;
  scopes?: string;
  error?: string;
}

export async function verifyGithubToken(
  token: string,
  signal?: AbortSignal,
): Promise<GithubTokenVerificationResult> {
  const cleanToken = token.trim();
  if (!cleanToken) {
    return { valid: false, error: "GitHub token is empty." };
  }

  try {
    if (isTauri()) {
      const response = await tauriInvoke<{
        status: number;
        text: string;
        headers?: Record<string, string>;
      }>("ai_network_request", {
        method: "GET",
        url: "https://api.github.com/rate_limit",
        headers: {
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "Tauri/Prompt-Generator",
          "Authorization": `Bearer ${cleanToken}`,
        },
        body: null,
      });

      if (response.status === 401) {
        return {
          valid: false,
          error: "Invalid or expired token (401 Unauthorized).",
        };
      }
      if (response.status < 200 || response.status >= 300) {
        return {
          valid: false,
          error: `GitHub API returned status ${response.status}.`,
        };
      }
      const data = JSON.parse(response.text || "{}");
      const core = data?.resources?.core || data?.rate || {};
      const scopes = response.headers?.["x-oauth-scopes"] || "";
      return {
        valid: true,
        limit: typeof core.limit === "number" ? core.limit : undefined,
        remaining:
          typeof core.remaining === "number" ? core.remaining : undefined,
        scopes,
      };
    }

    const res = await fetch("/api/repo/verify-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: withTimeoutSignal(12000, signal),
      body: JSON.stringify({ token: cleanToken }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.valid) {
      return {
        valid: false,
        error: payload?.error || `Verification failed (${res.status}).`,
      };
    }
    return {
      valid: true,
      limit: payload.limit,
      remaining: payload.remaining,
      scopes: payload.scopes,
    };
  } catch (err: any) {
    return {
      valid: false,
      error: err?.message || "Failed to verify GitHub token.",
    };
  }
}

