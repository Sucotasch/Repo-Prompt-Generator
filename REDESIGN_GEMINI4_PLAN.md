# Комплексный технический план: Редизайн UI (Web & Desktop), миграция на Gemini 4 и исправление Agentic RAG

**Статус:** На согласовании (изменения в код ещё не вносились)  
**База проверки:** Фактический анализ кода (`apps/web`, `apps/desktop`, `packages/core`, `packages/ui`), `Audit.md`, `BUGHUNT_AUDIT.md`, `metadata.json` и актуальных SDK-спецификаций `@google/genai@3.3.0`.

---

## 1. Результаты аудита текущих проблем (без допущений)

### 1.1. Модели Google Gemini и SDK
1. **Устаревшие зашитые модели (`gemini-3-*`):**
   - `packages/core/src/services/geminiService.ts:156, 176` — `rewriteQueryWithGemini` жёстко вызывает `"gemini-3-flash-preview"`.
   - `packages/core/src/services/geminiService.ts:236` — `generateSystemPrompt` жёстко вызывает `"gemini-3.1-pro-preview"`.
   - `apps/desktop/src-tauri/src/lib.rs:93` — `call_gemini_secure` по умолчанию использует `"gemini-3-flash-preview"`.
   - `apps/desktop/src-tauri/src/lib.rs:167` — `call_gemini_advanced` по умолчанию использует `"gemini-3.1-pro-preview"`.
   - В UI (`packages/ui/src/App.tsx`) полностью отсутствует выбор модели Gemini и уровня рассуждений (`thinkingLevel`).
2. **Устаревший SDK `@google/genai`:**
   - В `packages/core/package.json:11`, `apps/web/package.json:17`, `apps/desktop/package.json:16` указано `"^1.29.0"`, в `node_modules` установлена `1.42.0`.
   - По спецификации `@google/genai`: поддержка семейства Gemini 4 (`gemini-4-hydrogen`, `gemini-4-argon`, `gemini-4-carbon`) требует `>= 2.29.1`, а `ThinkingLevel.XHIGH` (для `gemini-4-hydrogen`) требует **`>= 3.3.0`** (актуальная версия в npm — `3.3.0`).
3. **Несовместимые параметры и архитектура ключа для Gemini 4:**
   - В `gemini-4-hydrogen`, `gemini-4-argon`, `gemini-4-carbon` **запрещены** `temperature`, `topP`, `topK`, `candidateCount`, `thinkingBudget` и `ThinkingLevel.MINIMAL` — передача любого из них возвращает `400 INVALID_ARGUMENT`.
   - В текущем UI (`App.tsx:2073`) слайдер `Temperature` отображается и при выборе `aiProvider === "gemini"`, что вводит пользователя в заблуждение. Управление глубиной анализа в Gemini 4 должно идти исключительно через `thinkingConfig: { thinkingLevel }` (`LOW` | `MEDIUM` | `HIGH` | `XHIGH`, где `XHIGH` поддерживается только в `gemini-4-hydrogen`).
   - В `apps/web/vite.config.ts:11` и `apps/desktop/vite.config.ts:11` выполняется `"process.env.GEMINI_API_KEY": JSON.stringify(env.GEMINI_API_KEY || "")`, что в Web-сборке встраивает серверный ключ из `.env` в клиентский JS-бандл. Для Web-версии правильнее проксировать Gemini через Express (`/api/gemini/*` с `User-Agent: "aistudio-build"` и `GEMINI_API_KEY` только на сервере, сохраняя опциональный BYOK-ключ из UI только если он явно введён пользователем, согласно балансу `Audit.md П.1` и требований AI Studio), а в Desktop (Tauri) — продолжать использовать нативный Rust (`call_gemini_secure` / `call_gemini_advanced`) с ОС-переменной `GEMINI_API_KEY` и/или локальным ключом пользователя и прокси.
   - Примечание по платным моделям: `gemini-4-hydrogen` работает на стандартном ключе (default), а `gemini-4-argon` и `gemini-4-carbon` требуют платного тарифа API (в AI Studio при добавлении платных моделей потребуется подтверждение через `show_aistudio_ui` с `ui_type: "paid_model_flow"`).

### 1.2. Протокол Agentic RAG (Deep Analysis) — выявленные дефекты
При многоходовом tool calling с Gemini 3/4 текущий код в `geminiService.ts` и `lib.rs` содержит 7 системных ошибок:
1. **Отсутствует `functionResponse.id` (`geminiService.ts:325–329, 436–440`):** передаётся только `{ name, response }`, но игнорируется `call.id`. Протокол Gemini 3/4 сопоставляет ответы с вызовами по `id` (особенно при нескольких вызовах).
2. **Падение с HTTP `400` при параллельных tool calls (`geminiService.ts:278, 394`):** код берёт только первый вызов (`parts.find(...)` в Tauri и `response.functionCalls[0]` в Web). Если модель вернёт 2+ вызова `request_additional_files` за один ход, а клиент отправит только 1 `functionResponse`, Gemini API отклонит следующий ход с ошибкой несоответствия числа `functionCall` и `functionResponse`.
3. **Одноразовый костыль вместо реального цикла и подмешивание текста в `functionResponse` (`geminiService.ts:280–342, 393–455`):**
   - Сейчас жёстко зашит ровно 1 раунд, после чего на Turn 2 передаётся `tools: undefined`, а к `functionResponse` доклеивается `{ text: "CRITICAL INSTRUCTION... Do NOT request any more files" }`.
   - При этом если история уже содержит `functionCall`/`functionResponse`, убирать `tools` полностью менее предсказуемо, чем оставлять `tools` и явно передавать `toolConfig: { functionCallingConfig: { mode: "NONE" } }` на финальном шаге синтеза.
   - Ограничение 1 шагом не даёт модели дочитать импортируемые файлы, обнаруженные на первом шаге, а смешивание `{ functionResponse }` и императивного `{ text }` в одном `user`-сообщении снижает точность ответа.
4. **Слепой спот `call_gemini_advanced` в Tauri Rust (`apps/desktop/src-tauri/src/lib.rs:160–196`):**
   - Нет `urlencoding::encode(&model_name)` в URL (строка 168, в отличие от `call_gemini_secure` на строке 96).
   - Нет `#[tauri::command(rename_all = "snake_case")]` (в отличие от `call_gemini_secure` на строке 78) — критично при добавлении новых полей конфигурации.
   - Нет поддержки `generationConfig` (невозможно передать `thinkingConfig: { thinkingLevel }`), `toolConfig` (невозможно задать `mode: "NONE"`/`"AUTO"`) и `systemInstruction`.
   - Нет проверки `promptFeedback.blockReason` при пустом `candidates`.
5. **Непрозрачное обрезание списка файлов (`geminiService.ts:253–257`, `githubService.ts:156`, `server.ts:457`):**
   - Бэкенд молча режет массив `filePaths.slice(0, 3)`, а при ошибке загрузки файла молча пропускает его. В итоге модель считает, что файл пуст или отсутствует в репозитории, а не была превышена квота за один вызов.
6. **Проглатывание ошибок как «успешного промпта» (`geminiService.ts:375, 488`) + разрывы `AbortSignal` (`githubService.ts:156, 200`, `geminiService.ts:410`):**
   - В `catch (e)` возвращается строка `finalPrompt = "Error: ..."`, которая затем в `App.tsx` заворачивается в шапку `Prompt Generation Metadata` как валидный результат, а не попадает в красный баннер ошибок `error`.
   - В Web-ветке `geminiService.ts:410` после `await fetchSpecificFiles(...)` нет проверки `if (signal?.aborted)`. В `githubService.ts:200` `fetchFilesFromRepo` использует `AbortSignal.timeout(30000)` без объединения с внешним `signal`, а Tauri-ветка (`line 156`) не проверяет `signal?.aborted` в цикле загрузки файлов.
7. **Дублирование логики и отравление кэша `rag_opt_*` (`App.tsx:934`, `embeddingCacheService.ts:161`):**
   - Tauri и Web ветки в `generateSystemPrompt` (`lines 267–490`) дублируют 220 строк практически идентичного кода.
   - При сбое или невалидном JSON `rewriteQueryWithGemini` возвращает исходный запрос как фоллбэк без флага ошибки, и `App.tsx:934` **кэширует этот фоллбэк в `localStorage["rag_opt_..."]`**, блокируя реальную оптимизацию при последующих запусках.
   - `EmbeddingCacheService.clearCache()` очищает `caches`, но не удаляет `localStorage["embedding_cache_activity"]`.

### 1.3. UI/UX (Web & Desktop) и скрытая ловушка Tauri
1. **Монолит и 4+ экрана прокрутки (`packages/ui/src/App.tsx`, 2874 строки):**
   - Форма выстроена в одну вертикальную колонну `max-w-4xl` (`1338–2676`), из-за чего `AI Provider`, `RAG`, `Advanced RAG Settings` (`2367`) и кнопка `Test Connection` (`2558`) оказываются на 3–4 экране прокрутки.
   - Фиксированная нижняя панель (`fixed bottom-0`) перекрывает контент и конфликтует с принципом компактного десктопного/веб workspace.
2. **Окно Desktop по умолчанию (`apps/desktop/src-tauri/tauri.conf.json:16–17`):**
   - Размер окна при старте `800x600`, что слишком тесно для 2-колоночного интерфейса. При увеличении дефолта до `1280x840` (`minWidth: 800, minHeight: 600`) приложение должно идеально выглядеть и на `1440px`, и при сжатии до `800px`.
3. **Нарушения чистоты дизайна (`frontend-design/SKILL.md` & `3_saas_dashboard.md`):**
   - Статичные пилюли/капсулы в шапке результата (`Model: ...`, `RAG: ...`, `Tokens x3`, счётчики), толстая левая граница `border-l-2 border-indigo-100` (`App.tsx:2174`), вложенные карточки (`bg-white -> bg-slate-50 -> bg-indigo-50/50`), `animate-pulse` на статусе (`line 2753`), дефолтный системный шрифт без типографической пары (`Plus Jakarta Sans` + `JetBrains Mono`).
4. **Критическая находка при проверке Desktop Local Folder (`lib.rs:199–241`):**
   - Команда `scan_local_repository` в Rust сейчас не фильтрует секреты (`.env*`, `.pem`, `.key`, `secrets.json`), не проверяет белый список `sourceExtensions`, не строит `RepoData` (`tree`, `readme`, `dependencies`, `sourceFiles` с оценкой важности) и не имеет лимита количества файлов. Если при редизайне подключить нативный диалог Tauri напрямую к ней без доработки, вернётся утечка секретов и риск OOM.

---

## 2. Конкретные технические решения

### 2.1. Единый реестр моделей Gemini 4 и `ThinkingLevel` (`packages/core/src/config/geminiModels.ts`)
Вынести конфигурацию моделей в единый источник правды (заменив все зашитые строки в `geminiService.ts`, `lib.rs` и UI):

```ts
export type GeminiModelId =
  | "gemini-4-hydrogen"
  | "gemini-4-argon"
  | "gemini-4-carbon";

export type GeminiThinkingLevel = "LOW" | "MEDIUM" | "HIGH" | "XHIGH";

export interface GeminiModelSpec {
  id: GeminiModelId;
  label: string;
  description: string;
  requiresPaidKey: boolean;
  defaultThinkingLevel: GeminiThinkingLevel;
  supportedThinkingLevels: readonly GeminiThinkingLevel[];
}

export const DEFAULT_GEMINI_MODEL: GeminiModelId = "gemini-4-hydrogen";

export const GEMINI_MODELS: Record<GeminiModelId, GeminiModelSpec> = {
  "gemini-4-hydrogen": {
    id: "gemini-4-hydrogen",
    label: "Gemini 4 Hydrogen",
    description: "Fast, versatile default & deep agentic workflows",
    requiresPaidKey: false,
    defaultThinkingLevel: "HIGH",
    supportedThinkingLevels: ["LOW", "MEDIUM", "HIGH", "XHIGH"],
  },
  "gemini-4-argon": {
    id: "gemini-4-argon",
    label: "Gemini 4 Argon",
    description: "Complex coding, STEM, and multi-module synthesis",
    requiresPaidKey: true,
    defaultThinkingLevel: "MEDIUM",
    supportedThinkingLevels: ["LOW", "MEDIUM", "HIGH"],
  },
  "gemini-4-carbon": {
    id: "gemini-4-carbon",
    label: "Gemini 4 Carbon",
    description: "Deep architectural, root-cause, and security reasoning",
    requiresPaidKey: true,
    defaultThinkingLevel: "MEDIUM",
    supportedThinkingLevels: ["LOW", "MEDIUM", "HIGH"],
  },
};

export function normalizeThinkingLevel(
  model: GeminiModelId,
  requested?: GeminiThinkingLevel,
): GeminiThinkingLevel {
  const spec = GEMINI_MODELS[model] ?? GEMINI_MODELS[DEFAULT_GEMINI_MODEL];
  if (requested && spec.supportedThinkingLevels.includes(requested)) {
    return requested;
  }
  if (requested === "XHIGH") {
    return "HIGH";
  }
  return spec.defaultThinkingLevel;
}
```

**Правила вызова Gemini 4:**
- `rewriteQueryWithGemini` использует `gemini-4-hydrogen` с `thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }` (минимальная задержка для JSON-роутинга, запрещённые параметры `temperature`/`topP`/`topK` не передаются).
- При сохранении старого `gemini_app_settings` из `localStorage` любые отсутствующие/устаревшие `geminiModel` мигрируют на `"gemini-4-hydrogen"`.

### 2.2. Исправление протокола Agentic RAG (единый transport-agnostic цикл)
Вынести транспорт (Web `/api/gemini/generate` или SDK vs Tauri `call_gemini_advanced`) в единую обёртку `invokeGeminiModel(...)`, а логику многоходового агента сделать единой:

```ts
const MAX_TOOL_ROUNDS = 3;
const MAX_FILES_PER_CALL = 5;
const alreadyFetched = new Map<string, string>(); // dedup по пути

for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
  throwIfAborted(signal);
  const isFinalForcedRound = round === MAX_TOOL_ROUNDS - 1;

  const response = await invokeGeminiModel({
    model: resolvedModel,
    contents,
    tools: isDeepAnalysis ? deepAnalysisTools : undefined,
    toolConfig: isDeepAnalysis
      ? { functionCallingConfig: { mode: isFinalForcedRound ? "NONE" : "AUTO" } }
      : undefined,
    thinkingLevel: resolvedThinkingLevel,
    signal,
    geminiApiKey,
  });

  const candidate = response.candidates?.[0];
  const candidateContent = candidate?.content;
  const parts = candidateContent?.parts ?? [];
  const functionCallParts = parts.filter((p: any) => Boolean(p?.functionCall));

  // Если вызовов инструментов нет — извлекаем финальный текст (без part.thought)
  if (functionCallParts.length === 0) {
    const finalText = extractCandidateText(candidate);
    if (!finalText.trim()) {
      throw new Error(
        `Gemini returned an empty response (finishReason: ${candidate?.finishReason || "Unknown"}).`,
      );
    }
    return {
      text: finalText,
      modelVersion: resolvedModel,
      requestedFiles: Array.from(requestedSet),
      fetchedFilesCount: alreadyFetched.size,
    };
  }

  // Сохраняем ВЕСЬ сырой candidateContent (включая thought + thoughtSignature!)
  contents.push(candidateContent);

  // Обрабатываем ВСЕ параллельные вызовы 1:1 с сохранением call.id
  const responseParts: any[] = [];
  for (const part of functionCallParts) {
    const call = part.functionCall;
    if (call.name !== "request_additional_files") {
      responseParts.push({
        functionResponse: {
          ...(call.id ? { id: call.id } : {}),
          name: call.name,
          response: { error: `Unknown tool: ${call.name}` },
        },
      });
      continue;
    }

    const rawPaths: string[] = Array.isArray(call.args?.filePaths) ? call.args.filePaths : [];
    const batchPaths = rawPaths.slice(0, MAX_FILES_PER_CALL);
    const skippedOverLimit = rawPaths.slice(MAX_FILES_PER_CALL);

    // Фильтруем уже загруженные, дозагружаем недостающие с поддержкой AbortSignal
    const toFetch = batchPaths.filter((p) => !alreadyFetched.has(p));
    const newlyFetched = toFetch.length > 0
      ? await fetchSpecificFiles(repoData, toFetch, token, referenceRepoData, localFiles, referenceLocalFiles, signal)
      : [];
    throwIfAborted(signal);

    for (const f of newlyFetched) alreadyFetched.set(f.path, f.content);

    const filesPayload = batchPaths
      .filter((p) => alreadyFetched.has(p))
      .map((p) => ({
        path: p,
        content: `\n<repository_file_content path="${p}">\n${alreadyFetched.get(p)}\n</repository_file_content>\n`,
      }));
    const missingPaths = batchPaths.filter((p) => !alreadyFetched.has(p));

    responseParts.push({
      functionResponse: {
        ...(call.id ? { id: call.id } : {}),
        name: call.name,
        response: {
          files: filesPayload,
          missing: missingPaths,
          skippedDueToBatchLimit: skippedOverLimit,
          remainingToolRounds: Math.max(0, MAX_TOOL_ROUNDS - 2 - round),
        },
      },
    });
  }

  // Чистый role: "user" с N functionResponse строго 1:1 к N functionCall
  contents.push({ role: "user", parts: responseParts });
}
```

**Ключевые гарантии этого решения:**
- Строго `N` `functionCall` → `N` `functionResponse` с сохранением `call.id`.
- Полное сохранение `candidateContent` (включая `thought` и `thoughtSignature`).
- Прозрачная обратная связь модели: какие файлы найдены, какие не найдены (`missing`), какие отсечены лимитом (`skippedDueToBatchLimit`), сколько раундов осталось.
- На последнем раунде `toolConfig.functionCallingConfig.mode = "NONE"` гарантирует синтез финального промпта без повторного вызова функций и без хрупких текстовых инъекций внутрь `functionResponse`.
- Исключения пробрасываются наверх в UI-баннер ошибок (и никогда не маскируются под сгенерированный Markdown).

### 2.3. Изменения в серверной и нативной частях (`apps/web/server.ts` & `apps/desktop/src-tauri/src/lib.rs`)
1. **`apps/web/server.ts` + `apps/web/vite.config.ts` + `metadata.json`:**
   - В `apps/web/server.ts` добавить `POST /api/gemini/rewrite` и `POST /api/gemini/generate` на базе серверного `@google/genai` (с `User-Agent: "aistudio-build"`, поддержкой `AbortController` на `req.on("close")`, пробросом `status` и понятных текстов ошибок `400`/`403`/`429`/`404`). Сервер использует `process.env.GEMINI_API_KEY`, либо (только если пользователь явно задал свой BYOK-ключ в настройках) заголовок `x-gemini-api-key`.
   - Убрать `"process.env.GEMINI_API_KEY"` из `apps/web/vite.config.ts`, чтобы ключ среды не попадал в клиентский бандл.
   - Обновить `/api/repo/files` (`server.ts:457`) и `fetchFilesFromRepo` (`githubService.ts:156`) на константу `MAX_FILES_PER_CALL = 5` + проброс `AbortSignal`.
   - Добавить `"MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API"` в `metadata.json`.
2. **`apps/desktop/src-tauri/src/lib.rs`:**
   - В `call_gemini_secure` поменять дефолт модели на `"gemini-4-hydrogen"`.
   - В `call_gemini_advanced`:
     - поменять дефолт на `"gemini-4-hydrogen"`, использовать `urlencoding::encode(&model_name)`;
     - добавить опциональные поля `generation_config: Option<serde_json::Value>`, `tool_config: Option<serde_json::Value>`, `system_instruction: Option<serde_json::Value>`;
     - возвращать явную ошибку при `promptFeedback.blockReason` если нет `candidates`.
   - Защитить и выровнять `scan_local_repository` (подключить те же правила фильтрации секретов `.env*`/`.pem`/`.key`/`secrets.json`, белый список `source_extensions`, оценку важности файлов `get_file_score`, сбор `tree`/`readme`/`dependencies`/`sourceFiles` по контракту `RepoData`, усечение дерева >1000 и файлов >100КБ) + добавить безопасную команду `read_local_repo_files(root_path, file_paths)` с `canonicalize()`-проверкой границ директории (защита от path traversal) для Agentic RAG в Desktop.

### 2.4. Архитектура редизайна UI ("Studio Workbench")
Отказ от длинной 4-экранной страницы в пользу **2-панельного рабочего пространства фиксированной высоты (`100vh` на десктопе `>= 1024px`)** с соблюдением всех правил `frontend-design` и `3_saas_dashboard.md`:

```text
+-----------------------------------------------------------------------------------+
| [Repo Prompt]    [Source & Task] [AI & Gemini] [RAG & Local LLM]   [Generate ->]  |  <- 56px Top Bar (3 зоны)
+-----------------------------------------+-----------------------------------------+
| ЛЕВАЯ ПАНЕЛЬ (42% / min 380px)          | ПРАВАЯ ПАНЕЛЬ (58%)                     |
| Независимый скролл только внутри вкладки| Постоянный предпросмотр и статус        |
|                                         |                                         |
| [Вкладка 1: Source & Task]              | Заголовок файла · модель · стратегия RAG|
|  - GitHub / Local Folder (native/web)   | [Copy] [Download .md]                   |
|  - Max Files · Token · Reference Repo   |-----------------------------------------|
|  - Task Template (+ Export/Import/Save) | [Баннеры: статус / truncation / error]  |
|  - Context + Attachments + Issues check |                                         |
|                                         | Просмотрщик результата (font-mono,      |
| [Вкладка 2: AI & Gemini]                | полная высота панели без скролла окна)  |
|  - Provider: Gemini / OpenAI-Compatible |                                         |
|  - Модель (Hydrogen/Argon/Carbon)       | В пустом состоянии:                     |
|  - Thinking Level (LOW/MED/HIGH/XHIGH)  | сводка активного пайплайна              |
|  - Agentic RAG (Deep Analysis)          | (Источник -> RAG -> Модель -> Выход)    |
|  - File Truncation Limit                |                                         |
|  - Desktop Key & Proxy (в Tauri) / BYOK |                                         |
|                                         |                                         |
| [Вкладка 3: RAG & Local LLM]            |                                         |
|  - [!] Верхняя панель подключения:      |                                         |
|    Engine + URL + [Test Connection]     |                                         |
|    + Start/Stop Ollama / .bat           |                                         |
|  - Переключатели: RAG / Local Summary / |                                         |
|    Local Final                          |                                         |
|  - Query, Embedding Model, Top-K,       |                                         |
|    Search Strategy                      |                                         |
|  - Advanced RAG Settings (всё на виду!) |                                         |
|  - Local LLM: Model, Ctx, Tokens, Temp  |                                         |
+-----------------------------------------+-----------------------------------------+
```

**Ключевые UX- и дизайн-улучшения:**
- **0–1 клик до любой настройки:** `Test Connection` закреплён в самом верху вкладки `RAG & Local LLM`; `Advanced RAG Settings` помещается на первом экране этой же вкладки (0 прокруток!).
- **Адаптивность под узкий Desktop (`800–1023px`) и мобильные:** При ширине `< 1024px` (включая старые `800px`) в верхних вкладках появляется 4-я вкладка `Output` с индикатором наличия готового результата — без горизонтального переполнения и без наезда панелей.
- **Отказ от антипаттернов (AI-slop):**
  - Типографика: `Plus Jakarta Sans` (интерфейс) + `JetBrains Mono` (`tabular-nums`, код, метрики, промпт). Подключаются в `apps/web/index.html` и `apps/desktop/index.html` с безопасным fallback.
  - **Никаких пилюль-бейджей** вокруг метаданных (`Model`, `Intent`, `RAG Query`, `Tokens x3`) — только чистый типографский текст с разделителями `·`.
  - **Никаких вложенных карточек в карточках** и **никаких `border-l-2`/`border-l-4` полос** — плоские поверхности `1px border-slate-200`, разделение отступами и тонкими линиями.
  - **Никаких `animate-pulse`** и декоративных мигающих точек.
  - Убрана нижняя полоса `fixed bottom-0` — главная кнопка `Generate Prompt` / `Cancel` находится в правом углу Top Bar (всегда видна, не перекрывает контент).
- **Декомпозиция `App.tsx` (выполнение `Audit.md П.9`):**
  - `packages/ui/src/hooks/useAppSettings.ts`
  - `packages/ui/src/hooks/useGenerationPipeline.ts`
  - `packages/ui/src/components/TopBar.tsx`
  - `packages/ui/src/components/SourceTaskTab.tsx`
  - `packages/ui/src/components/ProviderSettingsTab.tsx`
  - `packages/ui/src/components/RagLocalTab.tsx`
  - `packages/ui/src/components/OutputPane.tsx`
  - `packages/ui/src/components/TokenWarningModal.tsx`

---

## 3. Проверка комплексного влияния (Cross-Module Matrix)

| Связка / Сценарий | Риск при несогласованных правках | Как решено в плане |
|---|---|---|
| `gemini-4-*` × слайдер `Temperature` | Передача `temperature` в Gemini 4 даёт `400 INVALID_ARGUMENT` | Слайдер `Temperature` передаётся только в Local LLM и Custom Provider; для Gemini рендерится `Thinking Level` и не передаётся в payload |
| `gemini-4-argon/carbon` × `ThinkingLevel.XHIGH` | `XHIGH` поддерживается только в `gemini-4-hydrogen`; на `argon`/`carbon` даёт `400` | `normalizeThinkingLevel()` автоматически ограничивает `argon`/`carbon` до `HIGH`, а UI блокирует опцию `XHIGH` с пояснением |
| `useOllamaForFinal` × `isDeepAnalysis` | Взаимоисключающие режимы финальной генерации | При активном `useOllamaForFinal` тумблер `Agentic RAG` отключается с явной подписью (поведение сохранено) |
| Agentic RAG × `Local Folder` (Desktop native vs Web) | В Tauri при нативном выборе папки `localFiles: FileList` может быть `null` | Хранить `nativeLocalPath` в состоянии; `fetchSpecificFiles` при `owner === "local"` в Tauri читает файлы через защищённый `read_local_repo_files` |
| Старый `localStorage` (`gemini_app_settings`) | У пользователей уже сохранены настройки без новых полей | Все новые поля (`geminiModel`, `geminiThinkingLevel`) имеют дефолты и безопасную валидацию при чтении |
| Дефолтные габариты окна Tauri | `800x600` обрезал бы 2-колоночный макет | `tauri.conf.json` обновляется до `1280x840` (`minWidth: 800, minHeight: 600`), а брейкпоинт `< 1024px` включает таб `Output` |
| Отсутствие `cargo`/`rustc` в среде AI Studio | Невозможно скомпилировать Rust-код локально в контейнере | Правки `lib.rs` проверяются статически по фактическим крейтам `Cargo.lock` (`isahc 1.7.2`, `urlencoding 2.1`, `serde_json 1.0`, `walkdir`, `tokio`), не добавляя новых Rust-зависимостей |

---

## 4. Поэтапный план реализации (Multi-Step)

### Этап 1: Обновление SDK, Gemini 4 и исправление протокола Agentic RAG
1. Установить `@google/genai@^3.3.0` (единоразово через `install_applet_package`) и синхронизировать версии зависимостей в монорепозитории.
2. Создать `packages/core/src/config/geminiModels.ts` и экспортировать из `packages/core/src/index.ts`.
3. Обновить `packages/core/src/services/geminiService.ts`, `aiAdapter.ts`, `githubService.ts`:
   - переход на `gemini-4-hydrogen` (дефолт), поддержка `argon`/`carbon` и `ThinkingLevel`;
   - переработка Agentic RAG на многоходовой цикл (до 3 раундов), `N:N` сопоставление `functionCall.id` ↔ `functionResponse.id`, сохранение `thoughtSignature`, `toolConfig: { functionCallingConfig: { mode: "NONE" } }` на финальном шаге, честный проброс ошибок и `AbortSignal`.
4. Обновить `apps/web/server.ts` (`/api/gemini/rewrite`, `/api/gemini/generate`, лимит `/api/repo/files` = 5), `apps/web/vite.config.ts` (убрать клиентскую инъекцию `GEMINI_API_KEY`) и `metadata.json` (`MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API`).
5. Обновить `apps/desktop/src-tauri/src/lib.rs`: Gemini 4 дефолты, `urlencoding` и `generation_config`/`tool_config`/`system_instruction` в `call_gemini_advanced`, `blockReason`-обработка.
6. Проверка сборки и типов: `compile_applet` + `lint_applet`. *(Если используются платные модели `gemini-4-argon` / `gemini-4-carbon`, согласовать через `show_aistudio_ui` `paid_model_flow`.)*

### Этап 2: Укрепление Desktop Local Scan + Редизайн UI "Studio Workbench"
1. В `apps/desktop/src-tauri/src/lib.rs` привести `scan_local_repository` к контракту `GithubRepoData` / `RepoData` с фильтрацией секретов и белым списком расширений, добавить `read_local_repo_files` с проверкой канонического пути; обновить `apps/desktop/src-tauri/tauri.conf.json` (`1280x840`, `minWidth: 800`, `minHeight: 600`).
2. Подключить `Plus Jakarta Sans` и `JetBrains Mono` в `apps/web/index.html` и `apps/desktop/index.html`, обновить `packages/ui/src/tailwind.css`.
3. Декомпозировать `packages/ui/src/App.tsx` на хуки (`useAppSettings`, `useGenerationPipeline`) и компоненты вкладочного 2-панельного рабочего пространства (`TopBar`, `SourceTaskTab`, `ProviderSettingsTab`, `RagLocalTab`, `OutputPane`, `TokenWarningModal`) с сохранением 100% существующей функциональности и без антипаттернов.
4. Финальная проверка сборки и линтинга: `compile_applet` + `lint_applet` + аудит чек-листа регрессий.
