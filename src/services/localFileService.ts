import { RepoData } from './githubService';

export async function selectLocalFolderWithTauri(maxFiles: number): Promise<RepoData> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const { invoke } = await import('@tauri-apps/api/core');

  const selected = await open({
    directory: true,
    multiple: false,
    title: "Select Repository Folder"
  });

  if (!selected || typeof selected !== 'string') {
    throw new Error("No folder selected");
  }

  const repoName = selected.split(/[\\/]/).pop() || 'local-repo';

  // Scans the repository using Rust for speed and bypassing browser limits
  const sourceFiles: { path: string, content: string }[] = await invoke('scan_local_repository', { path: selected });

  // Filter and score are now handled by the UI/services or can be refined
  // For consistency with existing logic, we might want to apply the same scoring here 
  // if the Rust command returns everything.

  // However, the Rust implementation I wrote returns ALL files. 
  // Let's refine the Rust command to do filtering too if we want, 
  // OR we can filter here in JS. 

  // For now, let's mirror the scoring logic from the original service 
  // but applied to the data returned from Rust.

  const HARD_IGNORE = ['venv', '.venv', 'node_modules', '.git', '__pycache__', 'dist', 'build'];
  const SECRET_IGNORE = ['.env', '.pem', '.key', '.cert', '.p12', 'secrets.json', 'credentials.json', 'id_rsa'];
  const depFiles = ['package.json', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle'];
  const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cpp', '.c', '.h', '.cs', '.md'];

  const getFileScore = (filePath: string): number => {
    let score = 0;
    const lowerPath = filePath.toLowerCase();
    const parts = lowerPath.split(/[\\/]/);
    const fileName = parts[parts.length - 1];
    const depth = parts.length;

    if (
      lowerPath.includes('/test/') || lowerPath.includes('/tests/') || lowerPath.includes('__tests__') ||
      lowerPath.includes('\\test\\') || lowerPath.includes('\\tests\\') ||
      fileName.includes('.test.') || fileName.includes('.spec.') || fileName.startsWith('test_') || fileName.endsWith('_test.go')
    ) {
      score -= 50;
    }

    const auxKeywords = ['build', 'setup', 'config', 'webpack', 'vite', 'rollup', 'gulpfile', 'backup', 'manage.py', 'scripts/', 'tools/', 'docs/', 'example', 'demo', 'migrations/'];
    if (auxKeywords.some(k => lowerPath.includes(k))) {
      score -= 30;
    }

    const coreDirs = ['src/', 'lib/', 'app/', 'core/', 'pkg/', 'internal/'];
    if (coreDirs.some(d => lower_path_contains(lowerPath, d))) {
      score += 20;
    }

    const importantNames = ['main', 'index', 'app', 'server', 'core', 'manager', 'parser', 'api', 'router', 'handler', 'controller', 'service', 'model', 'database'];
    if (importantNames.some(n => fileName.includes(n))) {
      score += 10;
    }

    score -= depth;
    return score;
  };

  function lower_path_contains(path: string, part: string) {
    return path.startsWith(part) || path.includes('/' + part) || path.includes('\\' + part);
  }

  // Filter files
  const filteredFiles = sourceFiles.filter(f => {
    const path = f.path;
    const isHardIgnored = HARD_IGNORE.some(ignore => path.includes(`/${ignore}/`) || path.includes(`\\${ignore}\\`) || path.startsWith(`${ignore}/`) || path.startsWith(`${ignore}\\`));
    const isSecret = SECRET_IGNORE.some(secret => path.endsWith(secret) || path.includes(`/${secret}`) || path.includes(`\\${secret}`));
    return !isHardIgnored && !isSecret;
  });

  const treePaths = filteredFiles.map(f => f.path.replace(selected, '').replace(/^[\\/]/, ''));

  let readme = '';
  const readmeFile = filteredFiles.find(f => f.path.toLowerCase().endsWith('readme.md'));
  if (readmeFile) readme = readmeFile.content;

  let dependencies = '';
  for (const depName of depFiles) {
    const depFile = filteredFiles.find(f => f.path.endsWith(depName));
    if (depFile) {
      dependencies += `\n--- ${depName} ---\n${depFile.content}\n`;
    }
  }

  let filesToFetch = filteredFiles.filter(f => {
    const p = f.path;
    return sourceExtensions.some(ext => p.endsWith(ext)) && !depFiles.some(d => p.endsWith(d)) && !p.toLowerCase().endsWith('readme.md');
  });

  filesToFetch.sort((a, b) => getFileScore(b.path) - getFileScore(a.path));

  const limit = Math.min(Math.max(1, Number(maxFiles) || 5), 200);
  filesToFetch = filesToFetch.slice(0, limit);

  const finalSourceFiles = filesToFetch.map(f => ({
    path: f.path.replace(selected, '').replace(/^[\\/]/, ''),
    content: f.content
  }));

  let finalTreePaths = treePaths;
  let isTruncated = false;
  if (finalTreePaths.length > 1000) {
    finalTreePaths = finalTreePaths.slice(0, 1000);
    isTruncated = true;
  }

  return {
    info: { owner: 'local', repo: repoName, defaultBranch: 'local', description: `Local folder: ${selected}` },
    tree: finalTreePaths,
    readme,
    dependencies,
    sourceFiles: finalSourceFiles,
    isTruncated
  };
}

export async function processLocalFolder(files: FileList, maxFiles: number): Promise<RepoData> {
  // Legacy support for web FileList
  // ... (rest of the original function or just throw error in Tauri mode)
  throw new Error("Standard FileList processing is not supported in Tauri mode. Use selectLocalFolderWithTauri instead.");
}
