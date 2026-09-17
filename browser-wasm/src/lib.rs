use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

use anyhow::Result;
use draw_shared::{ChatSender, DrawTicket, EndpointId, RelayUrl, TopicId};
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
    /// Spawns a gossip node.
    pub async fn spawn() -> Result<Self, JsError> {
        let inner = SharedNode::spawn(None)
            .await
            .map_err(to_js_err)?;
        Ok(Self(inner))
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

    /// Opens a drawing room.
    pub async fn create(&self, nickname: String) -> Result<Channel, JsError> {
        let ticket = DrawTicket::new_random();
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
        let receiver = receiver.map(move |event| {
            if let Ok(event) = &event {
                match event {
                    draw_shared::Event::Joined { neighbors } => {
                        neighbors2.lock().unwrap().extend(neighbors.iter().cloned());
                    }
                    draw_shared::Event::NeighborUp { endpoint_id } => {
                        neighbors2.lock().unwrap().insert(*endpoint_id);
                    }
                    draw_shared::Event::NeighborDown { endpoint_id } => {
                        neighbors2.lock().unwrap().remove(endpoint_id);
                    }
                    _ => {}
                }
            }
            event
                .map_err(|err| JsValue::from(&err.to_string()))
                .map(|event| serde_wasm_bindgen::to_value(&event).unwrap())
        });
        let receiver = ReadableStream::from_stream(receiver).into_raw();

        // Carry relay hints forward so re-shared tickets stay dialable.
        let mut relays = ticket.relays.clone();
        // Add ourselves (live value — the relay may have settled since join).
        if let Some(url) = self.0.relay_url() {
            relays.insert(self.0.endpoint_id(), url);
        }

        // Add ourselves to the ticket.
        let mut ticket = ticket;
        ticket.bootstrap.insert(self.0.endpoint_id());

        let topic = Channel {
            topic_id: ticket.topic_id,
            bootstrap: ticket.bootstrap,
            relays,
            neighbors,
            me: self.0.endpoint_id(),
            sender,
            receiver,
        };
        Ok(topic)
    }
}

type ChannelReceiver = wasm_streams::readable::sys::ReadableStream;

#[wasm_bindgen]
pub struct Channel {
    topic_id: TopicId,
    me: EndpointId,
    bootstrap: BTreeSet<EndpointId>,
    relays: BTreeMap<EndpointId, RelayUrl>,
    neighbors: Arc<Mutex<BTreeSet<EndpointId>>>,
    sender: ChannelSender,
    receiver: ChannelReceiver,
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

    pub fn ticket(&self, opts: JsValue) -> Result<String, JsError> {
        let opts: TicketOpts = serde_wasm_bindgen::from_value(opts)?;
        let mut ticket = DrawTicket::new(self.topic_id);
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
            if let Some(url) = self.relays.get(&id) {
                ticket.relays.insert(id, url.clone());
            }
        }
        tracing::info!("opts {:?} ticket {:?}", opts, ticket);
        Ok(ticket.serialize())
    }

    pub fn id(&self) -> String {
        self.topic_id.to_string()
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
}

fn to_js_err(err: impl Into<anyhow::Error>) -> JsError {
    let err: anyhow::Error = err.into();
    JsError::new(&err.to_string())
}
