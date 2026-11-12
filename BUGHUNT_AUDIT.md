# Комплексный аудит и BugHunt кодовой базы (Full-Stack Web & Desktop Tauri)

**Проект:** Repo Prompt Generator (Monorepo: `apps/web`, `apps/desktop`, `packages/core`, `packages/ui`)  
**Дата аудита:** 2026-11-12  
**Режим проверки:** Статический сквозной анализ всех модулей (TypeScript / React / Express / Vite / Rust Tauri v2) с учетом ограничений Google AI Studio и ранее принятых решений из `Audit.md` (П.1–П.9).

---

## 1. Резюме и карта рисков

Анализ всей кодовой базы выявил **29 подтвержденных дефектов**, среди которых **6 критических** и **8 высокоприоритетных**. Примечательно, что наибольшая концентрация критических сбоев находится на стыке **Desktop (Tauri Rust ↔ TS)** и **Web-окружения (Vite / AI Studio iframe)**, а также в **RAG-конвейере**.

| Критичность | Кол-во | Ключевые области сбоев |
|---|---|---|
| **CRITICAL** | 6 | Нерабочий `set_app_config` в Tauri (`geminiKey` vs `gemini_key`), сломанный парсинг в `rewriteQueryWithGemini` (Tauri), игнорирование `branch` и фильтров в Rust `fetch_github_repo`, недостижимый `process.env.GEMINI_API_KEY` в Web, тихий откат `Custom Provider` на Gemini, полностью нерабочий `fetchFilesFromRepo` в Tauri Deep Analysis (`BUG-C6`) |
| **HIGH** | 8 | Неработающая кнопка `Cancel`, мертвый `Intent-Aware Reranking` из-за `(Part N)` и `BUGFIX` vs `BUG_HUNT`, падение `cosineSimilarity`, path-traversal в `/api/repo/files`, таймаут `/api/repo`, скрытое обрезание на 2000 символов, потеря `githubToken` в Deep Analysis, повторный `tools` на 2-м шаге |
| **MEDIUM** | 8 | Потеря `temperature` и keyless-серверов в OpenAI-прокси, сброс `localFiles` (`>1000`), `alert`/`confirm` в iframe AI Studio, порча `EmbeddingCache` при наборе URL, порт `3000` vs `5173` в Tauri, BM25/Chunker баги, наивный `.endsWith` в `localFileService` (`BUG-M7`), UX/Markdown-дефекты в `App.tsx` (`BUG-M8`) |
| **LOW / TECH DEBT** | 7 | Незарегистрированный `architectureTemplate`, мертвый код (`scan_local_repository`, `fetchedFilesDetails`, `open`), отладочный мусор, `ProcessRefreshKind::everything()` вместо `nothing()`, отсутствие `RepoInfo.branch` в Rust, несоответствие среза дерева (`500` vs `1000`), `.env.local` в корне для `SECRET_IGNORE` |

> **Совместимость с решениями `Audit.md`:**  
> Рекомендации ниже полностью уважают решения консилиума: клиентское использование ключа Gemini в AI Studio (П.1), разрешение приватных IP в OpenAI-прокси (П.2), последовательные эмбеддинги Ollama (П.4) и отложенный рефакторинг монолита `App.tsx` (П.9).

---

## 2. Критические баги (CRITICAL)

### [BUG-C1] Tauri `set_app_config`: UI-настройки `geminiApiKey` никогда не попадают в Rust, а при исправлении затрут env-ключ
* **Локация:** `apps/desktop/src-tauri/src/lib.rs:30-35` ↔ `packages/ui/src/App.tsx:335-342`
* **Причина:**
  1. В Tauri v2 макрос `#[tauri::command]` по умолчанию ожидает аргументы со стороны JS в **camelCase** (`geminiKey`), если явно не указано `rename_all = "snake_case"`.
  2. `App.tsx:338` передает `{ gemini_key: geminiApiKey, proxy: proxyAddress }`, а в `lib.rs:30` `#[tauri::command]` не имеет `rename_all = "snake_case"`. Так как `gemini_key` имеет тип `Option<String>`, Tauri не кидает ошибку — поле тихо десериализуется как `None`. Введенный в Desktop UI ключ Gemini **никогда не применяется**.
  3. **Вторичный эффект (ловушка при исправлении):** Если просто поправить имя поля на `geminiKey`, то при монтировании `App.tsx` (когда поле в UI пустое `""`, а ключ задан через переменную окружения `GEMINI_API_KEY`) `useEffect` вызовет `set_app_config({ geminiKey: "", ... })`, и строка `lib.rs:33` перезапишет ключ из `env` пустой строкой `""`!
  4. **Побочный дефект в `lib.rs:45-65`:** Для настройки прокси используется `std::env::set_var("HTTPS_PROXY", ...)` / `remove_var`, что меняет переменные окружения всего процесса (небезопасно в многопоточном Tokio runtime). В `Cargo.lock` используется `isahc 1.7.2`, который нативно поддерживает `.proxy(...)` на `HttpClientBuilder`.
* **Фикс (`apps/desktop/src-tauri/src/lib.rs` и `packages/ui/src/App.tsx`):**

```rust
// apps/desktop/src-tauri/src/lib.rs
use isahc::config::Configurable;

#[tauri::command]
async fn set_app_config(
    state: State<'_, AppState>,
    gemini_key: Option<String>,
    proxy: Option<String>,
) -> Result<(), String> {
    if let Some(key) = gemini_key {
        let trimmed = key.trim().to_string();
        let resolved = if trimmed.is_empty() {
            // Fallback на системную переменную, если пользователь очистил поле в UI
            std::env::var("GEMINI_API_KEY")
                .or_else(|_| std::env::var("VITE_GEMINI_API_KEY"))
                .unwrap_or_default()
                .trim()
                .to_string()
        } else {
            trimmed
        };
        *state.gemini_api_key.write().await = resolved;
    }

    let proxy_url = proxy.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let mut builder = isahc::HttpClient::builder().timeout(Duration::from_secs(3600));

    if let Some(url) = proxy_url {
        let proxy_uri = if url.starts_with("http://") || url.starts_with("https://") {
            url.to_string()
        } else {
            format!("http://{}", url)
        };
        let parsed: isahc::http::Uri = proxy_uri
            .parse()
            .map_err(|e| format!("Invalid proxy URL '{}': {}", proxy_uri, e))?;
        builder = builder.proxy(Some(parsed));
    }

    let client = builder
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
    *state.http_client.write().await = client;
    Ok(())
}
```
```ts
// packages/ui/src/App.tsx:337 (camelCase под контракт Tauri v2)
tauriInvoke("set_app_config", {
  geminiKey: geminiApiKey,
  proxy: proxyAddress,
}).catch(console.error);
```

---

### [BUG-C2] Tauri `rewriteQueryWithGemini`: 100% отказ Query Expansion и Intent Detection в Desktop-версии
* **Локация:** `apps/desktop/src-tauri/src/lib.rs:78-117` ↔ `packages/core/src/services/geminiService.ts:126-142`
* **Причина:**
  1. Rust-команда `call_gemini_secure` возвращает **сырой HTTP JSON-конверт Gemini REST API**: `{"candidates":[{"content":{"parts":[{"text":"{\"optimizedQuery\":...}"}]}}]}`.
  2. TypeScript-код `rewriteQueryWithGemini` передает этот конверт напрямую в `safeJsonParse<{optimizedQuery?, intent?}>(cleanText, ...)`.
  3. Парсер успешно парсит внешний объект `{ candidates: [...] }`, не находит в корне `optimizedQuery` и `intent`, и **всегда** откатывается к исходному `query` и `"GENERAL"`.
  4. Дополнительно, `call_gemini_secure` не передает `generationConfig.responseMimeType = "application/json"` и не отбрасывает `part.thought`.
* **Фикс (`apps/desktop/src-tauri/src/lib.rs` и `packages/core/src/services/geminiService.ts`):**

```rust
// apps/desktop/src-tauri/src/lib.rs
#[tauri::command(rename_all = "snake_case")]
async fn call_gemini_secure(
    state: State<'_, AppState>,
    prompt: String,
    model: Option<String>,
    response_mime_type: Option<String>,
) -> Result<String, String> {
    let key = state.gemini_api_key.read().await.clone();
    if key.is_empty() {
        return Err("Gemini API key is missing.".to_string());
    }

    let model_name = model.unwrap_or_else(|| "gemini-3-flash-preview".to_string());
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        model_name
    );

    let mut body = serde_json::json!({
        "contents": [{ "parts": [{ "text": prompt }] }]
    });
    if let Some(mime) = response_mime_type {
        body["generationConfig"] = serde_json::json!({ "responseMimeType": mime });
    }
    // ... отправка запроса (как сейчас) ...
    let envelope: serde_json::Value = serde_json::from_str(&res_text)
        .map_err(|e| format!("Invalid Gemini JSON response: {}", e))?;

    let parts = envelope["candidates"][0]["content"]["parts"]
        .as_array()
        .ok_or_else(|| "Gemini response missing candidate parts".to_string())?;

    let mut text = String::new();
    for part in parts {
        if part["thought"].as_bool() != Some(true) {
            if let Some(t) = part["text"].as_str() {
                text.push_str(t);
            }
        }
    }
    if text.trim().is_empty() {
        for part in parts {
            if let Some(t) = part["text"].as_str() {
                text.push_str(t);
            }
        }
    }
    Ok(text)
}
```
```ts
// packages/core/src/services/geminiService.ts:127
const responseText = await tauriInvoke<string>("call_gemini_secure", {
  prompt,
  model: "gemini-3-flash-preview",
  response_mime_type: "application/json",
});
```

---

### [BUG-C3] Tauri `fetch_github_repo`: игнорирование выбранной ветки (`branch`), отсутствие `SECRET_IGNORE`/`HARD_IGNORE` и DoS лимита GitHub
* **Локация:** `apps/desktop/src-tauri/src/lib.rs:260-428`
* **Причина:**
  1. В строках `293`, `326` и `391` запросы к `/readme` и `/contents/{file}` **не передают `?ref={default_branch}`**! Если пользователь указал URL ветки `https://github.com/owner/repo/tree/dev`, то `tree` берется из `dev`, а `README`, `package.json` и все исходники — из основной ветки `main` (или падают с 404).
  2. Не используется URL-кодирование (при том, что крейт `urlencoding = "2.1"` уже подключен в `Cargo.toml:35`, но нигде не вызывается) — ветки со слэшами и пути со спецсимволами (`#`, `?`, пробелы, `[id]`) ломаются.
  3. Строка `280` не проверяет `tree_res.status().is_success()` (ошибка 404/403 превращается в пустое дерево).
  4. В отличие от `apps/web/server.ts:89-130`, в `lib.rs:283-286` **полностью отсутствует фильтрация `HARD_IGNORE` (`node_modules`, `.git`, `dist`, `build`) и `SECRET_IGNORE` (`.env`, `.pem`, `.key`)**.
  5. Строка `383` разрешает до 200 параллельных запросов без проверки наличия `token` (в `server.ts:289` стоит `token ? 200 : 10`), что мгновенно сжигает лимит 60 req/hr без токена.
* **Фикс (`apps/desktop/src-tauri/src/lib.rs`):**

```rust
// Вспомогательная функция кодирования пути по сегментам
fn encode_github_path(path: &str) -> String {
    path.split('/')
        .map(|seg| urlencoding::encode(seg).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

// 1. Валидация статуса tree_res (после строки 280)
if !tree_res.status().is_success() {
    return Err(format!("Failed to fetch repository tree for branch '{}': {}", default_branch, tree_res.status()));
}

// 2. Фильтрация HARD_IGNORE и SECRET_IGNORE (строки 283-286)
let hard_ignore = ["venv", ".venv", "node_modules", ".git", "__pycache__", "dist", "build", "target"];
let secret_ignore = [".env", ".pem", ".key", ".cert", ".p12", "secrets.json", "credentials.json", "id_rsa"];

let mut tree_paths: Vec<String> = tree_json["tree"]
    .as_array()
    .map(|a| {
        a.iter()
            .filter(|i| i["type"] == "blob")
            .filter_map(|i| i["path"].as_str().map(str::to_string))
            .filter(|p| {
                let lower = p.to_lowercase();
                let is_hard = hard_ignore.iter().any(|ig| lower.starts_with(&format!("{}/", ig)) || lower.contains(&format!("/{}/", ig)));
                let is_secret = secret_ignore.iter().any(|sec| lower.ends_with(sec) || lower.starts_with(sec) || lower.contains(&format!("/{}", sec)));
                !is_hard && !is_secret
            })
            .collect()
    })
    .unwrap_or_default();

// 3. Передача ?ref= в readme, deps, source_files + лимит по токену
let encoded_branch = urlencoding::encode(&default_branch).into_owned();
let readme_url = format!("https://api.github.com/repos/{}/{}/readme?ref={}", owner, repo, encoded_branch);
// Для deps и source_files:
let file_url = format!(
    "https://api.github.com/repos/{}/{}/contents/{}?ref={}",
    owner, repo, encode_github_path(&file), encoded_branch
);
// Лимит как на сервере Web:
let abs_max = if token_arc.is_empty() { 10 } else { 200 };
let limit = max_files.unwrap_or(5).clamp(1, abs_max) as usize;
```

---

### [BUG-C4] Web-режим: `typeof process !== 'undefined'` делает `GEMINI_API_KEY` из Vite `define` полностью недостижимым в браузере
* **Локация:** `packages/core/src/services/geminiService.ts:145, 326` + `apps/web/vite.config.ts:11` + `apps/desktop/vite.config.ts:11` + `packages/ui/src/App.tsx:1762`
* **Причина:**
  1. В `vite.config.ts` настроено: `define: { "process.env.GEMINI_API_KEY": JSON.stringify(env.GEMINI_API_KEY) }`. Vite заменяет **только точное выражение** `process.env.GEMINI_API_KEY`, но **не определяет** глобальный объект `process`.
  2. В `geminiService.ts` написано: `(typeof process !== 'undefined' ? process.env.GEMINI_API_KEY : undefined)`.
  3. В браузере `typeof process` всегда равен `"undefined"`. Даже после подстановки Vite код превращается в `(typeof process !== 'undefined' ? "AIza..." : undefined)`, что в рантайме браузера **всегда возвращает `undefined`**!
  4. Более того, если `env.GEMINI_API_KEY` не задан, `JSON.stringify(undefined)` в `vite.config.ts` возвращает JS `undefined`, и Vite вообще не делает замену, а в `App.tsx:1762` поле ввода `Gemini API Key` скрыто под `{isTauri() && ...}`, поэтому в Web-версии пользователь даже не может ввести свой ключ вручную.
* **Фикс (`apps/web/vite.config.ts`, `apps/desktop/vite.config.ts`, `packages/core/src/services/geminiService.ts`):**

```ts
// apps/web/vite.config.ts и apps/desktop/vite.config.ts
define: {
  "process.env.GEMINI_API_KEY": JSON.stringify(env.GEMINI_API_KEY || ""),
},
```
```ts
// packages/core/src/services/geminiService.ts
function resolveGeminiApiKey(explicitKey?: string): string {
  if (explicitKey && explicitKey.trim()) return explicitKey.trim();
  try {
    // Vite заменит process.env.GEMINI_API_KEY на строковый литерал во время сборки/dev
    if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  } catch {
    // На случай среды без define и без Node process
  }
  return import.meta.env.VITE_GEMINI_API_KEY || "";
}
```
*(Опционально: разрешить ввод `geminiApiKey` в Web UI при отсутствии ключа в env).*

---

### [BUG-C5] `aiAdapter.ts`: Тихий откат `Custom Provider` на Gemini (утечка приватного кода при ошибке конфигурации)
* **Локация:** `packages/core/src/services/aiAdapter.ts:30-49, 84-124`
* **Причина:**
  Условие ветвления проверяет `if (provider === "custom" && options?.customBaseUrl && options?.customApiKey && options?.customModel)`. Если пользователь выбрал `Custom (OpenAI Compatible)` (например, локальный корпоративный vLLM без ключа API, или просто забыл указать `Model Name`), условие ложно, и `else` **молча отправляет всю кодовую базу в Google Gemini**!
* **Фикс (`packages/core/src/services/aiAdapter.ts`):**

```ts
if (provider === "custom") {
  if (!options?.customBaseUrl?.trim()) {
    throw new Error("Custom Provider selected, but Base URL is missing.");
  }
  if (!options?.customModel?.trim()) {
    throw new Error("Custom Provider selected, but Model Name is missing.");
  }
  const promptText = buildPromptText(
    repoData,
    taskInstruction,
    additionalContext,
    analyzeIssues,
    referenceRepoData,
    attachedDocs,
    fileTruncationLimit, // Также исправляет хардкод 0 (см. BUG-H5)
  );
  const text = await generate_final_prompt_with_openai_compatible(
    promptText,
    options.customBaseUrl.trim(),
    options.customApiKey?.trim() || "",
    options.customModel.trim(),
    options.temperature ?? 0.3,
  );
  return { text, modelVersion: `custom/${options.customModel.trim()}` };
}
```

---

### [BUG-C6] Tauri Deep Analysis: `fetchFilesFromRepo` всегда возвращает `[]` (несоответствие контракта `ai_network_request`)
* **Локация:** `packages/core/src/services/githubService.ts:122-146` ↔ `apps/desktop/src-tauri/src/lib.rs:646-685`
* **Причина:**
  1. Rust-команда `ai_network_request` возвращает HTTP-обертку `{ status: u16, text: string, headers: object }` (`lib.rs:679-684`), а не распарсенное тело ответа GitHub API.
  2. `githubService.ts:130` проверяет `if (response && response.content)` без проверки `response.status` и без вызова `JSON.parse(response.text)`. Так как `response.content` всегда `undefined`, дозапрос файлов (`request_additional_files`) в Desktop-версии **никогда не возвращает ни одного файла**.
  3. Дополнительно `atob(fileData.content)` падает в браузерном движке WebView при наличии символов перевода строки (`\n`), которые GitHub API всегда вставляет в base64-ответы.
* **Фикс (`packages/core/src/services/githubService.ts`):**
```ts
const encodedFile = sanitizeAndEncodeGitHubPath(file);
if (!encodedFile) continue;
const response = await tauriInvoke<{ status: number; text: string }>(
  "ai_network_request",
  { method: "GET", url: `https://api.github.com/repos/${owner}/${repo}/contents/${encodedFile}?ref=${encodedBranch}`, headers, body: null },
);
if (response && response.status >= 200 && response.status < 300 && response.text) {
  const fileData = JSON.parse(response.text);
  if (fileData && typeof fileData.content === "string") {
    const cleanBase64 = fileData.content.replace(/\s/g, "");
    const binaryString = atob(cleanBase64);
    const bytes = Uint8Array.from(binaryString, (c) => c.charCodeAt(0));
    let content = new TextDecoder("utf-8").decode(bytes);
    if (content.length > 50000) {
      content = content.substring(0, 50000) + "\n\n... [TRUNCATED: File exceeds 50KB limit. Showing only the top part.]";
    }
    fetchedFiles.push({ path: file, content });
  }
}
```

---

## 3. Высокоприоритетные баги (HIGH)

### [BUG-H1] Кнопка `Cancel` ничего не отменяет — фоновая генерация продолжает тратить токены и портит UI
* **Локация:** `packages/ui/src/App.tsx:208, 641-648, 677-678`
* **Причина:** `abortControllerRef.current = new AbortController()` создается, локальная переменная `const signal = ...` объявляется на строке 678, но `signal` **нигде не передается** в `fetchRepoData`, `performRAG`, `summarize_with_ollama`, `generatePrompt`, `rewriteQuery`, и `signal.aborted` нигде не проверяется. Если нажать `Cancel` и запустить новую генерацию, оба процесса работают параллельно и старый `finally` сбрасывает `loading = false` и перезаписывает `setPrompt` у нового запуска.
* **Фикс (`packages/ui/src/App.tsx`):**
  Добавить `const runIdRef = React.useRef(0)` + проверку `signal.aborted` / `runIdRef.current !== runId` между этапами и передать `signal` в `fetch`:

```ts
const runIdRef = React.useRef(0);

const cancelGeneration = () => {
  runIdRef.current += 1;
  if (abortControllerRef.current) {
    abortControllerRef.current.abort();
    abortControllerRef.current = null;
  }
  setLoading(false);
  setStatus("Generation cancelled by user.");
};

// В handleGenerate:
const myRunId = ++runIdRef.current;
const ensureActive = () => {
  if (signal.aborted || runIdRef.current !== myRunId) {
    throw new DOMException("Generation cancelled", "AbortError");
  }
};
// Вызывать ensureActive() после каждого await и в циклах суммаризации/RAG;
// В catch (err): if (err.name === "AbortError") return;
// В finally: if (runIdRef.current === myRunId) { setLoading(false); setStatus(""); }
```

---

### [BUG-H2] Intent-Aware Reranking в RAG частично мертв (`(Part N)` суффикс + `BUGFIX` vs `BUG_HUNT`)
* **Локация:** `packages/core/src/services/ragService.ts:180, 230-277` ↔ `packages/ui/src/App.tsx:910-919`
* **Причина:**
  1. На строке `ragService.ts:180` формируется `path: \`${file.path} (Part ${i + 1})\``.
  2. Далее на строках `240, 252-256, 266` проверяется `pathLower.endsWith(".md")`, `pathLower.endsWith(".tsx")`, `pathLower.endsWith(".sql")` и т.д. Так как `pathLower` всегда оканчивается на `" (part 1)"`, **все проверки `.endsWith(...)` всегда возвращают `false`**!
  3. На строке `App.tsx:911` для шаблонов `audit` и `security` выставляется `queryIntent = "BUGFIX"`, а `ragService.ts:230` проверяет `if (intent === "BUG_HUNT")`.
  4. Переключатель `useIntentReranking === false` игнорируется для стандартных шаблонов (`App.tsx:910-919`) и не передается в `performRAG`.
* **Фикс:**

```ts
// packages/core/src/services/ragService.ts
// Хранить rawPath отдельно или снимать суффикс перед проверкой:
const cleanPathLower = chunk.path.replace(/\s+\(Part \d+\)$/i, "").toLowerCase();
// Везде в блоках if (intent === ...) использовать cleanPathLower.endsWith(...)

// packages/ui/src/App.tsx:910-919
if (isStandardTemplateDefault && useIntentReranking) {
  if (templateMode === "audit" || templateMode === "security")
    queryIntent = "BUG_HUNT";
  else if (templateMode === "architecture" || templateMode === "integration")
    queryIntent = "ARCHITECTURE";
  else
    queryIntent = "GENERAL";
}
```

---

### [BUG-H3] Падение `performRAG` и отравление кеша при невалидном эмбеддинге Ollama + искажение RRF при отказе чанков
* **Локация:** `packages/core/src/services/ragService.ts:74-75, 108-119, 196-216, 298-299`
* **Причина:**
  1. В Web-ветке для `ollama` (`ragService.ts:74-75`) отсутствует проверка `if (!Array.isArray(data.embedding) || data.embedding.length === 0)`. Если пользователь указал не-embedding модель (или Ollama вернула ошибку в 200 JSON), `embedding` равен `undefined`, сохраняется в `Cache API` и затем вызывает падение `cosineSimilarity` (`Cannot read properties of undefined (reading 'length')`) **вне блока `try/catch`**.
  2. `cosineSimilarity(a, b)` не проверяет `a.length !== b.length` — при несовпадении размерностей в кеше дает `NaN`, ломая сортировку.
  3. В `ragService.ts:298-299`: если `queryEmbedding` получен, но ни один чанк не смог эмбеддиться (`hasChunkEmbeddings === false`), `vectorWeight` остается `0.5` и фиктивный `vectorRanked` с эвристиками по-прежнему на 50% искажает BM25.
* **Фикс (`packages/core/src/services/ragService.ts`):**

```ts
// 1. Проверка ответа Ollama Web (строка 75)
if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
  throw new Error("Invalid or empty embedding returned by Ollama (ensure an embedding model is selected)");
}
embedding = data.embedding;

// 2. Защита cosineSimilarity (строка 108)
function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

// 3. Проверка успешности чанк-эмбеддингов перед RRF (строка 298)
const hasVectorEmbeddings = Boolean(queryEmbedding) && allChunks.some((c) => Array.isArray(c.embedding) && c.embedding.length > 0);
const vectorWeight = hasVectorEmbeddings ? (1 - searchStrategy) : 0;
const lexicalWeight = hasVectorEmbeddings ? searchStrategy : 1;
```

---

### [BUG-H4] Security / Reliability: Path Traversal и некорректное кодирование путей в `/api/repo/files` и Tauri `fetchFilesFromRepo`
* **Локация:** `apps/web/server.ts:340-388` и `packages/core/src/services/githubService.ts:120-128`
* **Причина:** В режиме `Agentic RAG (Deep Analysis)` список `filePaths` приходит напрямую из `functionCall` ответа LLM (который потенциально подвержен prompt injection через чужой `README.md`). Строки `server.ts:365` и `githubService.ts:122` подставляют `file` в URL GitHub API `.../contents/${file}?ref=...` **без проверки на `..` и без сегментного `encodeURIComponent`**. Злоумышленник через `../../user/repos` может заставить сервер выполнить GET к другим эндпоинтам GitHub с токеном пользователя, а легитимные пути вроде `app/[id]/page.tsx` или `docs/C# Guide.md` падают с 404.
* **Фикс (`apps/web/server.ts` и `packages/core/src/services/githubService.ts`):**

```ts
function sanitizeAndEncodeGitHubPath(filePath: string): string | null {
  if (typeof filePath !== "string") return null;
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) {
    return null;
  }
  return segments.map(encodeURIComponent).join("/");
}
```

---

### [BUG-H5] Скрытое обрезание промпта на 2000 символов для Gemini и хардкод `0` для Custom Provider
* **Локация:** `packages/ui/src/App.tsx:149-153, 1129, 2349` и `packages/core/src/services/aiAdapter.ts:97`
* **Причина:**
  1. `fileTruncationLimit` по умолчанию равен `2000`, но поле настройки в UI скрыто под условием `(useOllama || useOllamaForFinal || useOllamaForQueryExpansion)` (`App.tsx:2349`). При этом `App.tsx:1129` передает `2000` в `generatePrompt` -> `geminiGenerate` -> `buildPromptText`. В итоге при работе с Gemini (1M контекст!) каждый исходный файл, README и `package.json` незаметно обрезаются на 2000 символах, а пользователь даже не видит эту настройку!
  2. Напротив, в `aiAdapter.ts:97` для `custom` провайдера передан жесткий `0` вместо `fileTruncationLimit`, что при работе с бесплатными провайдерами с малым контекстом (8k–32k) приводит к `Context length exceeded`.
* **Фикс:** Вынести настройку `File Truncation (Chars)` из блока локального движка в общие настройки генерации (или по умолчанию передавать `0` для облачных моделей, когда локальный движок отключен) и пробросить `fileTruncationLimit` в `aiAdapter.ts:97`.

---

### [BUG-H6] Tauri Deep Analysis (`Agentic RAG`) теряет `githubToken`
* **Локация:** `packages/core/src/services/geminiService.ts:252` (vs `347-354`)
* **Причина:** В Web-ветке `generateSystemPrompt` достает `githubToken` из `localStorage`, а в Tauri-ветке (строка 252) передает `undefined`. Дозапрос файлов в Desktop для приватных репозиториев (или без лимита 60 req/hr) всегда падает.
* **Фикс:** Передавать `githubToken` явным параметром через `options` в `aiAdapter.ts -> generateSystemPrompt` и использовать его в обеих ветках (Tauri и Web).

---

### [BUG-H7] `Agentic RAG`: Повторный вызов `request_additional_files` на 2-м шаге + риск `undefined` в `contents`
* **Локация:** `packages/core/src/services/geminiService.ts:285-289, 371, 387-393`
* **Причина:** После получения дозапрошенных файлов в 2-м запросе к Gemini снова передаются `tools` (`request_additional_files`), несмотря на текстовый запрет в промпте. Модель периодически снова вызывает инструмент и падает с ошибкой `"Model attempted to call function 'request_additional_files' again"`. Также на строке `371` `contents.push(response.candidates?.[0]?.content)` при отсутствии `content` пушит `undefined`.
* **Фикс (`packages/core/src/services/geminiService.ts`):**

```ts
// На 2-м шаге не передавать tools (или явно отключить вызов функций)
const candidateMsg = response.candidates?.[0]?.content;
if (!candidateMsg) {
  throw new Error("Missing candidate content for function response turn.");
}
contents.push(candidateMsg);
// ... push functionResponse ...
// В Tauri: tools: undefined; в Web: config: {} (без tools)
```

---

### [BUG-H8] Таймауты `/api/repo` при `maxFiles = 200` + отсутствие лимита размера файла в `processLocalFolder` и `/api/repo`
* **Локация:** `apps/web/server.ts:293-307`, `packages/core/src/services/githubService.ts:77`, `packages/core/src/services/localFileService.ts:104-109`
* **Причина:**
  1. `server.ts:293-307` качает до 200 файлов строго последовательно (`await fetch` внутри `for`). При 200 файлах × ~250–350 мс = 50–70 сек, что упирается в клиентский `AbortSignal.timeout(60000)` (`githubService.ts:77`).
  2. На серверных `fetch` нет собственного `AbortSignal.timeout`, а в `sourceFiles` (как в `/api/repo`, так и в `localFileService.ts:107`) нет ограничения размера на один файл: один минифицированный `bundle.js` на 10 MB переполнит память/контекст (при том что `/api/repo/files` ограничивает файлы до `50KB`).
* **Фикс (`apps/web/server.ts` и `localFileService.ts`):** Загружать файлы батчами по 8–10 с `Promise.all` и добавить единый порог усечения (например, `100KB` на файл, либо `fileTruncationLimit`).

---

## 4. Среднеприоритетные баги (MEDIUM)

### [BUG-M1] Ошибки OpenAI-прокси и `openaiCompatibleService.ts` (температура, trailing slash, keyless-серверы, `</think>`)
* **Локации:** `packages/core/src/services/openaiCompatibleService.ts`, `apps/web/server.ts:391-442`
* **Дефекты:**
  1. В Web-прокси `/api/openai-compatible/chat` (`openaiCompatibleService.ts:214-217`, `362-368`) и локальном `rewriteQueryWithOpenAICompatible` (`327-333`) теряется параметр `temperature`.
  2. `server.ts:394, 418` возвращает `400 Bad Request`, если `apiKey` пустой — это ломает локальные/интранет-серверы (vLLM, OpenGate, LM Studio), не требующие авторизации.
  3. `server.ts:408, 438` отправляет JSON-ответ через `res.status(...).send(text)` без `Content-Type: application/json`, и не ставит `AbortSignal.timeout` на `fetch`.
  4. `openaiCompatibleService.ts` (`12, 49, 150, 186, 272, 321`) и `ollamaService.ts` (`10, 24, 58, 131, 183`) и `lib.rs` (`505, 519, 556, 606`) не обрезают завершающий `/` в `baseURL`/`url` -> двойные слэши `//models`, `//api/tags`.
  5. `extractChoiceContent` (`openaiCompatibleService.ts:130-135`) не обрабатывает случай, когда шаблон инференса подставил `<think>` на стороне сервера, и модель вернула текст, заканчивающийся на `</think>\nОтвет` без открывающего `<think>`.
* **Фикс `extractChoiceContent`:**
```ts
if (text.includes("<think>")) {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (stripped.length > 0) text = stripped;
} else if (text.includes("</think>")) {
  const afterThink = text.split("</think>").pop()?.trim();
  if (afterThink) text = afterThink;
}
```
* **Фикс `server.ts` (без блокировки приватных IP согласно `Audit.md` П.2):**
```ts
if (!baseUrl || !payload) {
  return res.status(400).json({ error: "baseUrl and payload are required" });
}
const headers: Record<string, string> = {
  "Content-Type": "application/json",
  "HTTP-Referer": "https://ais-dev.run.app",
  "X-Title": "AI Studio Applet",
  "User-Agent": "AI-Studio-Applet/1.0",
};
if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
// fetch(..., { signal: AbortSignal.timeout(120000) })
// res.status(response.status).type(response.headers.get("content-type") || "application/json").send(text);
```

---

### [BUG-M2] `window.alert` и `window.confirm` в `App.tsx` нарушают ограничения iframe Google AI Studio
* **Локация:** `packages/ui/src/App.tsx:388, 398, 434, 436, 439, 478, 570`
* **Причина:** В sandbox-iframe Google AI Studio нативные диалоги `alert()` и `confirm()` блокируются политикой браузера. Удаление кастомного шаблона (`handleDeleteTemplate`), ошибки импорта/экспорта и проверка размера файла (`>5MB`) либо молча не срабатывают, либо ломают UX.
* **Фикс:** Заменить на inline-состояние подтверждения в UI (`confirmDeleteId`) и вывод уведомлений через `setError(...)` / `setStatus(...)`.

---

### [BUG-M3] `App.tsx:711`: Сброс `localFiles` в `null` после первой генерации для большинства реальных проектов
* **Локация:** `packages/ui/src/App.tsx:711-716`
* **Причина:** Браузерный `<input type="file" webkitdirectory="">` помещает в `FileList` **все** файлы папки, включая `node_modules` и `.git`. Для почти любого проекта `localFiles.length > 1000`. После первой генерации строка `712` выполняет `setLocalFiles(null)`, из-за чего кнопка `Generate Prompt` мгновенно становится `disabled` (`!localFiles || localFiles.length === 0`), не давая перегенерировать промпт с другим шаблоном.
* **Фикс:** Убрать `setLocalFiles(null)` (в JS `FileList` хранит лишь легковесные ссылки-дескрипторы на файлы, а не их содержимое в RAM; чтение происходит только для выбранных `limit <= 200` файлов). В Desktop же целесообразно задействовать существующую Rust-команду `scan_local_repository`.

---

### [BUG-M4] Спам `pruneUnusedCaches` на каждое нажатие клавиши + путаница namespace в `Local` режиме
* **Локация:** `packages/ui/src/App.tsx:249-270, 931, 945, 1149`
* **Причина:**
  1. `useEffect(..., [url, templateMode, referenceUrl, useReferenceRepo])` запускает `EmbeddingCacheService.pruneUnusedCaches` при каждом вводе символа в поле `URL`, засоряя `localStorage["embedding_cache_activity"]` фейковыми хешами от недописанных URL.
  2. При `inputMode === "local"` в `performRAG` и в метаданные промпта передается `url` от вкладки GitHub (либо `""`, из-за чего кэш попадает в `"default"`, который затем удаляется при переключении, так как `activeRepos.filter(Boolean)` отбрасывает `""`).
  3. На строке `931` проверка `!lastOptimizedQuery` читает устаревшее значение из замыкания React до завершения `setLastOptimizedQuery(null)` со строки `684`.
* **Фикс:** Вызывать `pruneUnusedCaches` только внутри `handleGenerate` с реальным идентификатором репозитория (`inputMode === "local" ? \`local://${repoData.info.repo}\` : url`), а `lastOptimizedQuery` обновлять через локальную переменную `let currentOptimizedQueryInfo = null`.

---

### [BUG-M5] Несовпадение порта Dev-сервера в Desktop Tauri (`5173` vs `3000`) и устаревшие метаданные Desktop
* **Локации:** `apps/desktop/src-tauri/tauri.conf.json:8-10`, `apps/desktop/vite.config.ts`, `apps/desktop/index.html:6`, `apps/desktop/metadata.json:2-3`
* **Причина:**
  1. `tauri.conf.json` ожидает `devUrl: "http://localhost:3000"` и запускает `beforeDevCommand: "npm run dev"` (`vite`), но в `apps/desktop/vite.config.ts` не задан `server.port = 3000` (Vite стартует на `5173`). Команда `tauri dev` в `apps/desktop` зависнет на ожидании порта 3000.
  2. В `apps/desktop/index.html` и `apps/desktop/metadata.json` остались старые заглушки (`My Google AI Studio App` / `Gemini Prompt Generator`), которые не были обновлены при ребрендинге Web-версии.
* **Фикс:** Добавить `port: 3000` в `apps/desktop/vite.config.ts` и синхронизировать `apps/desktop/index.html` и `apps/desktop/metadata.json` с `Repo Prompt Generator`.

---

### [BUG-M6] Проблемы качества поиска и чанкинга: BM25 ASCII-only / CamelCase, CRLF в `SemanticChunker` и недостижимые расширения в `zoneDetector`
* **Локации:** `packages/core/src/utils/hybridSearch.ts:54-59`, `packages/core/src/utils/semanticChunker.ts:31, 38`, `packages/core/src/services/localFileService.ts:20-34`, `apps/web/server.ts:183-197`, `packages/core/src/utils/zoneDetector.ts:29-43`
* **Дефекты:**
  1. `BM25.tokenize` делит по `/[^a-z0-9_]+/i`: кириллические запросы без AI Query Expansion дают пустой массив токенов (нули по всем файлам), а `camelCase`-идентификаторы (`fetchRepoData`) не бьются на составные слова (`fetch`, `repo`, `data`).
  2. `SemanticChunker` делит по `\n\n`, что не срабатывает на Windows-файлах с переносами `\r\n\r\n`, а `options.overlapTokens || 50` не позволяет передать `0` (`??`).
  3. `zoneDetector.ts` мапит `.vue`, `.svelte`, `.sql`, `.prisma`, `.css`, `.scss`, `.html`, но ни `server.ts`, ни `lib.rs`, ни `localFileService.ts` не включают их в `sourceExtensions`.
* **Фикс `hybridSearch.ts` & `semanticChunker.ts`:**
```ts
// hybridSearch.ts: разбиение camelCase + поддержка Unicode букв/цифр
private tokenize(text: string): string[] {
  const expanded = text.replace(/([a-z])([A-Z])/g, "$1 $2");
  return expanded
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1);
}

// semanticChunker.ts: нормализация CRLF и nullish coalescing
const overlapChars = (options.overlapTokens ?? 50) * this.CHARS_PER_TOKEN;
const normalized = text.replace(/\r\n/g, "\n");
```

---

### [BUG-M7] `localFileService.ts`: Наивный поиск `README.md` и файлов зависимостей через `.endsWith()`
* **Локация:** `packages/core/src/services/localFileService.ts:66-88`
* **Причина:** Проверка `.endsWith("package.json")` и `.endsWith("readme.md")` сопоставляет произвольные вложенные или суффиксные файлы (`apps/sub/package.json`, `mock_package.json`, `old_readme.md`) вместо корневых/наименее вложенных файлов репозитория.
* **Фикс (`packages/core/src/services/localFileService.ts`):** Выбирать файлы с точным совпадением имени (`(^|\/)package\.json$` и `(^|\/)readme\.md$`) с наименьшей глубиной вложенности (предпочитая корень проекта).

---

### [BUG-M8] UX и Markdown-дефекты в `App.tsx` (экранирование бэктиков, хардкод `"Ollama"`, санитизация имени файла)
* **Локации:** `packages/ui/src/App.tsx:1033, 1172, 1204-1222, 1234, 1334, 1988-2008` и `packages/core/src/services/geminiService.ts:431`
* **Дефекты:**
  1. Блоки `Task Instructions` и `Additional Context` (`App.tsx:1204-1222`) оборачиваются в ```` ```text ```` — если внутри есть тройные бэктики кода, разметка Markdown ломается. Нужно динамическое ограждение (4+ бэктиков ```` ````text ```` или длиннее максимальной последовательности `` ` `` в тексте).
  2. На строках `App.tsx:1033, 1172` и `geminiService.ts:431` захардкожено `"Ollama"` в статусах и метаданных даже при выборе `lmstudio` или `llamacpp`.
  3. На строке `App.tsx:1234` `projectName` подставляется в имя `.md`-файла без санитизации запрещенных символов Windows (`<>:"/\|?*`), а на строке `1334` `localFiles[0].webkitRelativePath.split("/")[0]` не имеет fallback при пустом `webkitRelativePath`.
  4. Чекбокс `isDeepAnalysis` (`App.tsx:2007`) визуально активен даже при включенном `useOllamaForFinal`, хотя ветка локальной финальной генерации его игнорирует.

---

## 5. Низкий приоритет и технический долг (LOW)

1. **Потерянный шаблон `architectureTemplate`** (`packages/core/src/templates/architecture.ts`): полностью написан, но не импортирован в `packages/core/src/templates/index.ts`, из-за чего недоступен в UI.
2. **Мертвый код и лишние зависимости:**
   * `apps/desktop/src-tauri/src/lib.rs:159` (`scan_local_repository`) — не вызывается в TS.
   * `packages/ui/src/App.tsx:47` (`open` из `@tauri-apps/plugin-shell`) — не используется; `@tauri-apps/plugin-shell` также лишний в корневом `package.json:17`.
   * `packages/ui/src/App.tsx:1054, 1143, 1182` (`fetchedFilesDetails`) — поле описано в `aiAdapter.ts:80` и рендерится в `App.tsx`, но никогда не возвращается из `geminiService.ts`.
   * `apps/web/server.ts:4` — неиспользуемый импорт `GoogleGenAI`.
3. **Утечка отладочных артефактов в репозиторий:** в `apps/desktop/` находятся временные скрипты (`check_syntax.py`, `count_tokens.py`, `debug_net.rs`, `find_parens.py`, `find_quotes.py`, `net_debug/`), `apps/desktop/src-tauri/2` и `app/applet/test-cors.js` в корне.
4. **Недостатки `lib.rs` и анализа графа/URL:**
   * `start_ollama` (`lib.rs:458`) не жнет дочерний `Child` (на macOS/Linux при завершении остается zombie-процесс до закрытия Tauri).
   * `is_ollama_running` (`lib.rs:434`), `stop_ollama` (`481`) и `RunEvent::Exit` (`776`) используют `ProcessRefreshKind::everything()` вместо `ProcessRefreshKind::nothing()` (доступно в `sysinfo 0.33.1`).
   * `RepoInfo` в `lib.rs:205` не содержит поле `branch` и перезаписывает `default_branch` выбранной веткой.
   * `codeGraph.ts:31` не резолвит относительные пути (`./utils` из разных папок схлопываются в один узел `"utils"`).
   * `githubService.ts:46-48` при URL на подпапку (`.../tree/main/src/app`) считает `"main/src/app"` именем ветки.
5. **Несогласованности контекста и фильтрации:**
   * `geminiService.ts:37, 59` ограничивает `tree.slice(0, 500)`, тогда как бэкенд ставит `isTruncated` при `> 1000` элементах.
   * `server.ts:126` `SECRET_IGNORE` не отлавливает `.env.local` в корне репозитория (`path.endsWith(".env")` не срабатывает для `.env.local` без `/`).

---

## 6. Поэтапный план исправлений (Remediation Roadmap)

| Этап | Фокус | Затрагиваемые файлы | Критерий приемки |
|---|---|---|---|
| **Этап 1: Tauri Desktop Criticals & Config** | Ключ Gemini (`geminiKey` + env fallback), прокси через `isahc::builder().proxy(...)`, `call_gemini_secure` парсер, `fetch_github_repo` (`?ref=`, `RepoInfo.branch`, `urlencoding`, фильтры, лимиты), фикс `fetchFilesFromRepo` в Tauri (`BUG-C6`), `githubToken` + Turn-2 `tools` в Deep Analysis, `vite.config.ts` порт `3000` и метаданные Desktop | `apps/desktop/src-tauri/src/lib.rs`, `packages/core/src/services/githubService.ts`, `geminiService.ts`, `aiAdapter.ts`, `apps/desktop/vite.config.ts`, `index.html`, `metadata.json`, `packages/ui/src/App.tsx` | Desktop корректно принимает ключ из UI/env, работают Query Expansion, Deep Analysis и ветки GitHub, стартует `tauri dev` |
| **Этап 2: Web / AI Core / Security** | Фикс `process.env.GEMINI_API_KEY` в Web Vite, запрет тихого отката Custom -> Gemini (`BUG-C5`), `temperature`, keyless, `Content-Type` и `</think>` в OpenAI-прокси, санитизация `filePaths` и корневых `.env.*` в `server.ts`, батчинг `/api/repo` + таймауты, `fileTruncationLimit` | `apps/web/vite.config.ts`, `apps/web/server.ts`, `packages/core/src/services/aiAdapter.ts`, `openaiCompatibleService.ts`, `ollamaService.ts` | Gemini работает в Web через env; Custom не сливает код в Gemini; нет path-traversal; 200 файлов грузятся < 10с |
| **Этап 3: RAG, Search & File Scanning** | Фикс `(Part N)` в intent-reranking, `BUG_HUNT` vs `BUGFIX`, защита `cosineSimilarity` и кеша, CRLF + Unicode/camelCase BM25, фикс `.endsWith` в `localFileService` (`BUG-M7`), относительные импорты в `codeGraph.ts`, регистрация `architectureTemplate` | `packages/core/src/services/ragService.ts`, `localFileService.ts`, `packages/core/src/utils/hybridSearch.ts`, `semanticChunker.ts`, `codeGraph.ts`, `packages/core/src/templates/index.ts`, `packages/ui/src/App.tsx` | Intent-reranking реально повышает целевые файлы; кириллица и Windows-файлы индексируются без сбоев |
| **Этап 4: UI/UX, Cancel & Cleanup** | Рабочий `Cancel` (`runIdRef` + `AbortSignal`), замена `alert`/`confirm`, удаление сброса `localFiles`, фикс `pruneUnusedCaches` / `lastOptimizedQuery` / 4-бэктиков / хардкода `"Ollama"`, видимость `fileTruncationLimit`, уборка отладочных файлов и мертвого кода | `packages/ui/src/App.tsx`, `packages/core/src/services/geminiService.ts`, `apps/web/server.ts`, `package.json`, удаление `test-cors.js` и скриптов в `apps/desktop/` | Отмена прерывает цепочку немедленно; нет заблокированных диалогов в iframe AI Studio; чистая сборка `npm run build` и `npm run lint` |
