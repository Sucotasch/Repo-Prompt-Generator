# AGENTS.md

## Architecture

npm workspaces monorepo. Business logic lives in shared packages; platform-specific shells are thin.

- **packages/core** — All AI services, RAG engine, templates, types, platform adapters. This is the single source of truth for app logic.
- **packages/ui** — Shared React UI (`App.tsx` ~2800 lines, the main component). Both apps render this.
- **apps/web** — Express proxy server + Vite SPA. Handles CORS for GitHub API and OpenAI-compatible endpoints via backend routes.
- **apps/desktop** — Tauri 2.0 (Rust backend + React frontend). Native file access, Ollama process management, and direct HTTP calls (no CORS).

Both `apps/web/src/main.tsx` and `apps/desktop/src/main.tsx` are identical: they import `<App />` from `@repo-prompt-generator/ui`.

Core's public surface is the barrel `packages/core/src/index.ts` — when adding a new service or template, re-export it there. A few utils (`semanticChunker.ts`, `zoneDetector.ts`, `jsonUtils.ts`) are imported by path and intentionally not in the barrel.

The UI shell (`App.tsx`) is a fixed three-region layout that never page-scrolls: a docked top task panel (source, template, instructions, status row), a left config sidebar and a right result pane, each with independent scroll containers. Don't reintroduce page-level scroll containers or render the result below the form. Generation history lives in `packages/core/src/services/historyCacheService.ts` — content in Cache Storage (`prompt-history-v1`), metadata index in localStorage (`prompt_history_index_v1`), capped at 20 entries; the last result is restored on startup.

Theming: `packages/ui/src/tailwind.css` defines semantic color tokens (`--app`, `--surface`, `--raised`, `--line`, `--ink`, `--brand`, warn/danger/ok families) with light values in `:root` and dark values under `html.theme-dark` plus `@media (prefers-color-scheme: dark) :root:not(.theme-light)`, exposed to Tailwind via `@theme inline`. The user picks system/light/dark via the toggle in the top panel; the choice persists in localStorage `app_theme` and is applied before first paint by an inline bootstrap script that must stay in **both** `apps/web/index.html` and `apps/desktop/index.html`. Do not use raw `slate-*`/`indigo-*`/`amber-*` classes or `dark:` variants in `App.tsx`; use the token utilities (`bg-surface`, `text-soft`, `border-line`, `bg-brand`, …). The generation status is a floating pill anchored to the header, not a reserved row.

## Dev commands

| Task | Command |
|------|---------|
| Web dev server (Express + Vite, port 3000) | `npm run dev` |
| Desktop dev (Tauri) | `npm run tauri dev -w apps/desktop` |
| Build all packages + web | `npm run build` |
| Build Tauri desktop installer | `npm run tauri build -w apps/desktop` |
| Lint (web only) | `npm run lint` (runs `tsc --noEmit` in web) |

`packages/core` and `packages/ui` have no build step — they are consumed as raw TS/TSX by Vite. Desktop lint is a no-op.

## Type checking

There is no root `tsconfig.json`. Each app has its own `tsconfig.json`:
- `apps/web/tsconfig.json`
- `apps/desktop/tsconfig.json`

Run type checks per-app via `npx tsc --noEmit` in the relevant `apps/` directory. The workspace lint script only covers `apps/web`.

## Platform adaptation

`packages/core/src/utils/tauriAdapter.ts` exposes `isTauri()` — checks for `window.__TAURI_INTERNALS__`. Use this (not feature detection or env vars) to branch platform behavior.

Key platform differences:
- **CORS**: Web routes all external API calls through Express (`apps/web/server.ts`). Desktop calls APIs directly from Rust via `ai_network_request` command.
- **File system**: Web uses browser File API / drag-and-drop. Desktop uses `@tauri-apps/plugin-fs` for native FS access.
- **Ollama management**: Desktop can start/stop Ollama as a native process via Rust (`invoke("start_ollama")`/`invoke("stop_ollama")`). Web requires user to run Ollama manually.
- **Embeddings**: Both platforms use Ollama for embeddings, but desktop routes through Rust (`invoke("ollama_embed")`) while web fetches directly.
- **Web → Windows porting journal**: `CHANGELOG_WEB_TO_WIN.md` (in Russian) tracks web-version changes that still need porting to the Tauri app. Read it before platform work. Note: web commits deliberately strip Tauri imports (see the 2026-03-17 entry) — when porting, skip those deletions; desktop keeps Tauri code.

## RAG engine

Custom hybrid search in `packages/core/src/services/ragService.ts`:
- BM25 + Cosine Similarity with Reciprocal Rank Fusion
- Embeddings via Ollama, LM Studio, or LlamaCpp (pass `engine` param: `"ollama" | "lmstudio" | "llamacpp"`)
- Semantic chunking via `packages/core/src/utils/semanticChunker.ts`
- Embedding cache in `packages/core/src/services/embeddingCacheService.ts` (IndexedDB/localStorage on web)
- Cache namespaced per repository; prunes unused caches after 5min grace period
- If query embedding fails, RRF weights fall back to 100% BM25 lexical search instead of erroring out

## AI providers

Managed through `packages/core/src/services/aiAdapter.ts` (`AIProvider = "gemini" | "custom"`):
- **Gemini**: `@google/genai` SDK, requires `GEMINI_API_KEY`
- **Ollama**: Local inference, used for query expansion and RAG embeddings (not a standalone "provider" — always available alongside Gemini or custom)
- **Custom (OpenAI-compatible)**: Any endpoint with `/v1/chat/completions` (LM Studio, local servers, etc.). Reasoning models are handled: `extractChoiceContent()` in `openaiCompatibleService.ts` falls back to `message.reasoning_content` (DeepSeek-R1/vLLM/OpenRouter) and strips `<think>...</think>` tags; `geminiService.ts` skips Gemini `part.thought` chunks when assembling output.

Note: Qwen provider support was removed. Use the custom OpenAI-compatible provider for Qwen endpoints.

## Templates

Template registry in `packages/core/src/templates/index.ts` currently wires 8 templates:
`default`, `audit`, `security`, `docs`, `integration`, `eli5`, `vibe`, `tutorial`

Each is a `TemplateDefinition` (in `types/template.ts`): `systemInstruction` (not `systemPrompt`), `deliverables`, `successMetrics`, `evidenceRequirements`, `defaultSearchQuery`, optional `tone`/`constraints`. Note: `architecture.ts` exists on disk but is **not** imported anywhere — dead file, don't assume the `architecture` template is selectable.

## Environment

- Copy `.env.example` to `.env.local` at project root
- `GEMINI_API_KEY` — required for Gemini; not needed for Ollama-only usage
- Desktop version reads env from Rust side; web version uses `dotenv`

## Gotchas

- **Stray root files** — `constants.ts` and `modelRegistry.ts` at the repo root are leftovers from the Qwen Code project (they import paths like `../core/contentGenerator.js` that don't exist here). `app/applet/test-cors.js` is a standalone CORS probe. Nothing imports them and they are in no build — leave them alone instead of "fixing" them.
- **`apps/desktop/net_debug/`** — standalone Rust crate (reqwest + tokio) for debugging HTTP requests. Not part of the Tauri app or any build; don't wire it into `src-tauri`.
- **Desktop build depends on the local, uncommitted icon set.** `apps/desktop/src-tauri/icons/*` were regenerated locally from untracked `apps/desktop/app-icon.png` (plus a one-line `lib.rs` fix: `text_async` → `text`); only this state was ever verified. The icon set committed on GitHub breaks `npm run tauri build -w apps/desktop`. Do not discard these working-tree changes (`git checkout --`, `git reset --hard`, dropping the stash) — doing so re-breaks the desktop build.
- **Synced with origin/main as of 2026-10-11** (`d3e06af`). The icon fix above and this file itself are still uncommitted working-tree state — the working desktop build exists only here. Commit them before any hard reset / checkout.
- **`Audit.md`** (Russian) — engineering audit with a decision registry from the 2026-09-04 review. Read it before proposing architecture changes; several ideas (e.g. server-side API-key isolation) were explicitly rejected there.
- **Tauri v2 command arguments are camelCase by default.** This codebase passes snake_case keys from JS (e.g. `gemini_key`, `timeout_secs`); any Rust command with multi-word params needs `#[tauri::command(rename_all = "snake_case")]`, otherwise Tauri silently drops the argument (no error — the param just arrives as `None`).
- `packages/core` depends on `@tauri-apps/*` packages. They resolve in desktop but may cause issues if you try to import core directly in a non-Tauri context without the adapter guards.
- The web server (`apps/web/server.ts`) loads `.env` via `dotenv/config` at startup. Changing env vars requires a server restart.
- RAG embedding cache is browser-limited (IndexedDB). Large repos (10k+ files) may hit storage quotas on web. Desktop TODO: migrate to native FS/SQLite.
- No test suite exists. No CI workflows. Type checking is the only automated verification.
- Local file filtering logic lives in `packages/core/src/services/localFileService.ts` — uses regex-based ignore/secret detection (`HARD_IGNORE_REGEX`, `SECRET_IGNORE_REGEX`), not a `.gitignore` parser.
