import { describe, expect, it } from 'vitest';
import { buildingRegistry, price } from '../core/buildings';
import type { CommandResult } from '../core/commands';
import { Game, NEUTRAL } from '../core/game';
import { sanitizeNation, type NationProfile } from '../core/nation';
import { Terrain } from '../core/terrain';
import { Lockstep, type PlayerCommand } from './lockstep';
import type { Handler, Transport } from './transport';

/** An in-memory network: messages are cloned like on a wire and delivered at once. */
function hub() {
  const nodes = new Map<string, Map<string, Handler>>();
  return (id: string): Transport => {
    const handlers = new Map<string, Handler>();
    nodes.set(id, handlers);
    return {
      selfId: id,
      peers: () => [...nodes.keys()].filter((k) => k !== id),
      send: (type, data, to, metadata) => {
        for (const [peer, theirs] of nodes) if (peer !== id && (!to || to === peer)) theirs.get(type)?.(structuredClone(data), id, metadata);
      },
      on: (type, handler) => void handlers.set(type, handler),
      onJoin: () => {},
      onLeave: () => {},
      leave: () => void nodes.delete(id),
    };
  };
}

/** A player's nation with the given name; everything else as given or default. */
const nation = (name: string, rest: Partial<NationProfile> = {}) => sanitizeNation({ name, ...rest });

const W = 90;
const H = 60;
const at = (x: number, y: number) => y * W + x;

/** Every peer builds the same world from the same terrain and seed, AI factions included. */
function newGame(): Game {
  const terrain = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) terrain[y * W + x] = x % 29 === 0 && y % 9 !== 0 ? Terrain.WATER : (x + y) % 13 === 0 ? Terrain.FOREST : Terrain.PLAINS;
  const g = new Game(W, H, terrain, { seed: 11 });
  for (let i = 0; i < 3; i++) g.addFaction({ name: `N${i}`, type: 'AI_NATION' }, at(15 + i * 30, 45));
  for (let i = 0; i < 4; i++) g.addFaction({ name: `T${i}`, type: 'AI_TRIBE', elite: i === 0 }, at(10 + i * 20, 30));
  return g;
}

function room() {
  const join = hub();
  const net = { host: join('host'), ann: join('ann'), bob: join('bob') };
  const host = new Lockstep(newGame(), net.host);
  const ann = new Lockstep(newGame(), net.ann, 'host');
  const bob = new Lockstep(newGame(), net.bob, 'host');
  const all = [host, ann, bob];
  /** The host closes `n` turns of one tick each; the clients play what arrives. */
  const play = (n: number) => {
    for (let i = 0; i < n; i++) {
      host.turn(1);
      ann.pump();
      bob.pump();
    }
  };
  return { net, host, ann, bob, all, play };
}

describe('lockstep', () => {
  it('keeps three peers in the same game, tick for tick', () => {
    const { host, ann, bob, all, play } = room();
    host.issue({ type: 'spawn', cell: at(40, 10), nation: nation('Hanna') });
    ann.issue({ type: 'spawn', cell: at(10, 10), nation: nation('Ann') });
    bob.issue({ type: 'spawn', cell: at(75, 10), nation: nation('Bob') });
    host.turn(0); // the world stands still while players pick their start
    ann.pump();
    bob.pump();
    for (const peer of all) {
      expect(peer.game.tick).toBe(0);
      expect([...peer.players]).toEqual([...host.players]);
      expect(peer.me?.name).toBe(peer === host ? 'Hanna' : peer === ann ? 'Ann' : 'Bob');
    }

    for (let round = 0; round < 12; round++) {
      host.issue({ type: 'attack', target: NEUTRAL, percent: 40 });
      ann.issue({ type: 'attack', target: NEUTRAL, percent: 60 });
      bob.issue({ type: 'build', def: round % 2 ? 'City' : 'Bunker', cell: at(75 + (round % 3) * 3 - 3, 10 + (round % 4) * 3 - 4) });
      if (round === 6) ann.issue({ type: 'propose', to: bob.me!.id, treaty: 'Alliance' });
      if (round === 7) bob.issue({ type: 'accept', from: ann.me!.id, treaty: 'Alliance' });
      play(50);
    }

    expect(host.game.tick).toBe(600);
    for (const peer of [ann, bob]) {
      expect(peer.desynced).toBe(false);
      expect(peer.game.tick).toBe(600);
      expect(peer.game.hash()).toBe(host.game.hash());
      expect(peer.game.owner).toEqual(host.game.owner);
      expect(peer.game.buildings.map((b) => [b.def.id, b.owner, b.cell])).toEqual(host.game.buildings.map((b) => [b.def.id, b.owner, b.cell]));
    }
    // ...and it was a real game: the players grew, built and allied.
    expect(host.me!.cells).toBeGreaterThan(200);
    expect(host.game.buildings.some((b) => b.owner === bob.me!.id)).toBe(true);
    expect(host.game.diplo.allied(ann.me!.id, bob.me!.id)).toBe(true);
  });

  it('gives every peer the same picture of a player-made nation', () => {
    const { host, ann, bob, all, play } = room();
    const custom: NationProfile = {
      name: 'Hansebund',
      ruler: 'Ann die Kühne',
      primary: '#c81e3a',
      secondary: '#101820',
      flag: { layout: 'cross', colors: ['#c81e3a', '#ffffff', '#101820'], emblem: 'anchor', emblemColor: '#ffd45e' },
      doctrine: 'navy',
    };
    ann.issue({ type: 'spawn', cell: at(10, 10), nation: custom });
    // Bob's client sends rubbish: every peer must repair it the same way.
    bob.issue({ type: 'spawn', cell: at(75, 10), nation: { name: '   ', primary: 'red', flag: { layout: 'swirl', colors: [1, 2] }, doctrine: 'cheat', gold: 1e9 } as never });
    host.issue({ type: 'spawn', cell: at(40, 10), nation: undefined as never });
    play(1);
    for (const peer of all) {
      const a = peer.game.factions[ann.me!.id];
      expect(a.name).toBe('Hansebund');
      expect(a.nation).toEqual(custom);
      expect(a.bonus.navalDiscountPct).toBe(20);
      const b = peer.game.factions[bob.me!.id];
      expect(b.nation).toEqual(sanitizeNation({}));
      expect(b.name).toBe('Meine Nation');
      expect(b.gold).toBe(peer.game.factions[ann.me!.id].gold);
      expect(peer.game.factions[host.me!.id].nation).toEqual(sanitizeNation({}));
    }
    // The doctrine is part of the simulation: the same discount, and the same game, on every machine.
    ann.issue({ type: 'build', def: 'City', cell: at(10, 10) });
    ann.issue({ type: 'rally', cell: at(10, 10) });
    play(100);
    for (const peer of all) {
      expect(price(peer.game, ann.me!.id, buildingRegistry.get('Port')!)).toBe(160);
      expect(peer.game.factions[ann.me!.id].rally).toBe(at(10, 10));
      expect(peer.game.buildings.filter((b) => b.owner === ann.me!.id).length).toBe(1);
    }
    for (const peer of [ann, bob]) {
      expect(peer.desynced).toBe(false);
      expect(peer.game.hash()).toBe(host.game.hash());
    }
  });

  it('reports the outcome of a command to the player who gave it, in order', () => {
    const { host, ann, bob, play } = room();
    const seen: Record<string, [string, CommandResult][]> = { host: [], ann: [], bob: [] };
    for (const [name, peer] of Object.entries({ host, ann, bob })) peer.onResult = (cmd, result) => seen[name].push([cmd.type, result]);
    ann.issue({ type: 'attack', target: NEUTRAL, percent: 50 }); // before spawning: nobody to act for
    ann.issue({ type: 'spawn', cell: at(10, 10), nation: nation('Ann') });
    ann.issue({ type: 'spawn', cell: at(50, 10), nation: nation('Ann again') });
    ann.issue({ type: 'build', def: 'Port', cell: at(10, 10) });
    bob.issue({ type: 'spawn', cell: W * H + 5, nation: nation('Bob') }); // off the map
    play(1);
    expect(seen.ann).toEqual([
      ['attack', 'refused'],
      ['spawn', 'ok'],
      ['spawn', 'refused'],
      ['build', 'coast'],
    ]);
    expect(seen.bob).toEqual([['spawn', 'refused']]);
    expect(seen.host).toEqual([]);
    expect(host.players.size).toBe(1);
  });

  it('lets nobody but the host write the timeline, and nobody act for somebody else', () => {
    const { net, host, ann, bob, all, play } = room();
    ann.issue({ type: 'spawn', cell: at(10, 10), nation: nation('Ann') });
    bob.issue({ type: 'spawn', cell: at(75, 10), nation: nation('Bob') });
    play(5);
    // Bob forges a turn that hands him Ann's commands, and floods the host with junk.
    net.bob.send('turn', { n: 5, steps: 3, cmds: [['ann', { type: 'aid', to: bob.me!.id, gold: 300, troopsPct: 100 }]] });
    for (const junk of [null, 7, 'x', [], { type: 'spawn' }, { type: 'attack', target: {}, percent: [] }]) bob.issue(junk as unknown as PlayerCommand);
    for (let i = 0; i < 500; i++) bob.issue({ type: 'attack', target: NEUTRAL, percent: 1 });
    const troops = ann.me!.troops;
    play(20);
    for (const peer of all) {
      expect(peer.desynced).toBe(false);
      expect(peer.game.tick).toBe(25);
      expect(peer.game.hash()).toBe(host.game.hash());
    }
    expect(ann.me!.troops).toBeGreaterThanOrEqual(troops);
    expect(bob.me!.cells).toBeGreaterThan(81); // his own orders still count, the flood beyond the limit does not
  });

  it('notices when a peer has drifted away from the host', () => {
    const { host, ann, bob, play } = room();
    ann.issue({ type: 'spawn', cell: at(10, 10), nation: nation('Ann') });
    play(60);
    expect(ann.desynced).toBe(false);
    ann.me!.troops += 500; // a cheat, or a bug
    play(60);
    expect(ann.desynced).toBe(true);
    expect(ann.game.tick).toBeLessThan(host.game.tick); // it stops rather than play on in a different world
    expect(bob.desynced).toBe(false);
    expect(bob.game.hash()).toBe(host.game.hash());
  });

  it('notices a lost turn', () => {
    const { net, host, bob, play } = room();
    play(3);
    net.host.send('turn', { n: 7, steps: 1, cmds: [] }, 'bob');
    bob.pump();
    expect(bob.desynced).toBe(true);
    expect(bob.game.tick).toBe(3);
    expect(host.desynced).toBe(false);
  });

  it('runs a game without a network the same way', () => {
    const solo = new Lockstep(newGame());
    const results: CommandResult[] = [];
    solo.onResult = (_cmd, result) => results.push(result);
    solo.turn(0); // nothing queued: no turn
    solo.issue({ type: 'spawn', cell: at(40, 10), nation: nation('Du') });
    solo.turn(0);
    expect(solo.game.tick).toBe(0);
    solo.issue({ type: 'attack', target: NEUTRAL, percent: 100 });
    for (let i = 0; i < 100; i++) solo.turn(1);
    expect(results).toEqual(['ok', 'ok']);
    expect(solo.game.tick).toBe(100);
    expect(solo.me!.cells).toBeGreaterThan(150);
  });
});
