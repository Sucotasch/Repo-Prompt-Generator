# Repo Prompt Generator & Code Auditor: Technical Documentation written by Repo Prompt Generator itself!

## 1. Real Capabilities

The **Repo-Prompt-Generator** is a sophisticated tool designed to bridge the gap between large-scale source code repositories and Large Language Models (LLMs) like Google Gemini and Ollama. Its primary goal is to generate context-aware prompts that allow AI to perform deep-dive analysis without hitting token limits.

### Core Features:
*   **Multi-Source Ingestion:** Supports fetching code directly from GitHub repositories or local file systems.
*   **Retrieval-Augmented Generation (RAG):** Implements a local RAG pipeline to chunk, embed, and retrieve only the most relevant code snippets for a specific query, significantly improving accuracy and reducing costs.
*   **Specialized Analysis Modes:**
    *   **Security Audit:** Detects RCE vulnerabilities, hardcoded secrets, data exfiltration, and "typosquatting" in dependencies.
    *   **Technical Documentation:** Automatically generates Wikis or READMEs based on code architecture.
    *   **Architectural Integration:** Provides patterns for merging logic from a "Reference Repo" into a "Target Repo" while preserving domain boundaries.
    *   **ELI5 (Explain Like I'm 5):** Simplifies complex logic for non-technical stakeholders.
*   **LLM Query Optimization:** Uses a "Chain of Thought" approach to expand simple user queries into technical keyword sets (e.g., converting "How is auth handled?" into "JWT, Middleware, OAuth2, bcrypt").
*   **Hybrid Provider Support:** Toggle between Google Gemini (Cloud) and Ollama (Local) for both processing and final generation.

---

## 2. Algorithm and Architecture

### High-Level Architecture
The application is built on a **React 19 + TypeScript** frontend with a **Vite/Express** backend. It follows a service-oriented architecture:

1.  **Data Layer (`githubService`, `localFileService`):** Fetches raw file content and metadata.
2.  **Processing Layer (`ragService`):** Handles text chunking (30-line windows) and semantic filtering.
3.  **Intelligence Layer (`geminiService`, `ollamaService`):** Manages communication with AI providers for query expansion and final response generation.
4.  **UI Layer (`App.tsx`):** Manages state for templates, query intents, and progress tracking.

### RAG Workflow Algorithm
To handle large repositories that exceed LLM context windows, the program follows this logic:

1.  **Query Expansion:** The user's natural language query is sent to an LLM to identify "Concrete Identifiers" (function names, classes) and "Intent" (e.g., `BUG_HUNT`).
2.  **Chunking:** The source code is broken into chunks of approximately 30 lines (max 8,000 characters per chunk for embedding safety).
3.  **Vectorization:** Each chunk and the optimized query are converted into embeddings (via Ollama/Gemini).
4.  **Similarity Search:** The system calculates the semantic similarity between the query and code chunks.
5.  **Top-K Retrieval:** Only the most relevant $N$ chunks are selected to form the final prompt context.
6.  **Template Injection:** The retrieved code is wrapped in a specialized `<SYSTEM_TEMPLATE>` (Audit, Docs, etc.) to guide the AI's persona and output format.

---

## 3. Installation and Configuration

### Prerequisites
*   **Node.js** (LTS version recommended)
*   **Ollama** (Optional, for local processing)
*   **Google Gemini API Key**

### Step-by-Step Setup

1.  **Clone and Install:**
    ```bash
    git clone https://github.com/Sucotasch/Repo-Prompt-Generator.git
    cd Repo-Prompt-Generator
    npm install
    ```

2.  **Environment Configuration:**
    Create a `.env.local` file in the root directory:
    ```env
    VITE_GEMINI_API_KEY=your_api_key_here
    ```

3.  **Local LLM Setup (Ollama):**
    If using Ollama for local RAG or generation, ensure it is running with CORS enabled to allow the browser to communicate with it.
    *   The app provides a "Download `.bat`" feature in the UI to automate this on Windows.
    *   Alternatively, set the environment variable: `OLLAMA_ORIGINS="http://localhost:5173"` before running `ollama serve`.

4.  **Run the Application:**
    ```bash
    npm run dev
    ```
    The server will start (via `server.ts` using `tsx`), and the frontend will be available at `http://localhost:5173`.

---

## 4. Usage Examples

### Example 1: Security Audit of a Repository
1.  Enter a GitHub URL (e.g., `https://github.com/expressjs/express`).
2.  Select the **"Security"** template.
3.  Enable **"Use RAG"** and **"Query Expansion"**.
4.  Input Query: *"Check for insecure middleware and potential RCE in route handlers."*
5.  **Output:** The tool will generate a prompt containing the most relevant routing logic and security middlewares, then send it to Gemini/Ollama to produce a Markdown report highlighting risks.

### Example 2: Generating Technical Documentation
1.  Upload local files or link a repository.
2.  Select the **"Documentation"** template.
3.  The system will analyze "Concrete Identifiers" (Exported classes, API routes).
4.  **Output:** A comprehensive `README.md` or Wiki structure including:
    *   Real capabilities.
    *   Public API definitions.
    *   Module-level architecture.

### Example 3: Local-Only Mode (Privacy Focused)
1.  Ensure Ollama is running locally with the `nomic-embed-text` and `llama3` models pulled.
2.  In the app settings, toggle **"Use Ollama for RAG"** and **"Use Ollama for Final Generation"**.
3.  The code never leaves your machine; the analysis happens entirely on your local GPU/CPU.

---

## Technical Metadata
*   **Stack:** React 19, Vite, Tailwind CSS, TypeScript.
*   **LLM Providers:** Google Gemini SDK, Ollama API.
*   **Chunking Strategy:** Line-based (30 lines) with character-limit safeguards (8000 chars).
*   **Security:** Sanity checks on HTML output via `dompurify`.
