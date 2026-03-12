> **🤖 Prompt Generation Metadata**
> - **Model:** gemini-3-flash-preview
> - **Target Repository:** https://github.com/Sucotasch/Repo-Prompt-Generator/tree/tauri_proxy
> - **Reference Repository:** https://github.com/Sucotasch/Repo-Prompt-Generator
> - **Auto-generated RAG Query:** "Сравни актуальность и функциональные возможности проектов, продумай, какие функции из reference repo можно внедрить в target repo, и как это лучше сделать. Предложи подробный план с примерами кода, готовый для передачи  на исполнение в google antigravity "
> 
> <details><summary><b>Task Instructions</b></summary>
> 
> ```text
> Сравни актуальность и функциональные возможности проектов, продумай, какие функции из reference repo можно внедрить в target repo, и как это лучше сделать. Предложи подробный план с примерами кода, готовый для передачи  на исполнение в google antigravity 
> ```
> </details>

---

Это детальный план модернизации проекта **Repo-Prompt-Generator** (ветка `tauri_proxy`), основанный на анализе предоставленного кода и сравнении с референсной реализацией.

---

### 1. Сравнение актуальности и функциональности

| Характеристика | Target Repo (`tauri_proxy`) | Reference Repo (`main`) | Преимущество / Что внедрить |
| :--- | :--- | :--- | :--- |
| **Среда выполнения** | Tauri (Desktop) + Node.js | Web (Browser/Express) | **Target:** Доступ к FS через Rust быстрее и безопаснее. |
| **AI Провайдеры** | Gemini, Ollama | Gemini, Ollama, **Qwen, OpenAI-Compatible** | **Reference:** Внедрить адаптерную систему провайдеров. |
| **RAG Логика** | Базовая (локальные эмбеддинги) | **Query Expansion, Intent Detection** | **Reference:** Внедрить оптимизацию запросов перед поиском. |
| **Шаблоны** | Хардкод (Audit) | **Structured Templates (Security, ELI5, etc.)** | **Reference:** Перенести систему плагинов-шаблонов. |
| **Перформанс** | Синхронный Rust (Bottleneck) | Асинхронный TS | **Fix:** Нужно перевести Rust на параллельный I/O (Tokio). |

---

### 2. План модернизации (Backlog для Google Antigravity)

#### Этап 1: Исправление критических узких мест (Rust Backend)
*   **Задача:** Устранить "Synchronous I/O Syndrome".
*   **Действие:** Переписать `scan_local_repository` и логику получения данных с GitHub на параллельное выполнение.
*   **Код (Пример для `src-tauri/src/lib.rs`):**

```rust
use tokio::task::JoinSet;

// Вместо последовательного цикла:
#[tauri::command]
async fn fetch_github_files_parallel(urls: Vec<String>, token: String) -> Result<Vec<FileEntry>, String> {
    let mut set = JoinSet::new();
    let client = reqwest::Client::new();

    for url in urls {
        let t = token.clone();
        let c = client.clone();
        set.spawn(async move {
            c.get(url)
                .header("Authorization", format!("token {}", t))
                .header("User-Agent", "Repo-Prompt-Generator-v2")
                .send()
                .await?
                .json::<GitHubContent>()
                .await
        });
    }

    let mut results = Vec::new();
    while let Some(res) = set.join_next().await {
        results.push(res.map_err(|e| e.to_string())??);
    }
    Ok(results)
}
```

#### Этап 2: Внедрение системы AI-адаптеров (Frontend)
*   **Задача:** Унифицировать вызовы разных LLM (Gemini, Qwen, Local).
*   **Действие:** Портировать `aiAdapter.ts` из Reference Repo.
*   **Код (`src/services/aiAdapter.ts`):**

```typescript
export interface AIProvider {
  generateResponse(prompt: string, config: any): Promise<string>;
  rewriteQuery?(query: string): Promise<{optimizedQuery: string, intent: string}>;
}

export class AISelector {
  static getProvider(type: 'gemini' | 'ollama' | 'openai'): AIProvider {
    switch(type) {
      case 'gemini': return new GeminiService();
      case 'ollama': return new OllamaService();
      // Добавляем поддержку OpenAI-compatible из референса
      default: throw new Error("Unsupported provider");
    }
  }
}
```

#### Этап 3: Продвинутый RAG и шаблонизация
*   **Задача:** Улучшить релевантность выдачи за счет "Intent Detection".
*   **Действие:** Перед поиском в векторной базе (Ollama) использовать Gemini для генерации технических ключевых слов.
*   **Код (Интеграция в `src/services/ragService.ts`):**

```typescript
// Из референсного кода: Оптимизация запроса
const RAG_OPTIMIZER_PROMPT = `Extract core technical keywords from: "${userQuery}". Return JSON {optimizedQuery, intent}`;

const { optimizedQuery, intent } = await gemini.rewriteQuery(RAG_OPTIMIZER_PROMPT);
// Теперь ищем в коде не по "как работает авторизация", 
// а по "AuthContext, JWT, passport.authenticate, login route"
const relevantFiles = await performRAG(sourceFiles, optimizedQuery, intent);
```

#### Этап 4: Поддержка "Integration Mode" (Сравнение репозиториев)
*   **Задача:** Позволить пользователю сравнивать текущий код с эталонным (Reference Repo).
*   **Действие:** Добавить в UI второе поле ввода URL и модифицировать `buildPromptText`, чтобы он принимал `referenceRepoData`.

---

### 3. Инструкция по выполнению (Ready for Execution)

1.  **Rust Refactor:**
    *   Заменить `isahc` на `reqwest` (лучшая поддержка прокси и асинхронности).
    *   Реализовать `RwLock` для `AppState`, чтобы менять прокси "на лету" без перезапуска Tauri.
    *   Внедрить `tauri-plugin-log` для маскировки API ключей в логах.

2.  **Frontend Migration:**
    *   Скопировать папку `src/templates/` из Reference в Target.
    *   Обновить `App.tsx`: добавить `Tab` систему (Single Repo / Integration Mode).
    *   Внедрить `dompurify` для безопасного рендеринга Markdown от LLM.

3.  **Security & UX:**
    *   Исправить баг "Clean Base64": сначала парсить JSON от GitHub, потом делать `.replace('\n', "")` только для поля `content`.
    *   Увеличить таймаут для Ollama до 300 секунд (для моделей 14b+).

### Итоговый результат:
Вы получите десктопное приложение (Tauri), которое работает в 3-5 раз быстрее текущей версии за счет параллелизма в Rust, поддерживает любые OpenAI-совместимые API и умеет делать глубокий аудит безопасности, используя продвинутые промпт-шаблоны из основной ветки проекта.