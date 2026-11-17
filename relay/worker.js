/**
 * Multiplayer relay for OSM-Front. The game runs in the players' browsers (host-tick lockstep);
 * this only forwards their messages, so that two players meet even when their networks do not
 * allow a direct WebRTC connection. One Durable Object per room; every message is JSON text.
 *
 *   client -> relay: { type, data, to?, meta?, chunk? }
 *   relay -> client: { t: 'welcome', id, peers } | { t: 'join', id } | { t: 'leave', id } | { ...message, from }
 */
import { DurableObject } from 'cloudflare:workers';

const MAX_PEERS = 16;
/** Text frames above this are refused; the client splits big payloads into chunks below it. */
const MAX_FRAME = 900 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = /^\/room\/([\w-]{3,40})$/.exec(url.pathname);
    if (!match) return new Response('OSM-Front relay. Connect a WebSocket to /room/<id>.', { status: match === null && url.pathname === '/' ? 200 : 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
  },
};

export class Room extends DurableObject {
  async fetch() {
    const peers = this.ctx.getWebSockets();
    if (peers.length >= MAX_PEERS) return new Response('Room is full', { status: 403 });
    const { 0: client, 1: server } = new WebSocketPair();
    const id = crypto.randomUUID().slice(0, 12);
    // Hibernation: the object may sleep between messages; the tag keeps each socket's peer id.
    this.ctx.acceptWebSocket(server, [id]);
    server.send(JSON.stringify({ t: 'welcome', id, peers: peers.map((ws) => this.ctx.getTags(ws)[0]) }));
    this.broadcast(JSON.stringify({ t: 'join', id }), server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > MAX_FRAME) return;
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') return;
    msg.from = this.ctx.getTags(ws)[0];
    const out = JSON.stringify(msg);
    if (typeof msg.to === 'string') {
      for (const peer of this.ctx.getWebSockets(msg.to)) peer.send(out);
    } else this.broadcast(out, ws);
  }

  webSocketClose(ws) {
    this.left(ws);
  }

  webSocketError(ws) {
    this.left(ws);
  }

  left(ws) {
    const id = this.ctx.getTags(ws)[0];
    try {
      ws.close(1000, 'bye');
    } catch {
      // already closed
    }
    this.broadcast(JSON.stringify({ t: 'leave', id }), ws);
  }

  broadcast(text, except) {
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === except) continue;
      try {
        peer.send(text);
      } catch {
        // a socket on its way out
      }
    }
  }
}
