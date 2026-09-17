use futures_util::StreamExt as _;
use wasm_bindgen::prelude::*;

const ALPN: &[u8] = b"iroh-live-draw/0";

#[wasm_bindgen]
pub struct Sync {
    ep: iroh::Endpoint,
    // One outbound queue per connected peer. push() only enqueues (never
    // blocks), and a dedicated pump task drains each queue in order — so a
    // slow/stalled peer can never stall the others.
    txs: std::sync::Arc<
        futures_util::lock::Mutex<Vec<futures_channel::mpsc::UnboundedSender<Vec<u8>>>>,
    >,
    rx_cb: Option<js_sys::Function>,
}

async fn write_frame(s: &mut iroh::endpoint::SendStream, b: &[u8]) -> anyhow::Result<()> {
    s.write_all(&(b.len() as u32).to_be_bytes()).await?;
    s.write_all(b).await?;
    Ok(())
}

#[wasm_bindgen]
impl Sync {
    /// Create endpoint (connects to default relay). Pass a previously stored
    /// secret key string for a stable device identity, or None to generate one.
    /// Read it back via [`Sync::secret_key`] and store (e.g. localStorage).
    pub async fn create(
        existing: Option<String>,
        on_remote: js_sys::Function,
    ) -> Result<Sync, JsValue> {
        let secret = match existing {
            Some(s) => s.parse().map_err(|e| format!("bad secret key: {e}"))?,
            None => {
                let mut bytes = [0u8; 32];
                getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
                iroh::SecretKey::from_bytes(&bytes)
            }
        };
        let ep = iroh::Endpoint::builder()
            .secret_key(secret)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .map_err(|e| e.to_string())?;
        let txs = std::sync::Arc::new(futures_util::lock::Mutex::new(Vec::new()));
        // accept loop: one queue+pump per inbound stream, plus a recv loop
        let (ep2, txs2, on_remote2) = (ep.clone(), txs.clone(), on_remote.clone());
        wasm_bindgen_futures::spawn_local(async move {
            while let Some(incoming) = ep2.accept().await {
                if let Ok(conn) = incoming.await {
                    let (cb, t2) = (on_remote2.clone(), txs2.clone());
                    wasm_bindgen_futures::spawn_local(async move {
                        if let Ok((mut s, mut r)) = conn.accept_bi().await {
                            let (tx, mut rx) = futures_channel::mpsc::unbounded::<Vec<u8>>();
                            t2.lock().await.push(tx);
                            wasm_bindgen_futures::spawn_local(async move {
                                while let Some(msg) = rx.next().await {
                                    if write_frame(&mut s, &msg).await.is_err() {
                                        break;
                                    }
                                }
                            });
                            loop {
                                let mut len = [0u8; 4];
                                if r.read_exact(&mut len).await.is_err() {
                                    break;
                                }
                                let mut buf = vec![0u8; u32::from_be_bytes(len) as usize];
                                if r.read_exact(&mut buf).await.is_err() {
                                    break;
                                }
                                let _ = cb.call1(
                                    &JsValue::NULL,
                                    &JsValue::from_str(&String::from_utf8_lossy(&buf)),
                                );
                            }
                        }
                    });
                }
            }
        });
        Ok(Sync {
            ep,
            txs,
            rx_cb: Some(on_remote),
        })
    }

    pub fn node_id(&self) -> String {
        self.ep.node_id().to_string()
    }

    /// Secret key string — persist it; passing it back to `create` restores
    /// this device's identity (same node id / addr across reloads).
    pub fn secret_key(&self) -> String {
        self.ep.secret_key().to_string()
    }

    /// Sign a message with this device's identity key (hex Ed25519 signature).
    /// Used for presence: the worker verifies it against our node id, so no
    /// password is ever needed or stored.
    pub fn sign_presence(&self, msg: &str) -> String {
        hex::encode(self.ep.secret_key().sign(msg.as_bytes()).to_bytes())
    }

    /// Full dial string: "<node-id> <home-relay-url>". Waits for home relay.
    pub async fn addr(&self) -> Result<String, JsValue> {
        let relay = self
            .ep
            .home_relay()
            .initialized()
            .await
            .map_err(|e| e.to_string())?;
        Ok(format!("{} {relay}", self.ep.node_id()))
    }

    /// Dial peer by addr string from [`Sync::addr`], then send current snapshot.
    pub async fn join(&self, peer: &str, snapshot: &str) -> Result<(), JsValue> {
        let (id_s, relay_s) = peer
            .trim()
            .split_once(char::is_whitespace)
            .ok_or("paste '<node-id> <relay-url>'")?;
        let id: iroh::NodeId = id_s.parse().map_err(|e| format!("bad node id: {e}"))?;
        let relay: iroh::RelayUrl = relay_s
            .trim()
            .parse()
            .map_err(|e| format!("bad relay url: {e}"))?;
        let conn = self
            .ep
            .connect(iroh::NodeAddr::new(id).with_relay_url(relay), ALPN)
            .await
            .map_err(|e| e.to_string())?;
        let (mut send, mut recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
        write_frame(&mut send, snapshot.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        // queue+pump for this peer (same shape as the accept path above)
        let (tx, mut rx) = futures_channel::mpsc::unbounded::<Vec<u8>>();
        self.txs.lock().await.push(tx);
        wasm_bindgen_futures::spawn_local(async move {
            while let Some(msg) = rx.next().await {
                if write_frame(&mut send, &msg).await.is_err() {
                    break;
                }
            }
        });
        // background: forward outbound queue + inbound to JS callback
        if let Some(cb) = self.rx_cb.clone() {
            wasm_bindgen_futures::spawn_local(async move {
                loop {
                    let mut len = [0u8; 4];
                    if recv.read_exact(&mut len).await.is_err() {
                        break;
                    }
                    let mut buf = vec![0u8; u32::from_be_bytes(len) as usize];
                    if recv.read_exact(&mut buf).await.is_err() {
                        break;
                    }
                    let _ = cb.call1(
                        &JsValue::NULL,
                        &JsValue::from_str(&String::from_utf8_lossy(&buf)),
                    );
                }
            });
        }
        Ok(())
    }

    /// Enqueue a message for every connected peer (never blocks).
    /// Dead peers are pruned; per-peer pumps preserve send order.
    pub fn push(&self, snapshot: &str) {
        let (t, b) = (self.txs.clone(), snapshot.as_bytes().to_vec());
        wasm_bindgen_futures::spawn_local(async move {
            let mut v = t.lock().await;
            v.retain(|tx| !tx.is_closed());
            for tx in v.iter() {
                let _ = tx.unbounded_send(b.clone());
            }
        });
    }
}
