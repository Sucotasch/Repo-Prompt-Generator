#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const DESKTOP_DIR = path.join(REPO_ROOT, "apps", "desktop");
const TAURI_DIR = path.join(DESKTOP_DIR, "src-tauri");
const ICONS_DIR = path.join(TAURI_DIR, "icons");
const SOURCE_SVG = path.join(TAURI_DIR, "app-icon.svg");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICNS_MAGIC = Buffer.from([0x69, 0x63, 0x6e, 0x73]); // "icns"
const UTF8_REPLACEMENT = Buffer.from([0xef, 0xbf, 0xbd]);

const REQUIRED_ICONS = [
  { file: "32x32.png", type: "png", width: 32, height: 32 },
  { file: "64x64.png", type: "png", width: 64, height: 64 },
  { file: "128x128.png", type: "png", width: 128, height: 128 },
  { file: "128x128@2x.png", type: "png", width: 256, height: 256 },
  { file: "icon.png", type: "png" },
  { file: "icon.ico", type: "ico" },
  { file: "icon.icns", type: "icns" },
];

function validatePng(buf, expectedWidth, expectedHeight) {
  if (buf.length < 24) return "file too small";
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) {
    if (buf.subarray(0, 3).equals(UTF8_REPLACEMENT)) {
      return "corrupted by UTF-8 replacement bytes (EF BF BD)";
    }
    return "invalid PNG magic header";
  }
  const chunkType = buf.subarray(12, 16).toString("ascii");
  if (chunkType !== "IHDR") return `unexpected first chunk '${chunkType}'`;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (expectedWidth && width !== expectedWidth) {
    return `width mismatch (expected ${expectedWidth}, got ${width})`;
  }
  if (expectedHeight && height !== expectedHeight) {
    return `height mismatch (expected ${expectedHeight}, got ${height})`;
  }
  return null;
}

function validateIco(buf) {
  if (buf.length < 22) return "file too small";
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  if (reserved !== 0 || type !== 1 || count === 0) {
    return "invalid ICO header";
  }
  if (buf.length < 6 + count * 16) return "truncated ICO directory";
  for (let i = 0; i < count; i++) {
    const entryOffset = 6 + i * 16;
    const bytesInRes = buf.readUInt32LE(entryOffset + 8);
    const imageOffset = buf.readUInt32LE(entryOffset + 12);
    if (bytesInRes === 0 || imageOffset + bytesInRes > buf.length) {
      return `ICO entry #${i} out of bounds (likely binary corruption)`;
    }
    const entryData = buf.subarray(imageOffset, imageOffset + Math.min(bytesInRes, 8));
    if (entryData.subarray(0, 3).equals(UTF8_REPLACEMENT)) {
      return `ICO entry #${i} corrupted by UTF-8 replacement bytes`;
    }
  }
  return null;
}

function validateIcns(buf) {
  if (buf.length < 16) return "file too small";
  if (!buf.subarray(0, 4).equals(ICNS_MAGIC)) return "invalid ICNS magic header";
  const declaredLen = buf.readUInt32BE(4);
  if (declaredLen !== buf.length) {
    return `ICNS length mismatch (header=${declaredLen}, actual=${buf.length})`;
  }
  return null;
}

export function auditDesktopIcons() {
  const issues = [];
  for (const spec of REQUIRED_ICONS) {
    const fullPath = path.join(ICONS_DIR, spec.file);
    if (!fs.existsSync(fullPath)) {
      issues.push(`${spec.file}: missing`);
      continue;
    }
    const buf = fs.readFileSync(fullPath);
    let err = null;
    if (spec.type === "png") {
      err = validatePng(buf, spec.width, spec.height);
    } else if (spec.type === "ico") {
      err = validateIco(buf);
    } else if (spec.type === "icns") {
      err = validateIcns(buf);
    }
    if (err) {
      issues.push(`${spec.file}: ${err}`);
    }
  }
  return issues;
}

function resolveTauriCliCommand() {
  const binName = process.platform === "win32" ? "tauri.cmd" : "tauri";
  const candidates = [
    path.join(REPO_ROOT, "node_modules", ".bin", binName),
    path.join(DESKTOP_DIR, "node_modules", ".bin", binName),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { cmd: candidate, prefixArgs: [] };
    }
  }
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  return { cmd: npxCmd, prefixArgs: ["--no-install", "tauri"] };
}

export function prepareDesktopIcons({ force = false, quiet = false } = {}) {
  if (!fs.existsSync(SOURCE_SVG)) {
    throw new Error(`Source SVG icon not found at: ${SOURCE_SVG}`);
  }

  const issues = force ? ["forced regeneration"] : auditDesktopIcons();
  if (issues.length === 0) {
    if (!quiet) {
      console.log("[desktop-icons] All Tauri icons passed binary validation.");
    }
    return { regenerated: false };
  }

  if (!quiet) {
    console.log(
      `[desktop-icons] Regenerating icons from app-icon.svg (${issues.length} issue(s): ${issues.slice(0, 3).join("; ")}${issues.length > 3 ? ", ..." : ""})`,
    );
  }

  fs.mkdirSync(ICONS_DIR, { recursive: true });

  const { cmd, prefixArgs } = resolveTauriCliCommand();
  const args = [...prefixArgs, "icon", SOURCE_SVG, "-o", ICONS_DIR];
  const result = spawnSync(cmd, args, {
    cwd: DESKTOP_DIR,
    stdio: quiet ? "pipe" : "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw new Error(`Failed to execute Tauri icon generator (${cmd}): ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString("utf-8").trim() : "";
    throw new Error(
      `Tauri icon generation exited with code ${result.status}.${stderr ? `\n${stderr}` : ""}`,
    );
  }

  const remainingIssues = auditDesktopIcons();
  if (remainingIssues.length > 0) {
    throw new Error(
      `Icons failed binary validation after regeneration:\n  - ${remainingIssues.join("\n  - ")}`,
    );
  }

  if (!quiet) {
    console.log("[desktop-icons] Icons regenerated and verified successfully.");
  }
  return { regenerated: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const args = new Set(process.argv.slice(2));
  const force = args.has("--force") || args.has("-f");
  const checkOnly = args.has("--check");

  try {
    if (checkOnly) {
      const issues = auditDesktopIcons();
      if (issues.length > 0) {
        console.error("[desktop-icons] Invalid or missing icons detected:");
        for (const issue of issues) {
          console.error(`  - ${issue}`);
        }
        process.exit(1);
      }
      console.log("[desktop-icons] All desktop icons are valid.");
      process.exit(0);
    }
    prepareDesktopIcons({ force });
  } catch (err) {
    console.error(`[desktop-icons] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
