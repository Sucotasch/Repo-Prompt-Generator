export interface RepoInfo {
  owner: string;
  repo: string;
  defaultBranch: string;
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
    // Parse URL on the client to send only owner and repo
    const githubRegex = /^https:\/\/github\.com\/([a-zA-Z0-9-._]+)\/([a-zA-Z0-9-._]+)/;
    const match = url.match(githubRegex);

    if (!match) {
      throw new Error("Invalid GitHub URL format. Please provide a full URL like https://github.com/owner/repo");
    }

    const owner = match[1];
    const repo = match[2].replace(/\.git$/, '');

    const { invoke } = await import('@tauri-apps/api/core');
    const data = await invoke<RepoData>('fetch_github_repo', {
      owner,
      repo,
      token,
      maxFiles
    });

    return data;
  } catch (err: any) {
    if (err.name === 'TypeError' && err.message === 'Failed to fetch') {
      throw new Error('Network error: Failed to reach the server. Please check your connection.');
    }
    throw err;
  }
}
