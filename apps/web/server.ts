import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const GITHUB_IDENT_REGEX = /^[a-zA-Z0-9-._]+$/;
const HARD_IGNORE_DIRS = new Set([
  "venv",
  ".venv",
  "node_modules",
  ".git",
  "__pycache__",
  "dist",
  "build",
  "target",
]);
const SECRET_EXACT_NAMES = new Set([
  "secrets.json",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
]);
const SECRET_EXTENSIONS = [".pem", ".key", ".cert", ".p12"];

function sanitizeAndEncodeGitHubPath(filePath: string): string | null {
  if (typeof filePath !== "string") return null;
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) {
    return null;
  }
  return segments.map((s) => encodeURIComponent(s)).join("/");
}

function shouldIgnoreRepoPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const segments = lower.split("/").filter(Boolean);
  if (segments.length > 1) {
    for (let i = 0; i < segments.length - 1; i++) {
      if (HARD_IGNORE_DIRS.has(segments[i])) return true;
    }
  }
  const fileName = segments[segments.length - 1] || "";
  if (
    fileName === ".env" ||
    (fileName.startsWith(".env.") &&
      !fileName.endsWith(".example") &&
      !fileName.endsWith(".template") &&
      !fileName.endsWith(".sample"))
  ) {
    return true;
  }
  if (SECRET_EXTENSIONS.some((ext) => fileName.endsWith(ext))) {
    return true;
  }
  return SECRET_EXACT_NAMES.has(fileName);
}

function truncateContent(content: string, maxChars: number, label: string): string {
  if (content.length <= maxChars) return content;
  return content.substring(0, maxChars) + `\n\n... [TRUNCATED: File exceeds ${label} limit. Showing only the top part.]`;
}

function validateProxyBaseUrl(baseUrl: unknown): string | null {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;
  try {
    const parsed = new URL(baseUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return baseUrl.trim().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // Health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // API route to fetch GitHub data
  app.post("/api/repo", async (req, res) => {
    try {
      const { owner, repo, branch, token, maxFiles = 5 } = req.body;

      if (
        !owner ||
        !repo ||
        typeof owner !== "string" ||
        typeof repo !== "string"
      ) {
        return res
          .status(400)
          .json({ error: "Invalid request. Owner and repo are required." });
      }

      if (branch && typeof branch !== "string") {
        return res
          .status(400)
          .json({ error: "Invalid request. Branch must be a string." });
      }

      const headers: Record<string, string> = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "repo-prompt-generator/1.0.0",
      };
      if (token && typeof token === "string") {
        headers["Authorization"] = `token ${token}`;
      }

      // Strict validation to prevent SSRF and injection
      if (!GITHUB_IDENT_REGEX.test(owner) || !GITHUB_IDENT_REGEX.test(repo)) {
        return res.status(400).json({ error: "Invalid owner or repo format." });
      }

      // Fetch basic info
      const infoRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}`,
        { headers, signal: AbortSignal.timeout(15000) },
      );
      if (!infoRes.ok) {
        if (infoRes.status === 403) {
          return res.status(403).json({
            error:
              "GitHub API rate limit exceeded. Please try again later or provide a GitHub token.",
          });
        } else if (infoRes.status === 404) {
          return res.status(404).json({
            error:
              "Repository not found. Please check the URL or provide a token for private repos.",
          });
        }
        return res.status(infoRes.status).json({
          error: `Failed to fetch repository info: ${infoRes.statusText}`,
        });
      }

      const infoData = await infoRes.json();
      const defaultBranch = infoData.default_branch;
      const description = infoData.description || "No description provided.";
      const stargazersCount = infoData.stargazers_count;
      const topics = infoData.topics || [];
      const language = infoData.language;

      const targetBranch = (branch && branch.trim()) || defaultBranch;
      const encodedBranch = encodeURIComponent(targetBranch);

      // Fetch tree
      const treeRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodedBranch}?recursive=1`,
        { headers, signal: AbortSignal.timeout(20000) },
      );
      let treePaths: string[] = [];

      if (treeRes.ok) {
        const treeData = await treeRes.json();
        treePaths = (treeData.tree || [])
          .filter((item: any) => item.type === "blob")
          .map((item: any) => item.path)
          .filter((filePath: string) => !shouldIgnoreRepoPath(filePath));
      } else {
        if (treeRes.status === 404) {
          return res.status(404).json({
            error: `Branch, tag, or commit '${targetBranch}' not found in repository.`,
          });
        }
        return res.status(treeRes.status).json({
          error: `Failed to fetch repository tree: ${treeRes.statusText}`,
        });
      }

      const depFiles = [
        "package.json",
        "requirements.txt",
        "go.mod",
        "Cargo.toml",
        "pom.xml",
        "build.gradle",
      ];

      // Fetch README and dependencies concurrently
      const [readmeResult, depResults] = await Promise.all([
        (async () => {
          try {
            const readmeRes = await fetch(
              `https://api.github.com/repos/${owner}/${repo}/readme?ref=${encodedBranch}`,
              { headers, signal: AbortSignal.timeout(15000) },
            );
            if (readmeRes.ok) {
              const readmeData = await readmeRes.json();
              if (readmeData.content) {
                return Buffer.from(readmeData.content, "base64").toString("utf-8");
              }
            }
          } catch (e) {
            console.warn("Failed to fetch README:", e);
          }
          return "";
        })(),
        Promise.all(
          depFiles
            .filter((file) => treePaths.includes(file))
            .map(async (file) => {
              const encodedFile = sanitizeAndEncodeGitHubPath(file);
              if (!encodedFile) return "";
              try {
                const fileRes = await fetch(
                  `https://api.github.com/repos/${owner}/${repo}/contents/${encodedFile}?ref=${encodedBranch}`,
                  { headers, signal: AbortSignal.timeout(15000) },
                );
                if (fileRes.ok) {
                  const fileData = await fileRes.json();
                  if (fileData.content) {
                    return `\n--- ${file} ---\n${Buffer.from(fileData.content, "base64").toString("utf-8")}\n`;
                  }
                }
              } catch (e) {
                console.warn(`Failed to fetch dep ${file}:`, e);
              }
              return "";
            }),
        ),
      ]);

      const readme = readmeResult;
      const dependencies = depResults.join("");

      // Fetch top source files
      const sourceFiles: { path: string; content: string }[] = [];
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

      let filesToFetch = treePaths
        .filter((p) => sourceExtensions.some((ext) => p.toLowerCase().endsWith(ext)))
        .filter(
          (p) => !depFiles.includes(p) && p.toLowerCase() !== "readme.md",
        );

      // Intelligent scoring system for file selection
      const getFileScore = (filePath: string): number => {
        let score = 0;
        const lowerPath = filePath.toLowerCase();
        const parts = lowerPath.split("/");
        const fileName = parts[parts.length - 1];
        const depth = parts.length;

        // 1. De-prioritize tests
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

        // 2. De-prioritize build/config/auxiliary scripts and docs
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

        // 3. Prioritize core directories
        const coreDirs = ["src/", "lib/", "app/", "core/", "pkg/", "internal/"];
        if (
          coreDirs.some(
            (d) => lowerPath.startsWith(d) || lowerPath.includes(`/${d}`),
          )
        ) {
          score += 20;
        }

        // 4. Prioritize important filenames
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

        // 5. Depth penalty (slight, to prefer shallower files *within* the same score tier)
        score -= depth;

        return score;
      };

      // Sort by score descending (highest score first)
      filesToFetch.sort((a, b) => getFileScore(b) - getFileScore(a));

      // Limit to requested maxFiles (dynamic based on token)
      const absoluteMax = token ? 200 : 10;
      const limit = Math.min(Math.max(1, Number(maxFiles) || 5), absoluteMax);
      filesToFetch = filesToFetch.slice(0, limit);

      const BATCH_SIZE = 10;
      for (let i = 0; i < filesToFetch.length; i += BATCH_SIZE) {
        const batch = filesToFetch.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (file) => {
            const encodedFile = sanitizeAndEncodeGitHubPath(file);
            if (!encodedFile) return null;
            try {
              const fileRes = await fetch(
                `https://api.github.com/repos/${owner}/${repo}/contents/${encodedFile}?ref=${encodedBranch}`,
                { headers, signal: AbortSignal.timeout(15000) },
              );
              if (fileRes.ok) {
                const fileData = await fileRes.json();
                if (fileData.content) {
                  const decoded = Buffer.from(fileData.content, "base64").toString("utf-8");
                  return {
                    path: file,
                    content: truncateContent(decoded, 100000, "100KB"),
                  };
                }
              }
            } catch (e) {
              console.warn(`Failed to fetch file ${file}:`, e);
            }
            return null;
          }),
        );
        for (const item of batchResults) {
          if (item) sourceFiles.push(item);
        }
      }

      // Truncate the tree representation for the LLM context if it's extremely large
      let isTruncated = false;
      if (treePaths.length > 1000) {
        treePaths = treePaths.slice(0, 1000);
        isTruncated = true;
      }

      res.json({
        info: { 
          owner, 
          repo, 
          defaultBranch, 
          branch: targetBranch, 
          description,
          stargazersCount,
          topics,
          language
        },
        tree: treePaths,
        readme,
        dependencies,
        sourceFiles,
        isTruncated,
      });
    } catch (error: any) {
      console.error("Error fetching repo data:", error);
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  });

  // API route to fetch specific files from GitHub
  app.post("/api/repo/files", async (req, res) => {
    try {
      const { owner, repo, branch, token, filePaths } = req.body;

      if (
        !owner ||
        !repo ||
        typeof owner !== "string" ||
        typeof repo !== "string" ||
        !filePaths ||
        !Array.isArray(filePaths)
      ) {
        return res.status(400).json({ error: "Missing required parameters" });
      }

      if (!GITHUB_IDENT_REGEX.test(owner) || !GITHUB_IDENT_REGEX.test(repo)) {
        return res.status(400).json({ error: "Invalid owner or repo format." });
      }

      if (branch && typeof branch !== "string") {
        return res.status(400).json({ error: "Branch must be a string." });
      }

      const headers: Record<string, string> = {
        "User-Agent": "AI-Studio-Applet/1.0",
        "Accept": "application/vnd.github.v3+json",
      };
      if (token && typeof token === "string") {
        headers["Authorization"] = `token ${token}`;
      }

      const encodedBranch = encodeURIComponent(branch || "main");
      const fetchedFiles: { path: string; content: string }[] = [];

      // Limit to 3 files max
      const pathsToFetch = filePaths.slice(0, 3);

      const fileResults = await Promise.all(
        pathsToFetch.map(async (file) => {
          const encodedFile = sanitizeAndEncodeGitHubPath(file);
          if (!encodedFile || shouldIgnoreRepoPath(file)) {
            console.warn(`Blocked invalid or sensitive file path: ${file}`);
            return null;
          }
          try {
            const fileRes = await fetch(
              `https://api.github.com/repos/${owner}/${repo}/contents/${encodedFile}?ref=${encodedBranch}`,
              { headers, signal: AbortSignal.timeout(15000) }
            );
            if (fileRes.ok) {
              const fileData = await fileRes.json();
              if (fileData.content) {
                const decoded = Buffer.from(fileData.content, "base64").toString("utf-8");
                return {
                  path: file,
                  content: truncateContent(decoded, 50000, "50KB"),
                };
              }
            }
          } catch (e) {
            console.warn(`Failed to fetch file ${file}:`, e);
          }
          return null;
        }),
      );

      for (const item of fileResults) {
        if (item) fetchedFiles.push(item);
      }

      res.json({ files: fetchedFiles });
    } catch (error: any) {
      console.error("Error fetching specific files:", error);
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  });

  // Proxy for OpenAI-compatible /models
  app.post("/api/openai-compatible/models", async (req, res) => {
    try {
      const { baseUrl, apiKey } = req.body;
      const cleanBaseUrl = validateProxyBaseUrl(baseUrl);
      if (!cleanBaseUrl) {
        return res
          .status(400)
          .json({ error: "A valid http/https baseUrl is required" });
      }
      const headers: Record<string, string> = {
        "HTTP-Referer": "https://ais-dev.run.app",
        "X-Title": "AI Studio Applet",
        "User-Agent": "AI-Studio-Applet/1.0",
      };
      if (typeof apiKey === "string" && apiKey.trim()) {
        headers["Authorization"] = `Bearer ${apiKey.trim()}`;
      }
      const response = await fetch(`${cleanBaseUrl}/models`, {
        headers,
        signal: AbortSignal.timeout(30000),
      });
      const text = await response.text();
      res
        .status(response.status)
        .type(response.headers.get("content-type") || "application/json")
        .send(text);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Proxy for OpenAI-compatible /chat/completions
  app.post("/api/openai-compatible/chat", async (req, res) => {
    try {
      const { baseUrl, apiKey, payload } = req.body;
      const cleanBaseUrl = validateProxyBaseUrl(baseUrl);
      if (!cleanBaseUrl || !payload) {
        return res
          .status(400)
          .json({ error: "A valid http/https baseUrl and payload are required" });
      }
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "HTTP-Referer": "https://ais-dev.run.app",
        "X-Title": "AI Studio Applet",
        "User-Agent": "AI-Studio-Applet/1.0",
      };
      if (typeof apiKey === "string" && apiKey.trim()) {
        headers["Authorization"] = `Bearer ${apiKey.trim()}`;
      }
      const response = await fetch(`${cleanBaseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120000),
      });
      const text = await response.text();
      res
        .status(response.status)
        .type(response.headers.get("content-type") || "application/json")
        .send(text);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
      root: __dirname,
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
