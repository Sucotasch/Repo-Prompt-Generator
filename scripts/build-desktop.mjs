#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareDesktopIcons } from "./prepare-desktop-icons.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const DESKTOP_DIR = path.join(REPO_ROOT, "apps", "desktop");
const BUNDLE_DIR = path.join(DESKTOP_DIR, "src-tauri", "target", "release", "bundle");

function parseArgs(argv) {
  const opts = {
    mode: "build", // "build" | "dev" | "icons-only"
    forceIcons: false,
    skipInstall: false,
    extraTauriArgs: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dev") {
      opts.mode = "dev";
    } else if (arg === "--icons-only") {
      opts.mode = "icons-only";
    } else if (arg === "--force-icons") {
      opts.forceIcons = true;
    } else if (arg === "--skip-install") {
      opts.skipInstall = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg === "--") {
      opts.extraTauriArgs.push(...argv.slice(i + 1));
      break;
    } else {
      opts.extraTauriArgs.push(arg);
    }
  }
  return opts;
}

function printUsage() {
  console.log(`Repo Prompt Generator — Turnkey Desktop Build Script

Usage:
  node scripts/build-desktop.mjs [options] [-- <extra tauri args>]
  npm run build:desktop

Options:
  --dev           Run Tauri desktop app in development mode (tauri dev)
  --icons-only    Only validate/regenerate Tauri binary icons and exit
  --force-icons   Force icon regeneration from app-icon.svg
  --skip-install  Skip automatic npm install check
  -h, --help      Show this help message
`);
}

function runCommand(cmd, args, cwd, label) {
  console.log(`\n[desktop-build] ${label}`);
  console.log(`  $ ${cmd} ${args.join(" ")}  (cwd: ${path.relative(REPO_ROOT, cwd) || "."})`);
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.error) {
    throw new Error(`Command '${cmd}' failed to start: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`Step "${label}" exited with status ${res.status}.`);
  }
}

function checkCommandVersion(cmd, args = ["--version"]) {
  const res = spawnSync(cmd, args, {
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  if (res.error || res.status !== 0) return null;
  return (res.stdout?.toString("utf-8") || res.stderr?.toString("utf-8") || "").trim();
}

function checkPrerequisites(mode) {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 18) {
    throw new Error(`Node.js >= 18 is required (current: ${process.version}).`);
  }
  console.log(`[desktop-build] Node.js: ${process.version}`);

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const npmVer = checkCommandVersion(npmCmd);
  if (!npmVer) {
    throw new Error("npm was not found in PATH.");
  }
  console.log(`[desktop-build] npm: ${npmVer}`);

  if (mode === "icons-only") return;

  const rustcVer = checkCommandVersion("rustc");
  const cargoVer = checkCommandVersion("cargo");
  if (!rustcVer || !cargoVer) {
    const platformHint =
      process.platform === "win32"
        ? "Install Rustup (https://rustup.rs) and Visual Studio C++ Build Tools (Desktop development with C++ + WebView2)."
        : process.platform === "darwin"
          ? "Install Xcode Command Line Tools (`xcode-select --install`) and Rustup (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)."
          : "Install Rustup (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`) and Tauri Linux deps (libwebkit2gtk-4.1-dev, build-essential, libssl-dev, libayatana-appindicator3-dev, librsvg2-dev).";
    throw new Error(
      `Rust toolchain (rustc/cargo) is not installed or not in PATH.\n  ${platformHint}`,
    );
  }
  console.log(`[desktop-build] ${rustcVer}`);
  console.log(`[desktop-build] ${cargoVer}`);
}

function ensureDependenciesInstalled(skipInstall) {
  const tauriBinName = process.platform === "win32" ? "tauri.cmd" : "tauri";
  const tauriBin = path.join(REPO_ROOT, "node_modules", ".bin", tauriBinName);
  const coreLink = path.join(REPO_ROOT, "node_modules", "@repo-prompt-generator", "core");
  const uiLink = path.join(REPO_ROOT, "node_modules", "@repo-prompt-generator", "ui");

  const hasDeps =
    fs.existsSync(tauriBin) && fs.existsSync(coreLink) && fs.existsSync(uiLink);

  if (hasDeps) {
    console.log("[desktop-build] Workspace dependencies already installed.");
    return;
  }
  if (skipInstall) {
    throw new Error(
      "Workspace dependencies are missing and --skip-install was passed. Run `npm install` at the repository root first.",
    );
  }

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  runCommand(npmCmd, ["install"], REPO_ROOT, "Installing workspace dependencies");
}

function resolveTauriCli() {
  const binName = process.platform === "win32" ? "tauri.cmd" : "tauri";
  const rootBin = path.join(REPO_ROOT, "node_modules", ".bin", binName);
  if (fs.existsSync(rootBin)) {
    return { cmd: rootBin, prefixArgs: [] };
  }
  const desktopBin = path.join(DESKTOP_DIR, "node_modules", ".bin", binName);
  if (fs.existsSync(desktopBin)) {
    return { cmd: desktopBin, prefixArgs: [] };
  }
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  return { cmd: npxCmd, prefixArgs: ["--no-install", "tauri"] };
}

function collectBundleArtifacts(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith(".app")) {
        out.push(full);
      } else {
        collectBundleArtifacts(full, out);
      }
    } else if (
      /\.(exe|msi|dmg|AppImage|deb|rpm|sig)$/i.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log("=== Repo Prompt Generator — Desktop Build ===");
  checkPrerequisites(opts.mode);
  ensureDependenciesInstalled(opts.skipInstall);

  prepareDesktopIcons({ force: opts.forceIcons });

  if (opts.mode === "icons-only") {
    console.log("\n[desktop-build] Done (--icons-only).");
    return;
  }

  const { cmd, prefixArgs } = resolveTauriCli();
  const subcommand = opts.mode === "dev" ? "dev" : "build";
  runCommand(
    cmd,
    [...prefixArgs, subcommand, ...opts.extraTauriArgs],
    DESKTOP_DIR,
    subcommand === "dev"
      ? "Starting Tauri desktop app in dev mode"
      : "Building desktop application bundle (Vite + Cargo + Tauri)",
  );

  if (subcommand === "build") {
    const artifacts = collectBundleArtifacts(BUNDLE_DIR);
    console.log("\n=== Desktop Build Completed Successfully ===");
    if (artifacts.length > 0) {
      console.log("Generated bundles:");
      for (const file of artifacts) {
        console.log(`  - ${path.relative(REPO_ROOT, file)}`);
      }
    } else {
      console.log(`Output directory: ${path.relative(REPO_ROOT, BUNDLE_DIR)}`);
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`\n[desktop-build] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
