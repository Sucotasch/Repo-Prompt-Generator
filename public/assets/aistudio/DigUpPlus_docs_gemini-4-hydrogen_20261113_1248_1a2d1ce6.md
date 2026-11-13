> **Prompt Generation Metadata**
> - **Model:** gemini-4-hydrogen
> - **Thinking Level:** HIGH
> - **Target Repository:** https://github.com/Sucotasch/DigUpPlus
> - **Auto-generated RAG Query:** "main entry points, exported functions, public API, core architecture, high-level modules

Specific Task Context: Нужен подробный и актуальный README, отвечающий всем современным требованиям, на двух языках - сначала на английском, затем на русском."
> - **Agentic RAG Requested Files:** (10/10 fetched)
>   - `README.md`
>   - `Package.swift`
>   - `docs/development-guide.md`
>   - `docs/agent-access.md`
>   - `Sources/digup/main.swift`
>   - `shell/src-tauri/src/main.rs`
>   - `shell/src-tauri/src/file_ops.rs`
>   - `Sources/DigUpKit/Searcher.swift`
>   - `Sources/DigUpKit/Indexer.swift`
>   - `Sources/digup/SearchService.swift`
> 
> <details><summary><b>Task Instructions</b></summary>
> 
> ````text
> You are an expert technical writer and software architect. Analyze the provided GitHub repository data to create comprehensive technical documentation in Markdown format (suitable for a Wiki or a detailed README.md). Make the code understandable.
> 
> Include:
> 1. Real capabilities of the program.
> 2. Algorithm of operation and architecture.
> 3. Installation and configuration process.
> 4. Examples of using the main functions.
> ````
> </details>
>
> <details><summary><b>Additional Context</b></summary>
> 
> ````text
> Нужен подробный и актуальный README, отвечающий всем современным требованиям, на двух языках - сначала на английском, затем на русском.
> ````
> </details>

---

<p align="center"><img src="docs/logo.png" width="96" alt="DigUp Plus logo"></p>

<h1 align="center" id="digup-plus">DigUp Plus</h1>

<p align="center"><b>Describe it. Dig it up.</b><br>
Local, private multimodal semantic search over your files powered by Google DeepMind's
<a href="https://huggingface.co/google/embeddinggemma-2">EmbeddingGemma 2</a>.</p>

<p align="center">
  <a href="#english">English</a> · <a href="#russian">Русский</a>
</p>

<p align="center">
  <a href="https://github.com/Sucotasch/DigUpPlus/releases"><img src="https://img.shields.io/github/v/release/Sucotasch/DigUpPlus?style=flat-square" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Sucotasch/DigUpPlus?style=flat-square" alt="MIT license"></a>
</p>

<p align="center"><img src="docs/demo.gif" width="800" alt="DigUp search demo across video frames, audio moments, PDF pages, photos in multiple languages, and source code"></p>

---

<a id="english"></a>

## Table of Contents (English)

1. [Overview & Fork Differences](#overview--fork-differences)
2. [Real Capabilities](#real-capabilities)
3. [Architecture & Algorithm of Operation](#architecture--algorithm-of-operation)
4. [Installation & Configuration](#installation--configuration)
5. [Usage Examples](#usage-examples)
6. [Building from Source & Testing](#building-from-source--testing)
7. [FAQ, Contributing & License](#faq-contributing--license)

---

## Overview & Fork Differences

**DigUp Plus** (`Sucotasch/DigUpPlus`, default branch `file-operations`) is a Windows-focused fork of [ARahim3/DigUp](https://github.com/ARahim3/DigUp). It shares the same core Swift engine (`DigUpKit`), the same 768-dimensional [EmbeddingGemma 2](https://huggingface.co/google/embeddinggemma-2) Q8_0 model on [llama.cpp](https://github.com/ggml-org/llama.cpp), the same SQLite/FTS5 index schema, and strict on-device privacy. The macOS SwiftUI app (`Sources/DigUpApp`) stays in the repository solely as a behavioral reference and is not built here.

### What This Fork Changes Over Upstream

| Area | Upstream (`ARahim3/DigUp`) | DigUp Plus (`Sucotasch/DigUpPlus`) |
|---|---|---|
| **Distribution** | macOS `.app` + installer/auto-updater | **Portable Windows bundle** (`DigUpPlus.exe` + `helper\` + `portable.txt` + `./data/`). No installer or admin rights required; no auto-updater; `-shell-only.zip` updates supported when the helper protocol matches |
| **Results & Pagination** | Fixed top cap (120 results in window) | **Unlimited paged ranking**: loads 120 hits first, then appends **300 at a time** incrementally via scroll or button without full DOM re-render |
| **Images View** | Mixed z-score ranking | **Cosine-layered ranking**: sorts by best segment's raw cosine (`visible` ≥ 0.648, `weak` 0.600–0.648, `hidden` < 0.600 in Standard profile; Loose/Strict profiles & adaptive low-scale shift) |
| **File Operations** | Read-only | **Move To…, Copy To…, Delete** in the big results window via Win32 wide/extended-length (`\\?\`) APIs; Recycle Bin + explicit permanent delete for paths ≥ 260 chars; conflict auto-numbering (`photo (2).jpg`); instant index sync & watcher echo suppression |
| **Total Commander** | Not available | **Feed results to Total Commander listbox** (*Selected to TC* / *All to TC*) in DigUp's exact relevance order |
| **Find Similar** | Flat similarity list | **Look-alike grouping** using 256-bit visual fingerprints (`Phash256`), folding near-duplicates (`+N` badge, `G` / `Shift+G`), accelerated by **Windows Imaging Component (WIC)** scaled JPEG decoding |
| **Hover Peek** | Spacebar preview only | **Hover-to-peek** enlarged image overlay near its native size without changing selection or stealing focus |
| **Storage & First Run** | Fixed AppData locations + onboarding wizard | **First run opens Settings** (nothing downloads automatically); **Settings → Storage** lets you adopt an existing index in-place, move the index folder, or import/move/delete model files |
| **Folder Rules & Lifecycle** | Basic root list & excludes | **Per-folder rules** (allowed kinds, `Scan subfolders` off = top-level only, per-folder excludes, audio **tags-only** mode), **Rescan**, **Re-read**, **Re-pick** (move folder without re-embedding), and **Forget** |
| **Agent Access (MCP)** | — | Built-in **read-only MCP server** (`digup mcp`) for Claude Desktop, Claude Code, and Cursor with `--root` scope enforcement |

---

## Real Capabilities

### 1. Multimodal Semantic + Exact Keyword Search
EmbeddingGemma 2 maps text, images, audio, and video frames into a single **768-dimensional vector space** across **100+ languages**:
- **Cross-modal & cross-lingual**: Search in English for a note written in Bengali or Arabic (or vice versa), find `"zebra in a video"` at the exact timestamp, `"where they talk about sleep"` at the exact podcast minute, or `"the clause about pets in the lease"` on the exact PDF page.
- **Exact word & ID matching**: SQLite **FTS5** (with Porter stemming and custom normalization in `SearchText`) rescues exact strings that embeddings blur—invoice numbers, error codes (`TRX50`), identifiers, and filenames. Queries composed of IDs or numbers automatically double keyword weight and halve meaning weight.

### 2. Supported File Types & Readers
DigUp Plus indexes **only the folders you choose**, skipping hidden directories (`.ssh`, `.git`), `.noindex` markers, keys/certificates/password files, developer/build caches, dataset-like folders (unless overridden), and cloud-only placeholders (OneDrive `FILE_ATTRIBUTE_OFFLINE` / `RECALL_ON_OPEN` / `RECALL_ON_DATA_ACCESS`).

| Kind | Formats | How It Is Extracted (`Platform/Portable` + `DigUpKit`) |
|---|---|---|
| **Images & Screenshots** | JPEG, PNG, HEIC, WebP, TIFF, AVIF, BMP, GIF (RAW/SVG on macOS only) | Decoded via `stb_image` / **WIC** (`Sources/CWIC`, scaled 1/2, 1/4, 1/8 for JPEG) / `ffmpeg` (HEIC/AVIF); resized (1024 px photos, 1536 px screenshots) and embedded. `Phash256` fingerprint computed from in-memory pixels. *(Note: OCR inside screenshots is macOS Vision only and not yet active on Windows/Linux.)* |
| **PDFs** | `.pdf` (text + scanned pages) | **PDFium** extracts text page-by-page; scanned/garbled pages are rendered at 1400 px and embedded as images. Long PDFs index their first **30 pages** immediately (`partial` state) and finish the rest (up to 5,000 pages) in a background second pass. |
| **Documents** | `.txt`, `.md`, `.typ`, `.rtf`, `.docx`, `.odt`, `.html`, `.xlsx`, `.ods`, `.pptx`, `.odp` | Native Swift/portable XML & Zip readers (`OfficeText`, `CMiniz`, `Docs+Portable`). Spreadsheets index sheet names & rows; presentations index slide text & speaker notes. Number-heavy data dumps get keyword-only indexing. |
| **Audio** | MP3, WAV, FLAC, M4A, AAC, OGG, Opus, etc. | **FFmpeg** slices audio into overlapping **30-second windows** so hits jump to the exact timestamp. Alternatively, folders or extensions (`--tag-type`) can use **tags-only** mode (`ffprobe` metadata: title, artist, album, genre, etc.) with zero audio embedding. |
| **Video** | MP4, MKV, MOV, WebM, AVI, TS, etc. | **FFmpeg** extracts keyframes per shot/interval (1024 px) + 30-second soundtrack windows, indexing both visual frames and audio segments. |
| **Code (Opt-in)** | Source files, `.ipynb` notebooks (outputs stripped), repo docs | Separate `code.sqlite` index activated via `code:` prefix (`--code`). Respects `.gitignore`, skips vendored/generated/secret files, chunks up to `codeStretch` (1800 chars), and opens results directly at the defining/matching line in your editor (VS Code, Cursor, Zed, JetBrains, Sublime Text, Notepad++). |

### 3. Windows File Operations & Total Commander
- **Move To…, Copy To…, Delete**: Operates on ticked or cursor-selected items in the big results window (`F5` Copy, `F6` Move, `F8` / `Del` Delete).
- **Safety Guarantees**:
  - Verifies source `size` and `mtime` before touching a file (skips stale results, symlinks, folders, and cloud placeholders).
  - Never overwrites destination files; name collisions become `photo (2).jpg`.
  - Delete sends files to the **Windows Recycle Bin** (`SHFileOperationW`). Only when a path exceeds `MAX_PATH` (≥ 260 UTF-16 units) does the report offer an explicit, second-confirmed **Permanent Delete** via `\\?\` extended-length `DeleteFileW`.
  - Batched index updates (`file_op` in chunks of 500) update paths, `inode`, `device`, `size`, and `mtime` directly in SQLite without re-embedding, while `echo.rs` suppresses redundant filesystem watcher rescans.
- **Total Commander Integration**: *Selected to TC* and *All to TC* export results as a UTF-16LE list file fed into Total Commander's panel (`totalcmd.exe` auto-detected or set in Settings → General) in DigUp's exact ranked order.

### 4. Visual Similarity, Grouping & Hover Peek
- **Find Similar**: Right-click any image → *Find similar* uses that file's stored 768-d embedding vector as the query (ranking by cosine similarity).
- **Look-alike Groups**: Computes a 256-bit perceptual fingerprint (`Phash256`) and folds near-identical copies (resizes, recompressions, monochrome/brightness variants) under their highest-ranked representative with a `+N` badge. Threshold is configurable as a bit-difference percentage in **Settings → Search** (default `6%`; measured resizes < 2%, 5% crops > 25%).
- **Hover Peek**: Hovering the cursor over a result thumbnail displays a large preview overlay without altering selection or keyboard focus.

### 5. Read-Only MCP Server for AI Agents
`digup mcp` exposes a newline-delimited JSON-RPC 2.0 server (`2024-11-05`) over `stdin`/`stdout` with three strictly read-only tools (`search`, `read_snippet`, `index_state`), response token budgets, and `--root` path scoping. See [`docs/agent-access.md`](docs/agent-access.md).

---

## Architecture & Algorithm of Operation

### System Architecture

DigUp Plus separates the **UI shell** (Rust + Tauri 2 + vanilla HTML/CSS/JS) from the **search & indexing engine** (Swift `digup` CLI/service processes) over newline-delimited JSON IPC (`stdin`/`stdout`), guarded by a strict `HELPER_PROTOCOL` version check (`--protocol`).

```
┌────────────────────────────────────────────────────────────────────────────┐
│                        Tauri Shell (shell/src-tauri)                       │
│  Tray Icon · Global Hotkey · FolderWatcher + Echo Suppression · File Ops   │
│  UI (shell/ui/* compiled into binary): panel, window, settings, setup      │
└───────────────┬──────────────────────────────────────────┬─────────────────┘
                │ JSON lines (stdin/stdout)                │ JSON lines
                ▼                                          ▼
┌───────────────────────────────┐        ┌───────────────────────────────────┐
│     digup search-service      │        │        digup index-service        │
│  • Keeps SQLite + Float16     │        │  • Crawler (sync diff by inode)   │
│    vector matrix in memory    │        │  • Two-stage overlapping pipeline │
│  • Text-only query encoder    │        │    (prepareAhead threads + model) │
│    (~250 MB, idles & unloads) │        │  • WorkerPool (1–4 GPU workers)   │
│  • Previews (<index>/previews)│        │  • Watchdog (memory/time limits)  │
│  • file_op / visual_groups    │        └─────────────────┬─────────────────┘
└───────────────┬───────────────┘                          │
                │                                          │
                ▼                                          ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                     DigUpKit + LlamaRuntime + Vendor                       │
│  SQLite + FTS5 (index.sqlite / code.sqlite) · llama.cpp (CPU/CUDA/Vulkan)  │
│  PDFium · FFmpeg / FFprobe · stb_image · miniz · Windows WIC (Sources/CWIC)│
└────────────────────────────────────────────────────────────────────────────┘
```

### Indexing Pipeline (`Indexer.swift` & `Crawler.swift`)

1. **Incremental Sync (`Indexer.sync`)**:
   - Walks chosen roots honoring per-folder `RootRule`s (`kinds`, `shallow`, `audioTags`/`audioContent`, `skipTypes`) and global exclusions.
   - Reconciles against `files` table by `path` and `(device, inode)` + `size` + `mtime`:
     - Unchanged files are skipped.
     - Moved files within crawled roots are **re-pathed in place** without re-embedding.
     - New/modified files are queued (`pending`).
     - If a chosen root exists on disk but is completely empty while rows exist beneath it, rows are preserved and Settings prompts the user to **Re-pick** (moved folder) or **Forget** (deleted files).
2. **Overlapping Prepare & Commit (`Indexer.process`)**:
   - Background `DispatchQueue` (`DigUp.prepare`) extracts files (`prepareAhead` batches ahead of the GPU) into temporary scratch folders while the main thread embeds the previous batch.
   - Images and screenshots are batched **8 at a time**; PDFs, docs, audio, video, and code are processed per file.
   - On CUDA GPUs, `DIGUP_INDEX_WORKERS=auto` spawns a `WorkerPool` of **1 to 4** worker processes (`2 GB` free VRAM per worker, capped at half CPU cores) to saturate GPU throughput.
   - Long PDFs and docs commit their first step (`pdfStep`/`docStep`) immediately as `partial` so search works right away, and `finishLongFiles()` completes the remainder after all pending files finish.
   - Every index stores a `fingerprint` (`vectorSource | options.fingerprint`) to prevent mixing incompatible embeddings, and records per-kind empirical timings in `costs.json` (`MeasuredCosts`) to refine future time estimates.

### Hybrid Search & Layering Algorithm (`Searcher.swift`)

1. **Vector Scoring**:
   - All segment vectors are stored L2-normalized as **768 × Float16** rows in a contiguous `VectorStorage` matrix.
   - The query is embedded (with `Prompts.query` or `Prompts.codeQuery`) by the text-only encoder (forced to CPU on Windows/Linux `search-service` for faster cold start) and multiplied block-by-block against the matrix to obtain raw cosine similarities.
2. **Modality-Centered Standardization (`Searcher.meaning`)**:
   - Because text, image, and audio vectors sit at slightly different baseline cosine levels for the same query, each vector subtracts the mean of its own `Modality` (if that modality has ≥ 20 scale-setting vectors; otherwise the global mean), then divides by the global standard deviation (floored at `0.02`), yielding a cross-modal **z-score**.
   - Later segments of long books/documents (`!rowSetsScale`) are scored against this scale without skewing the mean/deviation.
   - **Small-Corpus Fallback**: If a modality has `< 8` scale-setting vectors (`smallCorpusVectors`), a statistical z-score cannot reach `2.0`; `Searcher` admits matches with `cosine >= 0.600` (`smallCorpusFloor`).
3. **Keyword Retrieval (FTS5)**:
   - Tokenizes and normalizes query terms (`SearchText`), dropping stopwords and kind hints (`"video"`, `"screenshot"`, etc., which instead apply a `+1.0` soft kind boost).
   - Matches FTS5 with BM25 weighting (`3.0` filename/title, `1.0` content), automatically adding prefix `*` for unindexed terms ≥ 3 chars or inflecting languages (e.g., Bengali), and quotes code identifiers as phrases.
4. **Fusion & Ranking**:
   - Candidates pass if `z >= zGate` (default `2.0`, configurable in Settings → Search) OR keyword coverage `>= 0.5`.
   - Fused score: `score = meaningWeight * max(z, 0) + wordWeight * (coverage ^ 1.5) + kindHintBoost`. For normal queries `meaningWeight = 1.0, wordWeight = 2.0` (`1.0` for code); for lookup queries (IDs/numbers), weights flip to `(0.5, 4.0)`.
   - **Ordinary / All-files View**: Results with `score >= 0.5 * topScore` are shown immediately; lower-scoring matches fold under *Weaker matches*.
   - **Images Cosine Layers (`byCosine = true`)**: Sorts strictly by the best segment's raw **cosine** (keyword-only matches without vectors stay at the top). Splits into three layers using profile cutoffs (**Standard**: `visible ≥ 0.648`, `weak` `0.600–0.648`, `hidden < 0.600`; also **Loose** and **Strict** presets). If fewer than 30 images land in `visible`, both cutoffs dynamically shift down relative to the query's top cosine (`visible = top - 0.05`, preserving the profile band width).
   - **Stable Pagination**: `SearchService` tracks an index `generation` counter and returns `offset`, `consumed` (pre-filter ranked items), and `next_offset = offset + consumed`, ensuring deleted/excluded files filtered out post-slice never cause skipped rows across pages.

---

## Installation & Configuration

### Windows Portable Installation (Recommended)

1. Download `DigUpPlus-x.y.z-windows-x64.zip` from [GitHub Releases](https://github.com/Sucotasch/DigUpPlus/releases).
2. Unpack it anywhere (no installer, no admin rights). Requirements: **64-bit Windows 10 or 11**.
   - If Windows SmartScreen warns on the unsigned binary, click **More info → Run anyway**.
3. Run `DigUpPlus.exe`. Because `portable.txt` sits alongside the executable, all state (settings, logs, `index.sqlite`, `code.sqlite`, model files, and WebView2 profile) is stored in `./data/` inside the unpacked folder.
   - To store data elsewhere, pass `--data <folder>` or set the `DIGUP_DATA` environment variable.

#### Updating
- **Full zip**: Close DigUp Plus from the tray and replace the unpacked files (keep your `data/` folder).
- **Shell-only zip** (`-shell-only.zip`): When release notes state the helper did not change, extract `DigUpPlus.exe`, `portable.txt`, and `THIRD-PARTY-NOTICES.txt` over the existing folder. The shell pins `HELPER_PROTOCOL` via `--protocol` and refuses to run with an incompatible `digup.exe`.

### First-Run Setup & Configuration

Unlike upstream's onboarding wizard, **first launch opens Settings directly** and performs **no automatic downloads or indexing**:

1. **Settings → Storage**:
   - **Model (865 MB total: `embeddinggemma-2-Q8_0.gguf` 310 MB + `mmproj-embeddinggemma-2-Q8_0.gguf` 555 MB)**:
     - Click **Download Model…** to fetch from Hugging Face with resume and SHA-256 verification, OR
     - Click **Use Model Files…** to point at or import already-downloaded GGUF files (verified before activation).
     - You can also **Change Folder…** or **Move** the model later without losing your index.
   - **Index**: Defaults to `data\index`. Use **Use Existing Index…** to adopt an existing `index.sqlite` in place (verified before switching) or **Move Index Folder…** to relocate it to another drive.
   - **Processor / GPU**: On first setup with a model, `digup speed --model` benchmarks GPU (CUDA/Vulkan) vs CPU and checks vector agreement (`cosine >= 0.999`); if the GPU is slower or disagrees, DigUp Plus automatically falls back to CPU. You can also toggle CPU-only mode in Settings.
2. **Settings → Folders**:
   - Click **Add Folders…** to select whole directories or uncheck subfolders. Each folder shows an empirical time estimate for the first pass.
   - Click **Rules…** on any folder to restrict **File kinds**, disable **Scan subfolders** (top-level only), add per-folder extension skips, or switch audio to **Tags only** vs **Sound**.
   - Use **Rescan** (incremental sync), **Re-read** (re-extract & re-embed folder), **Re-pick** (update path of a moved folder while preserving vectors), or **Forget** (drop rows of an emptied folder).
3. **Settings → Search & General**:
   - Configure **Meaning threshold** (`zGate`), **Images layer profile** (`Standard` / `Loose` / `Strict`), and **Look-alike difference %** (default `6%`).
   - Set **Global Hotkey** (default `Ctrl+Shift+Space`), **Index Hours** schedule, **Code Editor**, **Total Commander** path (`totalcmd.exe` + new tab toggle), and confirmation prompts for Move/Copy/Delete.

---

## Usage Examples

### 1. Desktop Workflow & Keyboard Shortcuts

| Shortcut | Context | Action |
|---|---|---|
| `Ctrl+Shift+Space` | Global | Open/hide the floating quick search panel |
| `Ctrl+O` | Search Panel | Promote current search to the big Results Window |
| `Tab` | Results Window | Switch focus between search input and results list/grid |
| `↑` / `↓` | Both | Navigate results |
| `Enter` | Both | Open file at exact PDF page, audio/video timestamp, or code line |
| `Space` | Both | Full-window preview overlay at the matched page or timestamp |
| *Hover mouse* | Results Window | **Hover Peek**: enlarge thumbnail without changing selection |
| `Ctrl+Enter` | Both | Reveal file in Windows Explorer |
| `Ctrl+C` | Both | Copy file to clipboard (ready to paste in Explorer/chat/email) |
| `Ctrl+1` … `Ctrl+6` | Results Window | Switch view: Images, Screenshots, Documents, Video, Audio, All files |
| `Insert` / `Ctrl+A` | Results Window | Tick/select items for batch operations |
| `F5` / `F6` / `F8` (`Del`) | Results Window | **Copy To…** / **Move To…** / **Delete** selected or cursor file |
| `Right-click → Find similar` | Results Window | Search by visual/semantic similarity to that image (folds look-alikes) |
| `G` / `Shift+G` | Find Similar | Expand or collapse the look-alike group under cursor / all groups |
| `Esc` / `Ctrl+W` | Results Window | Hide window to system tray (keeps indexing running) |

> **Tip:** Closing the Results Window with the **X** button quits DigUp Plus completely (pausing indexing until the next launch).

### 2. Developer & Power-User CLI (`digup.exe`)

Run `digup.exe` with `DIGUP_MODELS` and `DIGUP_BACKENDS` (or beside `helper\` where DLLs reside):

```powershell
# Estimate indexing time and file counts for a folder (JSON output)
.\helper\digup.exe estimate "D:\Photos" --index ".\data\index" --json

# Index folders with a custom per-folder rule (top-level images only)
.\helper\digup.exe index "D:\Photos" --index ".\data\index" `
  --root-rule '{"root":"D:/Photos","kinds":["image"],"shallow":true}'

# Hybrid semantic + keyword search (top 20 PDF results, JSON)
$env:DIGUP_MODELS = ".\data\models"
.\helper\digup.exe search "clause about pets" --index ".\data\index" --kind pdf -n 20 --json

# Search the separate code index
.\helper\digup.exe search "code: retry a failed call with backoff" --index ".\data\index"

# Check index statistics, schema fingerprint, and pending/unfinished counts
.\helper\digup.exe status --index ".\data\index"

# Benchmark GPU vs CPU speed and store calibration in costs.json
.\helper\digup.exe speed --model --index ".\data\index"

# Re-point a moved folder in the index without re-embedding unchanged files
.\helper\digup.exe repick --index ".\data\index" --from "D:\OldPhotos" --to "E:\Archive\Photos" --apply

# Compute missing Phash256 look-alike fingerprints for an existing index
.\helper\digup.exe phash --index ".\data\index" --threads 6

# Run retrieval quality evaluation (Recall@1/5/10 and MRR)
.\helper\digup.exe eval .\evals\synthetic.json --index ".\data\index"
```

### 3. Connecting AI Agents via MCP (`digup mcp`)

In **Settings → Storage → Agents**, click **Copy MCP Config**, or generate it from the CLI:

```powershell
.\helper\digup.exe mcp --index ".\data\index" --root "D:\Documents" --print-config claude-desktop
```

Merge the generated `mcpServers.digup` entry into your client config (`claude_desktop_config.json`, `.mcp.json`, or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "digup": {
      "command": "D:\\Apps\\DigUpPlus\\helper\\digup.exe",
      "args": [
        "mcp",
        "--index", "D:\\Apps\\DigUpPlus\\data\\index",
        "--root", "D:\\Documents"
      ],
      "env": {
        "DIGUP_MODELS": "D:\\Apps\\DigUpPlus\\data\\models"
      }
    }
  }
}
```

Available read-only MCP tools:
- `search(query, kinds?, limit=10..50, offset=0..10000, meaning=true, code=false)` — returns ranked hits with `segment_id`, `loc`/`loc_end`, and ≤100-char snippets (6,000-char response budget).
- `read_snippet(path, segment_id?, query?, max_tokens=32..1024, code?)` — returns a windowed excerpt around matching terms (never dumps an entire file; rejects paths outside `--root` or not in the index).
- `index_state()` — returns counts by kind/state, chosen roots, and active model info.

---

## Building from Source & Testing

### Prerequisites (Windows)
- **Swift 6.2+** (tested with Swift 6.4.0 on Windows)
- **Rust** (stable MSVC toolchain; `shell/src-tauri/.cargo/config.toml` links CRT statically)
- **Node.js** (for `@tauri-apps/cli@2.12.2`)
- **Visual Studio 2022** C++ Build Tools (`vcvars64.bat`, MSVC linker)
- **Git for Windows Bash** (run scripts from Git Bash, **not** WSL `bash.exe`) & **MSYS2 MINGW64** (for `build-ffmpeg.sh`)
- Optional for GPU acceleration: **NVIDIA CUDA Toolkit** (`CUDA_PATH`) or Vulkan SDK

### Build & Package Steps

```sh
git clone https://github.com/Sucotasch/DigUpPlus && cd DigUpPlus
git switch file-operations

# 1. Fetch hash-pinned C dependencies (SQLite FTS5, stb, miniz, PDFium)
scripts/fetch-vendor.sh

# 2. Build llama.cpp at pinned tag with no-logits patch
scripts/build-llama.sh

# 3. Build FFmpeg/FFprobe (run in MSYS2 MINGW64 shell)
scripts/build-ffmpeg.sh

# 4. Build Swift engine & CLI
swift build -c release --product digup

# 5. Build Rust Tauri shell & create portable Windows package
#    (Run inside a Visual Studio Developer environment with MSVC link.exe first in PATH)
scripts/package-portable.sh
# Output: shell/src-tauri/target/release/DigUpPlus.exe + helper\ + portable.txt
# Optional shell-only zip: SHELL_ONLY=1 scripts/package-portable.sh
```

See [`docs/development-guide.md`](docs/development-guide.md) for detailed Windows build notes, troubleshooting linker shadowing (`/usr/bin/link.exe` vs MSVC `link.exe`), and headless UI CDP test harnesses.

### Running Tests

```sh
# Swift engine & LlamaRuntime tests (194 tests; see docs/development-guide.md for Windows DLL env)
swift test
# On Windows dev environment with helper wrapper:
# python .build/swift_test.py

# Rust shell unit & integration tests (file_ops, settings, echo, rules, etc.)
cd shell/src-tauri && cargo test --locked

# Frontend JS syntax check
for f in shell/ui/*.js; do node --check "$f" || echo "FAIL $f"; done
```

---

## FAQ, Contributing & License

- **How is this different from Windows Search or Everything?** They index filenames, metadata, and plain text. DigUp Plus understands visual content in photos/videos, spoken audio, scanned PDFs, and natural-language concepts across 100+ languages—and jumps directly to the matching page, timestamp, or code line.
- **What data leaves my computer?** None. The only network request DigUp Plus can make is downloading the open-weight EmbeddingGemma 2 model once when you click **Download Model…** (or opening GitHub Releases when you click Download in Settings). Zero telemetry, zero accounts.
- **How do I uninstall?** Quit DigUp Plus from the tray icon and delete the unpacked folder. If you enabled **Open at login**, turn it off in **Settings → General** before deleting the folder to remove the Windows Registry `Run` key.
- **Contributing**: Please read [CONTRIBUTING.md](CONTRIBUTING.md). Open an issue before submitting major PRs, and include before/after `digup eval` metrics for any ranking changes.
- **License & Acknowledgements**: Released under the [MIT License](LICENSE) (upstream copyright © 2026 Abdur Rahim; fork changes by Sucotasch). Built with [EmbeddingGemma 2](https://huggingface.co/google/embeddinggemma-2) (Apache 2.0), [llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT), [Tauri](https://tauri.app) (MIT/Apache 2.0), [PDFium](https://pdfium.googlesource.com/pdfium/) (BSD), [FFmpeg](https://ffmpeg.org) (LGPL), [stb](https://github.com/nothings/stb) (Public Domain), and [miniz](https://github.com/richgel999/miniz) (MIT). Full notices ship in `THIRD-PARTY-NOTICES.txt`.

---
---

<a id="russian"></a>

<h1 align="center" id="digup-plus-ru">DigUp Plus (Русская документация)</h1>

<p align="center"><b>Опиши — и найди.</b><br>
Локальный приватный мультимодальный семантический поиск по вашим файлам на базе модели
<a href="https://huggingface.co/google/embeddinggemma-2">EmbeddingGemma 2</a> от Google DeepMind.</p>

<p align="center">
  <a href="#english">English</a> · <a href="#russian">Русский</a>
</p>

## Содержание (Русский)

1. [Обзор и отличия от upstream](#обзор-и-отличия-от-upstream)
2. [Реальные возможности программы](#реальные-возможности-программы)
3. [Архитектура и алгоритм работы](#архитектура-и-алгоритм-работы)
4. [Установка и настройка](#установка-и-настройка)
5. [Примеры использования основных функций](#примеры-использования-основных-функций)
6. [Сборка из исходников и тестирование](#сборка-из-исходников-и-тестирование)
7. [FAQ, участие в разработке и лицензия](#faq-участие-в-разработке-и-лицензия)

---

## Обзор и отличия от upstream

**DigUp Plus** (`Sucotasch/DigUpPlus`, основная ветка `file-operations`) — это ориентированный на Windows форк проекта [ARahim3/DigUp](https://github.com/ARahim3/DigUp). Внутри используется тот же движок на Swift (`DigUpKit`), та же 768-мерная модель [EmbeddingGemma 2](https://huggingface.co/google/embeddinggemma-2) Q8_0 на базе [llama.cpp](https://github.com/ggml-org/llama.cpp), тот же формат индекса SQLite/FTS5 и строгие правила локальной приватности. Приложение macOS SwiftUI (`Sources/DigUpApp`) оставлено в репозитории только как эталон поведения и в этом форке не собирается.

### Что изменено по сравнению с upstream

| Область | Upstream (`ARahim3/DigUp`) | DigUp Plus (`Sucotasch/DigUpPlus`) |
|---|---|---|
| **Дистрибуция** | macOS `.app` / установщик с автообновлением | **Portable-сборка для Windows** (`DigUpPlus.exe` + `helper\` + `portable.txt` + `./data/`). Не требует установки и прав администратора; автообновление удалено; поддерживаются малые архивы `-shell-only.zip` при совпадении протокола helper |
| **Выдача и пагинация** | Жёсткий лимит (120 результатов в окне) | **Безлимитная постраничная выдача**: открывает лучшие 120, далее инкрементально догружает по **300** при прокрутке или по кнопке без перерисовки DOM |
| **Фильтр Images** | Смешанный z-score рейтинг | **Слои по косинусному сходству**: сортировка по чистому cosine лучшего сегмента (`visible` ≥ 0.648, `weak` 0.600–0.648, `hidden` < 0.600 в профиле Standard; профили Loose/Strict и адаптивный сдвиг при низких значениях) |
| **Файловые операции** | Только чтение | **Move To…, Copy To…, Delete** прямо в большом окне результатов через Win32 wide/`\\?\` API; удаление в Корзину + отдельное подтверждаемое безвозвратное удаление для путей ≥ 260 символов; автонумерация при конфликтах (`photo (2).jpg`); мгновенное обновление индекса и подавление эха watcher'а |
| **Total Commander** | Отсутствует | **Передача результатов списком в панель Total Commander** (*Selected to TC* / *All to TC*) в точном порядке ранжирования DigUp |
| **Find similar** | Плоский список похожих | **Группировка визуально похожих** картинок по 256-битному отпечатку `Phash256` (свёртка дублей/ресайзов под значком `+N`, клавиши `G` / `Shift+G`), ускоренная масштабируемым декодированием JPEG через **Windows Imaging Component (WIC)** |
| **Hover Peek** | Превью только по Space | **Увеличенная подсказка при наведении курсора** на миниатюру без смены выделения и перехвата фокуса |
| **Хранение и первый запуск** | Фиксированные пути AppData + мастер настройки | **Первый запуск открывает Settings** (ничего не скачивается само); **Settings → Storage** позволяет подключить готовый индекс на месте, перенести индекс на другой диск, импортировать/перенести/удалить файлы модели |
| **Правила папок и жизненный цикл** | Базовый список папок и исключений | **Пер-корневые правила** (типы файлов, `Scan subfolders` выкл. = только верхний уровень, исключения расширений, режим аудио **только по тегам**), **Rescan**, **Re-read**, **Re-pick** (перенос папки без переэмбеддинга) и **Forget** |
| **Доступ агентов (MCP)** | — | Встроенный **read-only MCP-сервер** (`digup mcp`) для Claude Desktop, Claude Code и Cursor с ограничением области через `--root` |

---

## Реальные возможности программы

### 1. Мультимодальный гибридный поиск (смысл + точные слова)
EmbeddingGemma 2 помещает текст, изображения, аудио и кадры видео в единое **768-мерное векторное пространство** и понимает **более 100 языков**:
- **Кросс-модальность и мультиязычность**: Запрос на одном языке находит заметки на другом (английский, русский, бенгальский, арабский и др.), `"зебра в видео"` открывает клип на нужной секунде, `"где говорят про сон"` переходит к нужной минуте подкаста, а `"пункт о животных в договоре"` открывает нужную страницу PDF.
- **Точные совпадения через SQLite FTS5**: Стеммер Портера и нормализация `SearchText` находят номера счетов, коды ошибок (`TRX50`), идентификаторы и имена файлов. Для запросов-идентификаторов/чисел вес точных слов автоматически удваивается, а вес смысла уменьшается вдвое.

### 2. Поддерживаемые форматы и экстракторы
DigUp Plus индексирует **только выбранные папки**, пропуская скрытые каталоги (`.ssh`, `.git`), маркеры `.noindex`, ключи/сертификаты/пароли, кэши разработчиков, датасеты (если не включено обратно) и облачные placeholder-файлы (OneDrive `FILE_ATTRIBUTE_OFFLINE` / `RECALL_ON_OPEN` / `RECALL_ON_DATA_ACCESS`).

| Тип | Форматы | Как извлекается и индексируется (`Platform/Portable` + `DigUpKit`) |
|---|---|---|
| **Изображения и скриншоты** | JPEG, PNG, HEIC, WebP, TIFF, AVIF, BMP, GIF (RAW/SVG только на macOS) | Декод через `stb_image` / **WIC** (`Sources/CWIC`, масштабированный декод 1/2, 1/4, 1/8 для JPEG) / `ffmpeg` (HEIC/AVIF); масштабирование (1024 px фото, 1536 px скриншоты) и эмбеддинг. `Phash256` считается из пикселей в памяти без повторного чтения. *(Примечание: OCR текста внутри скриншотов пока работает только на macOS Vision.)* |
| **PDF** | `.pdf` (текст и сканы) | **PDFium** извлекает текст постранично; сканированные или с «битой» кодировкой страницы рендерятся (1400 px) и эмбеддятся как изображения. Крупные PDF индексируют первые **30 страниц** сразу (состояние `partial`), а остаток (до 5 000 страниц) дочитывается в фоне после очереди. |
| **Документы** | `.txt`, `.md`, `.typ`, `.rtf`, `.docx`, `.odt`, `.html`, `.xlsx`, `.ods`, `.pptx`, `.odp` | Нативные парсеры + `OfficeText`/`CMiniz`/`Docs+Portable`. Таблицы сохраняют имена листов и строки; презентации — текст слайдов и заметки докладчика. Текст, состоящий в основном из чисел (выгрузки данных), попадает только в FTS5 без векторов. |
| **Аудио** | MP3, WAV, FLAC, M4A, AAC, OGG, Opus и др. | **FFmpeg** нарезает звук на перекрывающиеся **30-секундные окна**, чтобы попадание открывалось на точном моменте. Правило папки или список `--tag-type` позволяют читать аудио **только по тегам** (`ffprobe`: title, artist, album и др.) без декодирования и эмбеддинга звука. |
| **Видео** | MP4, MKV, MOV, WebM, AVI, TS и др. | **FFmpeg** извлекает ключевые кадры по интервалу/сценам (1024 px) и 30-секундные окна звуковой дорожки, индексируя и картинку, и звук. |
| **Код (Opt-in)** | Исходники, `.ipynb` (без output'ов), документация репозитория | Отдельный индекс `code.sqlite`, включается префиксом `code:` (`--code`). Учитывает `.gitignore`, пропускает vendor/generated/ключи, режет чанки по `codeStretch` (1800 символов) и открывает файл сразу на строке определения/совпадения в редакторе (VS Code, Cursor, Zed, JetBrains, Sublime Text, Notepad++). |

### 3. Файловые операции на Windows и интеграция с Total Commander
- **Move To…, Copy To…, Delete**: Работают над отмеченными чекбоксами или текущим файлом в большом окне результатов (`F5` Копировать, `F6` Переместить, `F8` / `Del` Удалить).
- **Надёжность и защита от потерь**:
  - Перед действием проверяются `size` и `mtime` (изменённые с момента поиска файлы, симлинки, папки и облачные placeholder'ы пропускаются).
  - Существующие файлы в папке назначения не перезаписываются — конфликт получает номер (`photo (2).jpg`).
  - Удаление идёт в **Корзину Windows** (`SHFileOperationW`). Если путь ≥ 260 символов UTF-16 и Корзина отказывает, отчёт предлагает отдельное, явно подтверждаемое **безвозвратное удаление** через extended-length `\\?\` и `DeleteFileW`.
  - Пакетное обновление индекса (`file_op` батчами по 500) сразу переписывает пути, `inode`, `device`, `size` и `mtime` в SQLite без переэмбеддинга, а модуль `echo.rs` подавляет ложное эхо файлового watcher'а.
- **Total Commander**: Кнопки *Selected to TC* и *All to TC* формируют UTF-16LE список и передают его в панель Total Commander (`totalcmd.exe` определяется из реестра или задаётся в Settings → General) в точном порядке выдачи DigUp.

### 4. Поиск похожих, группировка и Hover Peek
- **Find similar**: ПКМ по картинке → *Find similar* использует её собственный 768-мерный вектор из индекса в качестве запроса (сортировка по cosine).
- **Группы похожих по облику**: Вычисляет 256-битный визуальный отпечаток (`Phash256`) и сворачивает дубли, ресайзы, пересохранения и серии вариантов в одну ячейку со значком `+N`. Порог задаётся в процентах отличия бит в **Settings → Search** (по умолчанию `6%`: ресайзы/пересжатия < 2%, обрезка на 5% уже > 25%).
- **Hover Peek**: Задержка курсора над миниатюрой показывает крупный оверлей изображения без изменения выделения и фокуса клавиатуры.

### 5. Read-only MCP-сервер для ИИ-агентов
`digup mcp` поднимает локальный JSON-RPC 2.0 сервер (`2024-11-05`) по `stdin`/`stdout` с тремя инструментами только для чтения (`search`, `read_snippet`, `index_state`), контролем бюджета токенов и ограничением области через `--root`. Подробнее: [`docs/agent-access.md`](docs/agent-access.md).

---

## Архитектура и алгоритм работы

### Общая архитектура

DigUp Plus разделяет **оболочку UI** (Rust + Tauri 2 + чистый HTML/CSS/JS) и **движок поиска/индексации** (Swift-процессы `digup`), общающиеся по протоколу JSON-строк (`stdin`/`stdout`) с жёсткой проверкой версии протокола (`--protocol` / `HELPER_PROTOCOL`).

```
┌────────────────────────────────────────────────────────────────────────────┐
│                      Оболочка Tauri (shell/src-tauri)                      │
│  Трей · Глобальный хоткей · FolderWatcher + Echo · Файловые операции       │
│  UI (shell/ui/* вкомпилированы в exe): panel, window, settings, setup      │
└───────────────┬──────────────────────────────────────────┬─────────────────┘
                │ JSON-строки (stdin/stdout)               │ JSON-строки
                ▼                                          ▼
┌───────────────────────────────┐        ┌───────────────────────────────────┐
│     digup search-service      │        │        digup index-service        │
│  • Держит открытым SQLite и   │        │  • Crawler (сверка по path/inode) │
│    матрицу Float16-векторов   │        │  • Конвейер с перекрытием стадий  │
│  • Текстовый энкодер (~250 МБ,│        │    (prepareAhead + модель)        │
│    выгружается при простое)   │        │  • WorkerPool (1–4 GPU-воркера)   │
│  • Превью (<index>/previews)  │        │  • Watchdog (лимиты RAM/времени)  │
│  • file_op / visual_groups    │        └─────────────────┬─────────────────┘
└───────────────┬───────────────┘                          │
                │                                          │
                ▼                                          ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                     DigUpKit + LlamaRuntime + Vendor                       │
│  SQLite + FTS5 (index.sqlite / code.sqlite) · llama.cpp (CPU/CUDA/Vulkan)  │
│  PDFium · FFmpeg / FFprobe · stb_image · miniz · Windows WIC (Sources/CWIC)│
└────────────────────────────────────────────────────────────────────────────┘
```

### Пайплайн индексации (`Indexer.swift` и `Crawler.swift`)

1. **Инкрементальная сверка (`Indexer.sync`)**:
   - Обходит выбранные корни с учётом `RootRule` (`kinds`, `shallow`, `audioTags`/`audioContent`, `skipTypes`) и глобальных исключений.
   - Сверяет с таблицей `files` по `path` и `(device, inode)` + `size` + `mtime`: неизменённые пропускаются, перемещённые внутри индексируемых папок **перепривязываются без переэмбеддинга**, новые/изменённые ставятся в очередь (`pending`).
   - Если выбранная папка существует, но пуста, пока под ней есть записи в базе, строки не удаляются — UI предлагает **Re-pick** (переезд папки) или **Forget** (удаление файлов).
2. **Параллельная подготовка и коммит (`Indexer.process`)**:
   - Фоновая очередь `DigUp.prepare` заранее читает и декодирует пакеты (`prepareAhead` батчей вперёд), пока модель эмбеддит предыдущий батч.
   - Изображения и скриншоты подаются батчами по **8 штук**; PDF, документы, аудио, видео и код — пофайлово.
   - На GPU CUDA `DIGUP_INDEX_WORKERS=auto` поднимает `WorkerPool` из **1–4 рабочих процессов** (`2 ГБ` свободной VRAM на воркер, не более половины ядер CPU), чтобы полностью загрузить видеокарту.
   - Крупные PDF и документы сначала индексируют первую порцию (`pdfStep`/`docStep`) в статусе `partial`, чтобы сразу стать доступными в поиске, а остаток дочитывается в `finishLongFiles()`.
   - Индекс хранит `fingerprint` (`vectorSource | options.fingerprint`) для защиты от смешивания векторов разных версий, а реальные замеры скорости пишутся в `costs.json` (`MeasuredCosts`) для точных оценок.

### Алгоритм гибридного поиска и слоёв (`Searcher.swift`)

1. **Векторный скоринг**:
   - Все векторы сегментов хранятся L2-нормализованными в виде плотной матрицы **768 × Float16** (`VectorStorage`).
   - Запрос эмбеддится текстовой частью модели (в `search-service` на Windows/Linux энкодер запроса принудительно работает на CPU для быстрого старта) и блочно перемножается с матрицей для получения косинусного сходства.
2. **Стандартизация по модальностям (`Searcher.meaning`)**:
   - Так как среднее косинусное сходство текста, картинок и аудио слегка сдвинуто, из каждого вектора вычитается среднее его `Modality` (если в ней ≥ 20 опорных векторов, иначе общее среднее), после чего разность делится на общее стандартное отклонение (минимум `0.02`). Это даёт единую шкалу **z-score**.
   - Поздние страницы длинных книг (`!rowSetsScale`) оцениваются по этой шкале, но не сдвигают её статистику.
   - **Малые индексы**: При `< 8` опорных векторов в модальности (`smallCorpusVectors`) z-score математически ограничен; в этом случае срабатывает абсолютный порог `cosine >= 0.600` (`smallCorpusFloor`).
3. **Ключевые слова (FTS5)**:
   - Токенизирует и нормализует запрос (`SearchText`), удаляя стоп-слова и маркеры типов (`"видео"`, `"screenshot"` и т. п., которые дают мягкий буст `+1.0`).
   - Ищет в FTS5 с весами BM25 (`3.0` имя файла, `1.0` текст), автоматически расширяя префиксом `*` редкие слова (≥ 3 символов) и флективные языки; идентификаторы кода ищутся как фразы.
4. **Слияние, слои и пагинация**:
   - Файл проходит в выдачу, если `z >= zGate` (по умолчанию `2.0`) ИЛИ покрытие слов запроса `>= 0.5`.
   - Итоговый скор: `score = meaningWeight * max(z, 0) + wordWeight * (coverage ^ 1.5) + kindHintBoost` (обычно `1.0 / 2.0`, для кода `1.0 / 1.0`, для ID/чисел `0.5 / 4.0`).
   - **Обычный поиск / All files**: Показываются результаты со `score >= 0.5 * topScore`; остальные сворачиваются под *Weaker matches*.
   - **Слои Images (`byCosine = true`)**: Сортировка строго по чистому **cosine** лучшего сегмента (точные совпадения по словам без вектора остаются сверху). Разбивка по порогам профиля (**Standard**: `visible ≥ 0.648`, `weak` `0.600–0.648`, `hidden < 0.600`; также профили **Loose** и **Strict**). Если в `visible` меньше 30 картинок, оба порога адаптивно сдвигаются под топ-1 запроса (`visible = top - 0.05` с сохранением ширины полосы `weak`).
   - **Надёжная пагинация**: `SearchService` хранит счётчик `generation` и возвращает `offset`, `consumed` и `next_offset = offset + consumed`, поэтому отфильтрованные несуществующие файлы не приводят к пропускам на границах страниц.

---

## Установка и настройка

### Portable-установка на Windows (основной способ)

1. Скачайте `DigUpPlus-x.y.z-windows-x64.zip` со страницы [Releases](https://github.com/Sucotasch/DigUpPlus/releases).
2. Распакуйте в любую папку (установка и права администратора не требуются; нужна **64-битная Windows 10 или 11**).
   - При предупреждении SmartScreen нажмите **Подробнее → Выполнить в любом случае**.
3. Запустите `DigUpPlus.exe`. Наличие файла `portable.txt` рядом с `.exe` переводит хранение всех данных (настройки, логи, `index.sqlite`, `code.sqlite`, модели, профиль WebView2) в локальную папку `./data/`.
   - Для выбора другого каталога данных передайте `--data <папка>` или задайте переменную окружения `DIGUP_DATA`.

#### Обновление
- **Полный архив**: Закройте DigUp Plus из трея и замените файлы в распакованной папке (не трогая папку `data/`).
- **Только оболочка (`-shell-only.zip`)**: Если в заметках к релизу указано, что helper не менялся, достаточно заменить `DigUpPlus.exe`, `portable.txt` и `THIRD-PARTY-NOTICES.txt`. Оболочка передаёт helper'у `--protocol` с константой `HELPER_PROTOCOL` и откажется запускаться при несовпадении поколений.

### Первый запуск и конфигурация

При первом запуске открывается окно **Settings** — программа **не скачивает модель и не начинает индексацию без вашего подтверждения**:

1. **Settings → Storage**:
   - **Модель (865 МБ: `embeddinggemma-2-Q8_0.gguf` 310 МБ + `mmproj-embeddinggemma-2-Q8_0.gguf` 555 МБ)**:
     - Нажмите **Download Model…** для скачивания с Hugging Face с докачкой и проверкой SHA-256, либо
     - Нажмите **Use Model Files…**, чтобы указать или импортировать уже скачанные GGUF-файлы.
     - Папку модели можно сменить или перенести (**Change Folder…**) без потери индекса.
   - **Индекс**: По умолчанию `data\index`. Кнопка **Use Existing Index…** подключает готовый `index.sqlite` на месте (с проверкой открытия), а **Move Index Folder…** переносит его на другой диск.
   - **Процессор / GPU**: После появления модели `digup speed --model` сравнивает скорость GPU (CUDA/Vulkan) и CPU и проверяет совпадение векторов (`cosine >= 0.999`); если GPU медленнее или расходится, автоматически выбирается CPU. Переключить режим вручную можно там же в настройках.
2. **Settings → Folders**:
   - Нажмите **Add Folders…** и выберите папки (можно развернуть дерево и снять галочки с лишних подпапок) — сразу отобразится оценка времени первого прохода.
   - Кнопка **Rules…** задаёт для конкретной папки разрешённые типы файлов, отключение обхода подпапок (**Scan subfolders**), локальные исключения расширений и режим аудио (**только по тегам** или звук).
   - Действия над папкой: **Rescan** (быстрая сверка), **Re-read** (полная переиндексация папки), **Re-pick** (указать новый путь перемещённой папки без переэмбеддинга), **Forget** (удалить строки очищенной папки).
3. **Settings → Search и General**:
   - Настройка порога смысла (`zGate`), профиля слоёв Images (`Standard` / `Loose` / `Strict`) и процента отличий `Find similar` (по умолчанию `6%`).
   - Глобальный хоткей (по умолчанию `Ctrl+Shift+Space`), расписание **Index Hours**, редактор кода, путь к `totalcmd.exe` для Total Commander и отключение/включение подтверждений Move/Copy/Delete.

---

## Примеры использования основных функций

### 1. Работа в интерфейсе и горячие клавиши

| Клавиша | Контекст | Действие |
|---|---|---|
| `Ctrl+Shift+Space` | Везде | Открыть/скрыть быструю панель поиска |
| `Ctrl+O` | Панель поиска | Перенести текущий запрос в большое окно результатов |
| `Tab` | Окно результатов | Переключение фокуса между строкой поиска и списком/сеткой |
| `↑` / `↓` | Оба окна | Навигация по результатам |
| `Enter` | Оба окна | Открыть файл на нужной странице PDF, минуте аудио/видео или строке кода |
| `Space` | Оба окна | Большой встроенный предпросмотр на найденном фрагменте |
| *Наведение мыши* | Окно результатов | **Hover Peek**: крупный просмотр картинки без смены выделения |
| `Ctrl+Enter` | Оба окна | Показать файл в Проводнике |
| `Ctrl+C` | Оба окна | Скопировать файл в буфер обмена (для вставки в Проводник/почту/чат) |
| `Ctrl+1` … `Ctrl+6` | Окно результатов | Вкладки: Images, Screenshots, Documents, Video, Audio, All files |
| `Insert` / `Ctrl+A` | Окно результатов | Отметить файлы галочками для пакетных операций |
| `F5` / `F6` / `F8` (`Del`) | Окно результатов | **Copy To…** / **Move To…** / **Delete** отмеченных или выбранного файла |
| `ПКМ → Find similar` | Окно результатов | Поиск визуально и семантически похожих изображений (со свёрткой дублей) |
| `G` / `Shift+G` | Find similar | Развернуть или свернуть группу похожих под курсором / все группы |
| `Esc` / `Ctrl+W` | Окно результатов | Свернуть окно в системный трей (индексация продолжается) |

> **Важно:** Закрытие большого окна кнопкой **X** полностью завершает работу DigUp Plus (индексация ставится на паузу до следующего запуска).

### 2. Консольный инструмент разработчика (`digup.exe`)

Примеры запуска CLI из распакованной папки (или из сборки с нужными переменными окружения):

```powershell
# Оценить время индексации и состав папки в JSON
.\helper\digup.exe estimate "D:\Photos" --index ".\data\index" --json

# Проиндексировать папку с правилом (только картинки, без подпапок)
.\helper\digup.exe index "D:\Photos" --index ".\data\index" `
  --root-rule '{"root":"D:/Photos","kinds":["image"],"shallow":true}'

# Гибридный поиск по PDF (топ-20, вывод в JSON)
$env:DIGUP_MODELS = ".\data\models"
.\helper\digup.exe search "пункт о животных" --index ".\data\index" --kind pdf -n 20 --json

# Поиск по отдельному индексу кода
.\helper\digup.exe search "code: retry a failed call with backoff" --index ".\data\index"

# Статистика индекса, fingerprint модели и количество незавершённых файлов
.\helper\digup.exe status --index ".\data\index"

# Замер скорости GPU vs CPU и сохранение калибровки в costs.json
.\helper\digup.exe speed --model --index ".\data\index"

# Перепривязать перемещённую папку в индексе без пересчёта векторов
.\helper\digup.exe repick --index ".\data\index" --from "D:\OldPhotos" --to "E:\Archive\Photos" --apply

# Досчитать отпечатки Phash256 для существующего индекса
.\helper\digup.exe phash --index ".\data\index" --threads 6

# Запустить оценку качества поиска (Recall@1/5/10 и MRR)
.\helper\digup.exe eval .\evals\synthetic.json --index ".\data\index"
```

### 3. Подключение ИИ-агентов через MCP (`digup mcp`)

В разделе **Settings → Storage → Agents** нажмите **Copy MCP Config** или сгенерируйте конфиг из CLI:

```powershell
.\helper\digup.exe mcp --index ".\data\index" --root "D:\Documents" --print-config claude-desktop
```

Добавьте полученный объект `mcpServers.digup` в конфиг клиента (`claude_desktop_config.json`, `.mcp.json` или `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "digup": {
      "command": "D:\\Apps\\DigUpPlus\\helper\\digup.exe",
      "args": [
        "mcp",
        "--index", "D:\\Apps\\DigUpPlus\\data\\index",
        "--root", "D:\\Documents"
      ],
      "env": {
        "DIGUP_MODELS": "D:\\Apps\\DigUpPlus\\data\\models"
      }
    }
  }
}
```

Доступные инструменты (только чтение):
- `search(query, kinds?, limit=10..50, offset=0..10000, meaning=true, code=false)` — возвращает ранжированные совпадения с `segment_id`, `loc`/`loc_end` и сниппетами ≤100 символов (бюджет ответа 6 000 символов).
- `read_snippet(path, segment_id?, query?, max_tokens=32..1024, code?)` — возвращает текстовое окно вокруг совпадения (никогда не отдаёт файл целиком; пути вне `--root` или отсутствующие в индексе отклоняются).
- `index_state()` — сводка по числу файлов, типам, статусам и корням.

---

## Сборка из исходников и тестирование

### Требования (Windows)
- **Swift 6.2+** (проверено на Swift 6.4.0 для Windows)
- **Rust** (MSVC toolchain; `shell/src-tauri/.cargo/config.toml` статически линкует CRT)
- **Node.js** (для `@tauri-apps/cli@2.12.2`)
- **Visual Studio 2022** C++ Build Tools (`vcvars64.bat`, линкер MSVC)
- **Git for Windows Bash** (скрипты запускаются через Git Bash, **не** через WSL `bash.exe`) и **MSYS2 MINGW64** (для `build-ffmpeg.sh`)
- Опционально для GPU: **NVIDIA CUDA Toolkit** (`CUDA_PATH`) или Vulkan SDK

### Шаги сборки

```sh
git clone https://github.com/Sucotasch/DigUpPlus && cd DigUpPlus
git switch file-operations

# 1. Загрузка C-зависимостей с проверкой SHA-256 (SQLite FTS5, stb, miniz, PDFium)
scripts/fetch-vendor.sh

# 2. Сборка llama.cpp на фиксированном теге с патчем no-logits
scripts/build-llama.sh

# 3. Сборка FFmpeg/FFprobe (выполняется в оболочке MSYS2 MINGW64)
scripts/build-ffmpeg.sh

# 4. Сборка Swift-движка и CLI
swift build -c release --product digup

# 5. Сборка Rust/Tauri-оболочки и упаковка portable-версии
#    (Запускать в среде Visual Studio Developer с MSVC link.exe первым в PATH)
scripts/package-portable.sh
# Результат: shell/src-tauri/target/release/DigUpPlus.exe + helper\ + portable.txt
# Только оболочка: SHELL_ONLY=1 scripts/package-portable.sh
```

Подробности по путям, обходу конфликта `link.exe` в Git Bash и headless-стендам CDP для проверки UI описаны в [`docs/development-guide.md`](docs/development-guide.md).

### Запуск тестов

```sh
# Тесты движка Swift и LlamaRuntime (194 теста; на Windows требуется PATH с DLL из Vendor)
swift test
# На локальной Windows-машине через обёртку:
# python .build/swift_test.py

# Тесты Rust-оболочки (file_ops, settings, echo, правила и др.)
cd shell/src-tauri && cargo test --locked

# Проверка синтаксиса JS-файлов интерфейса
for f in shell/ui/*.js; do node --check "$f" || echo "FAIL $f"; done
```

---

## FAQ, участие в разработке и лицензия

- **Чем DigUp Plus отличается от Windows Search или Everything?** Они ищут по именам, метаданным и обычному тексту. DigUp Plus понимает содержание картинок и видео, речь в аудиозаписях, сканированные PDF и смысл запросов на 100+ языках, открывая нужную страницу, секунду или строку кода.
- **Отправляются ли данные в сеть?** Нет. Единственный сетевой запрос — однократная загрузка открытых весов EmbeddingGemma 2 по кнопке **Download Model…** (и открытие страницы GitHub Releases по кнопке Download). Нет телеметрии и аккаунтов.
- **Как удалить программу?** Закройте DigUp Plus через иконку в трее и удалите распакованную папку. Если была включена опция **Open at login**, предварительно отключите её в **Settings → General**, чтобы убрать запись из ветки автозапуска в реестре Windows.
- **Участие в разработке**: Перед PR ознакомьтесь с [CONTRIBUTING.md](CONTRIBUTING.md). Изменения в логике ранжирования должны сопровождаться замерами «до/после» на наборе `evals/` через `digup eval`.
- **Лицензия и благодарности**: Проект распространяется под лицензией [MIT](LICENSE) (оригинальный копирайт © 2026 Abdur Rahim; доработки форка — Sucotasch). Использует [EmbeddingGemma 2](https://huggingface.co/google/embeddinggemma-2) (Apache 2.0), [llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT), [Tauri](https://tauri.app) (MIT/Apache 2.0), [PDFium](https://pdfium.googlesource.com/pdfium/) (BSD), [FFmpeg](https://ffmpeg.org) (LGPL), [stb](https://github.com/nothings/stb) (Public Domain) и [miniz](https://github.com/richgel999/miniz) (MIT). Полный текст уведомлений поставляется в `THIRD-PARTY-NOTICES.txt`.