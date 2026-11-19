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

export function shouldIgnoreRepoPath(filePath: string): boolean {
  const lower = filePath.replace(/\\/g, "/").toLowerCase();
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

export function stripTrailingTruncationNotice(text: string): {
  cleanText: string;
  hadNotice: boolean;
} {
  const match = text.match(/\n\n\.\.\.\s*\[TRUNCATED:[^\]]*\]\s*$/i);
  if (!match || match.index === undefined) {
    return { cleanText: text, hadNotice: false };
  }
  return { cleanText: text.slice(0, match.index), hadNotice: true };
}

/**
 * Truncates text to at most `maxChars`, snapping back to the last newline boundary
 * when possible so the final visible line is never split mid-line.
 */
export function truncateAtLineBoundary(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (maxChars <= 0 || text.length <= maxChars) {
    return { text, truncated: false };
  }
  const sliced = text.slice(0, maxChars);
  const lastNewline = sliced.lastIndexOf("\n");
  if (lastNewline > 0) {
    return { text: sliced.slice(0, lastNewline), truncated: true };
  }
  return { text: `${sliced} ... [LINE TRUNCATED]`, truncated: true };
}
