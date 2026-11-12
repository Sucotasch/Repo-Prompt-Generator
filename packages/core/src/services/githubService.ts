import { isTauri, tauriInvoke } from "../utils/tauriAdapter.ts";

export interface RepoInfo {
  owner: string;
  repo: string;
  defaultBranch: string;
  branch?: string;
  description: string;
  stargazersCount?: number;
  topics?: string[];
  language?: string | null;
}

export interface RepoData {
  info: RepoInfo;
  tree: string[];
  readme: string;
  dependencies: string;
  sourceFiles?: { path: string; content: string }[];
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
): Promise<{ path: string; content: string }[]> {
  if (filePaths.length === 0) return [];
  if (signal?.aborted) {
    throw new DOMException("Generation cancelled", "AbortError");
  }

  try {
    const owner = info.owner;
    const repo = info.repo;
    const branch = info.branch || info.defaultBranch;

    if (isTauri()) {
      const fetchedFiles: { path: string; content: string }[] = [];
      const encodedBranch = encodeURIComponent(branch);
      const headers: Record<string, string> = {
        "User-Agent": "AI-Studio-Applet/1.0",
        "Accept": "application/vnd.github.v3+json",
      };
      if (token) {
        headers["Authorization"] = `token ${token}`;
      }

      for (const file of filePaths.slice(0, 5)) {
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
              let content = new TextDecoder("utf-8").decode(bytes);

              if (content.length > 50000) {
                content = content.substring(0, 50000) + "\n\n... [TRUNCATED: File exceeds 50KB limit. Showing only the top part.]";
              }
              fetchedFiles.push({ path: file, content });
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
      body: JSON.stringify({ owner, repo, branch, token, filePaths: filePaths.slice(0, 5) }),
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
): Promise<{ path: string; content: string }[]> {
  if (signal?.aborted) {
    throw new DOMException("Generation cancelled", "AbortError");
  }
  const targetFiles = filePaths.filter(f => repoData.tree.includes(f));
  const refFiles = referenceRepoData ? filePaths.filter(f => referenceRepoData.tree.includes(f) && !repoData.tree.includes(f)) : [];
  const unknownFiles = filePaths.filter(f => !repoData.tree.includes(f) && !(referenceRepoData && referenceRepoData.tree.includes(f)));

  const finalTargetFiles = [...targetFiles, ...unknownFiles];

  let results: { path: string; content: string }[] = [];

  if (finalTargetFiles.length > 0) {
    if (repoData.info.owner === "local") {
      const localResults = await fetchLocalFiles(finalTargetFiles, localFiles, repoData);
      results = results.concat(localResults);
    } else {
      const targetResults = await fetchFilesFromRepo(repoData.info, finalTargetFiles, token, signal);
      results = results.concat(targetResults);
    }
  }

  if (signal?.aborted) {
    throw new DOMException("Generation cancelled", "AbortError");
  }

  if (refFiles.length > 0 && referenceRepoData) {
    if (referenceRepoData.info.owner === "local") {
      const refLocalResults = await fetchLocalFiles(refFiles, referenceLocalFiles, referenceRepoData);
      results = results.concat(refLocalResults);
    } else {
      const refResults = await fetchFilesFromRepo(referenceRepoData.info, refFiles, token, signal);
      results = results.concat(refResults);
    }
  }

  return results;
}

async function fetchLocalFiles(
  filePaths: string[],
  localFiles: FileList | null | undefined,
  repoData: RepoData,
): Promise<{ path: string; content: string }[]> {
  const results: { path: string; content: string }[] = [];
  const missingNativePaths: string[] = [];

  for (const filePath of filePaths.slice(0, 5)) {
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
          let content = await file.text();
          if (content.length > 50000) {
            content =
              content.substring(0, 50000) +
              "\n\n... [TRUNCATED: File exceeds 50KB limit. Showing only the top part.]";
          }
          results.push({ path: filePath, content });
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
      const nativeFiles = await tauriInvoke<{ path: string; content: string }[]>(
        "read_local_repo_files",
        {
          root_path: repoData.localRootPath,
          file_paths: missingNativePaths,
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
