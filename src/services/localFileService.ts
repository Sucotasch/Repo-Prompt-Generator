import { RepoData } from './githubService';

export async function processLocalFolder(files: FileList, maxFiles: number): Promise<RepoData> {
  const HARD_IGNORE = ['venv', '.venv', 'node_modules', '.git', '__pycache__', 'dist', 'build'];
  const SECRET_IGNORE = ['.env', '.pem', '.key', '.cert', '.p12', 'secrets.json', 'credentials.json', 'id_rsa'];
  const depFiles = ['package.json', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle'];
  const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cpp', '.c', '.h', '.cs', '.md'];

  let repoName = 'local-project';
  if (files.length > 0 && files[0].webkitRelativePath) {
    repoName = files[0].webkitRelativePath.split('/')[0];
  }

  const validFiles: File[] = [];
  const treePaths: string[] = [];

  // 1. Filter files
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const path = file.webkitRelativePath || file.name;
    // Strip the root folder name for cleaner paths if webkitRelativePath is present
    const cleanPath = path.includes('/') ? path.substring(path.indexOf('/') + 1) : path;

    const isHardIgnored = HARD_IGNORE.some(ignore => cleanPath.includes(`/${ignore}/`) || cleanPath.startsWith(`${ignore}/`) || cleanPath === ignore);
    const isSecret = SECRET_IGNORE.some(secret => cleanPath.endsWith(secret) || cleanPath.includes(`/${secret}`));

    if (!isHardIgnored && !isSecret) {
      validFiles.push(file);
      treePaths.push(cleanPath);
    }
  }

  // 2. Find README
  let readme = '';
  const readmeFile = validFiles.find(f => {
    const p = f.webkitRelativePath.includes('/') ? f.webkitRelativePath.substring(f.webkitRelativePath.indexOf('/') + 1) : f.name;
    return p.toLowerCase() === 'readme.md';
  });
  if (readmeFile) {
    readme = await readmeFile.text();
  }

  // 3. Find Dependencies
  let dependencies = '';
  for (const depName of depFiles) {
    const depFile = validFiles.find(f => {
      const p = f.webkitRelativePath.includes('/') ? f.webkitRelativePath.substring(f.webkitRelativePath.indexOf('/') + 1) : f.name;
      return p === depName;
    });
    if (depFile) {
      const content = await depFile.text();
      dependencies += `\n--- ${depName} ---\n${content}\n`;
    }
  }

  // 4. Score and select source files
  const getFileScore = (filePath: string): number => {
    let score = 0;
    const lowerPath = filePath.toLowerCase();
    const parts = lowerPath.split('/');
    const fileName = parts[parts.length - 1];
    const depth = parts.length;

    if (
      lowerPath.includes('/test/') || lowerPath.includes('/tests/') || lowerPath.includes('__tests__') ||
      fileName.includes('.test.') || fileName.includes('.spec.') || fileName.startsWith('test_') || fileName.endsWith('_test.go')
    ) {
      score -= 50;
    }

    const auxKeywords = ['build', 'setup', 'config', 'webpack', 'vite', 'rollup', 'gulpfile', 'backup', 'manage.py', 'scripts/', 'tools/', 'docs/', 'example', 'demo', 'migrations/'];
    if (auxKeywords.some(k => lowerPath.includes(k))) {
      score -= 30;
    }

    const coreDirs = ['src/', 'lib/', 'app/', 'core/', 'pkg/', 'internal/'];
    if (coreDirs.some(d => lowerPath.startsWith(d) || lowerPath.includes(`/${d}`))) {
      score += 20;
    }

    const importantNames = ['main', 'index', 'app', 'server', 'core', 'manager', 'parser', 'api', 'router', 'handler', 'controller', 'service', 'model', 'database'];
    if (importantNames.some(n => fileName.includes(n))) {
      score += 10;
    }

    score -= depth;
    return score;
  };

  let filesToFetch = validFiles.filter(f => {
    const p = f.webkitRelativePath.includes('/') ? f.webkitRelativePath.substring(f.webkitRelativePath.indexOf('/') + 1) : f.name;
    return sourceExtensions.some(ext => p.endsWith(ext)) && !depFiles.includes(p) && p.toLowerCase() !== 'readme.md';
  });

  filesToFetch.sort((a, b) => {
    const pathA = a.webkitRelativePath.includes('/') ? a.webkitRelativePath.substring(a.webkitRelativePath.indexOf('/') + 1) : a.name;
    const pathB = b.webkitRelativePath.includes('/') ? b.webkitRelativePath.substring(b.webkitRelativePath.indexOf('/') + 1) : b.name;
    return getFileScore(pathB) - getFileScore(pathA);
  });

  const limit = Math.min(Math.max(1, Number(maxFiles) || 5), 200); // Allow up to 200 for local
  filesToFetch = filesToFetch.slice(0, limit);

  const sourceFiles: {path: string, content: string}[] = [];
  for (const file of filesToFetch) {
    const p = file.webkitRelativePath.includes('/') ? file.webkitRelativePath.substring(file.webkitRelativePath.indexOf('/') + 1) : file.name;
    const content = await file.text();
    sourceFiles.push({ path: p, content });
  }

  let finalTreePaths = treePaths;
  let isTruncated = false;
  if (finalTreePaths.length > 1000) {
    finalTreePaths = finalTreePaths.slice(0, 1000);
    isTruncated = true;
  }

  return {
    info: { owner: 'local', repo: repoName, defaultBranch: 'local', description: 'Local folder analysis' },
    tree: finalTreePaths,
    readme,
    dependencies,
    sourceFiles,
    isTruncated
  };
}
