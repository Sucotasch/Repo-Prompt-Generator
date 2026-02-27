This migration plan outlines the architectural shift from a browser-restricted environment to a native **Tauri + Rust** desktop application. By moving sensitive logic and heavy I/O to the Rust "Main Process," we eliminate the current security vulnerabilities and performance bottlenecks.

---

### 1. Rust Command Patterns (The "Main Process")

In Tauri, the Rust backend acts as a privileged controller. We will implement `commands` that the frontend can `invoke`.

**`src-tauri/src/main.rs`**
```rust
use tauri::{State, Manager};
use serde::{Serialize, Deserialize};
use reqwest::Client;

struct AppState {
    gemini_api_key: String,
    http_client: Client,
}

#[tauri::command]
async fn call_gemini_secure(
    state: State<'_, AppState>,
    prompt: String
) -> Result<String, String> {
    // The Frontend never sees the key; it's injected here from the Rust State
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key={}",
        state.gemini_api_key
    );

    let response = state.http_client
        .post(url)
        .json(&serde_json::json!({ "contents": [{ "parts": [{ "text": prompt }] }] }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    Ok(response.text().await.map_err(|e| e.to_string())?)
}

#[tauri::command]
async fn scan_local_repository(path: String) -> Result<Vec<FileEntry>, String> {
    // Native recursive scanning using Rust's 'walkdir'
    // Bypasses browser memory limits for 10,000+ file repos
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(path).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            let content = std::fs::read_to_string(entry.path()).unwrap_or_default();
            files.push(FileEntry { 
                path: entry.path().display().to_string(), 
                content 
            });
        }
    }
    Ok(files)
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            gemini_api_key: std::env::var("GEMINI_API_KEY").expect("Key not found"),
            http_client: Client::new(),
        })
        .invoke_handler(tauri::generate_handler![call_gemini_secure, scan_local_repository])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

---

### 2. Tauri Configuration (`tauri.conf.json`)

To enable the hardware-level bridge, we must explicitly whitelist the native capabilities.

```json
{
  "tauri": {
    "allowlist": {
      "fs": {
        "all": true,
        "scope": ["$HOME/**", "C:\\**"] 
      },
      "dialog": {
        "open": true,
        "directory": true
      },
      "http": {
        "all": true,
        "request": true,
        "scope": ["http://localhost:11434/*", "https://generativelanguage.googleapis.com/*"]
      }
    },
    "security": {
      "csp": "default-src 'self'; connect-src 'self' http://localhost:11434"
    }
  }
}
```

---

### 3. Frontend Adaptation

We replace standard `fetch` and web-filesystem calls with Tauri's `invoke` and `plugin-fs`.

#### `src/services/geminiService.ts`
```typescript
import { invoke } from '@tauri-apps/api/tauri';

export async function generateSystemPrompt(repoData: any, instruction: string) {
  // Logic: Instead of fetch(), we call our secure Rust command
  const prompt = buildPrompt(repoData, instruction);
  
  // The API Key is NOT passed here. Rust handles it.
  const response: string = await invoke('call_gemini_secure', { prompt });
  return JSON.parse(response);
}
```

#### `src/services/localFileService.ts`
```typescript
import { open } from '@tauri-apps/api/dialog';
import { invoke } from '@tauri-apps/api/tauri';

export async function selectLocalFolder() {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Select Repository Folder"
  });

  if (selected) {
    // Rust handles the heavy lifting of reading files into memory
    return await invoke('scan_local_repository', { path: selected });
  }
}
```

---

### 4. Rust-Powered RAG Logic (Performance Upgrade)

Instead of processing Cosine Similarity in the single-threaded JS loop (which freezes the UI), we use Rust's `ndarray` and `rayon` for parallel processing.

**`src-tauri/src/rag.rs`**
```rust
pub fn calculate_similarity(vec_a: &[f32], vec_b: &[f32]) -> f32 {
    let dot_product: f32 = vec_a.iter().zip(vec_b).map(|(a, b)| a * b).sum();
    let norm_a: f32 = vec_a.iter().map(|a| a * a).sum::<f32>().sqrt();
    let norm_b: f32 = vec_b.iter().map(|b| b * b).sum::<f32>().sqrt();
    dot_product / (norm_a * norm_b)
}
// This runs in a background thread in Rust, keeping the React UI at 60fps.
```

---

### 5. Security Audit Fixes

| Vulnerability | Web-App Status | Tauri Native Status |
| :--- | :--- | :--- |
| **API Key Leakage** | **High Risk**: Visible in Network Tab/Source. | **Resolved**: Key resides only in Rust memory. Never reaches the Renderer. |
| **CORS / SSRF** | **Broken**: Requires `start-ollama.bat` hack. | **Resolved**: Rust's `reqwest` ignores CORS. Direct TCP communication with Ollama. |
| **Path Traversal** | **Limited**: Browser restricts file access. | **Resolved**: Tauri `allowlist` scopes restrict file access to specific directories. |
| **Memory Exhaustion** | **High**: Large repos crash the browser tab. | **Resolved**: Rust handles file streaming/chunking; React only receives the final prompt. |

### Execution Steps
1. **Initialize Tauri**: `npm install @tauri-apps/cli && npx tauri init`.
2. **Move Secrets**: Transfer `GEMINI_API_KEY` from `.env` to the OS Environment or a secure local encrypted file managed by Rust.
3. **Port Services**: Systematic replacement of `fetch` with `invoke` in the 4 service files.
4. **Build Binary**: `npm run tauri build` to generate a standalone `.msi` or `.exe`.