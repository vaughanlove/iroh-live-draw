//! Keeper: an always-on watch peer. Browsers POST share tickets to
//! `POST /watch`; the keeper joins those gossip topics as a dumb cache —
//! it merges everything it sees (same LWW-element-map rules as the clients)
//! and answers `snap-req` so newcomers and rejoiners converge even when the
//! owner is offline. It never answers `pull` (owner-only) and never edits.
//!
//! Env: LISTEN (default 0.0.0.0:8081), KEEPER_DATA (default ./keeper-data),
//!   KEEPER_SECRET (hex secret key; generated + saved if absent),
//!   RELAY_URL (custom relay; default n0), KEEPER_TOKEN (optional bearer
//!   for /watch), MAX_TOPICS (default 100).
//!
//! State is best-effort persisted as JSON; browsers re-register on every
//! boot, so a restart heals automatically.
use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
use draw_shared::{ChatSender, DrawNode, DrawTicket, Event, TopicId};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

// ---- CRDT claims (mirror of the TS LWW-element-map) ----

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
struct Claim {
    #[serde(default)]
    v: i64,
    #[serde(default)]
    ts: i64,
    #[serde(default)]
    author: String,
}

fn cmp_claim(a: &Claim, b: &Claim) -> std::cmp::Ordering {
    a.v.cmp(&b.v)
        .then(a.ts.cmp(&b.ts))
        .then(a.author.cmp(&b.author))
}

#[derive(Default, Debug, Clone, Serialize, Deserialize)]
struct PageState {
    elements: HashMap<String, serde_json::Value>,
    meta: HashMap<String, Claim>,
    tombs: HashMap<String, Claim>,
    files: HashMap<String, serde_json::Value>,
}

impl PageState {
    fn best(&self, id: &str) -> Option<(&Claim, bool)> {
        match (self.meta.get(id), self.tombs.get(id)) {
            (Some(m), Some(t)) => Some(if cmp_claim(m, t) != std::cmp::Ordering::Less {
                (m, false)
            } else {
                (t, true)
            }),
            (Some(m), None) => Some((m, false)),
            (None, Some(t)) => Some((t, true)),
            (None, None) => None,
        }
    }

    fn ingest_tombs(&mut self, tombs: &[serde_json::Value]) -> bool {
        let mut changed = false;
        for t in tombs {
            let (Some(id), v, ts, author) = (
                t.get("id").and_then(|v| v.as_str()),
                t.get("v").and_then(|v| v.as_i64()).unwrap_or(0),
                t.get("ts").and_then(|v| v.as_i64()).unwrap_or(0),
                t.get("author").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            ) else {
                continue;
            };
            let cand = Claim { v, ts, author };
            let wins = self.best(id).map(|(e, _)| cmp_claim(&cand, &e).is_gt()).unwrap_or(true);
            if wins {
                self.tombs.insert(id.to_string(), cand);
                self.meta.remove(id);
                changed = true;
            }
        }
        changed
    }

    fn ingest_elements(&mut self, elements: &[serde_json::Value], meta: &serde_json::Map<String, serde_json::Value>) {
        for el in elements {
            let Some(id) = el.get("id").and_then(|v| v.as_str()) else { continue };
            let v = el.get("version").and_then(|v| v.as_i64()).unwrap_or(0);
            let (ts, author) = meta
                .get(id)
                .and_then(|m| m.as_array())
                .map(|a| (a.first().and_then(|v| v.as_i64()).unwrap_or(0), a.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string()))
                .unwrap_or((0, String::new()));
            let cand = Claim { v, ts, author };
            let wins = self.best(id).map(|(e, _)| cmp_claim(&cand, &e).is_gt()).unwrap_or(true);
            if wins {
                self.meta.insert(id.to_string(), cand);
                self.tombs.remove(id);
                self.elements.insert(id.to_string(), el.clone());
            }
        }
    }

    fn evict(&mut self) {
        let condemned: Vec<String> = self
            .elements
            .keys()
            .filter(|id| matches!(self.best(id), Some((_, true))))
            .cloned()
            .collect();
        for id in condemned {
            self.elements.remove(&id);
        }
    }
}

struct WatchedDoc {
    ticket: String,
    pages: HashMap<String, PageState>,
    sender: ChatSender,
    epoch: String,
    seq: Mutex<u64>,
    fw_version: Mutex<i64>,
    /// Last gossip traffic (any sender) — silence means our mesh leg died.
    last_rx_ms: Mutex<u128>,
    /// Every peer we've heard from (rejoin bootstrap candidates).
    seen: Mutex<HashSet<String>>,
}

impl std::fmt::Debug for WatchedDoc {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WatchedDoc").field("ticket_len", &self.ticket.len()).field("pages", &self.pages.keys().collect::<Vec<_>>()).finish()
    }
}

impl WatchedDoc {
    fn send(&self, me: &str, obj: serde_json::Value) {
        let mut seq = self.seq.lock().expect("poisoned");
        *seq += 1;
        let mut envelope = serde_json::Map::new();
        envelope.insert("from".into(), me.into());
        envelope.insert("epoch".into(), self.epoch.clone().into());
        envelope.insert("seq".into(), (*seq).into());
        if let serde_json::Value::Object(map) = obj {
            envelope.extend(map);
        }
        let text = serde_json::Value::Object(envelope).to_string();
        let sender = self.sender.clone();
        tokio::spawn(async move {
            if let Err(e) = sender.send(text).await {
                warn!("keeper broadcast failed: {e}");
            }
        });
    }
}

#[derive(Clone)]
struct Keeper {
    node: DrawNode,
    me: String,
    docs: Arc<Mutex<HashMap<TopicId, WatchedDoc>>>,
    owners: Arc<Mutex<HashMap<TopicId, String>>>,
    data_dir: PathBuf,
    max_topics: usize,
    token: Option<String>,
}

#[derive(Deserialize)]
struct WatchReq {
    ticket: String,
}

async fn healthz() -> &'static str {
    "ok"
}

async fn list_docs(State(k): State<Keeper>) -> Json<serde_json::Value> {
    let docs = k.docs.lock().expect("poisoned");
    Json(serde_json::json!({
        "me": k.me,
        "topics": docs.keys().map(|t| t.to_string()).collect::<Vec<_>>(),
    }))
}

async fn watch(
    State(k): State<Keeper>,
    headers: axum::http::HeaderMap,
    Json(req): Json<WatchReq>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if let Some(token) = &k.token {
        let ok = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v == format!("Bearer {token}"));
        if (!ok) && headers.get("x-keeper-token").and_then(|v| v.to_str().ok()) != Some(token.as_str()) {
            return Err(StatusCode::UNAUTHORIZED);
        }
    }
    let topic = k.watch_ticket(&req.ticket, None).await.map_err(|e| {
        warn!("watch failed: {e:#}");
        StatusCode::BAD_REQUEST
    })?;
    Ok(Json(serde_json::json!({ "topic": topic, "keeper": k.me })))
}

async fn info(State(k): State<Keeper>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "keeper": k.me }))
}

impl Keeper {
    async fn watch_ticket(
        &self,
        ticket_str: &str,
        restore: Option<HashMap<String, PageState>>,
    ) -> anyhow::Result<String> {
        let ticket = DrawTicket::deserialize(ticket_str)?;
        let topic = ticket.topic_id;
        {
            let docs = self.docs.lock().expect("poisoned");
            if docs.len() >= self.max_topics && !docs.contains_key(&topic) {
                anyhow::bail!("topic cap reached ({})", self.max_topics);
            }
            if docs.contains_key(&topic) {
                return Ok(topic.to_string());
            }
        }
        // Join outside the lock (it awaits).
            let (sender, receiver) = self.node.join(&ticket, "keeper".to_string()).await?;
        if let Some(owner) = ticket.owner {
            self.owners.lock().expect("poisoned").insert(topic, owner.to_string());
        }
        {
            let mut docs = self.docs.lock().expect("poisoned");
            let entry = docs.entry(topic).or_insert_with(|| WatchedDoc {
                ticket: ticket_str.to_string(),
                pages: HashMap::new(),
                sender: sender.clone(),
                epoch: format!("k{}", rand_suffix()),
                seq: Mutex::new(0),
                fw_version: Mutex::new(0),
                last_rx_ms: Mutex::new(now_ms()),
                seen: Mutex::new(HashSet::new()),
            });
            entry.ticket = ticket_str.to_string();
            if let Some(pages) = restore {
                if !pages.is_empty() {
                    entry.pages = pages;
                }
            }
        }
        self.persist();
        let keeper = self.clone();
        tokio::spawn(async move {
            keeper.pump(topic, receiver).await;
        });
        info!(%topic, "watching");
        Ok(topic.to_string())
    }

    /// Rejoin a topic whose mesh leg went silent, with an enriched ticket:
    /// original bootstrap + every peer we've heard from + their current
    /// relays. The old subscription is left running (duplicate merges are
    /// idempotent); the fresh join dials everyone we know.
    async fn rejoin_with_ticket(&self, topic: TopicId, ticket_str: &str) {
        let Ok(ticket) = DrawTicket::deserialize(ticket_str) else { return };
        if ticket.topic_id != topic {
            return;
        }
        // Enrich bootstrap + relays from everything we've learned.
        let mut bootstrap: HashSet<String> =
            ticket.bootstrap.iter().map(|id| id.to_string()).collect();
        let seen: Vec<String> = self
            .docs
            .lock()
            .expect("poisoned")
            .get(&topic)
            .map(|d| d.seen.lock().expect("poisoned").iter().cloned().collect())
            .unwrap_or_default();
        for id in &seen {
            bootstrap.insert(id.clone());
        }
        let mut ticket = ticket;
        let mut relays = ticket.relays.clone();
        for id_s in bootstrap {
            let Ok(id) = id_s.parse() else { continue };
            ticket.bootstrap.insert(id);
            if relays.contains_key(&id) {
                continue;
            }
            // Current relay, learned from the live connection if any.
            if let Some(info) = self.node.endpoint().remote_info(id).await {
                for addr in info.into_addrs() {
                    if let draw_shared::TransportAddr::Relay(url) = addr.into_addr() {
                        relays.insert(id, url);
                        break;
                    }
                }
            }
        }
        ticket.relays = relays;
        let ticket_str = ticket.serialize();
        let Ok((sender, receiver)) = self.node.join(&ticket, "keeper".to_string()).await else { return };
        {
            let mut docs = self.docs.lock().expect("poisoned");
            if let Some(doc) = docs.get_mut(&topic) {
                doc.sender = sender;
                doc.ticket = ticket_str;
                doc.epoch = format!("k{}", rand_suffix());
                *doc.seq.lock().expect("poisoned") = 0;
                *doc.last_rx_ms.lock().expect("poisoned") = now_ms();
            } else {
                return;
            }
        }
        self.persist();
        let keeper = self.clone();
        tokio::spawn(async move {
            keeper.pump(topic, receiver).await;
        });
        info!(%topic, "rejoined idle mesh leg");
    }

    /// Watchdog: topics silent too long with known peers get rejoined. This
    /// is what heals the mesh after churn — browsers can't rediscover peers,
    /// but the keeper (native endpoint, full address knowledge) can redial.
    /// Thresholds via env for tests: IDLE_AFTER_SEC (default 90),
    /// REJOIN_TICK_SEC (default 30).
    async fn rejoin_idle(&self) {
        let idle_after_ms: u128 =
            std::env::var("IDLE_AFTER_SEC").ok().and_then(|v| v.parse().ok()).unwrap_or(90) * 1000;
        let now = now_ms();
        let stale: Vec<(TopicId, String)> = {
            let docs = self.docs.lock().expect("poisoned");
            docs.iter()
                .filter(|(_, d)| {
                    now.saturating_sub(*d.last_rx_ms.lock().expect("poisoned")) > idle_after_ms
                        && !d.seen.lock().expect("poisoned").is_empty()
                })
                .map(|(t, d)| (*t, d.ticket.clone()))
                .collect()
        };
        for (topic, ticket) in stale {
            self.rejoin_with_ticket(topic, &ticket).await;
        }
    }

    async fn pump(
        &self,
        topic: TopicId,
        mut receiver: futures_util::stream::BoxStream<'static, anyhow::Result<Event>>,
    ) {
        while let Some(ev) = receiver.next().await {
            let Ok(ev) = ev else { continue };
            match ev {
                Event::MessageReceived { from, text, .. } => {
                    if from.to_string() == self.me {
                        continue;
                    }
                    // Liveness bookkeeping for the idle-rejoin watchdog.
                    {
                        let docs = self.docs.lock().expect("poisoned");
                        if let Some(doc) = docs.get(&topic) {
                            *doc.last_rx_ms.lock().expect("poisoned") = now_ms();
                            doc.seen.lock().expect("poisoned").insert(from.to_string());
                        }
                    }
                    let Ok(m) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                    if std::env::var("KEEPER_VERBOSE").is_ok() {
                        info!(%topic, %from, t = m.get("t").and_then(|v| v.as_str()).unwrap_or("?"), "rx");
                    }
                    self.on_message(topic, &m).await;
                }
                Event::Presence { .. } => {}
                _ => {}
            }
        }
        warn!(%topic, "pump ended");
    }

    async fn on_message(&self, topic: TopicId, m: &serde_json::Value) {
        let t = m.get("t").and_then(|v| v.as_str()).unwrap_or("");
        let page = m.get("page").and_then(|v| v.as_str()).unwrap_or("main").to_string();
        // Firewall datagrams replicate like any client: only the topic owner
        // is honored, newest version wins.
        if t == "fw" {
            let from = m.get("from").and_then(|v| v.as_str()).unwrap_or("");
            let is_owner = self.owner_of(topic).as_deref() == Some(from) && !from.is_empty();
            if is_owner {
                if let (Some(v), Some(snap)) = (
                    m.get("v").and_then(|v| v.as_i64()),
                    m.get("snap").and_then(|v| v.as_str()),
                ) {
                    let docs = self.docs.lock().expect("poisoned");
                    if let Some(doc) = docs.get(&topic) {
                        if v > *doc.fw_version.lock().expect("poisoned") {
                            if apply_fw_snapshot(&self.node, topic, snap) {
                                *doc.fw_version.lock().expect("poisoned") = v;
                            }
                        }
                    }
                }
            }
            return;
        }
        if t != "p" && t != "snap" && t != "snap-req" && t != "f" {
            return;
        }
        let mut docs = self.docs.lock().expect("poisoned");
        let Some(doc) = docs.get_mut(&topic) else { return };
        let st = doc.pages.entry(page.clone()).or_default();
        if t == "f" {
            if let Some(files) = m.get("files").and_then(|v| v.as_array()) {
                for f in files {
                    if let Some(id) = f.get("id").and_then(|v| v.as_str()) {
                        st.files.insert(id.to_string(), f.clone());
                    }
                }
            }
            drop(docs);
            self.persist_soon();
            return;
        }
        if t == "snap-req" {
            // Dumb cache answers from stored state (live or not).
            let els: Vec<_> = st.elements.values().cloned().collect();
            let meta: serde_json::Map<_, _> = st
                .meta
                .iter()
                .map(|(id, c)| (id.clone(), serde_json::json!([c.ts, c.author])))
                .collect();
            let tombs: Vec<_> = st
                .tombs
                .iter()
                .map(|(id, c)| serde_json::json!({"id": id, "v": c.v, "ts": c.ts, "author": c.author}))
                .collect();
            let files: Vec<_> = st.files.values().cloned().collect();
            let me = self.me.clone();
            info!(%topic, els = els.len(), "answering snap-req");
            doc.send(&me, serde_json::json!({
                "t": "snap", "page": page,
                "elements": els, "meta": meta, "tombs": tombs, "files": files,
            }));
            drop(docs);
            return;
        }
        // p / snap: merge by CRDT claim.
        if let Some(tombs) = m.get("tombs").and_then(|v| v.as_array()) {
            st.ingest_tombs(tombs);
        }
        if let Some(elements) = m.get("elements").and_then(|v| v.as_array()) {
            let meta = m.get("meta").and_then(|v| v.as_object()).cloned().unwrap_or_default();
            st.ingest_elements(elements, &meta);
        }
        if let Some(files) = m.get("files").and_then(|v| v.as_array()) {
            for f in files {
                if let Some(id) = f.get("id").and_then(|v| v.as_str()) {
                    st.files.insert(id.to_string(), f.clone());
                }
            }
        }
        st.evict();
        drop(docs);
        self.persist_soon();
    }

    fn owner_of(&self, topic: TopicId) -> Option<String> {
        // Seeded from the ticket at watch time (tickets state the owner).
        self.owners.lock().expect("poisoned").get(&topic).cloned()
    }

    fn persist(&self) {
        let dump: HashMap<String, serde_json::Value> = {
            let docs = self.docs.lock().expect("poisoned");
            docs.iter()
                .map(|(topic, doc)| {
                    (
                        topic.to_string(),
                        serde_json::json!({ "ticket": doc.ticket, "pages": doc.pages }),
                    )
                })
                .collect()
        };
        if let Err(e) = std::fs::create_dir_all(&self.data_dir).and_then(|_| {
            std::fs::write(self.data_dir.join("state.json"), serde_json::to_string(&dump).unwrap_or_default())
        }) {
            warn!("persist failed: {e}");
        }
    }

    fn persist_soon(&self) {
        // Coalesced by the interval saver; snapshots ride the next tick.
        // (No-op hook kept so merge paths stay uniform.)
    }
}

fn apply_fw_snapshot(node: &DrawNode, topic: TopicId, snap: &str) -> bool {
    #[derive(Deserialize)]
    struct Snap {
        #[serde(default)]
        open: bool,
        #[serde(default)]
        allowed: Vec<String>,
        #[serde(default)]
        revoked: Vec<String>,
    }
    let Ok(snap): Result<Snap, _> = serde_json::from_str(snap) else { return false };
    let parse = |ids: Vec<String>| {
        ids.into_iter()
            .filter_map(|s| s.parse().ok())
            .collect::<Vec<draw_shared::EndpointId>>()
    };
    node.firewall().apply_snapshot(topic, snap.open, parse(snap.allowed), parse(snap.revoked));
    true
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn rand_suffix() -> String {
    (now_ms() % 1_000_000_000).to_string()
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).init();
    let data_dir = PathBuf::from(std::env::var("KEEPER_DATA").unwrap_or("./keeper-data".into()));
    std::fs::create_dir_all(&data_dir)?;
    let max_topics: usize = std::env::var("MAX_TOPICS").ok().and_then(|v| v.parse().ok()).unwrap_or(100);
    let token = std::env::var("KEEPER_TOKEN").ok().filter(|s| !s.is_empty());

    // Stable identity across restarts (else the roster churns every deploy).
    let secret_path = data_dir.join("secret.hex");
    let secret_key = match std::fs::read_to_string(&secret_path) {
        Ok(s) => {
            let bytes = hex_decode(s.trim())?;
            draw_shared::SecretKey::from_bytes(&bytes.try_into().map_err(|_| anyhow::anyhow!("bad secret length"))?)
        }
        Err(_) => {
            let key = draw_shared::SecretKey::generate();
            std::fs::write(&secret_path, hex_encode(&key.to_bytes()))?;
            key
        }
    };
    let relay: Option<draw_shared::RelayUrl> = std::env::var("RELAY_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().parse().map(|u| draw_shared::bare_relay_url(&u)))
        .transpose()
        .map_err(|e| anyhow::anyhow!("bad RELAY_URL: {e}"))?;
    let docs: Arc<Mutex<HashMap<TopicId, WatchedDoc>>> = Arc::new(Mutex::new(HashMap::new()));
    let owners: Arc<Mutex<HashMap<TopicId, String>>> = Arc::new(Mutex::new(HashMap::new()));
    let firewall = draw_shared::Firewall::default();
    let node = DrawNode::spawn(
        Some(secret_key),
        relay,
        firewall.clone(),
        vec![(
            draw_shared::KEEPER_ALPN.to_vec(),
            Box::new(KeeperProto {
                firewall,
                docs: docs.clone(),
                owners: owners.clone(),
            }) as Box<dyn draw_shared::DynProtocolHandler>,
        )],
    )
    .await?;
    let me = node.endpoint_id().to_string();
    info!(%me, "keeper online");

    let keeper = Keeper {
        node,
        me,
        docs,
        owners,
        data_dir: data_dir.clone(),
        max_topics,
        token,
    };

    // Rejoin persisted topics with their cached pages (tickets may be stale;
    // browsers re-POST fresh ones on every boot, which heals the set).
    if let Ok(raw) = std::fs::read_to_string(data_dir.join("state.json")) {
        if let Ok(map) = serde_json::from_str::<HashMap<String, serde_json::Value>>(&raw) {
            for entry in map.values() {
                let ticket = entry.get("ticket").and_then(|v| v.as_str()).unwrap_or("");
                if ticket.is_empty() {
                    continue;
                }
                let pages = entry
                    .get("pages")
                    .and_then(|p| serde_json::from_value::<HashMap<String, PageState>>(p.clone()).ok());
                if let Err(e) = keeper.watch_ticket(ticket, pages).await {
                    warn!("rejoin failed: {e:#}");
                }
            }
        }
    }

    // Periodic snapshot persistence + idle mesh-leg rejoins.
    let saver = keeper.clone();
    let tick_secs: u64 = std::env::var("REJOIN_TICK_SEC").ok().and_then(|v| v.parse().ok()).unwrap_or(30);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(tick_secs));
        loop {
            tick.tick().await;
            saver.persist();
            saver.rejoin_idle().await;
        }
    });

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/info", get(info))
        .route("/docs", get(list_docs))
        .route("/watch", axum::routing::post(watch))
        // Prototype-open CORS: the app is served from a different origin
        // (Pages / LAN IP) than the keeper. Tighten if this ever matters.
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(keeper);
    let listen: SocketAddr = std::env::var("LISTEN")
        .or_else(|_| std::env::var("PORT").map(|p| format!("0.0.0.0:{p}")))
        .unwrap_or("0.0.0.0:8081".into())
        .parse()?;
    info!(%listen, "keeper http online");
    axum::serve(tokio::net::TcpListener::bind(listen).await?, app).await?;
    Ok(())
}

fn hex_decode(s: &str) -> anyhow::Result<Vec<u8>> {
    if s.len() % 2 != 0 {
        anyhow::bail!("odd hex length");
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(Into::into))
        .collect()
}

fn hex_encode(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Direct serving protocol: newcomers fetch full page state over QUIC
/// without needing a working gossip mesh. Ticket is the credential;
/// the firewall still applies (remote id must be allowed on the topic).
#[derive(Clone, Debug)]
struct KeeperProto {
    firewall: draw_shared::Firewall,
    docs: Arc<Mutex<HashMap<TopicId, WatchedDoc>>>,
    owners: Arc<Mutex<HashMap<TopicId, String>>>,
}

impl iroh::protocol::ProtocolHandler for KeeperProto {
    async fn accept(&self, conn: iroh::endpoint::Connection) -> Result<(), iroh::protocol::AcceptError> {
        let remote = conn.remote_id();
        tracing::info!(%remote, "keeper direct accept");
        let (mut send, mut recv) = conn.accept_bi().await.map_err(iroh::protocol::AcceptError::from_err)?;
        let err = async {
            let body = draw_shared::read_frame(&mut recv).await?;
            let req: draw_shared::KeeperReq = serde_json::from_slice(&body)?;
            let ticket = draw_shared::DrawTicket::deserialize(&req.ticket)?;
            let docs = self.docs.lock().expect("poisoned");
            let doc = docs.get(&ticket.topic_id).ok_or_else(|| anyhow::anyhow!("unknown topic"))?;
            if !self.firewall.is_allowed(&ticket.topic_id, &remote) {
                anyhow::bail!("not allowed");
            }
            let st = doc.pages.get(&req.page).cloned().unwrap_or_default();
            // PageState isn't Clone; rebuild the answer from parts.
            let res = draw_shared::KeeperRes {
                elements: st.elements.values().cloned().collect(),
                meta: st.meta.iter().map(|(id, c)| (id.clone(), (c.ts, c.author.clone()))).collect(),
                tombs: st.tombs.iter().map(|(id, c)| draw_shared::KeeperTomb {
                    id: id.clone(), v: c.v, ts: c.ts, author: c.author.clone(),
                }).collect(),
                files: st.files.values().cloned().collect(),
                topic: ticket.topic_id.to_string(),
            };
            Ok::<_, anyhow::Error>(res)
        }
        .await;
        match err {
            Ok(res) => {
                let io_err = |e: &dyn std::fmt::Display| {
                    iroh::protocol::AcceptError::from_err(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        e.to_string(),
                    ))
                };
                let body = serde_json::to_vec(&res).map_err(|e| io_err(&e))?;
                draw_shared::write_frame(&mut send, &body).await.map_err(|e| io_err(&e))?;
                use tokio::io::AsyncWriteExt;
                let _ = send.finish();
                // Wait for the client's ack (bounded) so the connection
                // isn't dropped before the response arrives. Without this
                // the browser sees "connection lost" with an empty read.
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    draw_shared::read_frame(&mut recv),
                )
                .await;
                Ok(())
            }
            Err(e) => {
                let body = serde_json::to_vec(&draw_shared::KeeperErr { message: e.to_string() })
                    .map_err(iroh::protocol::AcceptError::from_err)?;
                let _ = draw_shared::write_frame(&mut send, &body).await;
                Err(iroh::protocol::AcceptError::from_err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    e.to_string(),
                )))
            }
        }
    }
}
