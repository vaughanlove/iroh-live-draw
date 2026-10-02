//! draw-crdt: the single source of truth for convergence.
//!
//! LWW-element-map over opaque element JSON. Per id, the winner is
//! max(version, ts, author); deletes are first-class tombstones so a late
//! snapshot can never resurrect a deleted element. Snapshots merge — they
//! never replace.
//!
//! Pure logic: no tokio, no iroh, no I/O. Compiled natively (keeper, tests)
//! and to wasm (celld cells via wasm_modules, browsers via wasm-bindgen).
//! The wire shape mirrors the TS `Entry` / keeper `Claim` and the cell
//! `/snapshot` + `/push` JSON: meta as `{id: [ts, author]}` alongside each
//! element's `version`, tombs as `{id, v, ts, author}`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// A CRDT claim on one element id.
#[derive(Clone, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Claim {
    #[serde(default)]
    pub v: i64,
    #[serde(default)]
    pub ts: i64,
    #[serde(default)]
    pub author: String,
}

impl Claim {
    pub fn new(v: i64, ts: i64, author: impl Into<String>) -> Self {
        Self { v, ts, author: author.into() }
    }
}

impl Ord for Claim {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.v.cmp(&other.v).then(self.ts.cmp(&other.ts)).then(self.author.cmp(&other.author))
    }
}

impl PartialOrd for Claim {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// One page of merged state: live elements + claims + tombstones + files.
/// Elements and files stay opaque JSON (envelopes when keyed); only the
/// claims are interpreted.
#[derive(Default, Debug, Clone, Serialize, Deserialize)]
pub struct PageState {
    #[serde(default)]
    pub elements: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub meta: HashMap<String, Claim>,
    #[serde(default)]
    pub tombs: HashMap<String, Claim>,
    #[serde(default)]
    pub files: HashMap<String, serde_json::Value>,
}

/// Best known claim for id: (claim, deleted?).
pub fn best(meta: &HashMap<String, Claim>, tombs: &HashMap<String, Claim>, id: &str) -> Option<(Claim, bool)> {
    match (meta.get(id), tombs.get(id)) {
        (Some(m), Some(t)) => Some(if m >= t { (m.clone(), false) } else { (t.clone(), true) }),
        (Some(m), None) => Some((m.clone(), false)),
        (None, Some(t)) => Some((t.clone(), true)),
        (None, None) => None,
    }
}

impl PageState {
    pub fn best(&self, id: &str) -> Option<(Claim, bool)> {
        best(&self.meta, &self.tombs, id)
    }

    /// Ingest tombstones; returns true if anything changed.
    pub fn ingest_tombs(&mut self, tombs: &[Tomb]) -> bool {
        let mut changed = false;
        for t in tombs {
            let cand = Claim::new(t.v, t.ts, t.author.clone());
            let wins = self.best(&t.id).map(|(e, _)| cand > e).unwrap_or(true);
            if wins {
                self.tombs.insert(t.id.clone(), cand);
                self.meta.remove(&t.id);
                changed = true;
            }
        }
        changed
    }

    /// Ingest elements with their parallel meta table (`id -> (ts, author)`,
    /// version read off each element). Unknown ids without meta default to
    /// `(0, "")`, exactly like the keeper.
    pub fn ingest_elements(&mut self, elements: &[serde_json::Value], meta: &HashMap<String, (i64, String)>) {
        for el in elements {
            let Some(id) = el.get("id").and_then(|v| v.as_str()) else { continue };
            let v = el.get("version").and_then(|v| v.as_i64()).unwrap_or(0);
            let (ts, author) = meta.get(id).cloned().unwrap_or((0, String::new()));
            let cand = Claim::new(v, ts, author);
            let wins = self.best(id).map(|(e, _)| cand > e).unwrap_or(true);
            if wins {
                self.meta.insert(id.to_string(), cand);
                self.tombs.remove(id);
                self.elements.insert(id.to_string(), el.clone());
            }
        }
    }

    /// Merge a full push (tombs first, then elements, then files), then evict
    /// anything the tombstones condemn. Mirrors the cell's merge + keeper
    /// ingest + TS mergePageSnapshot.
    pub fn merge(&mut self, push: &Push) {
        self.ingest_tombs(&push.tombs);
        self.ingest_elements(&push.elements, &push.meta);
        for (id, f) in &push.files {
            self.files.insert(id.clone(), f.clone());
        }
        self.evict();
    }

    /// Drop live elements condemned by a winning tombstone.
    pub fn evict(&mut self) {
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

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            elements: self.elements.values().cloned().collect(),
            meta: self.meta.iter().map(|(id, c)| (id.clone(), (c.ts, c.author.clone()))).collect(),
            tombs: self
                .tombs
                .iter()
                .map(|(id, c)| Tomb { id: id.clone(), v: c.v, ts: c.ts, author: c.author.clone() })
                .collect(),
            files: self.files.values().cloned().collect(),
        }
    }
}

/// One tombstone on the wire.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Tomb {
    pub id: String,
    #[serde(default)]
    pub v: i64,
    #[serde(default)]
    pub ts: i64,
    #[serde(default)]
    pub author: String,
}

/// A push to merge: sealed/opaque elements + cleartext claims + tombstones.
/// `meta` parallels `elements` (`id -> (ts, author)`); element versions ride
/// on the elements themselves.
#[derive(Default, Debug, Clone, Serialize, Deserialize)]
pub struct Push {
    #[serde(default)]
    pub elements: Vec<serde_json::Value>,
    #[serde(default)]
    pub meta: HashMap<String, (i64, String)>,
    #[serde(default)]
    pub tombs: Vec<Tomb>,
    #[serde(default)]
    pub files: HashMap<String, serde_json::Value>,
}

/// A merged snapshot to serve / ingest.
#[derive(Default, Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    #[serde(default)]
    pub elements: Vec<serde_json::Value>,
    #[serde(default)]
    pub meta: HashMap<String, (i64, String)>,
    #[serde(default)]
    pub tombs: Vec<Tomb>,
    #[serde(default)]
    pub files: Vec<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn el(id: &str, version: i64) -> serde_json::Value {
        json!({ "id": id, "version": version })
    }

    #[test]
    fn lww_order_is_version_then_ts_then_author() {
        assert!(Claim::new(2, 0, "") > Claim::new(1, 99, "z"));
        assert!(Claim::new(1, 2, "") > Claim::new(1, 1, "z"));
        assert!(Claim::new(1, 1, "b") > Claim::new(1, 1, "a"));
    }

    #[test]
    fn late_snapshot_cannot_resurrect() {
        let mut s = PageState::default();
        s.merge(&Push {
            elements: vec![el("a", 1)],
            meta: [("a".to_string(), (10, "alice".to_string()))].into(),
            ..Default::default()
        });
        assert!(s.elements.contains_key("a"));
        // Delete wins at higher version…
        s.merge(&Push {
            tombs: vec![Tomb { id: "a".into(), v: 2, ts: 11, author: "alice".into() }],
            ..Default::default()
        });
        assert!(!s.elements.contains_key("a"));
        // …and a stale copy of the element stays dead.
        s.merge(&Push {
            elements: vec![el("a", 1)],
            meta: [("a".to_string(), (10, "alice".to_string()))].into(),
            ..Default::default()
        });
        assert!(!s.elements.contains_key("a"));
        assert!(s.tombs.contains_key("a"));
    }

    #[test]
    fn live_element_beating_its_tomb_buries_it() {
        let mut s = PageState::default();
        s.merge(&Push {
            tombs: vec![Tomb { id: "a".into(), v: 1, ts: 5, author: "alice".into() }],
            ..Default::default()
        });
        s.merge(&Push {
            elements: vec![el("a", 2)],
            meta: [("a".to_string(), (6, "alice".to_string()))].into(),
            ..Default::default()
        });
        assert!(s.elements.contains_key("a"));
        assert!(!s.tombs.contains_key("a"));
    }

    #[test]
    fn snapshot_round_trips_through_json() {
        let mut s = PageState::default();
        s.merge(&Push {
            elements: vec![el("a", 3)],
            meta: [("a".to_string(), (7, "bob".to_string()))].into(),
            ..Default::default()
        });
        let snap = s.snapshot();
        let json = serde_json::to_string(&snap).unwrap();
        let back: Snapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(back.elements.len(), 1);
        assert_eq!(back.meta["a"], (7, "bob".to_string()));
    }
}
