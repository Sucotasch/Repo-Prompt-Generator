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

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Serialize, Deserialize)]
pub struct FileEntry {
    path: String,
    content: String,
}

pub struct AppState {
    pub gemini_api_key: String,
    pub http_client: HttpClient,
    pub ollama_client: HttpClient,
    pub we_started_ollama: AtomicBool,
}

#[tauri::command(rename_all = "snake_case")]
async fn call_gemini_secure(state: State<'_, AppState>, prompt: String, api_key: Option<String>, proxy: Option<String>) -> Result<String, String> {
    let key = api_key
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| state.gemini_api_key.clone());

    if key.is_empty() {
        return Err("Gemini API key is missing. Please enter it in the settings or set the GEMINI_API_KEY environment variable.".to_string());
    }

    println!("[Gemini] Using key: {}... (len: {})", &key[..std::cmp::min(4, key.len())], key.len());

    let url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";

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

    // If proxy is specified, create a dedicated client with proxy
    let proxy_addr = proxy.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());
    let mut response = if let Some(proxy_url) = proxy_addr {
        println!("[Gemini] Using proxy: {}", proxy_url);
        let proxy_uri = if !proxy_url.starts_with("http") {
            format!("http://{}", proxy_url)
        } else {
            proxy_url.to_string()
        };
        // Set proxy env vars for libcurl (isahc backend)
        std::env::set_var("HTTPS_PROXY", &proxy_uri);
        std::env::set_var("HTTP_PROXY", &proxy_uri);
        let proxy_client = HttpClient::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| format!("Failed to create proxy client: {}", e))?;
        let result = proxy_client.send_async(request).await
            .map_err(|e| format!("Gemini API connection error (via proxy): {}", e));
        // Clean up proxy env vars
        std::env::remove_var("HTTPS_PROXY");
        std::env::remove_var("HTTP_PROXY");
        result?
    } else {
        state.http_client
            .send_async(request)
            .await
            .map_err(|e| format!("Gemini API connection error: {}", e))?
    };

    let status = response.status();
    let res_text = response.text().await.unwrap_or_else(|_| "Could not read response body".to_string());

    if !status.is_success() {
        return Err(format!("Gemini API error ({}): {}", status, res_text));
    }

    Ok(res_text)
}

#[tauri::command]
async fn scan_local_repository(path: String) -> Result<Vec<FileEntry>, String> {
    let mut files = Vec::new();
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
            if let Ok(content) = fs::read_to_string(entry.path()) {
                files.push(FileEntry {
                    path: entry.path().display().to_string(),
                    content,
                });
            }
        }
    }
    Ok(files)
}

#[derive(Serialize, Deserialize)]
pub struct RepoInfo {
    owner: String,
    repo: String,
    default_branch: String,
    description: String,
}

#[derive(Serialize, Deserialize)]
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
    token: Option<String>,
    max_files: Option<u32>,
) -> Result<GithubRepoData, String> {
    // Fetch basic info
    let info_url = format!("https://api.github.com/repos/{}/{}", owner, repo);
    let mut builder = isahc::Request::builder()
        .method("GET")
        .uri(&info_url)
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    if let Some(ref t) = token {
        if !t.is_empty() {
            builder = builder.header("Authorization", format!("token {}", t));
        }
    }

    let mut info_res = state
        .http_client
        .send_async(builder.body(()).unwrap())
        .await
        .map_err(|e| {
            let mut msg = format!("error sending request for url ({}): {}", info_url, e);
            let mut curr = &e as &dyn std::error::Error;
            while let Some(source) = curr.source() {
                msg.push_str(&format!(" | Caused by: {}", source));
                curr = source;
            }
            msg
        })?;

    if !info_res.status().is_success() {
        return Err(format!(
            "Failed to fetch repo info ({}): {}",
            info_res.status(),
            info_res.text().await.unwrap_or_default()
        ));
    }
    
    let info_text = info_res.text().await.map_err(|e| e.to_string())?;
    let info_json: serde_json::Value = serde_json::from_str(&info_text).map_err(|e| e.to_string())?;

    let default_branch = info_json["default_branch"]
        .as_str()
        .unwrap_or("main")
        .to_string();
    let description = info_json["description"]
        .as_str()
        .unwrap_or("No description provided.")
        .to_string();

    // Fetch tree
    let tree_url = format!(
        "https://api.github.com/repos/{}/{}/git/trees/{}?recursive=1",
        owner, repo, default_branch
    );
    let mut tree_builder = isahc::Request::builder()
        .method("GET")
        .uri(&tree_url)
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    if let Some(ref t) = token {
        if !t.is_empty() {
            tree_builder = tree_builder.header("Authorization", format!("token {}", t));
        }
    }

    let mut tree_res = state
        .http_client
        .send_async(tree_builder.body(()).unwrap())
        .await
        .map_err(|e| e.to_string())?;
    
    let tree_text = tree_res.text().await.map_err(|e| e.to_string())?;
    let tree_json: serde_json::Value = serde_json::from_str(&tree_text).map_err(|e| e.to_string())?;

    let mut tree_paths: Vec<String> = tree_json["tree"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|i| i["type"] == "blob")
                .filter_map(|i| i["path"].as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    // Filtering logic (mirroring server.ts)
    let hard_ignore = [
        "venv",
        ".venv",
        "node_modules",
        ".git",
        "__pycache__",
        "dist",
        "build",
    ];
    let secret_ignore = [
        ".env",
        ".pem",
        ".key",
        ".cert",
        ".p12",
        "secrets.json",
        "credentials.json",
        "id_rsa",
    ];

    tree_paths.retain(|path| {
        let is_hard_ignored = hard_ignore
            .iter()
            .any(|&i| path.contains(&format!("/{}/", i)) || path.starts_with(&format!("{}/", i)));
        let is_secret = secret_ignore
            .iter()
            .any(|&s| path.ends_with(s) || path.contains(&format!("/{}/", s)));
        !is_hard_ignored && !is_secret
    });

    // Fetch README
    let mut readme = String::new();
    let readme_url = format!("https://api.github.com/repos/{}/{}/readme", owner, repo);
    let mut readme_builder = isahc::Request::builder()
        .method("GET")
        .uri(&readme_url)
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    if let Some(ref t) = token {
        if !t.is_empty() {
            readme_builder = readme_builder.header("Authorization", format!("token {}", t));
        }
    }

    if let Ok(mut readme_res) = state.http_client.send_async(readme_builder.body(()).unwrap()).await {
        if readme_res.status().is_success() {
            if let Ok(readme_text) = readme_res.text().await {
                if let Ok(readme_json) = serde_json::from_str::<serde_json::Value>(&readme_text) {
                    if let Some(content) = readme_json["content"].as_str() {
                        let cleaned = content.replace('\n', "").replace('\r', "");
                        if let Ok(decoded) =
                            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, cleaned)
                        {
                            readme = String::from_utf8_lossy(&decoded).to_string();
                        }
                    }
                }
            }
        }
    }

    // Sequential fetch for dependencies
    let dep_files = [
        "package.json",
        "requirements.txt",
        "go.mod",
        "Cargo.toml",
        "pom.xml",
        "build.gradle",
    ];
    
    let mut dependencies = String::new();
    for file in dep_files {
        if tree_paths.contains(&file.to_string()) {
            let file_url = format!(
                "https://api.github.com/repos/{}/{}/contents/{}",
                owner, repo, file
            );
            let mut file_builder = isahc::Request::builder()
                .method("GET")
                .uri(&file_url)
                .header("Accept", "application/vnd.github.v3+json")
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

            if let Some(ref t) = token {
                if !t.is_empty() {
                    file_builder = file_builder.header("Authorization", format!("token {}", t));
                }
            }

            if let Ok(mut file_res) = state.http_client.send_async(file_builder.body(()).unwrap()).await {
                if file_res.status().is_success() {
                    if let Ok(file_text) = file_res.text().await {
                        if let Ok(file_json) = serde_json::from_str::<serde_json::Value>(&file_text) {
                            if let Some(content) = file_json["content"].as_str() {
                                let cleaned = content.replace('\n', "").replace('\r', "");
                                if let Ok(decoded) = base64::Engine::decode(
                                    &base64::engine::general_purpose::STANDARD,
                                    cleaned,
                                ) {
                                    dependencies.push_str(&format!(
                                        "\n--- {} ---\n{}\n",
                                        file,
                                        String::from_utf8_lossy(&decoded)
                                    ));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Scoring and selection (mirroring server.ts)
    let source_extensions = [
        ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".cpp", ".c", ".h", ".cs",
        ".md",
    ];
    let mut files_to_fetch: Vec<String> = tree_paths
        .iter()
        .filter(|p| source_extensions.iter().any(|ext| p.ends_with(ext)))
        .filter(|p| !dep_files.contains(&p.as_str()) && p.to_lowercase() != "readme.md")
        .cloned()
        .collect();

    fn get_file_score(path: &str) -> i32 {
        let mut score = 0;
        let lower_path = path.to_lowercase();
        let parts: Vec<&str> = lower_path.split('/').collect();
        let file_name = parts.last().unwrap_or(&"");
        let depth = parts.len() as i32;

        if lower_path.contains("/test/")
            || lower_path.contains("/tests/")
            || lower_path.contains("__tests__")
            || file_name.contains(".test.")
            || file_name.contains(".spec.")
            || file_name.starts_with("test_")
            || file_name.ends_with("_test.go")
        {
            score -= 50;
        }

        let aux_keywords = [
            "build",
            "setup",
            "config",
            "webpack",
            "vite",
            "rollup",
            "gulpfile",
            "backup",
            "manage.py",
            "scripts/",
            "tools/",
            "docs/",
            "example",
            "demo",
            "migrations/",
        ];
        if aux_keywords.iter().any(|k| lower_path.contains(k)) {
            score -= 30;
        }

        let core_dirs = ["src/", "lib/", "app/", "core/", "pkg/", "internal/"];
        if core_dirs
            .iter()
            .any(|d| lower_path.starts_with(d) || lower_path.contains(&format!("/{}", d)))
        {
            score += 20;
        }

        let important_names = [
            "main",
            "index",
            "app",
            "server",
            "core",
            "manager",
            "parser",
            "api",
            "router",
            "handler",
            "controller",
            "service",
            "model",
            "database",
        ];
        if important_names.iter().any(|n| file_name.contains(n)) {
            score += 10;
        }

        score -= depth;
        score
    }

    files_to_fetch.sort_by(|a, b| get_file_score(b).cmp(&get_file_score(a)));

    let limit = max_files.unwrap_or(5).clamp(1, 200) as usize;
    let files_to_fetch_names: Vec<String> = if files_to_fetch.len() > limit {
        files_to_fetch[0..limit].to_vec()
    } else {
        files_to_fetch
    };

    let mut source_files = Vec::new();
    for file in files_to_fetch_names {
        let file_url = format!(
            "https://api.github.com/repos/{}/{}/contents/{}",
            owner, repo, file
        );
        let mut file_builder = isahc::Request::builder()
            .method("GET")
            .uri(&file_url)
            .header("Accept", "application/vnd.github.v3+json")
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

        if let Some(ref t) = token {
            if !t.is_empty() {
                file_builder = file_builder.header("Authorization", format!("token {}", t));
            }
        }

        if let Ok(mut file_res) = state.http_client.send_async(file_builder.body(()).unwrap()).await {
            if file_res.status().is_success() {
                if let Ok(file_text) = file_res.text().await {
                    if let Ok(file_json) = serde_json::from_str::<serde_json::Value>(&file_text) {
                        if let Some(content) = file_json["content"].as_str() {
                            let cleaned = content.replace('\n', "").replace('\r', "");
                            if let Ok(decoded) = base64::Engine::decode(
                                &base64::engine::general_purpose::STANDARD,
                                cleaned,
                            ) {
                                source_files.push(FileEntry {
                                    path: file.clone(),
                                    content: String::from_utf8_lossy(&decoded).to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    
    let mut is_truncated = false;
    if tree_paths.len() > 1000 {
        tree_paths.truncate(1000);
        is_truncated = true;
    }

    Ok(GithubRepoData {
        info: RepoInfo {
            owner,
            repo,
            default_branch,
            description,
        },
        tree: tree_paths,
        readme,
        dependencies,
        source_files,
        is_truncated,
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
    let endpoint = format!("{}/api/tags", url);
    let res = state.ollama_client.get_async(endpoint).await;
    match res {
        Ok(r) => Ok(r.status().is_success()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
async fn ollama_fetch_models(state: State<'_, AppState>, url: String) -> Result<Vec<String>, String> {
    let endpoint = format!("{}/api/tags", url);
    let mut res = state.ollama_client.get_async(endpoint).await.map_err(|e| e.to_string())?;
    
    if !res.status().is_success() {
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
    num_ctx: Option<u32>,
    num_predict: Option<u32>,
    temperature: Option<f32>,
) -> Result<String, String> {
    let endpoint = format!("{}/api/generate", url);
    
    let mut options = serde_json::Map::new();
    if let Some(ctx) = num_ctx { options.insert("num_ctx".to_string(), serde_json::Value::from(ctx)); }
    if let Some(predict) = num_predict { options.insert("num_predict".to_string(), serde_json::Value::from(predict)); }
    if let Some(temp) = temperature { options.insert("temperature".to_string(), serde_json::Value::from(temp)); }

    let body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
        "options": options
    });

    let mut res = state.ollama_client
        .post_async(endpoint, serde_json::to_string(&body).unwrap())
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
    let endpoint = format!("{}/api/embeddings", url);
    
    let body = serde_json::json!({
        "model": model,
        "prompt": prompt
    });

    let mut res = state.ollama_client
        .post_async(endpoint, serde_json::to_string(&body).unwrap())
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
fn get_gemini_key_source() -> Result<String, String> {
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
            gemini_api_key,
            http_client: client,
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
            get_gemini_key_source
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
