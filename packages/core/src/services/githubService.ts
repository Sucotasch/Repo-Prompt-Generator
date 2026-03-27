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
