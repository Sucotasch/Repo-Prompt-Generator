import express from "express";
import { createServer as createViteServer } from "vite";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API route to fetch GitHub data
  app.post("/api/repo", async (req, res) => {
    try {
      const { url } = req.body;
      
      let urlObj;
      try {
        urlObj = new URL(url);
      } catch (e) {
        return res.status(400).json({ error: 'Invalid URL format. Please provide a full URL like https://github.com/owner/repo' });
      }
      
      if (!urlObj.hostname.includes('github.com')) {
        return res.status(400).json({ error: 'Please provide a valid GitHub repository URL.' });
      }

      const parts = urlObj.pathname.split('/').filter(Boolean);
      if (parts.length < 2) {
        return res.status(400).json({ error: 'URL must include repository owner and name.' });
      }

      const owner = parts[0];
      const repo = parts[1].replace(/\.git$/, '');

      // Fetch basic info
      const infoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
      if (!infoRes.ok) {
        if (infoRes.status === 403) {
          return res.status(403).json({ error: 'GitHub API rate limit exceeded. Please try again later.' });
        } else if (infoRes.status === 404) {
          return res.status(404).json({ error: 'Repository not found. Please check the URL.' });
        }
        return res.status(infoRes.status).json({ error: `Failed to fetch repository info: ${infoRes.statusText}` });
      }
      
      const infoData = await infoRes.json();
      const defaultBranch = infoData.default_branch;
      const description = infoData.description || 'No description provided.';

      const HARD_IGNORE = ['venv', '.venv', 'node_modules', '.git', '__pycache__', 'dist', 'build'];

      // Fetch tree
      const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`);
      let treePaths: string[] = [];
      if (treeRes.ok) {
        const treeData = await treeRes.json();
        treePaths = treeData.tree
          .filter((item: any) => item.type === 'blob')
          .map((item: any) => item.path)
          .filter((path: string) => !HARD_IGNORE.some(ignore => path.includes(`/${ignore}/`) || path.startsWith(`${ignore}/`)));
      }

      // Fetch README
      let readme = '';
      const readmeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme`);
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
          const fileRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${file}`);
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
      const filesToFetch = treePaths
        .filter(p => sourceExtensions.some(ext => p.endsWith(ext)))
        .filter(p => !depFiles.includes(p) && p.toLowerCase() !== 'readme.md')
        .slice(0, 5); // Limit to 5 files to avoid GitHub API rate limits

      for (const file of filesToFetch) {
        const fileRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${file}`);
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
        sourceFiles
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
