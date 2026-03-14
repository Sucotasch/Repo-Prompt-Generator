use reqwest::Client;
use std::time::Duration;

#[tokio::main]
async fn main() {
    let url = "https://api.github.com/repos/Sucotasch/Repo-Prompt-Generator";
    println!("Testing connection to: {}", url);

    // Test 1: Default Client (Native TLS, system proxy)
    test_client("Default (Native TLS, System Proxy)", Client::builder()).await;

    // Test 2: Native TLS, No Proxy
    test_client("Native TLS, No Proxy", Client::builder().no_proxy()).await;

    // Test 3: Browser-like User Agent
    test_client("Browser-like UA", Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
    ).await;
}

async fn test_client(name: &str, builder: reqwest::ClientBuilder) {
    println!("\n--- {} ---", name);
    let client = builder
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();

    match client.get("https://api.github.com/repos/Sucotasch/Repo-Prompt-Generator")
        .header("User-Agent", "Diagnostic-Script")
        .send().await {
        Ok(res) => println!("Success! Status: {}", res.status()),
        Err(e) => {
            println!("Failed: {}", e);
            let mut curr = &e as &dyn std::error::Error;
            while let Some(source) = curr.source() {
                println!("  Caused by: {}", source);
                curr = source;
            }
        }
    }
}
