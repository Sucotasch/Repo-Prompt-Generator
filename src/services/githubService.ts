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

export async function fetchRepoData(url: string, token?: string, maxFiles: number = 5): Promise<RepoData> {
  try {
    let urlObj;
    try {
      urlObj = new URL(url);
    } catch (e) {
      throw new Error("Invalid URL format. Please provide a full GitHub URL.");
    }

    if (urlObj.hostname !== 'github.com') {
      throw new Error("Only github.com URLs are supported.");
    }

    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    if (pathParts.length < 2) {
      throw new Error("Invalid GitHub URL format. Please provide a full URL like https://github.com/owner/repo");
    }

    const owner = pathParts[0];
    const repo = pathParts[1].replace(/\.git$/, '');
    let branch = undefined;

    if (pathParts.length >= 4 && pathParts[2] === 'tree') {
      branch = pathParts.slice(3).join('/');
    }

    const response = await fetch('/api/repo', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ owner, repo, branch, token, maxFiles }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to fetch repository data');
    }

    return data;
  } catch (err: any) {
    if (err.name === 'TypeError' && err.message === 'Failed to fetch') {
      throw new Error('Network error: Failed to reach the server. Please check your connection.');
    }
    throw err;
  }
}
