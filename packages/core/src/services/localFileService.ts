import { RepoData } from "./githubService";

export async function processLocalFolder(
  files: FileList,
  maxFiles: number,
): Promise<RepoData> {
  const HARD_IGNORE = [
    "venv",
    ".venv",
    "node_modules",
    ".git",
    "__pycache__",
    "dist",
    "build",
  ];
  const SECRET_IGNORE = [
    ".env",
    ".pem",
    ".key",
    ".cert",
    ".p12",
    "secrets.json",
    "credentials.json",
    "id_rsa",
  ];
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
    const fileName = parts[parts.length - 1];
    const depth = parts.length;

    if (
      lowerPath.includes("/test/") ||
      lowerPath.includes("/tests/") ||
      lowerPath.includes("__tests__") ||
      fileName.includes(".test.") ||
      fileName.includes(".spec.") ||
      fileName.startsWith("test_") ||
      fileName.endsWith("_test.go")
    ) {
      score -= 50;
    }

    const auxKeywords = [
      "build",
      "setup",
      "config",
      "webpack",
      "vite",
      "rollup",
      "gulpfile",
      "backup",
      "manage.py",
      "scripts/",
      "tools/",
      "docs/",
      "example",
      "demo",
      "migrations/",
    ];
    if (auxKeywords.some((k) => lowerPath.includes(k))) {
      score -= 30;
    }

    const coreDirs = ["src/", "lib/", "app/", "core/", "pkg/", "internal/"];
    if (
      coreDirs.some(
        (d) => lowerPath.startsWith(d) || lowerPath.includes("/" + d),
      )
    ) {
      score += 20;
    }

    const importantNames = [
      "main",
      "index",
      "app",
      "server",
      "core",
      "manager",
      "parser",
      "api",
      "router",
      "handler",
      "controller",
      "service",
      "model",
      "database",
    ];
    if (importantNames.some((n) => fileName.includes(n))) {
      score += 10;
    }

    score -= depth;
    return score;
  };

  const fileArray = Array.from(files);

  const filteredFiles = fileArray.filter((f) => {
    const path = f.webkitRelativePath || f.name;
    const isHardIgnored = HARD_IGNORE.some(
      (ignore) => path.includes(`/${ignore}/`) || path.startsWith(`${ignore}/`),
    );
    const isSecret = SECRET_IGNORE.some(
      (secret) => path.endsWith(secret) || path.includes(`/${secret}`),
    );
    return !isHardIgnored && !isSecret;
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

  filesToFetch.sort(
    (a, b) =>
      getFileScore(b.webkitRelativePath || b.name) -
      getFileScore(a.webkitRelativePath || a.name),
  );

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
