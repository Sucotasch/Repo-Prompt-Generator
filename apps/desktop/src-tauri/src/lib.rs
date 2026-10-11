use isahc::prelude::*;
use isahc::HttpClient;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use sysinfo::System;
use tauri::{State, RunEvent, Manager};
use tokio::sync::RwLock;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const DEFAULT_MODEL_FLASH: &str = "gemini-3-flash-preview";
const DEFAULT_MODEL_PRO: &str = "gemini-3.1-pro-preview";
const STATIC_ALLOWED_HOSTS: [&str; 2] = [
    "api.github.com",
    "generativelanguage.googleapis.com",
];

/// UTF-8-safe "first 4 + last 4 chars" hint for logs; never panics on
/// multi-byte characters (a naive byte slice does).
fn key_hint(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    let head: String = chars.iter().take(4).collect();
    let tail: String = if chars.len() > 8 {
        chars[chars.len() - 4..].iter().collect()
    } else {
        String::new()
    };
    if tail.is_empty() {
        head
    } else {
        format!("{head}...{tail}")
    }
}

/// Extracts the lowercase host from a URL, prepending http:// when the
/// scheme is missing (settings fields accept both forms).
fn host_of(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }
    let owned = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    isahc::http::Uri::try_from(owned.as_str())
        .ok()?
        .host()
        .map(|h| h.to_lowercase())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    path: String,
    content: String,
}

pub struct AppState {
    pub gemini_api_key: RwLock<String>,
    pub http_client: RwLock<HttpClient>,
    pub ollama_client: HttpClient,
    pub ollama_child: Mutex<Option<Child>>,
    pub allowed_hosts: RwLock<HashSet<String>>,
}

// rename_all: JS passes snake_case keys (gemini_key) — see note on ai_network_request.
#[tauri::command(rename_all = "snake_case")]
async fn set_app_config(
    state: State<'_, AppState>,
    gemini_key: Option<String>,
    proxy: Option<String>,
    custom_base_url: Option<String>,
    ollama_url: Option<String>,
) -> Result<(), String> {
    if let Some(key) = gemini_key {
        *state.gemini_api_key.write().await = key.trim().to_string();
    }

    // Provider hosts configurable from the UI join the ai_network_request
    // allowlist (static GitHub/Gemini hosts are seeded at startup).
    for url in [custom_base_url.as_deref(), ollama_url.as_deref()]
        .into_iter()
        .flatten()
    {
        if let Some(host) = host_of(url) {
            state.allowed_hosts.write().await.insert(host);
        }
    }

    let proxy_url = proxy.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());

    // Build the client with an EXPLICIT proxy config. The previous
    // implementation set HTTPS_PROXY env vars around the client build and
    // restored them — but libcurl resolves the proxy at request time, after
    // the vars were already restored, so the setting never actually applied.
    // proxy(None) also explicitly disables env-var proxy detection, making an
    // empty field mean "direct, guaranteed".
    let mut builder = isahc::HttpClient::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(3600));

    let client = match proxy_url {
        Some(url) => {
            let proxy_uri = if !url.starts_with("http") {
                format!("http://{}", url)
            } else {
                url.to_string()
            };
            let uri: isahc::http::Uri = proxy_uri
                .parse()
                .map_err(|e| format!("Invalid proxy address '{}': {}", proxy_uri, e))?;
            builder = builder.proxy(Some(uri));
            builder
                .build()
                .map_err(|e| format!("Failed to create proxy client: {}", e))?
        }
        None => builder
            .proxy(None)
            .build()
            .map_err(|e| format!("Failed to create client: {}", e))?,
    };

    *state.http_client.write().await = client;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
async fn call_gemini_secure(state: State<'_, AppState>, prompt: String, model: Option<String>) -> Result<String, String> {
    let key = state.gemini_api_key.read().await.clone();

    if key.is_empty() {
        return Err("Gemini API key is missing. Please enter it in the settings or set the GEMINI_API_KEY environment variable.".to_string());
    }

    println!("[Gemini] key present (len: {})", key.len());

    let model_name = model.unwrap_or_else(|| DEFAULT_MODEL_FLASH.to_string());
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent", model_name);

    let body = serde_json::json!({
        "contents": [{ "parts": [{ "text": prompt }] }]
    });

    let request = isahc::Request::builder()
        .method("POST")
        .uri(url)
        .header("Content-Type", "application/json")
        .header("x-goog-api-key", &key)
        .body(serde_json::to_string(&body).unwrap())
        .map_err(|e| e.to_string())?;

    let client = state.http_client.read().await.clone();
    let mut response = client
        .send_async(request)
        .await
        .map_err(|e| format!("Gemini API connection error: {}", e))?;

    let status = response.status();
    let res_text = response.text().await.unwrap_or_else(|_| "Could not read response body".to_string());

    if !status.is_success() {
        return Err(format!("Gemini API error ({}): {}", status, res_text));
    }

    Ok(res_text)
}

#[tauri::command]
async fn call_gemini_advanced(state: State<'_, AppState>, contents: serde_json::Value, tools: Option<serde_json::Value>, model: Option<String>) -> Result<serde_json::Value, String> {
    let key = state.gemini_api_key.read().await.clone();

    if key.is_empty() {
        return Err("Gemini API key is missing. Please enter it in the settings or set the GEMINI_API_KEY environment variable.".to_string());
    }

    let model_name = model.unwrap_or_else(|| DEFAULT_MODEL_PRO.to_string());
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent", model_name);

    let mut body_map = serde_json::Map::new();
    body_map.insert("contents".to_string(), contents);
    if let Some(t) = tools {
        body_map.insert("tools".to_string(), t);
    }
    let body = serde_json::Value::Object(body_map);

    let request = isahc::Request::builder()
        .method("POST")
        .uri(url)
        .header("Content-Type", "application/json")
        .header("x-goog-api-key", &key)
        .body(body.to_string())
        .map_err(|e| e.to_string())?;

    let client = state.http_client.read().await.clone();
    let mut response = client.send_async(request).await.map_err(|e| e.to_string())?;

    let response_body = response.text().await.map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("Gemini API error: {} - {}", response.status(), response_body));
    }

    let json: serde_json::Value = serde_json::from_str(&response_body).map_err(|e| e.to_string())?;
    Ok(json)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    owner: String,
    repo: String,
    default_branch: String,
    description: String,
    stargazers_count: Option<u32>,
    topics: Option<Vec<String>>,
    language: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepoData {
    info: RepoInfo,
    tree: Vec<String>,
    readme: String,
    dependencies: String,
    source_files: Vec<FileEntry>,
    is_truncated: bool,
}

#[tauri::command]
async fn fetch_github_repo(
    state: State<'_, AppState>,
    owner: String,
    repo: String,
    branch: Option<String>,
    token: Option<String>,
    max_files: Option<u32>,
) -> Result<GithubRepoData, String> {
    use tokio::task::JoinSet;
    use std::sync::Arc;

    let client = Arc::new(state.http_client.read().await.clone());
    let token_arc = Arc::new(token.unwrap_or_default());

    // 1. Fetch basic info
    let info_url = format!("https://api.github.com/repos/{}/{}", owner, repo);
    let mut builder = isahc::Request::builder()
        .method("GET")
        .uri(&info_url)
        .timeout(Duration::from_secs(30))
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "Tauri/Prompt-Generator");

    if !token_arc.is_empty() {
        builder = builder.header("Authorization", format!("token {}", *token_arc));
    }

    let mut info_res = client.send_async(builder.body("".to_string()).unwrap()).await.map_err(|e| e.to_string())?;
    if !info_res.status().is_success() {
        return Err(format!("Failed to fetch repo info: {}", info_res.status()));
    }
    
    let info_text = info_res.text().await.map_err(|e| e.to_string())?;
    let info_json: serde_json::Value = serde_json::from_str(&info_text).map_err(|e| e.to_string())?;
    let default_branch = branch.filter(|b| !b.is_empty()).unwrap_or_else(|| {
        info_json["default_branch"].as_str().unwrap_or("main").to_string()
    });
    let description = info_json["description"].as_str().unwrap_or("No description.").to_string();
    let stargazers_count = info_json["stargazers_count"].as_u64().map(|n| n as u32);
    let topics = info_json["topics"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect());
    let language = info_json["language"].as_str().map(|s| s.to_string());

    // 2. Fetch tree
    let tree_url = format!("https://api.github.com/repos/{}/{}/git/trees/{}?recursive=1", owner, repo, default_branch);
    let mut tree_builder = isahc::Request::builder()
        .method("GET")
        .uri(&tree_url)
        .timeout(Duration::from_secs(30))
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "Tauri/Prompt-Generator");

    if !token_arc.is_empty() {
        tree_builder = tree_builder.header("Authorization", format!("token {}", *token_arc));
    }

    let mut tree_res = client.send_async(tree_builder.body("".to_string()).unwrap()).await.map_err(|e| e.to_string())?;
    if !tree_res.status().is_success() {
        let status = tree_res.status();
        let body = tree_res.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|j| j["message"].as_str().map(|s| s.to_string()))
            .unwrap_or_default();
        return Err(format!(
            "GitHub API error {status} fetching the file tree: {msg} (rate limit? unauthenticated GitHub allows 60 requests/hour — add a token)",
        ));
    }
    let tree_text = tree_res.text().await.map_err(|e| e.to_string())?;
    let tree_json: serde_json::Value = serde_json::from_str(&tree_text).map_err(|e| e.to_string())?;
    let mut tree_paths: Vec<String> = tree_json["tree"]
        .as_array()
        .map(|a| a.iter().filter(|i| i["type"] == "blob").filter_map(|i| i["path"].as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    // 3. Parallel fetch for README and dependencies
    let dep_files_list = ["package.json", "requirements.txt", "go.mod", "Cargo.toml", "pom.xml", "build.gradle"];
    let mut join_set = JoinSet::new();

    // Fetch README
    let readme_url = format!("https://api.github.com/repos/{}/{}/readme", owner, repo);
    let client_c = Arc::clone(&client);
    let token_c = Arc::clone(&token_arc);
    join_set.spawn(async move {
        let mut b = isahc::Request::builder()
            .uri(&readme_url)
            .timeout(Duration::from_secs(30))
            .header("Accept", "application/vnd.github.v3+json")
            .header("User-Agent", "Tauri/Prompt-Generator");
        if !token_c.is_empty() { b = b.header("Authorization", format!("token {}", *token_c)); }
        
        if let Ok(mut res) = client_c.send_async(b.body("".to_string()).unwrap()).await {
            if res.status().is_success() {
                if let Ok(text) = res.text().await {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let Some(content) = json["content"].as_str() {
                            let cleaned = content.replace('\n', "").replace('\r', "");
                            if let Ok(decoded) = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, cleaned) {
                                return Some(("readme", String::from_utf8_lossy(&decoded).to_string()));
                            }
                        }
                    }
                }
            }
        }
        None
    });

    // Fetch deps
    for file in dep_files_list {
        if tree_paths.contains(&file.to_string()) {
            let client_c = Arc::clone(&client);
            let token_c = Arc::clone(&token_arc);
            let file_name = file.to_string();
            let file_url = format!("https://api.github.com/repos/{}/{}/contents/{}", owner, repo, file);
            join_set.spawn(async move {
                let mut b = isahc::Request::builder()
                    .uri(&file_url)
                    .timeout(Duration::from_secs(30))
                    .header("Accept", "application/vnd.github.v3+json")
                    .header("User-Agent", "Tauri/Prompt-Generator");
                if !token_c.is_empty() { b = b.header("Authorization", format!("token {}", *token_c)); }
                
                if let Ok(mut res) = client_c.send_async(b.body("".to_string()).unwrap()).await {
                    if res.status().is_success() {
                        if let Ok(text) = res.text().await {
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                                if let Some(content) = json["content"].as_str() {
                                    let cleaned = content.replace('\n', "").replace('\r', "");
                                    if let Ok(decoded) = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, cleaned) {
                                        return Some(("dep", format!("\n--- {} ---\n{}\n", file_name, String::from_utf8_lossy(&decoded))));
                                    }
                                }
                            }
                        }
                    }
                }
                None
            });
        }
    }

    let mut readme = String::new();
    let mut dependencies = String::new();
    while let Some(res) = join_set.join_next().await {
        if let Ok(Some((type_tag, content))) = res {
            if type_tag == "readme" { readme = content; }
            else { dependencies.push_str(&content); }
        }
    }

    // 4. Determine and fetch source files in parallel
    let source_extensions = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".cpp", ".c", ".h", ".cs", ".md"];
    let mut files_to_fetch: Vec<String> = tree_paths.iter()
        .filter(|p| source_extensions.iter().any(|ext| p.ends_with(ext)))
        .filter(|p| !dep_files_list.contains(&p.as_str()) && p.to_lowercase() != "readme.md")
        .cloned().collect();

    fn get_file_score(path: &str) -> i32 {
        let mut score = 0;
        let lower = path.to_lowercase();
        let parts: Vec<&str> = lower.split('/').collect();
        let name = parts.last().unwrap_or(&"");
        if lower.contains("/test/") || lower.contains("/tests/") || lower.contains("__tests__") || name.contains(".test.") || name.contains(".spec.") { score -= 50; }
        if ["build", "setup", "config", "webpack", "vite", "docs/"].iter().any(|&k| lower.contains(k)) { score -= 30; }
        if ["src/", "lib/", "app/", "core/"].iter().any(|&d| lower.starts_with(d) || lower.contains(&format!("/{}", d))) { score += 20; }
        if ["main", "index", "app", "server", "core", "api", "service", "model"].iter().any(|&n| name.contains(n)) { score += 10; }
        score -= parts.len() as i32;
        score
    }

    files_to_fetch.sort_by(|a, b| get_file_score(b).cmp(&get_file_score(a)));
    let limit = max_files.unwrap_or(5).clamp(1, 200) as usize;
    let selected = if files_to_fetch.len() > limit { files_to_fetch[0..limit].to_vec() } else { files_to_fetch };

    let mut source_join_set = JoinSet::new();
    for file in selected {
        let client_c = Arc::clone(&client);
        let token_c = Arc::clone(&token_arc);
        let path = file.clone();
        let file_url = format!("https://api.github.com/repos/{}/{}/contents/{}", owner, repo, file);
        source_join_set.spawn(async move {
            let mut b = isahc::Request::builder()
                .uri(&file_url)
                .timeout(Duration::from_secs(30))
                .header("Accept", "application/vnd.github.v3+json")
                .header("User-Agent", "Tauri/Prompt-Generator");
            if !token_c.is_empty() { b = b.header("Authorization", format!("token {}", *token_c)); }
            
            if let Ok(mut res) = client_c.send_async(b.body("".to_string()).unwrap()).await {
                if res.status().is_success() {
                    if let Ok(text) = res.text().await {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                            if let Some(content) = json["content"].as_str() {
                                let cleaned = content.replace('\n', "").replace('\r', "");
                                if let Ok(decoded) = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, cleaned) {
                                    return Some(FileEntry { path, content: String::from_utf8_lossy(&decoded).to_string() });
                                }
                            }
                        }
                    }
                }
            }
            None
        });
    }

    let mut source_files = Vec::new();
    while let Some(res) = source_join_set.join_next().await {
        if let Ok(Some(entry)) = res { source_files.push(entry); }
    }

    let mut is_truncated = false;
    if tree_paths.len() > 1000 { tree_paths.truncate(1000); is_truncated = true; }

    Ok(GithubRepoData {
        info: RepoInfo { owner, repo, default_branch, description, stargazers_count, topics, language },
        tree: tree_paths, readme, dependencies, source_files, is_truncated,
    })
}

#[tauri::command]
async fn is_ollama_running() -> bool {
    let mut s = System::new();
    s.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, sysinfo::ProcessRefreshKind::everything());
    let name_win = OsStr::new("ollama.exe");
    let name_unix = OsStr::new("ollama");
    
    s.processes().values().any(|p| p.name() == name_win || p.name() == name_unix)
}

#[tauri::command]
async fn start_ollama(state: State<'_, AppState>) -> Result<String, String> {
    if is_ollama_running().await {
        return Ok("Ollama is already running".to_string());
    }

    #[cfg(target_os = "windows")]
    let child = Command::new("ollama")
        .arg("serve")
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .spawn();

    #[cfg(not(target_os = "windows"))]
    let child = Command::new("ollama")
        .arg("serve")
        .spawn();

    match child {
        Ok(child) => {
            *state.ollama_child.lock().unwrap() = Some(child);
            Ok("Ollama started successfully".to_string())
        }
        Err(e) => Err(format!("Failed to start Ollama: {}", e)),
    }
}

#[tauri::command]
async fn save_text_file(path: String, content: String) -> Result<String, String> {
    match fs::write(&path, content) {
        Ok(_) => Ok(format!("Successfully saved to {}", path)),
        Err(e) => Err(format!("Failed to save file: {}", e)),
    }
}

#[tauri::command]
async fn stop_ollama(state: State<'_, AppState>) -> Result<String, String> {
    // Kill only the instance this application spawned — never a user-started one.
    let child = state.ollama_child.lock().unwrap().take();
    match child {
        Some(mut child) => match child.kill() {
            Ok(_) => {
                let _ = child.wait();
                Ok("Stopped the Ollama instance started by this application.".to_string())
            }
            Err(e) => Err(format!("Failed to stop Ollama: {}", e)),
        },
        None => Ok("No Ollama process was started by this application.".to_string()),
    }
}

#[tauri::command]
async fn ollama_check_connection(state: State<'_, AppState>, url: String) -> Result<bool, String> {
    let url = url.replacen("://localhost", "://127.0.0.1", 1);
    let endpoint = format!("{}/api/tags", url);
    let res = state.ollama_client.get_async(&endpoint).await;
    match res {
        Ok(r) => Ok(r.status().is_success()),
        Err(e) => {
            eprintln!("Ollama connection error for {}: {}", endpoint, e);
            Ok(false)
        }
    }
}

#[tauri::command]
async fn ollama_fetch_models(state: State<'_, AppState>, url: String) -> Result<Vec<String>, String> {
    let url = url.replacen("://localhost", "://127.0.0.1", 1);
    let endpoint = format!("{}/api/tags", url);
    let mut res = state.ollama_client.get_async(&endpoint).await.map_err(|e| {
        eprintln!("Ollama fetch models error for {}: {}", endpoint, e);
        e.to_string()
    })?;
    
    if !res.status().is_success() {
        return Err(format!("Ollama models: HTTP {}", res.status()));
    }

    let data_text = res.text().await.map_err(|e| e.to_string())?;
    let data: serde_json::Value = serde_json::from_str(&data_text).map_err(|e| e.to_string())?;
    let models = data["models"]
        .as_array()
        .map(|a: &Vec<serde_json::Value>| {
            a.iter()
                .filter_map(|m| m["name"].as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    
    Ok(models)
}

#[tauri::command]
async fn ollama_generate(
    state: State<'_, AppState>,
    url: String,
    model: String,
    prompt: String,
    num_ctx: Option<usize>,
    num_predict: Option<usize>,
    temperature: Option<f32>,
    format: Option<String>,
) -> Result<String, String> {
    let url = url.replacen("://localhost", "://127.0.0.1", 1);
    let endpoint = format!("{}/api/generate", url);
    
    let mut options = serde_json::Map::new();
    if let Some(ctx) = num_ctx { options.insert("num_ctx".to_string(), serde_json::Value::from(ctx)); }
    if let Some(predict) = num_predict { options.insert("num_predict".to_string(), serde_json::Value::from(predict)); }
    if let Some(temp) = temperature { options.insert("temperature".to_string(), serde_json::Value::from(temp)); }

    let mut body_map: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    body_map.insert("model".to_string(), serde_json::Value::from(model));
    body_map.insert("prompt".to_string(), serde_json::Value::from(prompt));
    body_map.insert("stream".to_string(), serde_json::Value::from(false));
    body_map.insert("options".to_string(), serde_json::Value::Object(options));
    if let Some(f) = format {
        body_map.insert("format".to_string(), serde_json::Value::from(f));
    }
    let body = serde_json::Value::Object(body_map);

    let request = isahc::Request::builder()
        .method("POST")
        .uri(endpoint)
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&body).unwrap())
        .map_err(|e| e.to_string())?;

    let mut res = state.ollama_client
        .send_async(request)
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    let data_text = res.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(format!("Ollama error: {}", data_text));
    }

    let data: serde_json::Value = serde_json::from_str(&data_text).map_err(|e| e.to_string())?;
    let response = data["response"].as_str().unwrap_or_default().to_string();
    
    Ok(response)
}

#[tauri::command]
async fn ollama_embed(
    state: State<'_, AppState>,
    url: String,
    model: String,
    prompt: String,
) -> Result<Vec<f32>, String> {
    let url = url.replacen("://localhost", "://127.0.0.1", 1);
    let endpoint = format!("{}/api/embeddings", url);
    
    let body = serde_json::json!({
        "model": model,
        "prompt": prompt
    });

    let request = isahc::Request::builder()
        .method("POST")
        .uri(endpoint)
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&body).unwrap())
        .map_err(|e| e.to_string())?;

    let mut res = state.ollama_client
        .send_async(request)
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    let res_text = res.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(format!("Ollama error: {}", res_text));
    }

    let data: serde_json::Value = serde_json::from_str(&res_text).map_err(|e| e.to_string())?;
    let embedding = data["embedding"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_f64().map(|f| f as f32))
                .collect()
        })
        .ok_or_else(|| "No embedding field in response".to_string())?;
    
    Ok(embedding)
}

// rename_all: Tauri v2 expects camelCase JS keys by default; the JS side of
// this codebase passes snake_case (timeout_secs) — without this attribute the
// argument is silently dropped and the per-request timeout never applies.
#[tauri::command(rename_all = "snake_case")]
async fn ai_network_request(
    state: State<'_, AppState>,
    method: String,
    url: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<serde_json::Value, String> {
    let url = url.replacen("://localhost", "://127.0.0.1", 1);

    // Host allowlist: the webview may only reach GitHub, Gemini, and hosts
    // configured in settings (custom provider Base URL / local engine API URL).
    let host = isahc::http::Uri::try_from(url.as_str())
        .ok()
        .and_then(|u| u.host().map(|h| h.to_lowercase()));
    let mut is_allowed = matches!(
        host.as_deref(),
        Some("127.0.0.1") | Some("localhost") | Some("::1")
    );
    if !is_allowed {
        if let Some(h) = host.as_deref() {
            is_allowed = state.allowed_hosts.read().await.contains(h);
        }
    }
    if !is_allowed {
        return Err(format!(
            "Host not allowed by the desktop security policy: {url}. Configure it via the provider Base URL / API URL settings."
        ));
    }

    // Per-request total timeout: short for metadata calls (/models), the
    // client default (1h) for long LLM generations.
    let timeout_secs = timeout_secs.unwrap_or(3600);
    let mut builder = isahc::Request::builder()
        .method(method.as_str())
        .uri(&url)
        .timeout(Duration::from_secs(timeout_secs));

    for (k, v) in headers {
        builder = builder.header(k, v);
    }

    let request = if let Some(b) = body {
        builder.body(b).map_err(|e| e.to_string())?
    } else {
        builder.body("".to_string()).map_err(|e| e.to_string())?
    };

    let client = state.http_client.read().await.clone();
    let mut res = client.send_async(request).await.map_err(|e| {
        if e.is_timeout() {
            format!(
                "Request timed out after {}s. The host did not respond — if you use a proxy (Global Proxy Address), check that it can reach this endpoint.",
                timeout_secs
            )
        } else {
            e.to_string()
        }
    })?;
    
    let mut res_headers = serde_json::Map::new();
    for (name, value) in res.headers() {
        res_headers.insert(name.to_string(), serde_json::Value::from(value.to_str().unwrap_or_default()));
    }

    let status = res.status();
    let text = res.text().await.unwrap_or_default();

    let mut result = serde_json::Map::new();
    result.insert("status".to_string(), serde_json::Value::from(status.as_u16()));
    result.insert("text".to_string(), serde_json::Value::from(text));
    result.insert("headers".to_string(), serde_json::Value::Object(res_headers));

    Ok(serde_json::Value::Object(result))
}

#[tauri::command]
async fn get_gemini_key_source(state: State<'_, AppState>) -> Result<String, String> {
    let app_key = state.gemini_api_key.read().await.clone();
    if !app_key.is_empty() {
        return Ok(format!("app_state:{}", key_hint(&app_key)));
    }

    let env_key = std::env::var("GEMINI_API_KEY")
        .or_else(|_| std::env::var("VITE_GEMINI_API_KEY"))
        .unwrap_or_default();

    if env_key.is_empty() || env_key == "YOUR_GEMINI_API_KEY_HERE" {
        Ok("none".to_string())
    } else {
        Ok(format!("env:{}", key_hint(&env_key)))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Priority: GEMINI_API_KEY (system) > VITE_GEMINI_API_KEY (.env) > empty
    let gemini_api_key = std::env::var("GEMINI_API_KEY")
        .or_else(|_| std::env::var("VITE_GEMINI_API_KEY"))
        .unwrap_or_default()
        .trim()
        .to_string();

    println!(
        "[Init] Gemini API key from env: {} (len: {})",
        if gemini_api_key.is_empty() { "NOT FOUND" } else { "present" },
        gemini_api_key.len()
    );

    let allowed_hosts: HashSet<String> = STATIC_ALLOWED_HOSTS
        .iter()
        .map(|s| s.to_string())
        .collect();

    let client = HttpClient::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .build()
        .expect("Failed to create HTTP client");

    let ollama_client = HttpClient::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(3600))
        .build()
        .expect("Failed to create Ollama client");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Persist window size/position/maximized state across restarts
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(AppState {
            gemini_api_key: RwLock::new(gemini_api_key),
            http_client: RwLock::new(client),
            ollama_client,
            ollama_child: Mutex::new(None),
            allowed_hosts: RwLock::new(allowed_hosts),
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            call_gemini_secure,
            call_gemini_advanced,
            fetch_github_repo,
            is_ollama_running,
            start_ollama,
            stop_ollama,
            save_text_file,
            ollama_check_connection,
            ollama_fetch_models,
            ollama_generate,
            ollama_embed,
            get_gemini_key_source,
            set_app_config,
            ai_network_request
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app_handle, event| {
            if let RunEvent::Exit = event {
                // Stop only the Ollama instance this application spawned.
                let child = {
                    let state = app_handle.state::<AppState>();
                    let mut guard = state.ollama_child.lock().unwrap();
                    guard.take()
                };
                if let Some(mut child) = child {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
