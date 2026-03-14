> **🤖 Prompt Generation Metadata**
> - **Model:** gemini-3-flash-preview
> - **Target Repository:** https://github.com/Sucotasch/Repo-Prompt-Generator
> - **Reference Repository:** https://github.com/Sucotasch/Repo-Prompt-Generator/tree/tauri_proxy
> - **Auto-generated RAG Query:** "Сравни актуальность и функциональные возможности проектов, продумай, какие функции из reference repo можно внедрить в target repo, и как это лучше сделать "
> 
> <details><summary><b>Task Instructions</b></summary>
> 
> ```text
> Сравни актуальность и функциональные возможности проектов, продумай, какие функции из reference repo можно внедрить в target repo, и как это лучше сделать 
> ```
> </details>

---

Проведенный анализ **Target Repo (основная ветка `main`)** и **Reference Repo (ветка `tauri_proxy`)** показывает, что хотя оба проекта решают одну задачу, они находятся на разных стадиях архитектурного развития. 

Ветка `main` — это стабильное веб-приложение (React + Express), в то время как `tauri_proxy` — это попытка переезда на десктоп с Rust-бэкендом, в ходе которой были выявлены и задокументированы критические архитектурные недостатки текущего подхода.

---

### 1. Сравнение актуальности и функциональности

| Характеристика | Target Repo (`main`) | Reference Repo (`tauri_proxy`) |
| :--- | :--- | :--- |
| **Стек** | Node.js (Express), React 19, Vite | Rust (Tauri), React 19, Vite |
| **Сильные стороны** | Готовность к деплою в веб, RAG на базе Ollama, поддержка Qwen/Gemini. | Нативная работа с ФС, глубокий аудит производительности (в .md файлах). |
| **Слабые стороны** | Последовательные сетевые запросы (медленно), слабая приоритизация файлов. | Статус "экспериментальный", синхронные блокировки в Rust. |
| **RAG/Фильтрация** | Семантический поиск (Embeddings). | Эвристический скоринг (вес файлов по пути/названию). |

---

### 2. Функции из Reference Repo для внедрения в Target Repo

Наибольшую ценность представляют не сами файлы `tauri_proxy`, а **результаты внутреннего аудита**, проведенного в этой ветке.

#### А. Эвристический скоринг файлов (Heuristic Scoring)
В `main` файлы выбираются либо все сразу (с обрезкой), либо через RAG. Reference repo предлагает систему весов:
*   **Booster (+20):** Файлы в `src/`, `lib/`, `app/`. Названия `main`, `index`, `server`, `api`.
*   **Penalty (-50):** Тесты (`.spec`, `.test`), документация, глубокая вложенность.
*   **Зачем:** Это позволит RAG-системе в `main` не просто искать по смыслу, а отдавать приоритет архитектурно значимым файлам.

#### Б. Параллельная загрузка (Concurrency)
Аудит в Reference repo выявил "Synchronous I/O syndrome". В `main` (файл `server.ts`) загрузка файлов из GitHub идет в цикле `for...await`, что делает запросы последовательными.
*   **Зачем:** Ускорение получения контекста в 3-5 раз для крупных репозиториев.

#### В. Улучшенная очистка Base64
В `main` очистка переносов строк (`.replace('\n', '')`) часто происходит неоптимально, создавая лишние аллокации строк. Reference рекомендует сначала парсить JSON, а затем чистить только контент.

---

### 3. План внедрения (Implementation Strategy)

#### Шаг 1: Оптимизация сетевого слоя (`server.ts`)
Замените последовательный перебор файлов на `Promise.all` с ограничением конкурентности.

**Как сделать:**
```typescript
// В server.ts
const fetchFile = async (file) => {
  const fileRes = await fetch(`.../contents/${file}`, { headers });
  if (fileRes.ok) {
    const fileData = await fileRes.json();
    // Оптимизированная очистка из Reference Repo:
    const cleanContent = fileData.content.replace(/[\n\r]/g, "");
    return { path: file, content: atob(cleanContent) };
  }
};

// Вместо for cycle:
const sourceFiles = await Promise.all(filesToFetch.map(fetchFile));
```

#### Шаг 2: Гибридный фильтр (RAG + Heuristics)
Интегрируйте логику скоринга из `src/services/localFileService.ts` (Reference) в `src/services/ragService.ts` (Target).

**Как сделать:**
1.  Создайте функцию `calculateFileWeight(path: string): number`.
2.  В `performRAG` при ранжировании результатов семантического поиска добавляйте "эвристический бонус" к `similarityScore`.
3.  Это гарантирует, что `App.tsx` будет выше в выдаче, чем какой-нибудь `utils.test.ts`, даже если в обоих есть ключевое слово.

#### Шаг 3: Настройка таймаутов для тяжелых моделей
Как указано в аудите Reference Repo (gemini (30).md), модели >14b (Ollama) долго грузятся в память.
**Как сделать:**
В `src/services/ollamaService.ts` увеличьте `timeout` или сделайте его динамическим в зависимости от выбранной модели (например, 300с для моделей класса 70b).

#### Шаг 4: Унификация интерфейса (Provider Pattern)
Внедрите идею `RepoProvider` из Reference Repo.
**Как сделать:**
Создайте общий интерфейс для `githubService` и `localFileService`. Это позволит легко добавить новые источники (GitLab, Bitbucket), о чем упоминалось в стратегии модернизации `tauri_proxy`.

### Резюме
Target Repo (`main`) — отличный движок, но он работает "в лоб". Внедрение **эвристического скоринга** и **параллельной загрузки** из Reference Repo превратит его из простого сборщика промптов в профессиональный инструмент анализа кода, который понимает структуру проекта так же хорошо, как и текст кода.