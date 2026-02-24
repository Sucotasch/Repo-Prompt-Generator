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
}

export async function fetchRepoData(url: string): Promise<RepoData> {
  try {
    const response = await fetch('/api/repo', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url }),
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
