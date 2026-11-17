import type { MessageAction } from 'trystero';

/**
 * What the game needs from a network: named messages to everyone or to one
 * peer, in order, and to know who is there. JSON goes through as JSON, typed
 * arrays as bytes (with optional JSON metadata alongside).
 */
export interface Transport {
  readonly selfId: string;
  peers(): string[];
  /** Resolves once the message has left this machine; later messages arrive after it. */
  send(type: string, data: unknown, to?: string, metadata?: unknown): Promise<void> | void;
  /** Registers the one handler for a message type. Binary payloads arrive as ArrayBuffer or typed array. */
  on(type: string, handler: Handler): void;
  onJoin: (peer: string) => void;
  onLeave: (peer: string) => void;
  leave(): void;
  /** How many of the relays that introduce peers to each other are reachable, if the transport uses any. */
  relays?(): { open: number; total: number };
  /** How the players are connected, for the lobby: through the relay server or peer to peer. */
  readonly kind: 'server' | 'p2p' | 'local';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- messages are untrusted; every handler checks what it got
export type Handler = (data: any, from: string, metadata?: any) => void;

const APP_ID = 'osm-front';

/** Public Nostr relays come and go; asking more of them at once makes it likelier that two players share one. */
const RELAY_REDUNDANCY = 10;

/** Peer-to-peer over WebRTC; peers find each other through public Nostr relays, no server of our own. */
export async function trysteroTransport(roomId: string): Promise<Transport> {
  const { joinRoom, selfId, getRelaySockets } = await import('trystero');
  const room = joinRoom({ appId: APP_ID, relayConfig: { redundancy: RELAY_REDUNDANCY } }, roomId);
  const actions = new Map<string, MessageAction>();
  const action = (type: string): MessageAction => {
    let a = actions.get(type);
    if (!a) actions.set(type, (a = room.makeAction(type)));
    return a;
  };
  const transport: Transport = {
    kind: 'p2p',
    selfId,
    peers: () => Object.keys(room.getPeers()),
    send: (type, data, to, metadata) => action(type).send(data as never, { target: to, metadata: metadata as never }).then(() => {}),
    on: (type, handler) => (action(type).onMessage = (data, { peerId, metadata }) => handler(data, peerId, metadata)),
    onJoin: () => {},
    onLeave: () => {},
    leave: () => void room.leave(),
    relays: () => {
      const sockets = Object.values(getRelaySockets() as Record<string, WebSocket>);
      return { open: sockets.filter((s) => s.readyState === WebSocket.OPEN).length, total: sockets.length };
    },
  };
  room.onPeerJoin = (peer) => transport.onJoin(peer);
  room.onPeerLeave = (peer) => transport.onLeave(peer);
  return transport;
}

/**
 * The same interface between tabs of one browser, over a BroadcastChannel.
 * For developing and testing multiplayer without relays (`?net=local`).
 */
export function localTransport(roomId: string): Transport {
  const channel = new BroadcastChannel(`${APP_ID}:${roomId}`);
  const selfId = Math.random().toString(36).slice(2, 12);
  const known = new Set<string>();
  const handlers = new Map<string, Handler>();
  const post = (kind: string, rest: object = {}) => channel.postMessage({ kind, from: selfId, ...rest });
  const transport: Transport = {
    kind: 'local',
    selfId,
    peers: () => [...known],
    send: (type, data, to, metadata) => post('msg', { type, data, to, metadata }),
    on: (type, handler) => void handlers.set(type, handler),
    onJoin: () => {},
    onLeave: () => {},
    leave: () => {
      post('leave');
      channel.close();
    },
  };
  channel.onmessage = ({ data: m }) => {
    if (m.to && m.to !== selfId) return;
    if (m.kind === 'leave') {
      if (known.delete(m.from)) transport.onLeave(m.from);
      return;
    }
    if (!known.has(m.from)) {
      known.add(m.from);
      if (m.kind === 'join') post('here', { to: m.from });
      transport.onJoin(m.from);
    }
    if (m.kind === 'msg') handlers.get(m.type)?.(m.data, m.from, m.metadata);
  };
  addEventListener('pagehide', () => post('leave'));
  post('join');
  return transport;
}

/** Raw bytes per chunk of a binary message on the relay: below its frame limit once base64-encoded. */
const CHUNK_BYTES = 600 * 1024;
/** How long to wait for the relay server before giving up on it. */
const RELAY_TIMEOUT_MS = 5000;

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Through our relay server (`relay/worker.js`, a Cloudflare Worker): one WebSocket per player,
 * the server forwards every message to the others. Works on any network that allows HTTPS,
 * where peer-to-peer WebRTC can fail behind strict routers. Rejects if the server does not answer.
 */
export function relayTransport(baseUrl: string, roomId: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/room/${encodeURIComponent(roomId)}`);
    const handlers = new Map<string, Handler>();
    const known = new Set<string>();
    /** Binary messages in transit: the chunks received so far, per sender and message. */
    const partial = new Map<string, string[]>();
    let selfId = '';
    let next = 0;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('relay did not answer'));
    }, RELAY_TIMEOUT_MS);
    const transport: Transport = {
      kind: 'server',
      get selfId() {
        return selfId;
      },
      peers: () => [...known],
      send: (type, data, to, meta) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
          const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          const id = next++;
          const n = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
          for (let i = 0; i < n; i++) ws.send(JSON.stringify({ type, to, meta, chunk: { id, i, n }, data: toBase64(bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)) }));
        } else ws.send(JSON.stringify({ type, to, meta, data }));
      },
      on: (type, handler) => void handlers.set(type, handler),
      onJoin: () => {},
      onLeave: () => {},
      leave: () => ws.close(1000, 'bye'),
      relays: () => ({ open: ws.readyState === WebSocket.OPEN ? 1 : 0, total: 1 }),
    };
    ws.onmessage = ({ data }) => {
      let m;
      try {
        m = JSON.parse(data);
      } catch {
        return;
      }
      if (m.t === 'welcome') {
        clearTimeout(timer);
        selfId = m.id;
        for (const peer of m.peers) known.add(peer);
        resolve(transport);
        for (const peer of m.peers) transport.onJoin(peer);
        return;
      }
      if (m.t === 'join') {
        known.add(m.id);
        transport.onJoin(m.id);
        return;
      }
      if (m.t === 'leave') {
        if (known.delete(m.id)) transport.onLeave(m.id);
        return;
      }
      if (typeof m.type !== 'string' || typeof m.from !== 'string') return;
      if (m.chunk) {
        const key = `${m.from}:${m.chunk.id}`;
        const parts = partial.get(key) ?? [];
        parts[m.chunk.i] = m.data;
        partial.set(key, parts);
        if (parts.filter((p) => p !== undefined).length < m.chunk.n) return;
        partial.delete(key);
        const chunks = parts.map(fromBase64);
        const whole = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
        let at = 0;
        for (const c of chunks) {
          whole.set(c, at);
          at += c.length;
        }
        handlers.get(m.type)?.(whole, m.from, m.meta);
      } else handlers.get(m.type)?.(m.data, m.from, m.meta);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('relay unreachable'));
    };
    ws.onclose = () => {
      for (const peer of known) transport.onLeave(peer);
      known.clear();
    };
  });
}
