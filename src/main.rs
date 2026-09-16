//! Static file server. Sync is P2P over iroh; discovery is via share links.
//! No API, no state.
use axum::Router;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let listen = std::env::var("LISTEN").unwrap_or("0.0.0.0:8080".into());
    let web_dir = std::env::var("WEB_DIR").unwrap_or("web/dist".into());
    let app = Router::new().fallback_service(
        tower_http::services::ServeDir::new(&web_dir).append_index_html_on_directories(true),
    );
    let l = tokio::net::TcpListener::bind(&listen).await?;
    println!("SERVING {web_dir} on http://{listen}");
    axum::serve(l, app).await?;
    Ok(())
}
