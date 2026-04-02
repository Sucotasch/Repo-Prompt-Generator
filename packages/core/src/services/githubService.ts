import { isTauri, tauriInvoke } from "../utils/tauriAdapter.ts";

export interface RepoInfo {
  owner: string;
  repo: string;
  defaultBranch: string;
  branch?: string;
  description: string;
}

export interface RepoData {
  info: RepoInfo;
  tree: string[];
  readme: string;
  dependencies: string;
  sourceFiles?: { path: string; content: string }[];
  isTruncated?: boolean;
}

export async function fetchRepoData(
  url: string,
  token?: string,
  maxFiles: number = 5,
): Promise<RepoData> {
  try {
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
      return await tauriInvoke<RepoData>("fetch_github_repo", {
        owner,
        repo,
        branch,
        token,
        maxFiles,
      });
    }

    const response = await fetch("/api/repo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(60000), // 60s timeout for repo fetch
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

async function fetchFilesFromRepo(
  info: RepoInfo,
  filePaths: string[],
  token?: string
): Promise<{ path: string; content: string }[]> {
  if (filePaths.length === 0) return [];
  
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

      for (const file of filePaths.slice(0, 3)) {
        try {
          const url = `https://api.github.com/repos/${owner}/${repo}/contents/${file}?ref=${encodedBranch}`;
          const response = await tauriInvoke<any>("ai_network_request", {
            method: "GET",
            url,
            headers,
            body: null,
          });

          if (response && response.content) {
            // Base64 decode in browser
            const binaryString = atob(response.content);
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
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ owner, repo, branch, token, filePaths }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Failed to fetch specific files");
    }

    const data = await response.json();
    return data.files || [];
  } catch (err: any) {
    console.error("Error fetching specific files:", err);
    return [];
  }
}

export async function fetchSpecificFiles(
  repoData: RepoData,
  filePaths: string[],
  token?: string,
  referenceRepoData?: RepoData
): Promise<{ path: string; content: string }[]> {
  const targetFiles = filePaths.filter(f => repoData.tree.includes(f));
  const refFiles = referenceRepoData ? filePaths.filter(f => referenceRepoData.tree.includes(f) && !repoData.tree.includes(f)) : [];
  const unknownFiles = filePaths.filter(f => !repoData.tree.includes(f) && !(referenceRepoData && referenceRepoData.tree.includes(f)));
  
  const finalTargetFiles = [...targetFiles, ...unknownFiles];
  
  let results: { path: string; content: string }[] = [];
  
  if (finalTargetFiles.length > 0) {
    const targetResults = await fetchFilesFromRepo(repoData.info, finalTargetFiles, token);
    results = results.concat(targetResults);
  }
  
  if (refFiles.length > 0 && referenceRepoData) {
    const refResults = await fetchFilesFromRepo(referenceRepoData.info, refFiles, token);
    results = results.concat(refResults);
  }
  
  return results;
}
