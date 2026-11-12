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

fn resolve_env_gemini_key() -> String {
    let val = std::env::var("GEMINI_API_KEY")
        .or_else(|_| std::env::var("VITE_GEMINI_API_KEY"))
        .unwrap_or_default()
        .trim()
        .to_string();
    if val == "YOUR_GEMINI_API_KEY_HERE" || val == "MY_GEMINI_API_KEY" {
        String::new()
    } else {
        val
    }
}

#[tauri::command]
async fn set_app_config(state: State<'_, AppState>, gemini_key: Option<String>, proxy: Option<String>) -> Result<(), String> {
    if let Some(key) = gemini_key {
        let trimmed = key.trim().to_string();
        let resolved = if trimmed.is_empty() {
            resolve_env_gemini_key()
        } else {
            trimmed
        };
        *state.gemini_api_key.write().await = resolved;
    }

    let proxy_url = proxy.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());
    let mut builder = isahc::HttpClient::builder().timeout(Duration::from_secs(300));

    if let Some(url) = proxy_url {
        let proxy_uri = if url.contains("://") {
            url.to_string()
        } else {
            format!("http://{}", url)
        };
        let parsed: isahc::http::Uri = proxy_uri
            .parse()
            .map_err(|e| format!("Invalid proxy URL '{}': {}", proxy_uri, e))?;
        builder = builder.proxy(Some(parsed));
    }

    let client = builder
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    *state.http_client.write().await = client;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
async fn call_gemini_secure(
    state: State<'_, AppState>,
    prompt: String,
    model: Option<String>,
    response_mime_type: Option<String>,
) -> Result<String, String> {
    let key = state.gemini_api_key.read().await.clone();

    if key.is_empty() {
        return Err("Gemini API key is missing. Please enter it in the settings or set the GEMINI_API_KEY environment variable.".to_string());
    }

    println!("[Gemini] Using key: {}... (len: {})", &key[..std::cmp::min(4, key.len())], key.len());

    let model_name = model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| "gemini-4-hydrogen".to_string());
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        urlencoding::encode(&model_name)
    );

    let mut body = serde_json::json!({
        "contents": [{ "parts": [{ "text": prompt }] }]
    });
    if let Some(mime) = response_mime_type.filter(|m| !m.trim().is_empty()) {
        body["generationConfig"] = serde_json::json!({ "responseMimeType": mime });
    }

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

    let envelope: serde_json::Value = serde_json::from_str(&res_text)
        .map_err(|e| format!("Invalid Gemini JSON response: {}", e))?;

    let parts = envelope["candidates"][0]["content"]["parts"]
        .as_array()
        .ok_or_else(|| {
            let block_reason = envelope["promptFeedback"]["blockReason"].as_str();
            match block_reason {
                Some(reason) => format!("Gemini blocked response: {}", reason),
                None => "Gemini response missing candidate parts".to_string(),
            }
        })?;

    let mut text = String::new();
    for part in parts {
        if part["thought"].as_bool() != Some(true) {
            if let Some(t) = part["text"].as_str() {
                text.push_str(t);
            }
        }
    }
    if text.trim().is_empty() {
        for part in parts {
            if let Some(t) = part["text"].as_str() {
                text.push_str(t);
            }
        }
    }

    Ok(text)
}

#[tauri::command(rename_all = "snake_case")]
async fn call_gemini_advanced(
    state: State<'_, AppState>,
    contents: serde_json::Value,
    tools: Option<serde_json::Value>,
    tool_config: Option<serde_json::Value>,
    generation_config: Option<serde_json::Value>,
    system_instruction: Option<serde_json::Value>,
    model: Option<String>,
) -> Result<serde_json::Value, String> {
    let key = state.gemini_api_key.read().await.clone();

    if key.is_empty() {
        return Err("Gemini API key is missing. Please enter it in the settings or set the GEMINI_API_KEY environment variable.".to_string());
    }

    let model_name = model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| "gemini-4-hydrogen".to_string());
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        urlencoding::encode(&model_name)
    );

    let mut body_map = serde_json::Map::new();
    body_map.insert("contents".to_string(), contents);
    if let Some(t) = tools {
        body_map.insert("tools".to_string(), t);
    }
    if let Some(tc) = tool_config {
        body_map.insert("toolConfig".to_string(), tc);
    }
    if let Some(gc) = generation_config {
        body_map.insert("generationConfig".to_string(), gc);
    }
    if let Some(si) = system_instruction {
        body_map.insert("systemInstruction".to_string(), si);
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

    let response_body = response.text_async().await.map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("Gemini API error ({}): {}", response.status(), response_body));
    }

    let json: serde_json::Value = serde_json::from_str(&response_body).map_err(|e| e.to_string())?;
    if json["candidates"].as_array().map(|a| a.is_empty()).unwrap_or(true) {
        if let Some(reason) = json["promptFeedback"]["blockReason"].as_str() {
            return Err(format!("Gemini blocked response: {}", reason));
        }
    }
    Ok(json)
}

fn get_local_file_score(file_path: &str) -> i32 {
    let mut score = 0;
    let lower = file_path.replace('\\', "/").to_lowercase();
    let parts: Vec<&str> = lower.split('/').filter(|s| !s.is_empty()).collect();
    let file_name = parts.last().copied().unwrap_or("");
    let depth = parts.len() as i32;

    if lower.contains("/test/")
        || lower.contains("/tests/")
        || lower.contains("__tests__")
        || file_name.contains(".test.")
        || file_name.contains(".spec.")
        || file_name.starts_with("test_")
        || file_name.ends_with("_test.go")
    {
        score -= 50;
    }
    if [
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
    ]
    .iter()
    .any(|k| lower.contains(k))
    {
        score -= 30;
    }
    if ["src/", "lib/", "app/", "core/", "pkg/", "internal/"]
        .iter()
        .any(|d| lower.starts_with(d) || lower.contains(&format!("/{}", d)))
    {
        score += 20;
    }
    if [
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
    ]
    .iter()
    .any(|n| file_name.contains(n))
    {
        score += 10;
    }

    score - depth
}

#[tauri::command(rename_all = "snake_case")]
async fn scan_local_repository(
    path: String,
    max_files: Option<u32>,
) -> Result<GithubRepoData, String> {
    use std::path::{Path, PathBuf};
    use tokio::task::JoinSet;

    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("Selected path is not a valid directory.".to_string());
    }

    let repo_name = root
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "local-folder".to_string());

    struct ScannedFile {
        rel_path: String,
        full_path: PathBuf,
        size: u64,
        depth: usize,
        base_lower: String,
    }

    let walker = walkdir::WalkDir::new(&root).into_iter().filter_entry(|e| {
        if e.depth() == 0 {
            return true;
        }
        let name = e.file_name().to_string_lossy().to_lowercase();
        let is_hidden_dir = name == ".git" || name == ".venv" || name == ".idea" || name == ".vscode";
        let is_heavy_dir = name == "node_modules"
            || name == "target"
            || name == "venv"
            || name == "dist"
            || name == "build"
            || name == "__pycache__";
        !is_hidden_dir && !is_heavy_dir
    });

    let mut candidates: Vec<ScannedFile> = Vec::new();
    for entry in walker.filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = match entry.path().strip_prefix(&root) {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if rel.is_empty() || should_ignore_github_path(&rel) {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let depth = rel.split('/').filter(|s| !s.is_empty()).count();
        let base_lower = Path::new(&rel)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_lowercase();

        candidates.push(ScannedFile {
            rel_path: rel,
            full_path: entry.path().to_path_buf(),
            size,
            depth,
            base_lower,
        });
    }

    candidates.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

    let mut tree_paths: Vec<String> = candidates.iter().map(|c| c.rel_path.clone()).collect();
    let mut is_truncated = false;
    if tree_paths.len() > 1000 {
        tree_paths.truncate(1000);
        is_truncated = true;
    }

    let find_shallowest = |target_lower: &str| -> Option<&ScannedFile> {
        candidates
            .iter()
            .filter(|c| c.base_lower == target_lower && c.size <= 1_000_000)
            .min_by_key(|c| c.depth)
    };

    let mut readme = String::new();
    if let Some(readme_file) = find_shallowest("readme.md") {
        if let Ok(content) = fs::read_to_string(&readme_file.full_path) {
            readme = truncate_utf8_content(content, 100_000);
        }
    }

    let dep_files = [
        "package.json",
        "requirements.txt",
        "go.mod",
        "Cargo.toml",
        "pom.xml",
        "build.gradle",
    ];
    let dep_set_lower: Vec<String> = dep_files.iter().map(|d| d.to_lowercase()).collect();
    let mut dependencies = String::new();
    for dep_name in dep_files {
        if let Some(dep_file) = find_shallowest(&dep_name.to_lowercase()) {
            if let Ok(content) = fs::read_to_string(&dep_file.full_path) {
                dependencies.push_str(&format!("\n--- {} ---\n{}\n", dep_name, content));
            }
        }
    }

    let source_extensions = [
        ".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte", ".py", ".go", ".rs", ".java", ".cpp",
        ".c", ".h", ".cs", ".sql", ".prisma", ".css", ".scss", ".html", ".md", ".mdx",
    ];

    let mut source_candidates: Vec<&ScannedFile> = candidates
        .iter()
        .filter(|c| {
            let lower_p = c.rel_path.to_lowercase();
            c.size <= 1_000_000
                && source_extensions.iter().any(|ext| lower_p.ends_with(ext))
                && !dep_set_lower.contains(&c.base_lower)
                && c.base_lower != "readme.md"
        })
        .collect();

    source_candidates.sort_by(|a, b| {
        get_local_file_score(&b.rel_path).cmp(&get_local_file_score(&a.rel_path))
    });

    let limit = max_files.unwrap_or(5).clamp(1, 200) as usize;
    let selected: Vec<(String, PathBuf)> = source_candidates
        .into_iter()
        .take(limit)
        .map(|c| (c.rel_path.clone(), c.full_path.clone()))
        .collect();

    let mut set = JoinSet::new();
    for (rel_path, full_path) in selected {
        set.spawn_blocking(move || match fs::read_to_string(&full_path) {
            Ok(content) => Some(FileEntry {
                path: rel_path,
                content: truncate_utf8_content(content, 100_000),
            }),
            Err(_) => None,
        });
    }

    let mut source_files = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok(Some(entry)) = res {
            source_files.push(entry);
        }
    }

    Ok(GithubRepoData {
        info: RepoInfo {
            owner: "local".to_string(),
            repo: repo_name,
            default_branch: "local".to_string(),
            branch: Some("local".to_string()),
            description: "Local folder upload".to_string(),
            stargazers_count: None,
            topics: None,
            language: None,
        },
        tree: tree_paths,
        readme,
        dependencies,
        source_files,
        is_truncated,
    })
}

#[tauri::command(rename_all = "snake_case")]
async fn read_local_repo_files(
    root_path: String,
    file_paths: Vec<String>,
) -> Result<Vec<FileEntry>, String> {
    let root_canonical = fs::canonicalize(&root_path)
        .map_err(|e| format!("Invalid local repository root: {}", e))?;
    let mut results = Vec::new();

    for rel in file_paths.into_iter().take(5) {
        let normalized = rel.replace('\\', "/").trim_start_matches('/').to_string();
        let segments: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
        if segments.is_empty()
            || segments.iter().any(|s| *s == "." || *s == "..")
            || should_ignore_github_path(&normalized)
        {
            continue;
        }

        let mut candidate = root_canonical.clone();
        for seg in &segments {
            candidate.push(seg);
        }

        let resolved = match fs::canonicalize(&candidate) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if !resolved.starts_with(&root_canonical) || !resolved.is_file() {
            continue;
        }
        if let Ok(meta) = fs::metadata(&resolved) {
            if meta.len() > 1_000_000 {
                continue;
            }
        }
        if let Ok(content) = fs::read_to_string(&resolved) {
            results.push(FileEntry {
                path: rel,
                content: truncate_utf8_content(content, 50_000),
            });
        }
    }

    Ok(results)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    owner: String,
    repo: String,
    default_branch: String,
    branch: Option<String>,
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

fn encode_github_path(path: &str) -> String {
    path.split('/')
        .map(|seg| urlencoding::encode(seg).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn is_valid_github_ident(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_')
}

fn should_ignore_github_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    let segments: Vec<&str> = lower.split('/').collect();
    if segments.len() > 1 {
        let dir_segments = &segments[..segments.len() - 1];
        let hard_ignore = ["venv", ".venv", "node_modules", ".git", "__pycache__", "dist", "build", "target"];
        if dir_segments.iter().any(|seg| hard_ignore.contains(seg)) {
            return true;
        }
    }
    let file_name = segments.last().copied().unwrap_or("");
    if file_name == ".env"
        || (file_name.starts_with(".env.")
            && !file_name.ends_with(".example")
            && !file_name.ends_with(".template")
            && !file_name.ends_with(".sample"))
    {
        return true;
    }
    if [".pem", ".key", ".cert", ".p12"].iter().any(|ext| file_name.ends_with(ext)) {
        return true;
    }
    ["secrets.json", "credentials.json", "id_rsa", "id_ed25519"].contains(&file_name)
}

fn truncate_utf8_content(mut content: String, max_chars: usize) -> String {
    if let Some((idx, _)) = content.char_indices().nth(max_chars) {
        content.truncate(idx);
        content.push_str("\n\n... [TRUNCATED: File exceeds 100KB limit]");
    }
    content
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
    use tokio::sync::Semaphore;
    use std::sync::Arc;

    if !is_valid_github_ident(&owner) || !is_valid_github_ident(&repo) {
        return Err("Invalid owner or repository name format.".to_string());
    }

    let client = Arc::new(state.http_client.read().await.clone());
    let token_arc = Arc::new(token.map(|t| t.trim().to_string()).unwrap_or_default());

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
    let default_branch = info_json["default_branch"].as_str().unwrap_or("main").to_string();
    let target_branch = branch
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| default_branch.clone());
    let encoded_branch = urlencoding::encode(&target_branch).into_owned();

    let description = info_json["description"].as_str().unwrap_or("No description.").to_string();
    let stargazers_count = info_json["stargazers_count"].as_u64().map(|n| n as u32);
    let topics = info_json["topics"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect());
    let language = info_json["language"].as_str().map(|s| s.to_string());

    // 2. Fetch tree
    let tree_url = format!("https://api.github.com/repos/{}/{}/git/trees/{}?recursive=1", owner, repo, encoded_branch);
    let mut tree_builder = isahc::Request::builder()
        .method("GET")
        .uri(&tree_url)
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "Tauri/Prompt-Generator");

    if !token_arc.is_empty() {
        tree_builder = tree_builder.header("Authorization", format!("token {}", *token_arc));
    }

    let mut tree_res = client.send_async(tree_builder.body("".to_string()).unwrap()).await.map_err(|e| e.to_string())?;
    if !tree_res.status().is_success() {
        return Err(format!(
            "Failed to fetch repository tree for branch '{}': {}",
            target_branch,
            tree_res.status()
        ));
    }
    let tree_text = tree_res.text().await.map_err(|e| e.to_string())?;
    let tree_json: serde_json::Value = serde_json::from_str(&tree_text).map_err(|e| e.to_string())?;
    let mut tree_paths: Vec<String> = tree_json["tree"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|i| i["type"] == "blob")
                .filter_map(|i| i["path"].as_str().map(|s| s.to_string()))
                .filter(|p| !should_ignore_github_path(p))
                .collect()
        })
        .unwrap_or_default();

    // 3. Parallel fetch for README and dependencies
    let dep_files_list = ["package.json", "requirements.txt", "go.mod", "Cargo.toml", "pom.xml", "build.gradle"];
    let mut join_set = JoinSet::new();

    // Fetch README
    let readme_url = format!("https://api.github.com/repos/{}/{}/readme?ref={}", owner, repo, encoded_branch);
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
            let file_url = format!(
                "https://api.github.com/repos/{}/{}/contents/{}?ref={}",
                owner,
                repo,
                encode_github_path(file),
                encoded_branch
            );
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

    // 4. Determine and fetch source files in bounded parallel batches
    let source_extensions = [".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte", ".py", ".go", ".rs", ".java", ".cpp", ".c", ".h", ".cs", ".sql", ".prisma", ".css", ".scss", ".html", ".md", ".mdx"];
    let mut files_to_fetch: Vec<String> = tree_paths.iter()
        .filter(|p| {
            let lower_p = p.to_lowercase();
            source_extensions.iter().any(|ext| lower_p.ends_with(ext))
        })
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
    let abs_max = if token_arc.is_empty() { 10 } else { 200 };
    let limit = max_files.unwrap_or(5).clamp(1, abs_max) as usize;
    let selected = if files_to_fetch.len() > limit { files_to_fetch[0..limit].to_vec() } else { files_to_fetch };

    let semaphore = Arc::new(Semaphore::new(12));
    let mut source_join_set = JoinSet::new();
    for file in selected {
        let client_c = Arc::clone(&client);
        let token_c = Arc::clone(&token_arc);
        let sem_c = Arc::clone(&semaphore);
        let path = file.clone();
        let file_url = format!(
            "https://api.github.com/repos/{}/{}/contents/{}?ref={}",
            owner,
            repo,
            encode_github_path(&file),
            encoded_branch
        );
        source_join_set.spawn(async move {
            let _permit = sem_c.acquire().await.ok()?;
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
                                    let text_content = truncate_utf8_content(String::from_utf8_lossy(&decoded).to_string(), 100_000);
                                    return Some(FileEntry { path, content: text_content });
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
        info: RepoInfo {
            owner,
            repo,
            default_branch,
            branch: Some(target_branch),
            description,
            stargazers_count,
            topics,
            language,
        },
        tree: tree_paths, readme, dependencies, source_files, is_truncated,
    })
}

#[tauri::command]
async fn is_ollama_running() -> bool {
    let mut s = System::new();
    s.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
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
        Ok(mut child_proc) => {
            state.we_started_ollama.store(true, Ordering::SeqCst);
            std::thread::spawn(move || {
                let _ = child_proc.wait();
            });
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
        s.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
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
    let url = url.trim().trim_end_matches('/').replace("localhost", "127.0.0.1");
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
    let url = url.trim().trim_end_matches('/').replace("localhost", "127.0.0.1");
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
    let url = url.trim().trim_end_matches('/').replace("localhost", "127.0.0.1");
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
    let url = url.trim().trim_end_matches('/').replace("localhost", "127.0.0.1");
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
async fn get_gemini_key_source(state: State<'_, AppState>) -> Result<String, String> {
    let app_key = state.gemini_api_key.read().await.clone();
    if !app_key.is_empty() {
        return Ok(format!("app_state:{}...{}", &app_key[..std::cmp::min(4, app_key.len())], &app_key[app_key.len().saturating_sub(4)..]));
    }

    let env_key = resolve_env_gemini_key();
    if env_key.is_empty() {
        Ok("none".to_string())
    } else {
        Ok(format!("env:{}...{}", &env_key[..std::cmp::min(4, env_key.len())], &env_key[env_key.len().saturating_sub(4)..]))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Priority: GEMINI_API_KEY (system) > VITE_GEMINI_API_KEY (.env) > empty
    let gemini_api_key = resolve_env_gemini_key();

    println!("[Init] Gemini API key from env: {} (len: {})",
        if gemini_api_key.is_empty() { "NOT FOUND" } else { &gemini_api_key[..std::cmp::min(4, gemini_api_key.len())] },
        gemini_api_key.len()
    );

    let client = HttpClient::builder()
        .timeout(Duration::from_secs(300))
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
            call_gemini_advanced,
            scan_local_repository,
            read_local_repo_files,
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
                let we_started_it = {
                    let state = app_handle.state::<AppState>();
                    state.we_started_ollama.swap(false, Ordering::SeqCst)
                };
                if we_started_it {
                    let mut s = System::new();
                    s.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
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
