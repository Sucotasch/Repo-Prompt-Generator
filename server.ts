import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API route to fetch GitHub data
  app.post("/api/repo", async (req, res) => {
    try {
      const { owner, repo, token, maxFiles = 5 } = req.body;
      
      if (!owner || !repo || typeof owner !== 'string' || typeof repo !== 'string') {
        return res.status(400).json({ error: "Invalid request. Owner and repo are required." });
      }

      const headers: Record<string, string> = {};
      if (token && typeof token === 'string') {
        headers['Authorization'] = `token ${token}`;
      }

      // Strict validation to prevent SSRF and injection
      const nameRegex = /^[a-zA-Z0-9-._]+$/;
      if (!nameRegex.test(owner) || !nameRegex.test(repo)) {
        return res.status(400).json({ error: "Invalid owner or repo format." });
      }

      // Fetch basic info
      const infoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
      if (!infoRes.ok) {
        if (infoRes.status === 403) {
          return res.status(403).json({ error: 'GitHub API rate limit exceeded. Please try again later or provide a GitHub token.' });
        } else if (infoRes.status === 404) {
          return res.status(404).json({ error: 'Repository not found. Please check the URL or provide a token for private repos.' });
        }
        return res.status(infoRes.status).json({ error: `Failed to fetch repository info: ${infoRes.statusText}` });
      }
      
      const infoData = await infoRes.json();
      const defaultBranch = infoData.default_branch;
      const description = infoData.description || 'No description provided.';

      const HARD_IGNORE = ['venv', '.venv', 'node_modules', '.git', '__pycache__', 'dist', 'build'];
      const SECRET_IGNORE = ['.env', '.pem', '.key', '.cert', '.p12', 'secrets.json', 'credentials.json', 'id_rsa'];

      // Fetch tree
      const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`, { headers });
      let treePaths: string[] = [];
      let isTruncated = false;
      
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
          
        if (treePaths.length > 150) {
          treePaths = treePaths.slice(0, 150);
          isTruncated = true;
        }
      }

      // Fetch README
      let readme = '';
      const readmeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, { headers });
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
          const fileRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${file}`, { headers });
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

        // 5. Depth penalty (slight, to prefer shallower files *within* the same score tier)
        score -= depth;

        return score;
      };
      
      // Sort by score descending (highest score first)
      filesToFetch.sort((a, b) => getFileScore(b) - getFileScore(a));
      
      // Limit to requested maxFiles (default 5, max 50)
      const limit = Math.min(Math.max(1, Number(maxFiles) || 5), 50);
      filesToFetch = filesToFetch.slice(0, limit);

      for (const file of filesToFetch) {
        const fileRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${file}`, { headers });
        if (fileRes.ok) {
          const fileData = await fileRes.json();
          try {
            sourceFiles.push({ path: file, content: decodeURIComponent(escape(atob(fileData.content))) });
          } catch (e) {
            sourceFiles.push({ path: file, content: atob(fileData.content) });
          }
        }
      }

      res.json({
        info: { owner, repo, defaultBranch, description },
        tree: treePaths,
        readme,
        dependencies,
        sourceFiles,
        isTruncated
      });
    } catch (error: any) {
      console.error("Error fetching repo data:", error);
      res.status(500).json({ error: error.message || "Internal server error" });
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
    app.use(express.static("dist"));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
