import { tauriInvoke } from "../utils/tauriAdapter.ts";
import { shouldIgnoreRepoPath, truncateAtLineBoundary } from "../utils/pathFilters.ts";
import type { RepoData } from "./githubService";

export const shouldIgnoreLocalPath = shouldIgnoreRepoPath;

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
const depFileSet = new Set(depFiles.map((d) => d.toLowerCase()));

const sourceExtensions = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".vue",
  ".svelte",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cpp",
  ".c",
  ".h",
  ".cs",
  ".sql",
  ".prisma",
  ".css",
  ".scss",
  ".html",
  ".md",
  ".mdx",
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

function getFileBaseNameLower(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return (idx === -1 ? normalized : normalized.slice(idx + 1)).toLowerCase();
}

function getPathDepth(filePath: string): number {
  return filePath.replace(/\\/g, "/").split("/").filter(Boolean).length;
}

function findShallowestByExactName(files: File[], targetLowerName: string): File | undefined {
  let bestFile: File | undefined = undefined;
  let bestDepth = Infinity;
  for (const f of files) {
    const p = f.webkitRelativePath || f.name;
    if (getFileBaseNameLower(p) === targetLowerName) {
      const depth = getPathDepth(p);
      if (depth < bestDepth) {
        bestDepth = depth;
        bestFile = f;
      }
    }
  }
  return bestFile;
}

export async function processLocalFolder(
  files: FileList,
  maxFiles: number,
): Promise<RepoData> {
  const fileArray = Array.from(files);

  const filteredFiles = fileArray.filter((f) => {
    const path = f.webkitRelativePath || f.name;
    return !shouldIgnoreLocalPath(path);
  });

  const treePaths = filteredFiles.map((f) => f.webkitRelativePath || f.name);

  let readme = "";
  const readmeFile = findShallowestByExactName(filteredFiles, "readme.md");
  if (readmeFile) {
    readme = await readmeFile.text();
  }

  let dependencies = "";
  for (const depName of depFiles) {
    const depFile = findShallowestByExactName(filteredFiles, depName.toLowerCase());
    if (depFile) {
      dependencies += `\n--- ${depName} ---\n${await depFile.text()}\n`;
    }
  }

  let filesToFetch = filteredFiles.filter((f) => {
    const p = f.webkitRelativePath || f.name;
    const lowerP = p.toLowerCase();
    const baseLower = getFileBaseNameLower(p);
    return (
      sourceExtensions.some((ext) => lowerP.endsWith(ext)) &&
      !depFileSet.has(baseLower) &&
      baseLower !== "readme.md"
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
    filesToFetch.map(async (f) => {
      const rawNormalized = (await f.text()).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const totalLines = rawNormalized.split("\n").length;
      const cut = truncateAtLineBoundary(rawNormalized, 100000);
      let content = cut.text;
      const truncated = cut.truncated;
      const endLine = content.split("\n").length;
      if (truncated) {
        content += `\n\n... [TRUNCATED: File exceeds 100KB limit. Showing lines 1-${endLine} of ${totalLines}.]`;
      }
      return {
        path: f.webkitRelativePath || f.name,
        content,
        startLine: 1,
        endLine,
        totalLines,
        truncated,
      };
    }),
  );

  const totalTreeFiles = treePaths.length;
  let finalTreePaths = treePaths;
  let isTruncated = false;
  if (finalTreePaths.length > 1000) {
    finalTreePaths = finalTreePaths.slice(0, 1000);
    isTruncated = true;
  }

  const repoName =
    fileArray.length > 0
      ? fileArray[0].webkitRelativePath?.split(/[/\\]/)[0] || "local-folder"
      : "local-folder";

  return {
    info: {
      owner: "local",
      repo: repoName,
      defaultBranch: "local",
      branch: "local",
      description: "Local folder upload",
      fetchedAt: new Date().toISOString(),
    },
    tree: finalTreePaths,
    totalTreeFiles,
    readme,
    dependencies,
    sourceFiles: finalSourceFiles,
    isTruncated,
  };
}

export async function processNativeLocalFolder(
  folderPath: string,
  maxFiles: number,
): Promise<RepoData> {
  const limit = Math.min(Math.max(1, Number(maxFiles) || 5), 200);
  const data = await tauriInvoke<RepoData>("scan_local_repository", {
    path: folderPath,
    max_files: limit,
  });
  return {
    ...data,
    localRootPath: folderPath,
  };
}
