use isahc::prelude::*;
use isahc::HttpClient;
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs;
use std::process::Command;
use std::time::Duration;
use std::sync::atomic::{AtomicBool, Ordering};
use sysinfo::{System, ProcessRefreshKind};
use tauri::{State, RunEvent, Manager};
use tokio::sync::RwLock;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

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
    pub we_started_ollama: AtomicBool,
}

#[tauri::command]
async fn set_app_config(state: State<'_, AppState>, gemini_key: Option<String>, proxy: Option<String>) -> Result<(), String> {
    if let Some(key) = gemini_key {
        *state.gemini_api_key.write().await = key.trim().to_string();
    }

    let proxy_url = proxy.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());
    
    let client = if let Some(url) = proxy_url {
        let proxy_uri = if !url.starts_with("http") {
            format!("http://{}", url)
        } else {
            url.to_string()
        };
        
        let old_https = std::env::var("HTTPS_PROXY").ok();
        let old_http = std::env::var("HTTP_PROXY").ok();
        
        std::env::set_var("HTTPS_PROXY", &proxy_uri);
        std::env::set_var("HTTP_PROXY", &proxy_uri);
        
        let c = isahc::HttpClient::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| format!("Failed to create proxy client: {}", e))?;
            
        if let Some(old) = old_https {
            std::env::set_var("HTTPS_PROXY", old);
        } else {
            std::env::remove_var("HTTPS_PROXY");
        }
        if let Some(old) = old_http {
            std::env::set_var("HTTP_PROXY", old);
        } else {
            std::env::remove_var("HTTP_PROXY");
        }
        c
    } else {
        isahc::HttpClient::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| format!("Failed to create client: {}", e))?
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

    println!("[Gemini] Using key: {}... (len: {})", &key[..std::cmp::min(4, key.len())], key.len());

    let model_name = model.unwrap_or_else(|| "gemini-3-flash-preview".to_string());
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
async fn scan_local_repository(path: String) -> Result<Vec<FileEntry>, String> {
    use tokio::task::JoinSet;
    let mut files = Vec::new();
    let mut set = JoinSet::new();

    let walker = walkdir::WalkDir::new(path)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            let is_hidden = name.starts_with(".git") || name == ".venv" || name == ".idea" || name == ".vscode";
            let is_heavy = name == "node_modules" || name == "target" || name == "venv" || name == "build" || name == "__pycache__";
            !is_hidden && !is_heavy
        });

    for entry in walker.filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            if let Ok(metadata) = entry.metadata() {
                if metadata.len() > 1_000_000 {
                    continue; // Skip files > 1MB
                }
            }
            
            let file_path = entry.path().to_path_buf();
            set.spawn_blocking(move || {
                match fs::read_to_string(&file_path) {
                    Ok(content) => Some(FileEntry {
                        path: file_path.display().to_string(),
                        content,
                    }),
                    Err(_) => None,
                }
            });
        }
    }

    while let Some(result) = set.join_next().await {
        if let Ok(Some(file_entry)) = result {
            files.push(file_entry);
        }
    }

    Ok(files)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    owner: String,
    repo: String,
    default_branch: String,
    description: String,
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

    // 2. Fetch tree
    let tree_url = format!("https://api.github.com/repos/{}/{}/git/trees/{}?recursive=1", owner, repo, default_branch);
    let mut tree_builder = isahc::Request::builder()
        .method("GET")
        .uri(&tree_url)
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "Tauri/Prompt-Generator");

    if !token_arc.is_empty() {
        tree_builder = tree_builder.header("Authorization", format!("token {}", *token_arc));
    }

    let mut tree_res = client.send_async(tree_builder.body("".to_string()).unwrap()).await.map_err(|e| e.to_string())?;
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
        info: RepoInfo { owner, repo, default_branch, description },
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
        Ok(_) => {
            state.we_started_ollama.store(true, Ordering::SeqCst);
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
    let we_started_it = state.we_started_ollama.swap(false, Ordering::SeqCst);

    if we_started_it {
        let mut s = System::new();
        s.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, ProcessRefreshKind::everything());
        let mut killed = 0;
        
        for process in s.processes_by_exact_name(OsStr::new("ollama.exe")) {
            process.kill();
            killed += 1;
        }
        for process in s.processes_by_exact_name(OsStr::new("ollama")) {
            process.kill();
            killed += 1;
        }
        
        if killed > 0 {
            return Ok(format!("Stopped {} Ollama processes", killed));
        }
        Ok("Process not found. It may have exited.".to_string())
    } else {
        Ok("No Ollama process was started by this application.".to_string())
    }
}

#[tauri::command]
async fn ollama_check_connection(state: State<'_, AppState>, url: String) -> Result<bool, String> {
    let url = url.replace("localhost", "127.0.0.1");
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
    let url = url.replace("localhost", "127.0.0.1");
    let endpoint = format!("{}/api/tags", url);
    let mut res = state.ollama_client.get_async(&endpoint).await.map_err(|e| {
        eprintln!("Ollama fetch models error for {}: {}", endpoint, e);
        e.to_string()
    })?;
    
    if !res.status().is_success() {
        eprintln!("Ollama fetch models failed with status: {}", res.status());
        return Ok(Vec::new());
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
    let url = url.replace("localhost", "127.0.0.1");
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
    let url = url.replace("localhost", "127.0.0.1");
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

#[tauri::command]
async fn ai_network_request(
    state: State<'_, AppState>,
    method: String,
    url: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<String>
) -> Result<serde_json::Value, String> {
    let url = url.replace("localhost", "127.0.0.1");
    let mut builder = isahc::Request::builder()
        .method(method.as_str())
        .uri(&url);

    for (k, v) in headers {
        builder = builder.header(k, v);
    }

    let request = if let Some(b) = body {
        builder.body(b).map_err(|e| e.to_string())?
    } else {
        builder.body("".to_string()).map_err(|e| e.to_string())?
    };

    let client = state.http_client.read().await.clone();
    let mut res = client.send_async(request).await.map_err(|e| e.to_string())?;
    
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
async fn qwen_device_code(state: State<'_, AppState>, client_id: String, scope: String, code_challenge: String) -> Result<serde_json::Value, String> {
    // Original server.ts uses chat.qwen.ai with form-urlencoded body
    let url = "https://chat.qwen.ai/api/v1/oauth2/device/code";
    let form_body = format!(
        "client_id={}&scope={}&code_challenge={}&code_challenge_method=S256",
        urlencoding::encode(&client_id),
        urlencoding::encode(&scope),
        urlencoding::encode(&code_challenge)
    );

    let request = isahc::Request::builder()
        .method("POST")
        .uri(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .body(form_body)
        .map_err(|e| e.to_string())?;

    let client = state.http_client.read().await.clone();
    let mut res = client.send_async(request).await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({"error": text.clone()}));
    
    if !status.is_success() {
        return Err(format!("Qwen Auth Error ({}): {}", status, text));
    }
    Ok(json)
}

#[tauri::command]
async fn qwen_poll_token(state: State<'_, AppState>, client_id: String, device_code: String, code_verifier: String) -> Result<serde_json::Value, String> {
    // Original server.ts uses chat.qwen.ai with form-urlencoded body
    let url = "https://chat.qwen.ai/api/v1/oauth2/token";
    let form_body = format!(
        "grant_type={}&client_id={}&device_code={}&code_verifier={}",
        urlencoding::encode("urn:ietf:params:oauth:grant-type:device_code"),
        urlencoding::encode(&client_id),
        urlencoding::encode(&device_code),
        urlencoding::encode(&code_verifier)
    );

    let request = isahc::Request::builder()
        .method("POST")
        .uri(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .body(form_body)
        .map_err(|e| e.to_string())?;

    let client = state.http_client.read().await.clone();
    let mut res = client.send_async(request).await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({"error": text.clone()}));
    
    // 400 with authorization_pending is a valid intermediate state
    if !status.is_success() && status != 400 && status != 429 {
        return Err(format!("Qwen Token Error ({}): {}", status, text));
    }
    
    let mut result = json.as_object().unwrap_or(&serde_json::Map::new()).to_owned();
    result.insert("http_status".to_string(), serde_json::Value::from(status.as_u16()));
    
    Ok(serde_json::Value::Object(result))
}

#[tauri::command]
async fn qwen_ai_proxy(
    state: State<'_, AppState>, 
    token: String, 
    prompt: String, 
    model: String, 
    is_json: bool,
    resource_url: Option<String>
) -> Result<serde_json::Value, String> {
    // Use OpenAI-compatible endpoint (same as original server.ts)
    let mut endpoint = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions".to_string();
    if let Some(ref url) = resource_url {
        let mut base = url.clone();
        if !base.starts_with("http://") && !base.starts_with("https://") {
            base = format!("https://{}", base);
        }
        if !base.ends_with("/v1/chat/completions") {
            if !base.ends_with('/') { base.push('/'); }
            base.push_str("v1/chat/completions");
        }
        endpoint = base;
    }
    endpoint = endpoint.replace("localhost", "127.0.0.1");

    // Build OpenAI-compatible request body (same as original server.ts)
    let mut payload = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": "You are an expert software architect. Output clean markdown." },
            { "role": "user", "content": prompt }
        ],
        "temperature": if is_json { 0.1 } else { 0.3 }
    });

    if is_json {
        payload.as_object_mut().unwrap().insert(
            "response_format".to_string(), 
            serde_json::json!({ "type": "json_object" })
        );
    }

    let request = isahc::Request::builder()
        .method("POST")
        .uri(&endpoint)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", token))
        .body(serde_json::to_string(&payload).unwrap())
        .map_err(|e| e.to_string())?;

    let client = state.http_client.read().await.clone();
    let mut res = client.send_async(request).await.map_err(|e| e.to_string())?;
    
    // Capture rate limit headers
    let mut rate_limit = serde_json::Map::new();
    if let Some(h) = res.headers().get("x-ratelimit-remaining-requests") { rate_limit.insert("remainingRequests".to_string(), serde_json::Value::from(h.to_str().unwrap_or_default())); }
    if let Some(h) = res.headers().get("x-ratelimit-reset-requests") { rate_limit.insert("resetRequests".to_string(), serde_json::Value::from(h.to_str().unwrap_or_default())); }
    if let Some(h) = res.headers().get("x-ratelimit-remaining-tokens") { rate_limit.insert("remainingTokens".to_string(), serde_json::Value::from(h.to_str().unwrap_or_default())); }
    if let Some(h) = res.headers().get("x-ratelimit-reset-tokens") { rate_limit.insert("resetTokens".to_string(), serde_json::Value::from(h.to_str().unwrap_or_default())); }

    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({"error": format!("Non-JSON response: {}", &text[..std::cmp::min(100, text.len())])}));

    if !status.is_success() {
        let err_msg = json.get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .or_else(|| json.get("message").and_then(|m| m.as_str()))
            .unwrap_or("Qwen API Error");
        
        let mut err_result = serde_json::Map::new();
        err_result.insert("output".to_string(), serde_json::json!({"error": err_msg}));
        err_result.insert("rateLimit".to_string(), serde_json::Value::Object(rate_limit));
        err_result.insert("status".to_string(), serde_json::Value::from(status.as_u16()));
        return Ok(serde_json::Value::Object(err_result));
    }

    // Map OpenAI response format to the structure expected by qwenService.ts
    // Original server.ts returns: { output: { text: "..." }, model: "...", rateLimit: {...} }
    let response_text = json.get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let response_model = json.get("model").and_then(|m| m.as_str()).unwrap_or(&model);

    let mut result_obj = serde_json::Map::new();
    result_obj.insert("output".to_string(), serde_json::json!({
        "output": { "text": response_text },
        "model": response_model
    }));
    result_obj.insert("rateLimit".to_string(), serde_json::Value::Object(rate_limit));
    result_obj.insert("status".to_string(), serde_json::Value::from(status.as_u16()));

    Ok(serde_json::Value::Object(result_obj))
}

#[tauri::command]
async fn get_gemini_key_source(state: State<'_, AppState>) -> Result<String, String> {
    let app_key = state.gemini_api_key.read().await.clone();
    if !app_key.is_empty() {
        return Ok(format!("app_state:{}...{}", &app_key[..std::cmp::min(4, app_key.len())], &app_key[app_key.len().saturating_sub(4)..]));
    }

    let env_key = std::env::var("GEMINI_API_KEY")
        .or_else(|_| std::env::var("VITE_GEMINI_API_KEY"))
        .unwrap_or_default();
    
    if env_key.is_empty() || env_key == "YOUR_GEMINI_API_KEY_HERE" {
        Ok("none".to_string())
    } else {
        Ok(format!("env:{}...{}", &env_key[..std::cmp::min(4, env_key.len())], &env_key[env_key.len().saturating_sub(4)..]))
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

    println!("[Init] Gemini API key from env: {} (len: {})",
        if gemini_api_key.is_empty() { "NOT FOUND" } else { &gemini_api_key[..std::cmp::min(4, gemini_api_key.len())] },
        gemini_api_key.len()
    );

    let client = HttpClient::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .expect("Failed to create HTTP client");

    let ollama_client = HttpClient::builder()
        .timeout(Duration::from_secs(3600))
        .build()
        .expect("Failed to create Ollama client");

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            gemini_api_key: RwLock::new(gemini_api_key),
            http_client: RwLock::new(client),
            ollama_client,
            we_started_ollama: AtomicBool::new(false),
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
            scan_local_repository,
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
            qwen_device_code,
            qwen_poll_token,
            qwen_ai_proxy,
            ai_network_request
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app_handle, event| {
            if let RunEvent::Exit = event {
                let we_started_it = {
                    let state = app_handle.state::<AppState>();
                    state.we_started_ollama.swap(false, Ordering::SeqCst)
                };
                if we_started_it {
                    let mut s = System::new();
                    s.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, ProcessRefreshKind::everything());
                    for process in s.processes_by_exact_name(OsStr::new("ollama.exe")) {
                        let _ = process.kill();
                    }
                    for process in s.processes_by_exact_name(OsStr::new("ollama")) {
                        let _ = process.kill();
                    }
                }
            }
        });
}
