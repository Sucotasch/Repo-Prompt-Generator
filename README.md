# Repo-Prompt-Generator: Technical Documentation

## 1. Introduction
**Repo-Prompt-Generator** is a specialized tool designed to bridge the gap between complex codebases and Large Language Models (LLMs). It automates the process of extracting repository structure, metadata, and source code to generate highly contextual "System Prompts" (typically saved as `gemini.md`). These prompts allow AI models to act as expert contributors or security auditors for a specific project with full awareness of the existing architecture.

---

## 2. Real Capabilities

*   **Comprehensive Context Extraction**: Automatically fetches file trees, README files, dependency lists (`package.json`, etc.), and key source code files via the GitHub API.
*   **Intelligent Filtering**: Implements a "Hard Ignore" list (e.g., `node_modules`, `.git`, `dist`) and a "Secret Ignore" list (e.g., `.env`, `.pem`, `id_rsa`) to prevent context bloat and security leaks.
*   **Multi-Model Support**:
    *   **Google Gemini**: Primary cloud-based generation using the `gemini` or similar models.
    *   **Ollama**: Local LLM integration for pre-processing or generating prompts without sending data to the cloud.
*   **Template-Driven Generation**:
    *   *Default/Development*: Focuses on project purpose, tech stack, and architectural patterns.
    *   *Security Audit*: Focuses on finding vulnerabilities, RCE risks, and "typosquatting" in dependencies.
*   **Context Truncation Handling**: Automatically manages large repositories by prioritizing key files and truncating large strings to fit LLM context windows.

---

## 3. Architecture and Algorithm

### Architecture Overview
The application follows a modern full-stack TypeScript architecture:
*   **Frontend**: React 19 (Vite) + Tailwind CSS. Handles UI, template selection, and local AI (Ollama) orchestration.
*   **Backend**: Express.js server acting as a secure proxy for the GitHub API.
*   **Services Layer**: Modular services for GitHub data fetching, Gemini API communication, and Ollama integration.

### Logic Flow (Algorithm)
1.  **Input Parsing**: The user provides a GitHub URL. The frontend extracts the `owner` and `repo` name using regex.
2.  **Server-Side Fetching**:
    *   The Express server queries the GitHub Git Trees API (recursive) to map the entire project structure.
    *   It identifies the default branch and fetches the description.
3.  **Content Sanitization**:
    *   The server filters out binary files and ignored directories.
    *   It retrieves the content of `README.md` and dependency files.
4.  **Prompt Construction**:
    *   The `geminiService.ts` assembles a structured string containing: Task Instructions + File Tree + README + Dependencies + Key Source Code.
5.  **AI Inference**:
    *   The assembled context is sent to the chosen LLM.
    *   The AI generates a Markdown-formatted system prompt based on the selected template.
6.  **Output**: The user receives a copyable/downloadable Markdown block.

---

## 4. Installation and Configuration

### Prerequisites
*   **Node.js** (v18 or higher recommended)
*   A **Google Gemini API Key** (from [Google AI Studio](https://aistudio.google.com/))

### Local Setup
1.  **Clone the repository**:
    ```bash
    git clone https://github.com/Sucotasch/Repo-Prompt-Generator.git
    cd Repo-Prompt-Generator
    ```

2.  **Install dependencies**:
    ```bash
    npm install
    ```

3.  **Environment Configuration**:
    Create a `.env` file in the root directory (based on `.env.example`):
    ```env
    GEMINI_API_KEY=your_api_key_here
    ```

4.  **Start the Development Server**:
    ```bash
    npm run dev
    ```
    The application will be available at `http://localhost:3000`.

---

## 5. Usage Examples

### A. Generating a Developer System Prompt
1.  Launch the app and paste a URL (e.g., `https://github.com/facebook/react`).
2.  Select the **"Default"** template.
3.  Click **"Generate Prompt"**.
4.  **Result**: You receive a `gemini.md` file content that you can paste into a "Custom Instructions" block in Gemini or ChatGPT to make the AI "understand" how to write code specifically for the React library.

### B. Performing a Security Audit
1.  Paste the URL of a repository you wish to audit.
2.  Select the **"Security"** template.
3.  Enable **"Analyze Issues"** toggle.
4.  **Result**: The AI will output a report highlighting:
    *   Suspicious `eval()` or `exec()` calls.
    *   Hardcoded API keys.
    *   Potential dependency vulnerabilities.

### C. Using Local Ollama for Privacy
1.  Ensure Ollama is running on your machine (`ollama serve`).
2.  In the app settings, select a local model (e.g., `llama3` or `mistral`).
3.  The pre-processing of the repository tree will happen locally, reducing the amount of raw data sent to external APIs.

---

## Technical Summary for Architects
*   **Language**: TypeScript
*   **Core Libraries**: `@google/genai`, `express`, `vite`, `lucide-react`.
*   **Security Features**: SSRF protection on the backend via strict regex validation of owner/repo names; Client-side HTML sanitization via `dompurify`.
*   **Scaling**: Uses recursive GitHub Tree API calls which are more efficient than individual file requests, staying within standard API rate limits for medium-sized repos.
