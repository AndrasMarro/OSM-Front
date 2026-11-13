import { sanitizeNation, type NationProfile } from '../core/nation';
import type { Transport } from './transport';

export interface Player {
  nation: NationProfile;
  host: boolean;
}

/**
 * Who is in the room. Peers introduce themselves with a `hello` that carries
 * their nation; whoever opened the room says so and is the host. Should two
 * peers claim that, the one with the smaller id is it, so everybody agrees
 * without a server.
 */
export class Lobby {
  readonly net: Transport;
  /** The other peers. */
  readonly roster = new Map<string, Player>();
  nation: NationProfile;
  /** Called whenever somebody joins, leaves or changes. */
  onChange: () => void = () => {};
  private readonly claimsHost: boolean;

  constructor(net: Transport, claimsHost: boolean, nation: NationProfile) {
    this.net = net;
    this.claimsHost = claimsHost;
    this.nation = nation;
    net.on('hello', (data, from) => {
      // Whatever a peer sends is cleaned up before anything here shows or stores it.
      this.roster.set(from, { nation: sanitizeNation(data?.nation), host: data?.host === true });
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

  /** The player edited their nation: tell the room. */
  present(nation: NationProfile): void {
    this.nation = nation;
    this.hello();
    this.onChange();
  }

  private hello(to?: string): void {
    void this.net.send('hello', { nation: this.nation, host: this.claimsHost }, to);
  }
}
