# Инженерно-архитектурный аудит кодовой базы (Engineering & Architecture Audit)
**Проект:** Repo Prompt Generator (Web & Desktop Tauri Monorepo)  
**Дата актуализации:** 2026-09-04  
**Статус:** Актуализирован по итогам технического консилиума и внесенных исправлений  

---

## 1. Реестр решений консилиума и статус пунктов аудита

| № | Проблема / Тема | Статус | Итоговое решение и обоснование |
|---|---|---|---|
| **П.1** | Изоляция API-ключа Gemini на серверном бэкенде | **ЗАКРЫТО (Отклонено)** | Разработка и запуск ведутся в окружении Google AI Studio. Вынос ключа в скрытый backend усложняет архитектуру, ломает автономность клиентского бандла и делает приложение неработоспособным в текущей среде. |
| **П.2** | SSRF-валидация и запрет приватных адресов в OpenAI-прокси | **ЗАКРЫТО (Отклонено)** | Архитектурная цель прокси — дать пользователю полный контроль и возможность подключать **любые** локальные и корпоративные эндпоинты (`localhost:11434`, LM Studio, OpenGate, vLLM в локальной сети). Фильтрация приватных IP ломает базовый сценарий локальной работы. |
| **П.3** | Утечка секретов и файлов `.env.*` при сканировании папок | **ЗАКРЫТО (Ложная тревога)** | Двухуровневая защита: regex `SECRET_IGNORE_REGEX` + строгий белый список расширений `sourceExtensions` (`.ts, .py, .go, .js...`). Файлы `.env*`, `.pem`, `.key` физически не читаются и в контекст LLM не попадают. |
| **П.4** | Параллелизация эмбеддингов для локальной Ollama | **ЗАКРЫТО (Архитектурная норма)** | У пользователей различное локальное «железо». Параллельный спам десятками одновременных запросов в `ollama serve` приводит к OOM, зависанию llama.cpp и троттлингу. Последовательная обработка с выводом прогресса в UI гарантирует стабильность. |
| **П.5** | Специфика Cache API в `EmbeddingCacheService` | **ОТЛОЖЕНО (Низкий приоритет)** | В браузере относительные пути работают через `window.location.origin`. В десктопе Tauri возможные ошибки перехватываются блоками `try/catch` без падения (происходит прозрачный fallback на повторное вычисление). Миграция на IndexedDB/Tauri Store признана несрочной. |
| **П.6** | Искажение RRF-ранжирования при сбое векторного эмбеддинга | **РЕШЕНО И ВНЕДРЕНО** | В `ragService.ts` добавлено динамическое переключение весов: при отсутствии `queryEmbedding` вес векторного поиска становится `0`, а лексического BM25 — `1.0`. Шум полностью исключен. |
| **П.7** | Потеря Function Calling в моделях Gemini 3.x с рассуждениями | **РЕШЕНО И ВНЕДРЕНО** | В `geminiService.ts` жесткая проверка `parts[0].functionCall` заменена на поиск по массиву `.find(p => p?.functionCall)`. Блоки мыслей (`thought: true`) отфильтрованы из финального промпта. |
| **П.7+** | Поддержка сторонних reasoning-моделей (DeepSeek, Qwen) | **РЕШЕНО И ВНЕДРЕНО** | В `openaiCompatibleService.ts` внедрена функция `extractChoiceContent`: поддержано чтение `reasoning_content` и корректная очистка тегов `<think>...</think>`. |
| **П.8** | Корневые файлы `constants.ts` и `modelRegistry.ts` | **ЗАКРЫТО (Без изменений)** | Файлы не импортируются в `apps/` и `packages/`, сборка их игнорирует. Удаление ради удаления нецелесообразно. |
| **П.9** | Монолитная структура `App.tsx` (>2700 строк) | **БЭКЛОГ (Рефакторинг UI)** | Не влияет на стабильность генерации и бизнес-логику. Вынесение в подкомпоненты запланировано на этап планового UI-рефакторинга. |

---

## 2. Детальное описание внедренных решений (П.6, П.7, П.7+)

### 2.1. П.6: Чистый BM25 Fallback в RAG (`ragService.ts`)
* **Файл:** `packages/core/src/services/ragService.ts` (строки 297–305).
* **Проблема:** Если модель эмбеддингов недоступна или Ollama выключена, `queryEmbedding` равен `null`. При этом вычислялся пустой `vectorRanked` со скорами `0` (+ эвристические надбавки интента), и вызывался RRF со стандартным весом `vectorWeight = 0.5`. Фиктивный векторный список на 50% искажал реальную выдачу BM25.
* **Внедренное решение:**
```typescript
// 4. Reciprocal Rank Fusion
// searchStrategy: 0 = Pure Vector, 1 = Pure BM25
// If query embedding failed, gracefully fallback to 100% BM25 lexical search
const vectorWeight = queryEmbedding ? (1 - searchStrategy) : 0;
const lexicalWeight = queryEmbedding ? searchStrategy : 1;

const fusedResults = reciprocalRankFusion(
  vectorRanked,
  lexicalRanked,
  vectorWeight,
  lexicalWeight,
);
```
* **Результат:** При падении эмбеддингов RAG переключается на 100% лексический поиск BM25 без перемешивания с фиктивными векторными ранжирами.

---

### 2.2. П.7: Поддержка Gemini 3.x Reasoning и Function Calling (`geminiService.ts`)
* **Файл:** `packages/core/src/services/geminiService.ts` (строки 241–245, 298–308, 400–410).
* **Проблема:** В Tauri-ветке ответ Google REST API парсился через `response.candidates[0].content.parts[0].functionCall`. В моделях семейства Gemini 3.x с включенными рассуждениями нулевой частью часто является блок мыслей `{ text: "...", thought: true }`, а вызов функции идет вторым элементом. Это приводило к потере вызова инструмента `request_additional_files`. Кроме того, текст мыслей попадал в готовый промпт.
* **Внедренное решение:**
  1. Безопасный поиск вызова функции по всему массиву частей:
```typescript
const candidateContent = response.candidates?.[0]?.content;
const parts = candidateContent?.parts || [];
const functionCallPart = parts.find((p: any) => p?.functionCall);

if (functionCallPart?.functionCall) {
  const call = functionCallPart.functionCall;
  // Обработка дозапроса файлов...
```
  2. Изоляция мыслей модели от пользовательского результата (как в Tauri, так и в Web ветках):
```typescript
if (candidate.content?.parts) {
  for (const part of candidate.content.parts) {
    if (part.text && !part.thought) text += part.text;
    if (part.functionCall) functionCall = part.functionCall;
  }
  if (!text.trim()) {
    for (const part of candidate.content.parts) {
      if (part.text) text += part.text;
    }
  }
}
```
* **Результат:** Корректная работа дозапроса файлов в reasoning-моделях и чистый системный промпт без промежуточных мыслей.

---

### 2.3. П.7+: Поддержка сторонних reasoning-моделей в `openaiCompatibleService.ts`
* **Файл:** `packages/core/src/services/openaiCompatibleService.ts` (строки 115–138, а также точки возврата контента).
* **Проблема:** Модели DeepSeek-R1, Qwen 2.5 / QwQ, работающие через vLLM, Ollama или OpenRouter, могут возвращать ход мыслей в отдельном поле `reasoning_content`, либо оборачивать их в теги `<think>...</think>` прямо в поле `content`. Это приводило к попаданию десятков килобайт внутренних рассуждений в промпт или поломке JSON-парсинга в RAG-оптимизаторе запросов.
* **Внедренное решение:**
```typescript
function extractChoiceContent(choice: any): string {
  if (!choice?.message) return "";
  const msg = choice.message;
  let text = msg.content || "";

  // Fallback для моделей с отдельным полем reasoning_content (DeepSeek-R1 / vLLM / OpenRouter)
  if (!text.trim() && msg.reasoning_content) {
    text = msg.reasoning_content;
  }

  // Стриппинг тегов <think>...</think> (Qwen, DeepSeek), если за ними следует итоговый ответ
  if (text.includes("<think>")) {
    const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (stripped.length > 0) {
      text = stripped;
    }
  }

  return text;
}
```
* **Результат:** Функция применена ко всем 6 точкам получения ответа (генерация промпта и RAG query rewriting). Готовый промпт и JSON-ответы очищены от технического reasoning-мусора.

---

## 3. Дополнительные технические особенности архитектуры

### 3.1. Специфика окружения Web vs Desktop (Tauri)
* **Web:**
  - Запросы к GitHub API и внешним провайдерам проксируются через Express-сервер (`/api/*`), что устраняет CORS-ограничения браузера.
  - Прямые запросы к локальной Ollama (`http://localhost:11434`) из веб-версии, открытой по HTTPS, могут блокироваться политикой браузера Mixed Content. Это штатное поведение браузерной песочницы.
* **Desktop (Tauri v2):**
  - Сетевые вызовы (`ai_network_request`, `ollama_generate`, `fetch_github_repo`) выполняются напрямую из процесса Rust (`apps/desktop/src-tauri/src/lib.rs`), полностью обходя браузерные ограничения CORS и Mixed Content.
  - Управление локальным процессом Ollama (запуск/остановка `ollama serve`) контролируется бэкендом Tauri.

### 3.2. Безопасность контекста и парсинг локальных папок
* Функция `processLocalFolder` в `localFileService.ts` производит фильтрацию по двум рубежам:
  1. Регулярные выражения игнорирования системных папок (`node_modules`, `.git`, `dist`, `build`) и конфигов с секретами.
  2. Строгий белый список расширений `sourceExtensions`. Файлы без расширения или с нестандартными суффиксами в `finalSourceFiles` не попадают.

---

## 4. Чек-лист для последующих релизов
1. При добавлении новых провайдеров в Custom Provider следить, чтобы парсинг ответа производился через `extractChoiceContent`.
2. При модификации алгоритмов поиска в `packages/core` запускать `npm run lint --workspaces` и проверять компиляцию монорепозитория.
3. Сохранять последовательную обработку локальных эмбеддингов для предотвращения перегрузки оборудования конечных пользователей.
