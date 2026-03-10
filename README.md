# Repo-Prompt-Generator

**Repo-Prompt-Generator** is a sophisticated technical tool designed to bridge the gap between large-scale codebases and Large Language Models (LLMs). It automates the creation of high-context prompts, code audits, and documentation by intelligently analyzing GitHub repositories or local file systems.

Unlike simple file concatenators, this tool employs **Retrieval-Augmented Generation (RAG)** and **Query Expansion** to provide LLMs with the most relevant code snippets, even when dealing with repositories that exceed standard context windows.

---

## 🚀 Real Capabilities

*   **Multi-Source Input:** Fetch data directly from GitHub (via URL) or upload local folders.
*   **Intelligent RAG (Retrieval-Augmented Generation):** Uses semantic search (via Ollama embeddings) to find the most relevant code parts for a specific query.
*   **Query Optimization:** Automatically rewrites user queries into "LLM-optimized" technical keywords and determines "Intent" (Architecture, Bugfix, Feature, etc.).
*   **Template-Driven Generation:** Specialized prompt templates for:
    *   **Security Audits:** Focused on vulnerabilities and exploits.
    *   **Documentation:** Generating high-level and technical docs.
    *   **ELI5:** Explaining complex logic in simple terms.
    *   **Integration:** Analyzing how to integrate two different repositories.
*   **Multi-Model Support:** Native integration with **Google Gemini**, **Ollama** (local), **Qwen**, and any **OpenAI-compatible** API.
*   **Smart Truncation:** Automatically manages large files and token limits to ensure the prompt remains within the model's capacity.

---

## 🏗 Architecture & Algorithm

### System Architecture

The application is built with a modern decoupled stack:

1.  **Frontend:** React 19 (Vite) with Tailwind CSS for a responsive, real-time UI.
2.  **Backend:** A lightweight Express server (`server.ts`) acting as a proxy for GitHub API requests and handling secure communication with AI providers.
3.  **Services Layer:** A modular adapter pattern (`aiAdapter.ts`) that abstracts the differences between various LLM providers.

### The RAG Workflow

When a user provides a query and a repository, the system follows this algorithm:

1.  **Query Expansion:** The system sends the raw query to an LLM to extract "Concrete Identifiers" (class names, functions) and determine the "Intent".
2.  **Chunking:** Source files are split into manageable chunks (default: 30 lines) to maintain context without overflowing embedding limits.
3.  **Embedding & Search:**
    *   Generates vector embeddings for the chunks using Ollama.
    *   Calculates semantic similarity between the optimized query and code chunks.
    *   Filters out "abstract sentiment" and prioritizes "functional identifiers."
4.  **Context Assembly:** The Top-K most relevant snippets are gathered and formatted into a markdown-compatible prompt (`gemini.md`).

---

## 🛠 Installation & Configuration

### Prerequisites

*   **Node.js** (v18 or higher)
*   **Ollama** (Optional, for local RAG/Embeddings)
*   **GitHub Token** (Optional, for private repos or higher rate limits)

### Setup

1. **Clone the repository:**

   ```bash
   git clone https://github.com/Sucotasch/Repo-Prompt-Generator.git
   cd Repo-Prompt-Generator
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Environment Variables:**
   Create a `.env.local` file in the root directory (refer to `.env.example`):

   ```env
   VITE_GEMINI_API_KEY=your_gemini_key_here
   # If using local Ollama
   VITE_OLLAMA_URL=http://localhost:11434
   ```

4. **Run Development Server:**

   ```bash
   npm run dev
   ```

---

## 📖 Usage Examples

### 1. Generating a Security Audit

*   **Source:** Paste a GitHub URL (e.g., `https://github.com/expressjs/express`).
*   **Template:** Select **Security**.
*   **Query:** "Check for SQL injection and middleware bypass patterns."
*   **Output:** A structured prompt ready to be pasted into Gemini/ChatGPT that includes only the relevant route handlers and database logic.

### 2. Local Code Exploration (RAG Mode)

*   **Source:** Select **Local Folder**.
*   **Mode:** Toggle **Use RAG**.
*   **Query:** "How is the authentication flow implemented?"
*   **Logic:** The tool will scan your local files, chunk them, and use Ollama to find files like `authService.ts`, `passport.js`, or `login.tsx`, excluding irrelevant CSS or asset files.

### 3. Repository Integration

*   **Target Repo:** Your current project.
*   **Reference Repo:** A library or boilerplate you want to implement.
*   **Template:** Select **Integration**.
*   **Result:** A prompt that explains how to map the patterns from the reference repo into your target project.

---

## 🗂 Project Structure

*   `/src/services`: Core logic for AI providers (Gemini, Qwen, Ollama) and the RAG engine.
*   `/src/templates`: Specialized markdown templates for different prompt types.
*   `/server.ts`: Node server for GitHub API proxying.
*   `metadata.json`: Configuration for the application's AI Studio metadata.

## ⚖️ License

This project is provided "as is". Please ensure you have the rights to analyze the repositories you input into the tool, especially when using cloud-based LLMs like Gemini or OpenAI.


**Repo-Prompt-Generator** — это мощный инструмент для разработчиков и архитекторов, предназначенный для автоматического создания структурированных промптов и проведения аудита кодовой базы. Система анализирует локальные или удаленные (GitHub) репозитории и генерирует контекст, оптимизированный для работы с современными LLM (Gemini, Qwen, Ollama, OpenAI-совместимые модели).

Инструмент идеально подходит для создания `gemini.md` файлов, подготовки контекста для исправления багов, написания документации или проведения анализа безопасности.

---

## 1. Основные возможности

*   **Мульти-источники данных:** Поддержка импорта кода напрямую из GitHub (через API) или локальных папок.
*   **RAG (Retrieval-Augmented Generation):** Интеллектуальный поиск по коду с использованием семантического сходства. Система разбивает файлы на части (chunks) и находит наиболее релевантные участки для вашего запроса.
*   **Поддержка множества AI-провайдеров:**
    *   **Google Gemini:** Основной движок для генерации длинных контекстов.
    *   **Ollama:** Для локального и приватного анализа кода.
    *   **Alibaba Qwen:** Специализированные модели для кодинга.
    *   **OpenAI Compatible:** Возможность подключения любого API, совместимого со спецификацией OpenAI.
*   **Шаблоны задач:** Предустановленные промпты для различных сценариев (Аудит, Документация, Безопасность, ELI5, Интеграция).
*   **Оптимизация запросов:** Автоматическая переработка пользовательского вопроса в технические ключевые слова для улучшения качества поиска в коде.
*   **Генерация BAT-скриптов:** Встроенная утилита для быстрого запуска Ollama с правильными настройками CORS.

---

## 2. Архитектура и Алгоритм работы

### Технологический стек
*   **Frontend:** React 19, Vite, TypeScript, Tailwind CSS, Motion (framer-motion).
*   **Backend/Server:** Express (используется для проксирования запросов и запуска сервера разработки).
*   **AI Integration:** `@google/genai`, кастомные адаптеры для Ollama и Qwen.

### Алгоритм работы RAG (Retrieval-Augmented Generation)
1.  **Сбор данных:** `githubService` или `localFileService` извлекают содержимое файлов и метаданные.
2.  **Оптимизация запроса:** LLM анализирует задачу пользователя и извлекает "Concrete Identifiers" (названия функций, классов, маршрутов), игнорируя абстрактные понятия.
3.  **Чанкинг (Chunking):** Файлы разбиваются на логические сегменты (обычно по 30 строк) для повышения точности эмбеддингов.
4.  **Векторизация и Поиск:** Генерируются эмбеддинги для запроса и фрагментов кода (через Ollama). Вычисляется косинусное сходство.
5.  **Сборка контекста:** Самые релевантные фрагменты объединяются в итоговый промпт, который отправляется в основную модель для решения задачи.

### Архитектура сервисов (`src/services/`)
*   `aiAdapter.ts`: Фасад, который скрывает сложность выбора между разными провайдерами (Gemini, Ollama и т.д.).
*   `ragService.ts`: Ядро логики семантического поиска.
*   `template.ts`: Система управления шаблонами вывода.

---

## 3. Установка и настройка

### Предварительные требования
*   Node.js (версия 18 или выше).
*   Установленный [Ollama](https://ollama.ai/) (если планируете использовать локальные модели).

### Пошаговая установка
1.  Клонируйте репозиторий:
    ```bash
    git clone https://github.com/Sucotasch/Repo-Prompt-Generator.git
    cd Repo-Prompt-Generator
    ```
2.  Установите зависимости:
    ```bash
    npm install
    ```
3.  Настройте переменные окружения:
    Создайте файл `.env.local` на основе `.env.example` и добавьте свой ключ API:
    ```env
    VITE_GEMINI_API_KEY=your_api_key_here
    ```
4.  Запустите приложение:
    ```bash
    npm run dev
    ```

### Настройка Ollama (CORS)
Для работы браузерной версии с локальным Ollama необходимо разрешить CORS. Приложение позволяет скачать `start-ollama.bat` автоматически, либо вы можете запустить его вручную:
```bash
set OLLAMA_ORIGINS="http://localhost:5173"
ollama serve
```

---

## 4. Использование и примеры

### Основной сценарий: Генерация аудита кода
1.  Введите URL GitHub репозитория.
2.  Выберите шаблон **"Security/Audit"**.
3.  Нажмите **"Generate Prompt"**.
4.  Система соберет структуру файлов, выявит критические узлы и сформирует промпт для LLM, который укажет на потенциальные уязвимости.

### Работа с локальными файлами
Вы можете перетащить папку с проектом в область загрузки. Система рекурсивно прочитает файлы, исключая `node_modules`, `.git` и другие системные директории (согласно настройкам в `metadata.json`).

### Примеры шаблонов:
*   **ELI5 (Explain Like I'm 5):** Объясняет сложную архитектуру простыми словами.
*   **Integration:** Генерирует код для интеграции текущего модуля в другую систему.
*   **Docs:** Создает качественную JSDoc или Markdown документацию на основе сигнатур функций.

### Пример оптимизированного RAG-запроса:
*   *Пользователь вводит:* "Как работает авторизация?"
*   *Система оптимизирует:* `AuthService, login, JWT, verifyToken, middleware, User model`
*   *Результат:* AI найдет именно эти файлы, даже если в них нет слова "авторизация".

---

## 5. Структура проекта

*   `/src/services`: Логика взаимодействия с API и файловой системой.
*   `/src/templates`: Набор промптов, определяющих поведение AI.
*   `/src/types`: TypeScript интерфейсы для обеспечения типобезопасности.
*   `server.ts`: Серверная часть для обхода ограничений CORS некоторых API.

---

**Разработчик:** Sucotasch
**Лицензия:** MIT
