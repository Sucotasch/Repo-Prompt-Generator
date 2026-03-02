# Repo-Prompt-Generator Technical Documentation written by Repo-Prompt-Generator itself!

## 1. Overview
**Repo-Prompt-Generator** is a specialized tool designed to bridge the gap between large codebases and LLMs (Large Language Models) like Google Gemini and Ollama. It analyzes GitHub repositories or local directories to generate highly structured, context-rich Markdown prompts (`gemini.md`) and code audits.

By utilizing **Retrieval-Augmented Generation (RAG)**, the application ensures that only the most relevant parts of a codebase are sent to the AI, staying within context window limits while providing maximum utility for debugging, architectural analysis, or feature planning.

---

## 2. Real Capabilities
*   **Multi-Source Ingestion**: Fetch code directly from a public GitHub URL or upload a local folder via the browser.
*   **Smart Context Filtering (RAG)**: Uses semantic similarity to filter out irrelevant files, ensuring the LLM focuses on the code that matters for your specific query.
*   **Hybrid AI Support**: 
    *   **Gemini API**: For high-performance cloud-based generation.
    *   **Ollama (Local)**: For private, offline generation and RAG processing.
*   **Query Optimization**: Automatically rewrites user queries into technical search terms to improve retrieval accuracy.
*   **Intent Classification**: Detects whether you are looking for bugs (`BUG_HUNT`), structural understanding (`ARCHITECTURE`), UI/UX improvements, or data flow analysis.
*   **Safety Audit (ELI5)**: Includes a unique "Explain Like I'm 5" mode that assesses code safety and technical debt in humorous, easy-to-understand terms.
*   **Automated Prompt Engineering**: Generates ready-to-use `.md` files compatible with Gemini AI Studio or CLI tools.

---

## 3. Algorithm of Operation and Architecture

### Architecture Diagram
```text
[User Interface (React)] 
      |
      |--> [GitHub Service / Local File Service] (Source Code Ingestion)
      |
      |--> [RAG Service] 
      |       |-- [Query Optimizer (LLM)] --> (Expanded Query + Intent)
      |       |-- [Similarity Engine] ------> (Top-K File Selection)
      |
      |--> [LLM Service Layer]
      |       |-- [Gemini API]
      |       |-- [Ollama Local API]
      |
      |--> [Output Generator] (Markdown Prompt / Audit Report)
```

### The Generation Workflow
1.  **Ingestion**: The system traverses the file tree of the target repository, excluding common ignored paths (e.g., `node_modules`, `.git`).
2.  **Query Expansion**: If a specific task is provided (e.g., "Add GPU support"), the system uses an LLM to rewrite this into a technical search string (e.g., "RTX, CUDA, Nvidia, acceleration, hardware interface").
3.  **Semantic Ranking (RAG)**: The system calculates the relevance of each file against the optimized query. 
    *   *Example*: A request about "data flow" prioritizes state managers and API service files over CSS or HTML.
4.  **Context Construction**: Selected files are concatenated into a structured format, including metadata and directory structures.
5.  **Final Generation**: The system wraps the code in instructions and sends it to the chosen model (Gemini or Ollama) to produce the final analysis or prompt file.

---

## 4. Installation and Configuration

### Prerequisites
*   **Node.js** (v18 or higher recommended)
*   **Gemini API Key** (for cloud features)
*   **Ollama** (optional, for local model support)

### Setup Steps
1.  **Clone the repository**:
    ```bash
    git clone https://github.com/Sucotasch/Repo-Prompt-Generator.git
    cd Repo-Prompt-Generator
    ```
2.  **Install dependencies**:
    ```bash
    npm install
    ```
3.  **Configure Environment**:
    Create a `.env.local` file in the root directory:
    ```env
    VITE_GEMINI_API_KEY=your_api_key_here
    ```
4.  **Run the application**:
    ```bash
    npm run dev
    ```

### Configuring Ollama (CORS Support)
To use local models, Ollama must accept requests from the browser. The application provides a `.bat` file generation utility, or you can run it manually:
```bash
# Windows
set OLLAMA_ORIGINS="http://localhost:5173"
ollama serve
```

---

## 5. Usage Examples

### Scenario A: Generating a Code Audit for a GitHub Repo
1.  Select the **GitHub Repository** tab.
2.  Enter the URL (e.g., `https://github.com/facebook/react`).
3.  Check the box **"Analyze repository for obvious errors, bugs, and outdated dependencies"**.
4.  Click **Generate**.
5.  **Result**: You receive a `gemini.md` file containing a summary of the project architecture and a list of potential technical risks.

### Scenario B: Focused Debugging with RAG
If you are working on a specific bug in a large local folder:
1.  Select **Local Folder** and upload your project.
2.  Enable **"Use RAG (Smart Context Filter)"**.
3.  In the context box, type: *"The authentication token is not persisting after a page refresh."*
4.  Set **Top-K Files** to 5.
5.  **Result**: The generator will ignore your 50+ UI components and only include files related to `localStorage`, `AuthContext`, or `SessionMiddleware` in the prompt, making the AI's response much more accurate.

### Scenario C: Offline Generation (Privacy Mode)
1.  Ensure Ollama is running locally.
2.  Toggle **"Use Local Model for Final Generation"**.
3.  Select your local model (e.g., `llama3` or `mistral`).
4.  The entire analysis happens on your machine without sending code to external servers.

---

## 6. Key Files Reference
*   `src/services/ragService.ts`: Core logic for semantic filtering and file ranking.
*   `src/services/ollamaService.ts`: Handles communication with local AI instances.
*   `src/services/githubService.ts`: Manages GitHub API interaction and file tree reconstruction.
*   `server.ts`: Minimal Express server for local development and file handling.
