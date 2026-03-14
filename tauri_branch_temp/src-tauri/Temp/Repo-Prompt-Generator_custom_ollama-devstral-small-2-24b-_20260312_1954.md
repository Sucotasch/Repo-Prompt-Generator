> **🤖 Prompt Generation Metadata**
> - **Model:** Ollama (devstral-small-2:24b)
> - **Target Repository:** https://github.com/Sucotasch/Repo-Prompt-Generator/tree/tauri_proxy
> - **Original RAG Query:** "ollama, RAG, gemini, openrouter, API"
> - **Optimized RAG Query:** "ollama API, RAG pipeline, gemini API, openrouter API, retrieval-augmented generation, code repository, API integration, function signatures, file paths, technical documentation, API endpoints, data retrieval, query optimization, natural language processing, machine learning models"
> 
> <details><summary><b>Task Instructions</b></summary>
> 
> ```text
> Сравни две версии приложения, выясни, какая из них актуальна, объясни чем конкретно они отличаются.
> ```
> </details>

---

Based on the provided codebase and audit, here's a comprehensive analysis and recommendations for improvement:

## Key Issues Identified

1. **Process Management Problems**:
   - The exit handler kills all Ollama processes indiscriminately
   - No distinction between processes started by the app vs. existing ones
   - Potential to disrupt user's other Ollama instances

2. **Resource Management Issues**:
   - Memory bloat from reading all files into memory without filtering
   - No size limits or folder exclusions (like .git)
   - Risk of OOM crashes with large repositories

3. **HTTP Client Problems**:
   - Double-reading response bodies in `call_gemini_secure`
   - No timeout differentiation between cloud and local API calls
   - Potential 403 errors from GitHub API due to generic User-Agent

4. **Architectural Concerns**:
   - Separate code paths for local vs GitHub sources
   - Lack of abstraction for different repository providers
   - Inefficient system refreshing in process checks

## Recommended Fixes

### 1. Process Management Improvements

```rust
// Track started processes in AppState
pub struct AppState {
    pub gemini_api_key: String,
    pub http_client: HttpClient,
    pub ollama_client: HttpClient,
    pub started_processes: Mutex<HashSet<u32>>, // Track PIDs
}

// In start_ollama:
let mut child = Command::new("ollama")
    .spawn()
    .map_err(|e| format!("Failed to start Ollama: {}", e))?;

let pid = child.id();
state.started_processes.lock().unwrap().insert(pid);

// In exit handler:
for &pid in state.started_processes.lock().unwrap().iter() {
    if let Some(process) = System::new().process(pid) {
        process.kill();
    }
}
```

### 2. Memory-Efficient File Scanning

```rust
async fn scan_local_repository(path: String) -> Result<Vec<FileEntry>, String> {
    let mut files = Vec::new();
    let walker = WalkDir::new(path)
        .max_depth(5) // Prevent deep recursion
        .into_iter()
        .filter_entry(|e| !e.path().starts_with(".git")) // Skip .git
        .filter_entry(|e| e.file_type().is_file());

    for entry in walker {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let size = path.metadata().map(|m| m.len()).unwrap_or(0);

        // Skip large files
        if size > 10_000_000 { // 10MB limit
            continue;
        }

        let content = fs::read_to_string(path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

        files.push(FileEntry {
            path: path.to_string_lossy().into_owned(),
            content,
        });
    }
    Ok(files)
}
```

### 3. HTTP Client Improvements

```rust
// In AppState initialization
let http_client = HttpClient::builder()
    .timeout(Duration::from_secs(120))
    .build()?;

let ollama_client = HttpClient::builder()
    .timeout(None) // No timeout for local
    .build()?;

// In call_gemini_secure
let mut response = client.post(url)
    .header("Content-Type", "application/json")
    .header("x-goog-api-key", &key)
    .header("User-Agent", "Repo-Prompt-Analyzer/1.0")
    .body(body)
    .send()
    .await
    .map_err(|e| e.to_string())?;

let status = response.status();
let text = response.text().await.map_err(|e| e.to_string())?;

// Check status once, use text once
if !status.is_success() {
    return Err(format!("Gemini API error: {} - {}", status, text));
}
```

### 4. Architectural Improvements

```rust
// Define a RepoProvider trait
pub trait RepoProvider {
    async fn get_files(&self) -> Result<Vec<FileEntry>, String>;
}

// Implement for different sources
struct GitHubProvider { /* ... */ }
impl RepoProvider for GitHubProvider { /* ... */ }

struct LocalProvider { /* ... */ }
impl RepoProvider for LocalProvider { /* ... */ }

// Usage in scoring algorithm
async fn score_repository(provider: impl RepoProvider) -> Result<f64, String> {
    let files = provider.get_files().await?;
    // Common scoring logic
}
```

## Additional Recommendations

1. **Logging Improvements**:
   - Replace println! with proper logging
   - Mask sensitive data in logs
   - Add correlation IDs for request tracing

2. **Error Handling**:
   - Implement proper error types instead of strings
   - Add retry logic for transient failures
   - Better user feedback for API rate limits

3. **Configuration**:
   - Make file size limits configurable
   - Allow customization of excluded folders
   - Support for proxy configuration

4. **Testing**:
   - Add unit tests for core logic
   - Mock external API calls for testing
   - Integration tests for file scanning

These changes would address the critical issues while maintaining the existing functionality and improving the application's robustness and maintainability.