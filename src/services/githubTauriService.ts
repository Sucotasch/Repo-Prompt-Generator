import { tauriFetch } from '../utils/tauriFetch';
import { RepoData } from './githubService';

export async function fetchRepoDataTauri(owner: string, repo: string, branch?: string, token?: string, maxFiles: number = 5): Promise<RepoData> {
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  // Fetch basic info
  const infoRes = await tauriFetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (!infoRes.ok) {
    if (infoRes.status === 403) {
      throw new Error('GitHub API rate limit exceeded. Please try again later or provide a GitHub token.');
    } else if (infoRes.status === 404) {
      throw new Error('Repository not found. Please check the URL or provide a token for private repos.');
    }
    throw new Error(`Failed to fetch repository info: ${infoRes.statusText}`);
  }
  
  const infoData = await infoRes.json();
  const defaultBranch = infoData.default_branch;
  const description = infoData.description || 'No description provided.';

  const targetBranch = branch || defaultBranch;
  const encodedBranch = encodeURIComponent(targetBranch);

  const HARD_IGNORE = ['venv', '.venv', 'node_modules', '.git', '__pycache__', 'dist', 'build'];
  const SECRET_IGNORE = ['.env', '.pem', '.key', '.cert', '.p12', 'secrets.json', 'credentials.json', 'id_rsa'];

  // Fetch tree
  const treeRes = await tauriFetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodedBranch}?recursive=1`, { headers });
  let treePaths: string[] = [];
  
  if (treeRes.ok) {
    const treeData = await treeRes.json();
    treePaths = treeData.tree
      .filter((item: any) => item.type === 'blob')
      .map((item: any) => item.path)
      .filter((path: string) => {
        const isHardIgnored = HARD_IGNORE.some(ignore => path.includes(`/${ignore}/`) || path.startsWith(`${ignore}/`));
        const isSecret = SECRET_IGNORE.some(secret => path.endsWith(secret) || path.includes(`/${secret}`));
        return !isHardIgnored && !isSecret;
      });
  } else {
    if (treeRes.status === 404) {
      throw new Error(`Branch, tag, or commit '${targetBranch}' not found in repository.`);
    }
    throw new Error(`Failed to fetch repository tree: ${treeRes.statusText}`);
  }

  // Fetch README
  let readme = '';
  const readmeRes = await tauriFetch(`https://api.github.com/repos/${owner}/${repo}/readme?ref=${encodedBranch}`, { headers });
  if (readmeRes.ok) {
    const readmeData = await readmeRes.json();
    try {
      readme = decodeURIComponent(escape(atob(readmeData.content)));
    } catch (e) {
      readme = atob(readmeData.content);
    }
  }

  // Fetch dependencies
  let dependencies = '';
  const depFiles = ['package.json', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle'];
  
  for (const file of depFiles) {
    if (treePaths.includes(file)) {
      const fileRes = await tauriFetch(`https://api.github.com/repos/${owner}/${repo}/contents/${file}?ref=${encodedBranch}`, { headers });
      if (fileRes.ok) {
        const fileData = await fileRes.json();
        try {
          dependencies += `\n--- ${file} ---\n${decodeURIComponent(escape(atob(fileData.content)))}\n`;
        } catch (e) {
          dependencies += `\n--- ${file} ---\n${atob(fileData.content)}\n`;
        }
      }
    }
  }

  // Fetch top source files
  const sourceFiles: {path: string, content: string}[] = [];
  const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cpp', '.c', '.h', '.cs', '.md'];
  
  let filesToFetch = treePaths
    .filter(p => sourceExtensions.some(ext => p.endsWith(ext)))
    .filter(p => !depFiles.includes(p) && p.toLowerCase() !== 'readme.md');
    
  // Intelligent scoring system for file selection
  const getFileScore = (filePath: string): number => {
    let score = 0;
    const lowerPath = filePath.toLowerCase();
    const parts = lowerPath.split('/');
    const fileName = parts[parts.length - 1];
    const depth = parts.length;

    // 1. De-prioritize tests
    if (
      lowerPath.includes('/test/') || lowerPath.includes('/tests/') || lowerPath.includes('__tests__') ||
      fileName.includes('.test.') || fileName.includes('.spec.') || fileName.startsWith('test_') || fileName.endsWith('_test.go')
    ) {
      score -= 50;
    }

    // 2. De-prioritize build/config/auxiliary scripts and docs
    const auxKeywords = ['build', 'setup', 'config', 'webpack', 'vite', 'rollup', 'gulpfile', 'backup', 'manage.py', 'scripts/', 'tools/', 'docs/', 'example', 'demo', 'migrations/'];
    if (auxKeywords.some(k => lowerPath.includes(k))) {
      score -= 30;
    }

    // 3. Prioritize core directories
    const coreDirs = ['src/', 'lib/', 'app/', 'core/', 'pkg/', 'internal/'];
    if (coreDirs.some(d => lowerPath.startsWith(d) || lowerPath.includes(`/${d}`))) {
      score += 20;
    }

    // 4. Prioritize important filenames
    const importantNames = ['main', 'index', 'app', 'server', 'core', 'manager', 'parser', 'api', 'router', 'handler', 'controller', 'service', 'model', 'database'];
    if (importantNames.some(n => fileName.includes(n))) {
      score += 10;
    }

    // 5. Depth penalty
    score -= depth;

    return score;
  };
  
  // Sort by score descending
  filesToFetch.sort((a, b) => getFileScore(b) - getFileScore(a));
  
  // Limit to requested maxFiles
  const absoluteMax = token ? 200 : 10;
  const limit = Math.min(Math.max(1, Number(maxFiles) || 5), absoluteMax);
  filesToFetch = filesToFetch.slice(0, limit);

  for (const file of filesToFetch) {
    const fileRes = await tauriFetch(`https://api.github.com/repos/${owner}/${repo}/contents/${file}?ref=${encodedBranch}`, { headers });
    if (fileRes.ok) {
      const fileData = await fileRes.json();
      try {
        sourceFiles.push({ path: file, content: decodeURIComponent(escape(atob(fileData.content))) });
      } catch (e) {
        sourceFiles.push({ path: file, content: atob(fileData.content) });
      }
    }
  }

  let isTruncated = false;
  if (treePaths.length > 1000) {
    treePaths = treePaths.slice(0, 1000);
    isTruncated = true;
  }

  return {
    info: { owner, repo, defaultBranch, branch: targetBranch, description },
    tree: treePaths,
    readme,
    dependencies,
    sourceFiles,
    isTruncated
  };
}
