import { describe, expect, it } from 'vitest';
import { build } from './buildings';
import { execute, type Command } from './commands';
import { DIFFICULTY, Game, NEUTRAL, type Difficulty } from './game';
import { Terrain } from './terrain';
import { at, run } from './testkit';

/** Two equal plains joined by a neck of mountains six cells wide: the player in the west, an AI nation in the east. */
function duel(difficulty: Difficulty, seed: number) {
  const w = 100;
  const h = 40;
  const t = new Uint8Array(w * h).fill(Terrain.WATER);
  for (let y = 2; y < h - 2; y++) {
    for (let x = 22; x < 79; x++) {
      const neck = x >= 46 && x <= 54;
      if (!neck || (y >= 17 && y < 23)) t[y * w + x] = neck ? Terrain.MOUNTAIN : Terrain.PLAINS;
    }
  }
  const g = new Game(w, h, t, { seed, difficulty });
  const me = g.addFaction({ name: 'Mensch', type: 'HUMAN_NATION' }, at(g, 40, 20))!;
  const ai = g.addFaction({ name: 'KI', type: 'AI_NATION' }, at(g, 62, 20))!;
  return { g, me, ai };
}

/**
 * Plays the duel with a scripted player, one decision every two seconds like the AI.
 * The naive one only expands. The clever one does what the level asks for: trade,
 * gifts and a pact to buy time, bunkers and a rally point on the neck, cities and SAM
 * sites behind it - and it strikes once it is clearly the stronger side.
 */
function play(difficulty: Difficulty, clever: boolean, seed: number, ticks: number) {
  const { g, me, ai } = duel(difficulty, seed);
  const cmd = (c: Command) => execute(g, me.id, c);
  const mine = (x: number, y: number) => g.owner[at(g, x, y)] === me.id;
  let firstBlood = -1;
  for (let i = 0; i < ticks && me.alive && ai.alive; i++) {
    if (i % 20 === 0) {
      if (me.bordersNeutral && me.troops * 5 >= g.maxTroops(me) * 2) cmd({ type: 'attack', target: NEUTRAL, percent: 30 });
      if (clever) {
        const status = g.diplo.status(g, me.id, ai.id);
        const ready = me.troops > ai.troops * 1.4 && me.troops * 10 > g.maxTroops(me) * 8;
        if (!g.diplo.trading(me.id, ai.id)) cmd({ type: 'propose', to: ai.id, treaty: 'TradeAgreement' });
        if (status === 'Neutral' && !ready && cmd({ type: 'propose', to: ai.id, treaty: 'NonAggressionPact' }) !== 'ok' && me.gold >= 100) cmd({ type: 'aid', to: ai.id, gold: 100, troopsPct: 0 });
        for (const [x, y] of [[47, 19], [47, 21], [44, 20]]) if (mine(x, y)) cmd({ type: 'build', def: 'Bunker', cell: at(g, x, y) });
        if (mine(46, 20)) cmd({ type: 'rally', cell: at(g, 46, 20) });
        for (const [x, y] of [[36, 8], [36, 32], [34, 20], [28, 8], [28, 32], [26, 20], [30, 14], [30, 26]]) if (mine(x, y)) cmd({ type: 'build', def: 'City', cell: at(g, x, y) });
        for (const [x, y] of [[38, 14], [38, 26], [30, 20]]) if (mine(x, y) && me.gold > 900) cmd({ type: 'build', def: 'SAMSite', cell: at(g, x, y) });
        if (me.neighbors.includes(ai.id) && ((status === 'War' && me.troops > ai.troops) || (status === 'Neutral' && ready))) cmd({ type: 'attack', target: ai.id, percent: 50 });
      }
    }
    g.step();
    if (firstBlood < 0 && g.attacks.some((a) => a.attacker === ai.id && a.target === me.id)) firstBlood = g.tick;
  }
  return { g, me, ai, firstBlood };
}

describe('difficulty "impossible"', () => {
  it('gives the AI +35 % growth and +40 % income, and no head start for the player', () => {
    const after = (difficulty: Difficulty) => {
      const { g, me, ai } = duel(difficulty, 5);
      ai.troops = me.troops = 500;
      ai.gold = me.gold = 0;
      run(g, 10); // before the AI spends anything
      return { meTroops: me.troops, meGold: me.gold, aiTroops: ai.troops - 500, aiGold: ai.gold };
    };
    const normal = after('normal');
    const impossible = after('impossible');
    expect(impossible.meTroops).toBe(normal.meTroops);
    expect(impossible.meGold).toBe(normal.meGold);
    expect(impossible.aiTroops / normal.aiTroops).toBeCloseTo(1.35, 1);
    expect(impossible.aiGold / normal.aiGold).toBeCloseTo(1.4, 5);
    expect(DIFFICULTY.impossible.peaceTicks).toBe(0);
  });

  it('is stronger than "hard": the AI is ahead early and overruns a player who only expands', () => {
    const hard = play('hard', false, 3, 300);
    const impossible = play('impossible', false, 3, 300);
    expect(impossible.ai.troops).toBeGreaterThan(hard.ai.troops * 1.1);
    expect(impossible.g.buildings.filter((b) => b.owner === impossible.ai.id).length).toBeGreaterThanOrEqual(hard.g.buildings.filter((b) => b.owner === hard.ai.id).length);
    const lost = play('impossible', false, 3, 3000);
    expect(lost.me.alive).toBe(false);
  });

  it('kills nobody on the spot: even the naive player gets a fight that lasts', () => {
    const { g, firstBlood } = play('impossible', false, 3, 3000);
    expect(firstBlood).toBeGreaterThan(100); // the AI has to grow and reach the player first
    expect(g.tick - firstBlood).toBeGreaterThan(100); // and then needs more than ten seconds
  });

  it.each([3, 7, 11])('can be beaten with bunkers on the chokepoint, diplomacy and a well-timed strike (seed %i)', (seed) => {
    const { me, ai } = play('impossible', true, seed, 9000);
    expect(me.alive).toBe(true);
    expect(ai.alive).toBe(false);
  });

  it('is deterministic', () => {
    expect(play('impossible', true, 3, 1500).g.hash()).toBe(play('impossible', true, 3, 1500).g.hash());
  });
});

describe('coalition against the leading player', () => {
  /** A large island for the player, one too small for a port for an AI nation with a missile silo and money to spend. */
  const islands = (difficulty: Difficulty) => {
    const w = 90;
    const h = 30;
    const t = new Uint8Array(w * h).fill(Terrain.WATER);
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) if (x < 50 || (x > 74 && x < 86 && y > 9 && y < 21)) t[y * w + x] = Terrain.PLAINS;
    const g = new Game(w, h, t, { seed: 4, difficulty });
    const me = g.addFaction({ name: 'Mensch', type: 'HUMAN_NATION' }, at(g, 25, 15))!;
    const ai = g.addFaction({ name: 'KI', type: 'AI_NATION' }, at(g, 80, 15))!;
    ai.gold = 4000;
    expect(build(g, ai.id, 'MissileSilo', at(g, 80, 15))).toBe('ok');
    let launches = 0;
    let seen = new Set<number>();
    for (let i = 0; i < 1200; i++) {
      if (i % 20 === 0 && me.bordersNeutral && me.troops * 5 >= g.maxTroops(me) * 2) execute(g, me.id, { type: 'attack', target: NEUTRAL, percent: 30 });
      g.step();
      const now = new Set(g.units.filter((u) => u.owner === ai.id && u.def.domain === 'missile').map((u) => u.id));
      for (const id of now) if (!seen.has(id)) launches++;
      seen = now;
    }
    return { g, me, ai, launches };
  };

  it('strikes the player who has outgrown it, without a war - but only on the highest level', () => {
    const hard = islands('hard');
    expect(hard.me.cells).toBeGreaterThan(hard.ai.cells);
    expect(hard.launches).toBe(0);
    const impossible = islands('impossible');
    expect(impossible.me.cells).toBeGreaterThan(impossible.ai.cells);
    expect(impossible.launches).toBeGreaterThan(0);
  });

  it('never empties a full treasury in one salvo', () => {
    const { launches, me } = islands('impossible');
    expect(launches).toBeLessThanOrEqual(12); // one strike per ten seconds
    expect(me.alive).toBe(true);
  });
});
