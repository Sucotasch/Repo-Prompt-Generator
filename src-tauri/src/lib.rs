use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{Manager, Runtime, State};

#[derive(Serialize, Deserialize)]
pub struct FileEntry {
    path: String,
    content: String,
}

pub struct AppState {
    pub gemini_api_key: String,
    pub http_client: Client,
}

#[tauri::command]
async fn call_gemini_secure(state: State<'_, AppState>, prompt: String) -> Result<String, String> {
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key={}",
        state.gemini_api_key
    );

    let response = state
        .http_client
        .post(url)
        .json(&serde_json::json!({ "contents": [{ "parts": [{ "text": prompt }] }] }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    Ok(response.text().await.map_err(|e| e.to_string())?)
}

#[tauri::command]
async fn scan_local_repository(path: String) -> Result<Vec<FileEntry>, String> {
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
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
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("User-Agent", "tauri-app".parse().unwrap());
    if let Some(t) = token {
        headers.insert("Authorization", format!("token {}", t).parse().unwrap());
    }

    // Fetch basic info
    let info_url = format!("https://api.github.com/repos/{}/{}", owner, repo);
    let info_res = state
        .http_client
        .get(info_url)
        .headers(headers.clone())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !info_res.status().is_success() {
        return Err(format!("Failed to fetch repo info: {}", info_res.status()));
    }
    let info_json: serde_json::Value = info_res.json().await.map_err(|e| e.to_string())?;

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
    let tree_res = state
        .http_client
        .get(tree_url)
        .headers(headers.clone())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let tree_json: serde_json::Value = tree_res.json().await.map_err(|e| e.to_string())?;

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
    if let Ok(readme_res) = state
        .http_client
        .get(readme_url)
        .headers(headers.clone())
        .send()
        .await
    {
        if readme_res.status().is_success() {
            if let Ok(readme_json) = readme_res.json::<serde_json::Value>().await {
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

    // Fetch dependencies
    let mut dependencies = String::new();
    let dep_files = [
        "package.json",
        "requirements.txt",
        "go.mod",
        "Cargo.toml",
        "pom.xml",
        "build.gradle",
    ];
    for file in dep_files {
        if tree_paths.contains(&file.to_string()) {
            let file_url = format!(
                "https://api.github.com/repos/{}/{}/contents/{}",
                owner, repo, file
            );
            if let Ok(file_res) = state
                .http_client
                .get(file_url)
                .headers(headers.clone())
                .send()
                .await
            {
                if file_res.status().is_success() {
                    if let Ok(file_json) = file_res.json::<serde_json::Value>().await {
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
    let files_to_fetch = if files_to_fetch.len() > limit {
        &files_to_fetch[0..limit]
    } else {
        &files_to_fetch
    };

    let mut source_files = Vec::new();
    for file in files_to_fetch {
        let file_url = format!(
            "https://api.github.com/repos/{}/{}/contents/{}",
            owner, repo, file
        );
        if let Ok(file_res) = state
            .http_client
            .get(file_url)
            .headers(headers.clone())
            .send()
            .await
        {
            if file_res.status().is_success() {
                if let Ok(file_json) = file_res.json::<serde_json::Value>().await {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let gemini_api_key = std::env::var("VITE_GEMINI_API_KEY")
        .unwrap_or_else(|_| "YOUR_GEMINI_API_KEY_HERE".to_string());

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            gemini_api_key,
            http_client: Client::new(),
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
            fetch_github_repo
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
