This audit analyzes the provided Rust/Tauri source code to address the Ollama timeout issues, API key security, and general code health.

### 1. The Ollama Timeout Issue (Models > 14b)

**The Cause:**
The bottleneck is located in `src/lib.rs` (Part 28). The global `HttpClient` is configured with a hardcoded timeout of **120 seconds**:

```rust
let client = HttpClient::builder()
    .timeout(Duration::from_secs(120)) // <--- THE LIMIT
    .build()
    .expect("Failed to create HTTP client");
```

**Why it affects >14b models:**
1.  **Loading Latency:** Models larger than 14b (e.g., 30b, 70b) require significant time to load from disk into VRAM/RAM. If the model isn't already "hot," Ollama may take over 2 minutes just to initialize the weights.
2.  **Generation Speed:** Large models have lower tokens-per-second. If you are requesting a long response (`num_predict`), the total request time frequently exceeds 120 seconds.
3.  **Non-Streaming:** The current implementation (seen in Part 23/24) waits for the full response body using `res.text().await`. Without streaming, the connection must remain open for the entire duration of the generation.

**Recommendation:**
Increase the timeout for the global client or, preferably, use a separate client configuration for Ollama that allows for a longer (or infinite) timeout.

---

### 2. API Key Security and GitHub Prevention

**Where the key is "saved":**
The code does not appear to save the key to a database. It retrieves it from two sources:
1.  **Environment Variables:** `GEMINI_API_KEY` or `VITE_GEMINI_API_KEY`. These are typically stored in a `.env` file in your project root or set in your Shell profile.
2.  **Frontend Pass-through:** The `call_gemini_secure` function accepts an `api_key: Option<String>`, implying the frontend may be storing it in `localStorage` and sending it via the IPC bridge.

**How to prevent sending to GitHub:**
1.  **Modify `.gitignore`:** Ensure your `.env` files are explicitly ignored. Add these lines to the `.gitignore` in the root:
    ```text
    .env
    .env.*
    !.env.example
    ```
2.  **Remove Cached Files:** If you already committed a `.env` file, remove it from git tracking without deleting the local file:
    ```bash
    git rm --cached .env
    ```
3.  **Audit Logs:** The function `get_gemini_key_source` (Part 27) returns a partial key (e.g., `env:ABCD...WXYZ`). While convenient for debugging, this exposes the key's existence and parts of its value in logs. Remove or gate this function behind a debug flag.

---

### 3. Detailed Code Audit

#### A. Logical Errors & Bugs
*   **Thread-Unsafe Proxy Configuration (Part 3):** 
    The code uses `std::env::set_var("HTTPS_PROXY", ...)` inside an `async` function. Environment variables are process-wide. If two requests are made simultaneously—one with a proxy and one without—the "secure" request might leak through the proxy or vice-versa.
    *   *Correction:* Pass the proxy configuration directly to the `isahc::Proxy` builder instead of mutating the global environment.
*   **Ollama Process Termination (Part 30):**
    The `RunEvent::Exit` logic kills *any* process named `ollama.exe`. If the user is running a separate Ollama instance for other tasks, your app will forcefully shut it down when closed, which is intrusive.

#### B. Performance Bottlenecks
*   **Memory Exhaustion in Repository Scanning (Part 4):**
    `scan_local_repository` uses `fs::read_to_string` on every file in a directory. 
    *   *Impact:* If a user scans a large folder (e.g., a `node_modules` or a large dataset), the app will attempt to load gigabytes of data into a `Vec<FileEntry>`, leading to an immediate **OOM (Out of Memory) crash**.
    *   *Correction:* Implement a file size limit and a skip-list (e.g., ignoring `.git`, `target`, `node_modules`).

#### C. Non-Functional / Brittle Functions
*   **Hardcoded Executable Names (Part 30):**
    The app looks specifically for `ollama.exe` and `ollama`. On Linux/macOS, depending on how it's installed, the process name might vary.
*   **Ollama Embeddings (Part 26):**
    `serde_json::to_string(&body).unwrap()` is used. If `prompt` contains invalid UTF-8 sequences (rare but possible with binary-adjacent files), this will panic the entire backend thread.

---

### 4. Modernization & Improvements

1.  **Move to `reqwest`:** While `isahc` is functional, `reqwest` is the current standard for Tauri/Rust. It has better integration with the `tokio` runtime which Tauri uses internally.
2.  **Streaming Responses:** Modify `ollama_generate` to use a streaming approach. This prevents timeouts because the "first byte" is received almost immediately, keeping the connection alive.
3.  **State Management:** Instead of a single `HttpClient` in `AppState`, use a struct that holds a `standard_client` (120s timeout) and a `long_poll_client` (for Ollama).
4.  **Security Modernization:** Use the `tauri-plugin-stronghold` or the OS Keyring (via the `keyring` crate) to store the Gemini API key instead of plain-text `.env` files.

### Recommended Correction (Minimal Intervention)

**Fixing the Timeout in `src/lib.rs`:**
```rust
// In AppState, add a second client
pub struct AppState {
    pub gemini_api_key: String,
    pub http_client: HttpClient,
    pub ollama_client: HttpClient, // New
}

// In run() function:
let client = HttpClient::builder()
    .timeout(Duration::from_secs(120))
    .build()
    .expect("Failed to create HTTP client");

let ollama_client = HttpClient::builder()
    .timeout(None) // No timeout for local Ollama
    .build()
    .expect("Failed to create Ollama client");

// Update manage state
.manage(AppState {
    gemini_api_key,
    http_client: client,
    ollama_client,
})
```
Then, update `ollama_generate` to use `state.ollama_client` instead of `state.http_client`.