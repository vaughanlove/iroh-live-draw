use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result};
pub use iroh::EndpointId;
pub use iroh::RelayUrl;
use iroh::address_lookup::memory::MemoryLookup;
use iroh::{EndpointAddr, PublicKey, SecretKey, Signature, TransportAddr, protocol::Router};
pub use iroh_gossip::proto::TopicId;
use iroh_gossip::{
    api::{Event as GossipEvent, GossipSender},
    net::{GOSSIP_ALPN, Gossip},
};
use iroh_tickets::Ticket;
use n0_future::{
    StreamExt,
    boxed::BoxStream,
    task::{self, AbortOnDropHandle},
    time::{Duration, SystemTime},
};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as TokioMutex, Notify};
use tracing::{debug, info, warn};

pub const TOPIC_PREFIX: &str = "iroh-draw/0:";
pub const PRESENCE_INTERVAL: Duration = Duration::from_secs(5); // what is this?

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DrawTicket {
    pub topic_id: TopicId,
    pub bootstrap: BTreeSet<EndpointId>, // an ordered set of endpoint ids
    /// Known relay homes, so joiners can dial without working discovery
    /// (browsers can't resolve bare IDs). Absent entries ride unresolved.
    pub relays: BTreeMap<EndpointId, RelayUrl>,
}

impl DrawTicket {
    pub fn new_random() -> Self {
        //generate a random topic id. this is probably what we would want to make persistent or give the option to load from previous?
        let topic_id = TopicId::from_bytes(rand::random());
        Self::new(topic_id)
    }

    pub fn new(topic_id: TopicId) -> Self {
        Self {
            topic_id,
            bootstrap: Default::default(), // an empty set
            relays: Default::default(),
        }
    }
    pub fn deserialize(input: &str) -> Result<Self> {
        <Self as Ticket>::decode_string(input).map_err(Into::into) // why do we need this and where is it currently used?
    }
    pub fn serialize(&self) -> String {
        <Self as Ticket>::encode_string(self) // above
    }
}

impl Ticket for DrawTicket {
    const KIND: &'static str = "draw";

    fn encode_bytes(&self) -> Vec<u8> {
        postcard::to_stdvec(&self).unwrap()
    }

    fn decode_bytes(bytes: &[u8]) -> Result<Self, iroh_tickets::ParseError> {
        let ticket = postcard::from_bytes(bytes)?;
        Ok(ticket)
    }
}

#[derive(Clone)]
pub struct DrawNode {
    secret_key: SecretKey,
    router: Router,
    gossip: Gossip,
    lookup: MemoryLookup,
}

impl DrawNode {
    /// Spawns a gossip node.
    pub async fn spawn(secret_key: Option<SecretKey>) -> Result<Self> {
        let secret_key = secret_key.unwrap_or_else(SecretKey::generate);
        let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(secret_key.clone())
            .alpns(vec![GOSSIP_ALPN.to_vec()])
            .bind()
            .await?;

        let endpoint_id = endpoint.id();
        info!("endpoint bound");
        info!("endpoint id: {endpoint_id:#?}");

        // Out-of-band address book: the browser can't resolve bare endpoint
        // IDs (no working discovery), so relay hints from tickets go here and
        // gossip dials resolve through it.
        let lookup = MemoryLookup::new();
        endpoint.address_lookup()?.add(lookup.clone());

        // Default gossip cap is 4KB and oversize sends fail silently —
        // scenes need headroom. (Long-term: chunk snapshots instead.)
        let gossip = Gossip::builder()
            .max_message_size(1024 * 256)
            .spawn(endpoint.clone());
        info!("gossip spawned");
        let router = Router::builder(endpoint)
            .accept(GOSSIP_ALPN, gossip.clone())
            .spawn();
        info!("router spawned");
        Ok(Self {
            gossip,
            router,
            secret_key,
            lookup,
        })
    }

    /// Returns the endpoint id of this endpoint.
    pub fn endpoint_id(&self) -> EndpointId {
        self.router.endpoint().id()
    }

    /// Our current home relay, if the endpoint has settled on one. Tickets
    /// carry this so joiners can dial us without discovery.
    pub fn relay_url(&self) -> Option<RelayUrl> {
        self.router
            .endpoint()
            .addr()
            .addrs
            .iter()
            .find_map(|a| match a {
                TransportAddr::Relay(url) => Some(url.clone()),
                _ => None,
            })
    }

    /// Joins a chat channel from a ticket.
    ///
    /// Returns a [`ChatSender`] to send messages or change our nickname
    /// and a stream of [`Event`] items for incoming messages and other event.s
    pub async fn join(
        &self,
        ticket: &DrawTicket,
        nickname: String,
    ) -> Result<(ChatSender, BoxStream<Result<Event>>)> {
        let topic_id = ticket.topic_id;
        let bootstrap = ticket.bootstrap.iter().cloned().collect();
        // Seed relay hints before subscribing so bootstrap dials resolve
        // without discovery.
        for (id, url) in &ticket.relays {
            let addr = EndpointAddr {
                id: *id,
                addrs: BTreeSet::from([TransportAddr::Relay(url.clone())]),
            };
            self.lookup.add_endpoint_info(addr);
        }
        info!(?bootstrap, "joining {topic_id}");
        let gossip_topic = self.gossip.subscribe(topic_id, bootstrap).await?;
        let (sender, receiver) = gossip_topic.split();

        let nickname = Arc::new(Mutex::new(nickname));
        let trigger_presence = Arc::new(Notify::new());

        // We spawn a task that occasionally sens a Presence message with our nickname.
        // This allows to track which peers are online currently.
        let sender = Arc::new(TokioMutex::new(sender));
        let presence_task = AbortOnDropHandle::new(task::spawn({
            let secret_key = self.secret_key.clone();
            let sender = sender.clone();
            let trigger_presence = trigger_presence.clone();
            let nickname = nickname.clone();

            async move {
                loop {
                    let nickname = nickname.lock().expect("poisoned").clone();
                    let message = Message::Presence { nickname };
                    debug!("send presence {message:?}");
                    let signed_message = SignedMessage::sign_and_encode(&secret_key, message)
                        .expect("failed to encode message");
                    if let Err(err) = sender.lock().await.broadcast(signed_message.into()).await {
                        // Never break here: a transient send failure must not
                        // permanently silence presence (roster would lose us
                        // while drawing keeps working). Retry next interval.
                        tracing::warn!("presence broadcast failed, retrying: {err}");
                    }
                    n0_future::future::race(
                        n0_future::time::sleep(PRESENCE_INTERVAL),
                        trigger_presence.notified(),
                    )
                    .await;
                }
            }
        }));

        // We create a stream of events, coming from the gossip topic event receiver.
        // We'll want to map the events to our own event type, which includes parsing
        // the messages and verifying the signatures, and trigger presence
        // once the swarm is joined initially.
        let receiver = n0_future::stream::try_unfold(receiver, {
            let trigger_presence = trigger_presence.clone();
            move |mut receiver| {
                let trigger_presence = trigger_presence.clone();
                async move {
                    loop {
                        // Store if we were joined before the next event comes in.
                        let was_joined = receiver.is_joined();

                        // Fetch the next event.
                        let Some(event) = receiver.try_next().await? else {
                            return Ok(None);
                        };
                        // Convert into our event type. this fails if we receive a message
                        // that cannot be decoced into our event type. If that is the case,
                        // we just keep and log the error.
                        let event: Event = match event.try_into() {
                            Ok(event) => event,
                            Err(err) => {
                                warn!("received invalid message: {err}");
                                continue;
                            }
                        };
                        // If we just joined, trigger sending our presence message.
                        if !was_joined && receiver.is_joined() {
                            trigger_presence.notify_waiters()
                        };

                        break Ok(Some((event, receiver)));
                    }
                }
            }
        });

        let sender = ChatSender {
            secret_key: self.secret_key.clone(),
            nickname,
            sender,
            trigger_presence,
            _presence_task: Arc::new(presence_task),
        };
        Ok((sender, Box::pin(receiver)))
    }

    pub async fn shutdown(&self) {
        if let Err(err) = self.router.shutdown().await {
            warn!("failed to shutdown router cleanly: {err}");
        }
        self.router.endpoint().close().await;
    }
}

#[derive(Debug, Clone)]
pub struct ChatSender {
    nickname: Arc<Mutex<String>>,
    secret_key: SecretKey,
    sender: Arc<TokioMutex<GossipSender>>,
    trigger_presence: Arc<Notify>,
    _presence_task: Arc<AbortOnDropHandle<()>>,
}

impl ChatSender {
    pub async fn send(&self, text: String) -> Result<()> {
        let nickname = self.nickname.lock().expect("poisoned").clone();
        let message = Message::Message { text, nickname };
        let signed_message = SignedMessage::sign_and_encode(&self.secret_key, message)?;
        self.sender
            .lock()
            .await
            .broadcast(signed_message.into())
            .await?;
        Ok(())
    }

    pub fn set_nickname(&self, name: String) {
        *self.nickname.lock().expect("poisoned") = name;
        self.trigger_presence.notify_waiters();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    #[serde(rename_all = "camelCase")]
    Joined {
        neighbors: Vec<EndpointId>,
    },
    #[serde(rename_all = "camelCase")]
    MessageReceived {
        from: EndpointId,
        text: String,
        nickname: String,
        sent_timestamp: u64,
    },
    #[serde(rename_all = "camelCase")]
    Presence {
        from: EndpointId,
        nickname: String,
        sent_timestamp: u64,
    },
    #[serde(rename_all = "camelCase")]
    NeighborUp {
        endpoint_id: EndpointId,
    },
    #[serde(rename_all = "camelCase")]
    NeighborDown {
        endpoint_id: EndpointId,
    },
    Lagged,
}

impl TryFrom<GossipEvent> for Event {
    type Error = anyhow::Error;
    fn try_from(event: GossipEvent) -> Result<Self, Self::Error> {
        let converted = match event {
            GossipEvent::NeighborUp(endpoint_id) => Self::NeighborUp { endpoint_id },
            GossipEvent::NeighborDown(endpoint_id) => Self::NeighborDown { endpoint_id },
            GossipEvent::Received(message) => {
                let message = SignedMessage::verify_and_decode(&message.content)
                    .context("failed to parse and verify signed message")?;
                match message.message {
                    Message::Presence { nickname } => Self::Presence {
                        from: message.from,
                        nickname,
                        sent_timestamp: message.timestamp,
                    },
                    Message::Message { text, nickname } => Self::MessageReceived {
                        from: message.from,
                        text,
                        nickname,
                        sent_timestamp: message.timestamp,
                    },
                }
            }
            GossipEvent::Lagged => Self::Lagged,
        };
        Ok(converted)
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct SignedMessage {
    from: PublicKey,
    data: Vec<u8>,
    signature: Signature,
}

impl SignedMessage {
    pub fn verify_and_decode(bytes: &[u8]) -> Result<ReceivedMessage> {
        let signed_message: Self = postcard::from_bytes(bytes)?;
        let key: PublicKey = signed_message.from;
        key.verify(&signed_message.data, &signed_message.signature)?;
        let message: WireMessage = postcard::from_bytes(&signed_message.data)?;
        let WireMessage::VO { timestamp, message } = message;
        Ok(ReceivedMessage {
            from: signed_message.from,
            timestamp,
            message,
        })
    }

    pub fn sign_and_encode(secret_key: &SecretKey, message: Message) -> Result<Vec<u8>> {
        let timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_micros() as u64;
        let wire_message = WireMessage::VO { timestamp, message };
        let data = postcard::to_stdvec(&wire_message)?;
        let signature = secret_key.sign(&data);
        let from: PublicKey = secret_key.public();
        let signed_message = Self {
            from,
            data,
            signature,
        };
        let encoded = postcard::to_stdvec(&signed_message)?;
        Ok(encoded)
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub enum WireMessage {
    VO { timestamp: u64, message: Message },
}

#[derive(Debug, Serialize, Deserialize)]
pub enum Message {
    Presence { nickname: String },
    Message { text: String, nickname: String },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReceivedMessage {
    timestamp: u64,
    from: EndpointId,
    message: Message,
}
