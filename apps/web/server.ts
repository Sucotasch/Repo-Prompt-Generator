import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import path from "path";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

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

      const headers: Record<string, string> = {};
      if (token && typeof token === "string") {
        headers["Authorization"] = `token ${token}`;
      }

      // Strict validation to prevent SSRF and injection
      const nameRegex = /^[a-zA-Z0-9-._]+$/;
      if (!nameRegex.test(owner) || !nameRegex.test(repo)) {
        return res.status(400).json({ error: "Invalid owner or repo format." });
      }

      // Fetch basic info
      const infoRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}`,
        { headers },
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

      const targetBranch = branch || defaultBranch;
      const encodedBranch = encodeURIComponent(targetBranch);

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

      // Fetch tree
      const treeRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodedBranch}?recursive=1`,
        { headers },
      );
      let treePaths: string[] = [];

      if (treeRes.ok) {
        const treeData = await treeRes.json();
        treePaths = treeData.tree
          .filter((item: any) => item.type === "blob")
          .map((item: any) => item.path)
          .filter((path: string) => {
            const isHardIgnored = HARD_IGNORE.some(
              (ignore) =>
                path.includes(`/${ignore}/`) || path.startsWith(`${ignore}/`),
            );
            const isSecret = SECRET_IGNORE.some(
              (secret) => path.endsWith(secret) || path.includes(`/${secret}`),
            );
            return !isHardIgnored && !isSecret;
          });
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

      // Fetch README
      let readme = "";
      const readmeRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/readme?ref=${encodedBranch}`,
        { headers },
      );
      if (readmeRes.ok) {
        const readmeData = await readmeRes.json();
        if (readmeData.content) {
          readme = Buffer.from(readmeData.content, "base64").toString("utf-8");
        }
      }

      // Fetch dependencies
      let dependencies = "";
      const depFiles = [
        "package.json",
        "requirements.txt",
        "go.mod",
        "Cargo.toml",
        "pom.xml",
        "build.gradle",
      ];

      for (const file of depFiles) {
        if (treePaths.includes(file)) {
          const fileRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${file}?ref=${encodedBranch}`,
            { headers },
          );
          if (fileRes.ok) {
            const fileData = await fileRes.json();
            if (fileData.content) {
              dependencies += `\n--- ${file} ---\n${Buffer.from(fileData.content, "base64").toString("utf-8")}\n`;
            }
          }
        }
      }

      // Fetch top source files
      const sourceFiles: { path: string; content: string }[] = [];
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

      let filesToFetch = treePaths
        .filter((p) => sourceExtensions.some((ext) => p.endsWith(ext)))
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

      for (const file of filesToFetch) {
        const fileRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${file}?ref=${encodedBranch}`,
          { headers },
        );
        if (fileRes.ok) {
          const fileData = await fileRes.json();
          if (fileData.content) {
            sourceFiles.push({
              path: file,
              content: Buffer.from(fileData.content, "base64").toString("utf-8"),
            });
          }
        }
      }

      // Truncate the tree representation for the LLM context if it's extremely large
      let isTruncated = false;
      if (treePaths.length > 1000) {
        treePaths = treePaths.slice(0, 1000);
        isTruncated = true;
      }

      res.json({
        info: { owner, repo, defaultBranch, branch: targetBranch, description },
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

      if (!owner || !repo || !filePaths || !Array.isArray(filePaths)) {
        return res.status(400).json({ error: "Missing required parameters" });
      }

      const headers: Record<string, string> = {
        "User-Agent": "AI-Studio-Applet/1.0",
        "Accept": "application/vnd.github.v3+json",
      };
      if (token) {
        headers["Authorization"] = `token ${token}`;
      }

      const encodedBranch = encodeURIComponent(branch || "main");
      const fetchedFiles: { path: string; content: string }[] = [];

      // Limit to 3 files max
      const pathsToFetch = filePaths.slice(0, 3);

      for (const file of pathsToFetch) {
        try {
          const fileRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${file}?ref=${encodedBranch}`,
            { headers }
          );
          if (fileRes.ok) {
            const fileData = await fileRes.json();
            if (fileData.content) {
              let content = Buffer.from(fileData.content, "base64").toString("utf-8");
              if (content.length > 50000) {
                content = content.substring(0, 50000) + "\n\n... [TRUNCATED: Файл превышает лимит в 50KB. Показана только верхняя часть.]";
              }
              fetchedFiles.push({ path: file, content });
            }
          }
        } catch (e) {
          console.warn(`Failed to fetch file ${file}:`, e);
        }
      }

      res.json({ files: fetchedFiles });
    } catch (error: any) {
      console.error("Error fetching specific files:", error);
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  });

  // API route to proxy Qwen requests
  app.post("/api/qwen", async (req, res) => {
    try {
      const {
        token,
        resourceUrl,
        prompt,
        messages,
        tools,
        model = "coder-model",
        isJson = false,
      } = req.body;

      if (!token) {
        return res.status(401).json({ error: "Qwen OAuth token is required." });
      }

      const payload: any = {
        model,
        messages: messages || [
          {
            role: "system",
            content:
              "You are an expert software architect. Output clean markdown.",
          },
          { role: "user", content: prompt },
        ],
        temperature: isJson ? 0.1 : 0.3,
      };

      if (tools) {
        payload.tools = tools;
      }

      if (isJson) {
        payload.response_format = { type: "json_object" };
      }

      let endpoint =
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
      if (resourceUrl) {
        let baseUrl = resourceUrl;
        if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
          baseUrl = "https://" + baseUrl;
        }
        try {
          const urlObj = new URL(baseUrl);
          if (urlObj.pathname === "/" || urlObj.pathname === "") {
            endpoint = new URL("/v1/chat/completions", baseUrl).toString();
          } else {
            endpoint = baseUrl;
          }
        } catch (e) {
          endpoint = baseUrl;
        }
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.error("Qwen API returned non-JSON:", text);
        return res.status(response.status).json({
          error: `Qwen API returned non-JSON: ${text.substring(0, 100)}`,
        });
      }

      console.log(
        "Qwen API Headers:",
        Object.fromEntries(response.headers.entries()),
      );

      const rateLimitRemainingRequests =
        response.headers.get("X-RateLimit-Remaining-Requests") ||
        response.headers.get("x-ratelimit-remaining-requests");
      const rateLimitResetRequests =
        response.headers.get("X-RateLimit-Reset-Requests") ||
        response.headers.get("x-ratelimit-reset-requests");
      const rateLimitRemainingTokens =
        response.headers.get("X-RateLimit-Remaining-Tokens") ||
        response.headers.get("x-ratelimit-remaining-tokens");
      const rateLimitResetTokens =
        response.headers.get("X-RateLimit-Reset-Tokens") ||
        response.headers.get("x-ratelimit-reset-tokens");

      const rateLimit = {
        remainingRequests: rateLimitRemainingRequests,
        resetRequests: rateLimitResetRequests,
        remainingTokens: rateLimitRemainingTokens,
        resetTokens: rateLimitResetTokens,
      };

      if (!response.ok) {
        console.error("Qwen API error:", data);
        return res.status(response.status).json({
          error:
            data.error?.message ||
            data.message ||
            `Qwen API Error: ${JSON.stringify(data)}`,
          code: data.code || data.error?.code,
          rateLimit,
        });
      }

      // Map OpenAI format back to the format expected by the frontend
      res.json({
        output: {
          text: data.choices?.[0]?.message?.content || "",
          message: data.choices?.[0]?.message,
        },
        model: data.model,
        rateLimit,
      });
    } catch (error: any) {
      console.error("Error proxying Qwen request:", error);
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  });

  // Proxy for Qwen OAuth Device Code
  app.post("/api/qwen/device/code", async (req, res) => {
    try {
      const response = await fetch(
        "https://chat.qwen.ai/api/v1/oauth2/device/code",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: new URLSearchParams(req.body).toString(),
        },
      );
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Proxy for Qwen OAuth Token Polling
  app.post("/api/qwen/device/token", async (req, res) => {
    try {
      const response = await fetch("https://chat.qwen.ai/api/v1/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams(req.body).toString(),
      });

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
        console.log("Qwen Token Response:", {
          ...data,
          access_token: data.access_token ? "***" : undefined,
          refresh_token: data.refresh_token ? "***" : undefined,
          id_token: data.id_token ? "***" : undefined,
        });
      } catch (e) {
        return res.status(response.status).send(text);
      }

      res.status(response.status).json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Proxy for OpenAI-compatible /models
  app.post("/api/openai-compatible/models", async (req, res) => {
    try {
      const { baseUrl, apiKey } = req.body;
      if (!baseUrl || !apiKey) {
        return res
          .status(400)
          .json({ error: "baseUrl and apiKey are required" });
      }
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://ais-dev.run.app",
          "X-Title": "AI Studio Applet",
          "User-Agent": "AI-Studio-Applet/1.0",
        },
      });
      const text = await response.text();
      res.status(response.status).send(text);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Proxy for OpenAI-compatible /chat/completions
  app.post("/api/openai-compatible/chat", async (req, res) => {
    try {
      const { baseUrl, apiKey, payload } = req.body;
      if (!baseUrl || !apiKey || !payload) {
        return res
          .status(400)
          .json({ error: "baseUrl, apiKey, and payload are required" });
      }
      const response = await fetch(
        `${baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://ais-dev.run.app",
            "X-Title": "AI Studio Applet",
            "User-Agent": "AI-Studio-Applet/1.0",
          },
          body: JSON.stringify(payload),
        },
      );
      const text = await response.text();
      res.status(response.status).send(text);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
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
