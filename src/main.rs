//! Static app server + keyless LAN lobby for peer discovery.
//! No keys, no AI routes here — downstream AI lives in a separate app.
use axum::{routing::{get, post}, Json, Router};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let listen = std::env::var("LISTEN").unwrap_or("0.0.0.0:8080".into());
    let web_dir = std::env::var("WEB_DIR").unwrap_or("web/dist".into());
    let peers: Peers = Default::default();
    let app = Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/peers", post(peer_register).get(peer_list))
        .fallback_service(tower_http::services::ServeDir::new(&web_dir).append_index_html_on_directories(true))
        .with_state(peers);
    let l = tokio::net::TcpListener::bind(&listen).await?;
    println!("SERVING {web_dir} on http://{listen}");
    axum::serve(l, app).await?;
    Ok(())
}

// LAN lobby: pages register their iroh addr; peers poll the list.
// Entries expire after 60s without re-register (clients re-POST every ~20s).
type Peers = std::sync::Arc<tokio::sync::Mutex<std::collections::HashMap<String, std::time::Instant>>>;

async fn peer_register(axum::extract::State(p): axum::extract::State<Peers>, Json(b): Json<serde_json::Value>) -> &'static str {
    if let Some(addr) = b.get("addr").and_then(|a| a.as_str()) {
        p.lock().await.insert(addr.to_string(), std::time::Instant::now());
    }
    "ok"
}

async fn peer_list(axum::extract::State(p): axum::extract::State<Peers>) -> Json<Vec<String>> {
    let mut m = p.lock().await;
    m.retain(|_, t| t.elapsed() < std::time::Duration::from_secs(60));
    Json(m.keys().cloned().collect())
}
