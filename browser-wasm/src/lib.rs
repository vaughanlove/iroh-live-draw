use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

use anyhow::Result;
use draw_shared::{ChatSender, DrawTicket, Endpoint, EndpointId, RelayUrl, TopicId};
use draw_shared::DrawNode as SharedNode;
use n0_future::{StreamExt, time::Duration};
use serde::{Deserialize, Serialize};
use tracing::level_filters::LevelFilter;
use tracing_subscriber_wasm::MakeConsoleWriter;
use wasm_bindgen::{JsError, JsValue, prelude::wasm_bindgen};
use wasm_streams::ReadableStream;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();

    tracing_subscriber::fmt()
        .with_max_level(LevelFilter::DEBUG)
        .with_writer(
            // To avoide trace events in the browser from showing their JS backtrace
            MakeConsoleWriter::default().map_trace_level_to(tracing::Level::DEBUG),
        )
        // If we don't do this in the browser, we get a runtime error.
        .without_time()
        .with_ansi(false)
        .init();

    tracing::info!("(testing logging) Logging setup");
}

/// Node for drawing together over iroh-gossip
#[wasm_bindgen]
pub struct DrawNode(SharedNode);

#[wasm_bindgen]
impl DrawNode {
    /// Spawns a gossip node with an ephemeral identity.
    pub async fn spawn() -> Result<Self, JsError> {
        Self::spawn_with_key(None, None).await
    }

    /// Spawns a gossip node with a stable identity.
    /// Pass back the string from `secret_key()` (stored e.g. in localStorage)
    /// to keep the same endpoint id across reloads.
    /// `relay`: your own relay URL — when set, the mesh uses only it.
    pub async fn spawn_with_key(existing: Option<String>, relay: Option<String>) -> Result<Self, JsError> {
        let key = match existing {
            Some(s) => {
                let bytes = hex::decode(s.trim())
                    .map_err(|e| JsError::new(&format!("bad secret key: {e}")))?;
                let arr: [u8; 32] = bytes
                    .try_into()
                    .map_err(|_| JsError::new("bad secret key: expected 32 bytes hex"))?;
                Some(draw_shared::SecretKey::from_bytes(&arr))
            }
            None => None,
        };
        let relay_url: Option<draw_shared::RelayUrl> = match relay {
            Some(s) if !s.trim().is_empty() => Some(
                s.trim()
                    .parse::<draw_shared::RelayUrl>()
                    .map(|u| draw_shared::bare_relay_url(&u))
                    .map_err(|e| JsError::new(&format!("bad relay url: {e}")))?,
            ),
            _ => None,
        };
        let inner = SharedNode::spawn(key, relay_url, draw_shared::Firewall::default(), vec![]).await.map_err(to_js_err)?;
        Ok(Self(inner))
    }

    /// Secret key string — persist it; passing it back to `spawn_with_key`
    /// restores this device's identity.
    pub fn secret_key(&self) -> String {
        hex::encode(self.0.secret_key().to_bytes())
    }

    /// Returns the endpoint id of this node.
    pub fn endpoint_id(&self) -> String {
        self.0.endpoint_id().to_string()
    }

    /// Our current home relay URL, if known yet. Included in tickets so
    /// joiners can dial us without working discovery.
    pub fn relay_url(&self) -> Option<String> {
        self.0.relay_url().map(|u| u.to_string())
    }

    /// Fetch a full page snapshot straight from the keeper over a direct
    /// QUIC request (no gossip mesh needed). Returns the KeeperRes JSON:
    /// `{elements, meta, tombs, files, topic}`. Throws KeeperErr message
    /// when refused.
    pub async fn fetch_snapshot(
        &self,
        keeper_id: String,
        relay: String,
        ticket: String,
        page: String,
    ) -> Result<String, JsError> {
        use draw_shared::{KEEPER_ALPN, KeeperReq};
        let id: EndpointId = keeper_id.trim().parse().map_err(|e| JsError::new(&format!("bad keeper id: {e}")))?;
        let relay_url: draw_shared::RelayUrl = relay
            .trim()
            .parse::<draw_shared::RelayUrl>()
            .map(|u| draw_shared::bare_relay_url(&u))
            .map_err(|e| JsError::new(&format!("bad relay url: {e}")))?;
        let req = KeeperReq { ticket, page };
        let body = serde_json::to_vec(&req).map_err(|e| JsError::new(&e.to_string()))?;
        let conn = self
            .0
            .endpoint()
            .connect(draw_shared::EndpointAddr::new(id).with_relay_url(relay_url), KEEPER_ALPN)
            .await
            .map_err(|e| JsError::new(&format!("keeper dial failed: {e}")))?;
        let (mut send, mut recv) = conn.open_bi().await.map_err(|e| JsError::new(&format!("keeper stream failed: {e}")))?;
        draw_shared::write_frame(&mut send, &body).await.map_err(to_js_err)?;
        let out = draw_shared::read_frame(&mut recv).await.map_err(to_js_err)?;
        // Acknowledge so the keeper can close gracefully without racing
        // our read (dropping the connection early loses the response).
        let _ = draw_shared::write_frame(&mut send, b"ok").await;
        let _ = send.finish();
        let res: serde_json::Value = serde_json::from_slice(&out).map_err(|e| JsError::new(&format!("bad keeper response: {e}")))?;
        if res.get("elements").is_some() {
            Ok(serde_json::to_string(&res).map_err(|e| JsError::new(&e.to_string()))?)
        } else {
            Err(JsError::new(
                res.get("message").and_then(|v| v.as_str()).unwrap_or("keeper refused"),
            ))
        }
    }

    /// Opens a drawing room. Caller becomes the owner (source of truth).
    pub async fn create(&self, nickname: String) -> Result<Channel, JsError> {
        let mut ticket = DrawTicket::new_random();
        ticket.owner = Some(self.0.endpoint_id());
        self.join_inner(ticket, nickname).await
    }

    /// Joins a drawing room.
    pub async fn join(&self, ticket: String, nickname: String) -> Result<Channel, JsError> {
        let ticket = DrawTicket::deserialize(&ticket).map_err(to_js_err)?;
        self.join_inner(ticket, nickname).await
    }

    async fn join_inner(&self, ticket: DrawTicket, nickname: String) -> Result<Channel, JsError> {
        let (sender, receiver) = self.0.join(&ticket, nickname).await.map_err(to_js_err)?;
        let sender = ChannelSender(sender);
        let neighbors = Arc::new(Mutex::new(BTreeSet::new()));
        let neighbors2 = neighbors.clone();
        let endpoint = self.0.endpoint();
        let endpoint2 = endpoint.clone();
        // Relay hints learned eagerly: the endpoint forgets idle remotes
        // after a while, so capturing the relay at NeighborUp time is the
        // only reliable way to keep re-shared tickets redialable.
        let relays = Arc::new(Mutex::new({
            let mut m = BTreeMap::new();
            for (id, url) in &ticket.relays {
                m.insert(*id, draw_shared::bare_relay_url(url));
            }
            if let Some(url) = self.0.relay_url() {
                m.insert(self.0.endpoint_id(), url);
            }
            m
        }));
        let relays2 = relays.clone();
        let receiver = receiver.map(move |event| {
            if let Ok(event) = &event {
                match event {
                    draw_shared::Event::Joined { neighbors } => {
                        neighbors2.lock().unwrap().extend(neighbors.iter().cloned());
                        for id in neighbors.iter().copied() {
                            learn_relay(endpoint2.clone(), relays2.clone(), id);
                        }
                    }
                    draw_shared::Event::NeighborUp { endpoint_id } => {
                        neighbors2.lock().unwrap().insert(*endpoint_id);
                        learn_relay(endpoint2.clone(), relays2.clone(), *endpoint_id);
                    }
                    draw_shared::Event::NeighborDown { endpoint_id } => {
                        neighbors2.lock().unwrap().remove(endpoint_id);
                    }
                    _ => {}
                }
            }
            // Events cross as JSON strings, never live JsValues: serde-wasm-bindgen
            // rejects u64 (sent_timestamp) and .unwrap() would kill the stream
            // task on the first event, deafening the tab with no JS exception.
            // (Micros timestamps fit exactly in a JS number, so this is safe.)
            event
                .map_err(|err| JsValue::from_str(&err.to_string()))
                .map(|event| match serde_json::to_string(&event) {
                    Ok(s) => JsValue::from_str(&s),
                    Err(err) => JsValue::from_str(
                        &serde_json::json!({"type": "error", "message": err.to_string()}).to_string(),
                    ),
                })
        });
        let receiver = ReadableStream::from_stream(receiver).into_raw();

        // Add ourselves to the ticket.
        let mut ticket = ticket;
        ticket.bootstrap.insert(self.0.endpoint_id());

        let topic = Channel {
            topic_id: ticket.topic_id,
            owner: ticket.owner,
            bootstrap: ticket.bootstrap,
            relays,
            neighbors,
            me: self.0.endpoint_id(),
            endpoint,
            sender,
            receiver,
            firewall: self.0.firewall(),
        };
        Ok(topic)
    }
}

/// Best-effort relay learning for one neighbor (see join_inner).
fn learn_relay(endpoint: draw_shared::Endpoint, relays: Arc<Mutex<BTreeMap<EndpointId, RelayUrl>>>, id: EndpointId) {
    wasm_bindgen_futures::spawn_local(async move {
        // Retry briefly: the address map may not know the peer yet at the
        // instant the neighbor event fires.
        for _ in 0..6 {
            if let Some(info) = endpoint.remote_info(id).await {
                for addr in info.into_addrs() {
                    if let draw_shared::TransportAddr::Relay(url) = addr.into_addr() {
                        let url = draw_shared::bare_relay_url(&url);
                        relays.lock().unwrap().insert(id, url);
                        return;
                    }
                }
            }
            n0_future::time::sleep(n0_future::time::Duration::from_secs(2)).await;
        }
    });
}

type ChannelReceiver = wasm_streams::readable::sys::ReadableStream;

#[wasm_bindgen]
pub struct Channel {
    topic_id: TopicId,
    owner: Option<EndpointId>,
    me: EndpointId,
    endpoint: Endpoint,
    bootstrap: BTreeSet<EndpointId>,
    relays: Arc<Mutex<BTreeMap<EndpointId, RelayUrl>>>,
    neighbors: Arc<Mutex<BTreeSet<EndpointId>>>,
    sender: ChannelSender,
    receiver: ChannelReceiver,
    firewall: draw_shared::Firewall,
}

#[wasm_bindgen]
impl Channel {
    #[wasm_bindgen(getter)]
    pub fn sender(&self) -> ChannelSender {
        self.sender.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn receiver(&mut self) -> ChannelReceiver {
        self.receiver.clone()
    }

    pub async fn ticket(&mut self, opts: JsValue) -> Result<String, JsError> {
        let opts: TicketOpts = serde_wasm_bindgen::from_value(opts)?;
        let mut ticket = DrawTicket::new(self.topic_id);
        ticket.owner = self.owner;
        // Only include relay hints we actually have; bare IDs ride along
        // unresolved (same as before) rather than blocking the ticket.
        let mut include = Vec::new();
        if opts.include_myself {
            include.push(self.me);
        }
        if opts.include_bootstrap {
            include.extend(self.bootstrap.iter().copied());
        }
        if opts.include_neighbors {
            let neighbors = self.neighbors.lock().unwrap();
            include.extend(neighbors.iter().copied());
        }
        for id in include {
            ticket.bootstrap.insert(id);
            // Eagerly learned hints first (see learn_relay); live endpoint
            // lookup as fallback.
            let known = self.relays.lock().unwrap().get(&id).cloned();
            if let Some(url) = known {
                ticket.relays.insert(id, draw_shared::bare_relay_url(&url));
            } else if let Some(info) = self.endpoint.remote_info(id).await {
                for addr in info.into_addrs() {
                    if let draw_shared::TransportAddr::Relay(url) = addr.into_addr() {
                        let url = draw_shared::bare_relay_url(&url);
                        ticket.relays.insert(id, url.clone());
                        self.relays.lock().unwrap().insert(id, url);
                        break;
                    }
                }
            }
        }
        tracing::info!("opts {:?} ticket {:?}", opts, ticket);
        Ok(ticket.serialize())
    }

    pub fn id(&self) -> String {
        self.topic_id.to_string()
    }

    /// Owner endpoint id (source of truth), if known.
    pub fn owner(&self) -> Option<String> {
        self.owner.as_ref().map(|o| o.to_string())
    }

    fn peer_arg(&self, peer: &str) -> Result<EndpointId, JsError> {
        peer.trim()
            .parse()
            .map_err(|e| JsError::new(&format!("bad endpoint id: {e}")))
    }

    /// Allow a peer on this topic (no-op on open topics unless revoked).
    pub fn allow_peer(&self, peer: String) -> Result<(), JsError> {
        self.firewall.allow(self.topic_id, self.peer_arg(&peer)?);
        Ok(())
    }

    /// Revoke a peer: their messages are dropped at ingress from now on.
    /// Deny wins over allow and over open topics.
    pub fn revoke_peer(&self, peer: String) -> Result<(), JsError> {
        self.firewall.revoke(self.topic_id, self.peer_arg(&peer)?);
        Ok(())
    }

    /// Open topics allow any ticket-holder; closed topics allow only the
    /// owner and explicitly allowed peers. New topics join open.
    pub fn set_open(&self, open: bool) {
        self.firewall.set_open(self.topic_id, open);
    }

    /// Query the local firewall replica: does this peer currently have
    /// access to this topic? PeerList `has_access` is derived from this.
    pub fn has_access(&self, peer: String) -> Result<bool, JsError> {
        Ok(self.firewall.is_allowed(&self.topic_id, &self.peer_arg(&peer)?))
    }

    /// Export this topic's firewall rules as JSON
    /// (`{open, allowed[], revoked[]}`) for owner broadcast.
    pub fn firewall_snapshot(&self) -> Result<String, JsError> {
        let (open, allowed, denied) = self.firewall.snapshot(&self.topic_id);
        let snap = serde_json::json!({
            "open": open,
            "allowed": allowed.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
            "revoked": denied.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
        });
        serde_json::to_string(&snap).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Apply an owner-broadcast rule snapshot (JSON from `firewall_snapshot`).
    pub fn apply_firewall(&self, json: String) -> Result<(), JsError> {
        let snap: serde_json::Value =
            serde_json::from_str(&json).map_err(|e| JsError::new(&format!("bad firewall snapshot: {e}")))?;
        let parse_ids = |key: &str| -> Result<Vec<EndpointId>, JsError> {
            snap.get(key)
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .map(|id| {
                            id.as_str()
                                .ok_or_else(|| JsError::new("bad endpoint id in snapshot"))
                                .and_then(|s| s.parse().map_err(|e| JsError::new(&format!("bad endpoint id: {e}"))))
                        })
                        .collect()
                })
                .unwrap_or(Ok(Vec::new()))
        };
        let open = snap.get("open").and_then(|v| v.as_bool()).unwrap_or(true);
        self.firewall.apply_snapshot(self.topic_id, open, parse_ids("allowed")?, parse_ids("revoked")?);
        Ok(())
    }

    pub fn neighbors(&self) -> Vec<String> {
        self.neighbors
            .lock()
            .unwrap()
            .iter()
            .map(|x| x.to_string())
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerInfo {
    pub endpoint_id: EndpointId,
    pub nickname: String,
    pub last_active: Duration,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketOpts {
    pub include_myself: bool,
    pub include_bootstrap: bool,
    pub include_neighbors: bool,
}

#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct ChannelSender(ChatSender);

#[wasm_bindgen]
impl ChannelSender {
    pub async fn broadcast(&self, text: String) -> Result<(), JsError> {
        self.0.send(text).await.map_err(to_js_err)?;
        Ok(())
    }

    pub fn set_nickname(&self, nickname: String) {
        self.0.set_nickname(nickname);
    }

    /// Announce which doc (topic id) we currently have open.
    pub fn set_current_doc(&self, doc: Option<String>) {
        self.0.set_current_doc(doc);
    }
}

fn to_js_err(err: impl Into<anyhow::Error>) -> JsError {
    let err: anyhow::Error = err.into();
    JsError::new(&err.to_string())
}
