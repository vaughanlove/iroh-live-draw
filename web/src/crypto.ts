// Project data-key crypto: AES-GCM-256 envelopes via @noble/ciphers.
//
// Pure-JS on purpose: WebCrypto Subtle is undefined on insecure origins
// (http LAN IPs — the main testing setup), and silently degrading to
// "send nothing" there once ate every outbound message with zero trace.
// Noble works everywhere with identical wire output, so envelopes sealed
// on any device open on any other.
//
// Key separation is the whole design: the share TICKET (routing + auth,
// seen by the keeper) and the project DATA KEY (content, peers only) are
// different secrets in different link params. The keeper only ever sees
// envelopes — {id, v, nonce, ct} — and merges by the cleartext CRDT
// claims exactly as before. Tombstones stay cleartext (ids only).
// Local storage stays plaintext (device trust boundary).
import { gcm } from '@noble/ciphers/aes.js'

export type Envelope = {
  id: string
  v: number
  enc: 1
  nonce: string
  ct: string
}

export type FileEnvelope = {
  id: string
  enc: 1
  nonce: string
  ct: string
}

const TE = new TextEncoder()
const TD = new TextDecoder()

const b64encode = (bytes: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

const b64decode = (s: string): Uint8Array => {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export const isEnvelope = (el: any): el is Envelope =>
  !!el && typeof el === 'object' && el.enc === 1 && typeof el.id === 'string' && typeof el.ct === 'string'

export const isFileEnvelope = (f: any): f is FileEnvelope =>
  !!f && typeof f === 'object' && f.enc === 1 && typeof f.id === 'string' && typeof f.ct === 'string'

async function importKey(raw: Uint8Array): Promise<Uint8Array> {
  if (raw.length !== 32) throw new Error('bad key length')
  return raw
}

export function generateKey(): Uint8Array {
  const raw = new Uint8Array(32)
  crypto.getRandomValues(raw)
  return raw
}

/// Boot self-test: seal+open round-trip. Logs loudly on failure — a broken
/// cipher must never degrade into silent send-nothing again.
export async function selfTest(): Promise<boolean> {
  try {
    const key = generateKey()
    const env = await sealElement(key, { id: 'selftest', version: 1, type: 'rect' })
    const pt = await openElement(key, env)
    const ok = !!pt && pt.id === 'selftest'
    if (!ok) console.error('[crypto] self-test FAILED: round-trip mismatch')
    return ok
  } catch (e) {
    console.error('[crypto] self-test FAILED:', e)
    return false
  }
}

export const keyToB64 = (raw: Uint8Array): string => b64encode(raw)
export const keyFromB64 = (s: string): Uint8Array | null => {
  try {
    const raw = b64decode(s.trim())
    return raw.length === 32 ? raw : null
  } catch {
    return null
  }
}

const randomNonce = (): Uint8Array => {
  const n = new Uint8Array(12)
  crypto.getRandomValues(n)
  return n
}

// AAD binds the ciphertext to its element id: blobs can't be cut-pasted
// between ids (or into another project sharing nothing else).
async function seal(key: Uint8Array, id: string, plaintext: string): Promise<{ nonce: string; ct: string }> {
  const nonce = randomNonce()
  const cipher = gcm(key, nonce, TE.encode(id))
  return { nonce: b64encode(nonce), ct: b64encode(cipher.encrypt(TE.encode(plaintext))) }
}

async function open(key: Uint8Array, id: string, nonce: string, ct: string): Promise<string | null> {
  try {
    const cipher = gcm(key, b64decode(nonce), TE.encode(id))
    return TD.decode(cipher.decrypt(b64decode(ct)))
  } catch {
    return null // wrong key or tampered: drop, never throw into sync
  }
}

export async function sealElement(rawKey: Uint8Array, el: any): Promise<Envelope> {
  const key = await importKey(rawKey)
  const { nonce, ct } = await seal(key, String(el.id), JSON.stringify(el))
  return { id: String(el.id), v: el.version ?? 0, enc: 1, nonce, ct }
}

export async function openElement(rawKey: Uint8Array, env: Envelope): Promise<any | null> {
  const key = await importKey(rawKey)
  const json = await open(key, env.id, env.nonce, env.ct)
  if (!json) return null
  try {
    const el = JSON.parse(json)
    if (!el || typeof el.id !== 'string') return null
    return el
  } catch {
    return null
  }
}

export async function sealFile(rawKey: Uint8Array, id: string, file: any): Promise<FileEnvelope> {
  const key = await importKey(rawKey)
  const { nonce, ct } = await seal(key, String(id), JSON.stringify(file))
  return { id: String(id), enc: 1, nonce, ct }
}

export async function openFile(rawKey: Uint8Array, env: FileEnvelope): Promise<any | null> {
  const key = await importKey(rawKey)
  const json = await open(key, env.id, env.nonce, env.ct)
  if (!json) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

// ---- per-project key storage (never leaves the device) ----
const keyLsKey = (docId: string) => `draw.key.${docId}`

export const loadKey = (docId: string): Uint8Array | null => {
  try {
    const s = localStorage.getItem(keyLsKey(docId))
    return s ? keyFromB64(s) : null
  } catch {
    return null
  }
}

export const saveKey = (docId: string, raw: Uint8Array) => {
  try {
    localStorage.setItem(keyLsKey(docId), keyToB64(raw))
  } catch {}
}
