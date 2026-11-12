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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- messages are untrusted; every handler checks what it got
export type Handler = (data: any, from: string, metadata?: any) => void;

const APP_ID = 'osm-front';

/** Peer-to-peer over WebRTC; peers find each other through public Nostr relays, no server of our own. */
export async function trysteroTransport(roomId: string): Promise<Transport> {
  const { joinRoom, selfId, getRelaySockets } = await import('trystero');
  const room = joinRoom({ appId: APP_ID }, roomId);
  const actions = new Map<string, MessageAction>();
  const action = (type: string): MessageAction => {
    let a = actions.get(type);
    if (!a) actions.set(type, (a = room.makeAction(type)));
    return a;
  };
  const transport: Transport = {
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
