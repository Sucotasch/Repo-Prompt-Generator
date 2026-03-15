use std::sync::Mutex;
use std::process::{Command, Child};
use std::fs;
use std::ffi::OsStr;
use sysinfo::{System, ProcessRefreshKind};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, RunEvent};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    path: String,
    content: String,
}

struct OllamaState {
    process: Mutex<Option<Child>>,
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

#[tauri::command]
fn start_ollama(state: State<'_, OllamaState>) -> Result<String, String> {
    let mut process_guard = state.process.lock().unwrap();
    
    if process_guard.is_some() {
        return Ok("Ollama is already running".to_string());
    }

    #[cfg(target_os = "windows")]
    let child = Command::new("cmd")
        .args(["/C", "ollama serve"])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .spawn();

    #[cfg(not(target_os = "windows"))]
    let child = Command::new("ollama")
        .arg("serve")
        .spawn();

    match child {
        Ok(c) => {
            *process_guard = Some(c);
            Ok("Ollama started successfully".to_string())
        }
        Err(e) => Err(format!("Failed to start Ollama: {}", e)),
    }
}

#[tauri::command]
fn stop_ollama(state: State<'_, OllamaState>) -> Result<String, String> {
    let mut process_guard = state.process.lock().unwrap();
    
    let mut s = System::new();
    s.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, ProcessRefreshKind::everything());
    let mut killed = 0;
    
    for process in s.processes_by_exact_name(OsStr::new("ollama.exe")) {
        process.kill();
        killed += 1;
    }
    for process in s.processes_by_exact_name(OsStr::new("ollama app.exe")) {
        process.kill();
        killed += 1;
    }
    for process in s.processes_by_exact_name(OsStr::new("ollama")) {
        process.kill();
        killed += 1;
    }

    if let Some(mut child) = process_guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }

    if killed > 0 {
        Ok(format!("Stopped {} Ollama processes", killed))
    } else {
        Ok("Ollama stopped".to_string())
    }
}

#[tauri::command]
fn is_ollama_running(state: State<'_, OllamaState>) -> bool {
    let process_guard = state.process.lock().unwrap();
    if process_guard.is_some() {
        return true;
    }
    
    let mut s = System::new();
    s.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, ProcessRefreshKind::everything());
    let name_win = OsStr::new("ollama.exe");
    let name_unix = OsStr::new("ollama");
    
    s.processes().values().any(|p| p.name() == name_win || p.name() == name_unix)
}

#[tauri::command]
fn get_env_var(name: String) -> Option<String> {
    std::env::var(name).ok()
}

#[tauri::command]
fn set_proxy_env(proxy_url: String) -> Result<(), String> {
    if proxy_url.is_empty() {
        std::env::remove_var("HTTP_PROXY");
        std::env::remove_var("HTTPS_PROXY");
        std::env::remove_var("http_proxy");
        std::env::remove_var("https_proxy");
    } else {
        std::env::set_var("HTTP_PROXY", &proxy_url);
        std::env::set_var("HTTPS_PROXY", &proxy_url);
        std::env::set_var("http_proxy", &proxy_url);
        std::env::set_var("https_proxy", &proxy_url);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_http::init())
    .manage(OllamaState {
        process: Mutex::new(None),
    })
    .invoke_handler(tauri::generate_handler![
        scan_local_repository,
        start_ollama,
        stop_ollama,
        is_ollama_running,
        get_env_var,
        set_proxy_env
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    });

  let app = builder.build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|app_handle, event| match event {
    RunEvent::ExitRequested { .. } => {
        // Force kill ollama on exit
        let state = app_handle.state::<OllamaState>();
        let _ = stop_ollama(state);
    }
    _ => {}
  });
}
