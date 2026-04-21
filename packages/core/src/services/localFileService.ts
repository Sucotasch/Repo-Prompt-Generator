import { RepoData } from "./githubService";

const HARD_IGNORE_REGEX = /(^|\/)(venv|\.venv|node_modules|\.git|__pycache__|dist|build)(\/|$)/i;
const SECRET_IGNORE_REGEX = /(\.env|\.pem|\.key|\.cert|\.p12|secrets\.json|credentials\.json|id_rsa)$|\/(\.env|\.pem|\.key|\.cert|\.p12|secrets\.json|credentials\.json|id_rsa)/i;

const TEST_REGEX = /(\/tests?\/|__tests__|.*\.(test|spec)\.|^test_|.*_test\.go)/i;
const AUX_REGEX = /(build|setup|config|webpack|vite|rollup|gulpfile|backup|manage\.py|scripts\/|tools\/|docs\/|example|demo|migrations\/)/i;
const CORE_DIRS_REGEX = /(^|\/)(src|lib|app|core|pkg|internal)\//i;
const IMPORTANT_NAMES_REGEX = /(main|index|app|server|core|manager|parser|api|router|handler|controller|service|model|database)/i;

const depFiles = [
  "package.json",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
];

const sourceExtensions = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cpp",
  ".c",
  ".h",
  ".cs",
  ".md",
];

const getFileScore = (filePath: string): number => {
  let score = 0;
  const lowerPath = filePath.toLowerCase();
  const parts = lowerPath.split(/[\\/]/);
  const fileName = parts[parts.length - 1] || "";
  const depth = parts.length;

  if (TEST_REGEX.test(lowerPath)) score -= 50;
  if (AUX_REGEX.test(lowerPath)) score -= 30;
  if (CORE_DIRS_REGEX.test(lowerPath)) score += 20;
  if (IMPORTANT_NAMES_REGEX.test(fileName)) score += 10;

  score -= depth;
  return score;
};

export async function processLocalFolder(
  files: FileList,
  maxFiles: number,
): Promise<RepoData> {
  const fileArray = Array.from(files);

  const filteredFiles = fileArray.filter((f) => {
    const path = f.webkitRelativePath || f.name;
    return !HARD_IGNORE_REGEX.test(path) && !SECRET_IGNORE_REGEX.test(path);
  });

  const treePaths = filteredFiles.map((f) => f.webkitRelativePath || f.name);

  let readme = "";
  const readmeFile = filteredFiles.find((f) =>
    (f.webkitRelativePath || f.name).toLowerCase().endsWith("readme.md"),
  );
  if (readmeFile) {
    readme = await readmeFile.text();
  }

  let dependencies = "";
  for (const depName of depFiles) {
    const depFile = filteredFiles.find((f) =>
      (f.webkitRelativePath || f.name).endsWith(depName),
    );
    if (depFile) {
      dependencies += `\n--- ${depName} ---\n${await depFile.text()}\n`;
    }
  }

  let filesToFetch = filteredFiles.filter((f) => {
    const p = f.webkitRelativePath || f.name;
    return (
      sourceExtensions.some((ext) => p.endsWith(ext)) &&
      !depFiles.some((d) => p.endsWith(d)) &&
      !p.toLowerCase().endsWith("readme.md")
    );
  });

  const scoredFiles = filesToFetch.map((f) => ({
    file: f,
    score: getFileScore(f.webkitRelativePath || f.name),
  }));

  scoredFiles.sort((a, b) => b.score - a.score);

  filesToFetch = scoredFiles.map((item) => item.file);

  const limit = Math.min(Math.max(1, Number(maxFiles) || 5), 200);
  filesToFetch = filesToFetch.slice(0, limit);

  const finalSourceFiles = await Promise.all(
    filesToFetch.map(async (f) => ({
      path: f.webkitRelativePath || f.name,
      content: await f.text(),
    })),
  );

  let finalTreePaths = treePaths;
  let isTruncated = false;
  if (finalTreePaths.length > 1000) {
    finalTreePaths = finalTreePaths.slice(0, 1000);
    isTruncated = true;
  }

  const repoName =
    fileArray.length > 0
      ? fileArray[0].webkitRelativePath.split("/")[0] || "local-folder"
      : "local-folder";

  return {
    info: {
      owner: "local",
      repo: repoName,
      defaultBranch: "local",
      branch: "local",
      description: "Local folder upload",
    },
    tree: finalTreePaths,
    readme,
    dependencies,
    sourceFiles: finalSourceFiles,
    isTruncated,
  };
}
