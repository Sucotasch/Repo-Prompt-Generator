export const FOLDER_ZONE_MAP: Record<string, string> = {
  "frontend": "Frontend",
  "front-end": "Frontend",
  "client": "Frontend",
  "ui": "Frontend",
  "components": "Frontend",
  "views": "Frontend",
  "pages": "Frontend",
  "backend": "Backend",
  "server": "Backend",
  "api": "Backend",
  "routes": "Backend",
  "services": "Backend",
  "controllers": "Backend",
  "models": "Backend",
  "db": "Database",
  "database": "Database",
  "prisma": "Database",
  "docs": "Documentation",
  "documentation": "Documentation",
  "tests": "Testing",
  "test": "Testing",
  "spec": "Testing",
  "__tests__": "Testing",
  "scripts": "Scripts",
  "tools": "Scripts"
};

export const EXTENSION_ZONE_MAP: Record<string, string> = {
  ".tsx": "Frontend",
  ".jsx": "Frontend",
  ".css": "Frontend",
  ".scss": "Frontend",
  ".html": "Frontend",
  ".vue": "Frontend",
  ".svelte": "Frontend",
  ".sql": "Database",
  ".prisma": "Database",
  ".md": "Documentation",
  ".mdx": "Documentation",
  ".sh": "Scripts",
  ".bat": "Scripts"
};

export function detectZoneFromPath(filePath: string): string {
  const lowerPath = filePath.toLowerCase();
  
  // 1. Check extension first (strongest signal)
  for (const [ext, zone] of Object.entries(EXTENSION_ZONE_MAP)) {
    if (lowerPath.endsWith(ext)) {
      // Exception: if it's a test file, it's Testing regardless of extension
      if (lowerPath.includes(".test.") || lowerPath.includes(".spec.")) {
        return "Testing";
      }
      return zone;
    }
  }

  // 2. Check path segments (reverse order to prioritize deeper folders)
  const parts = lowerPath.split(/[/\\]/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (FOLDER_ZONE_MAP[part]) {
      return FOLDER_ZONE_MAP[part];
    }
  }

  // 3. Check for test files specifically
  if (lowerPath.includes(".test.") || lowerPath.includes(".spec.") || lowerPath.includes("test_")) {
    return "Testing";
  }

  return "General";
}
