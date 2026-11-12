import type { Transport } from './transport';

export interface Player {
  name: string;
  host: boolean;
}

const MAX_NAME = 20;

/**
 * Who is in the room. Peers introduce themselves with a `hello`; whoever
 * opened the room says so and is the host. Should two peers claim that, the
 * one with the smaller id is it, so everybody agrees without a server.
 */
export class Lobby {
  readonly net: Transport;
  /** The other peers. */
  readonly roster = new Map<string, Player>();
  name: string;
  /** Called whenever somebody joins, leaves or changes. */
  onChange: () => void = () => {};
  private readonly claimsHost: boolean;

  constructor(net: Transport, claimsHost: boolean, name: string) {
    this.net = net;
    this.claimsHost = claimsHost;
    this.name = name;
    net.on('hello', (data, from) => {
      if (typeof data?.name !== 'string') return;
      this.roster.set(from, { name: data.name.trim().slice(0, MAX_NAME) || 'Spieler', host: data.host === true });
      this.onChange();
    });
    net.onJoin = (peer) => this.hello(peer);
    net.onLeave = (peer) => {
      if (this.roster.delete(peer)) this.onChange();
    };
    this.hello();
  }

  /** The peer everybody takes the timeline from, or null while no host is in the room. */
  get hostId(): string | null {
    const claims = [...this.roster].filter(([, p]) => p.host).map(([id]) => id);
    if (this.claimsHost) claims.push(this.net.selfId);
    return claims.length ? claims.sort()[0] : null;
  }

  get isHost(): boolean {
    return this.hostId === this.net.selfId;
  }

  rename(name: string): void {
    this.name = name.trim().slice(0, MAX_NAME) || 'Spieler';
    this.hello();
    this.onChange();
  }

  private hello(to?: string): void {
    void this.net.send('hello', { name: this.name, host: this.claimsHost }, to);
  }
}
