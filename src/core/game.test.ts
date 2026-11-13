import { describe, expect, it } from 'vitest';
import { Game, NEUTRAL } from './game';
import { mulberry32 } from './rng';
import { Terrain } from './terrain';
import { at, human, run, world } from './testkit';

const { WATER, PLAINS, MOUNTAIN, FOREST } = Terrain;

describe('mulberry32', () => {
  it('repeats for the same seed and stays in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v >= 0 && v < 1).toBe(true);
    }
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe('cell flooding', () => {
  it('floods free land but never water or the land behind it', () => {
    const g = world(40, 40, (x) => (x === 20 ? WATER : PLAINS));
    const me = human(g, 8, 20);
    const before = me.cells;
    expect(g.attack(me.id, NEUTRAL, 100)).toBe(true);
    run(g, 300);
    expect(me.cells).toBeGreaterThan(before * 3);
    for (let y = 0; y < 40; y++) for (let x = 20; x < 40; x++) expect(g.owner[at(g, x, y)]).toBe(NEUTRAL);
  });

  it('advances faster over plains than over mountains', () => {
    const g = world(80, 21, (x) => (x < 40 ? MOUNTAIN : PLAINS));
    const me = human(g, 40, 10);
    g.attack(me.id, NEUTRAL, 100);
    run(g, 40);
    let mountain = 0;
    let plains = 0;
    for (let x = 0; x < 80; x++) if (g.owner[at(g, x, 10)] === me.id) x < 40 ? mountain++ : plains++;
    expect(plains).toBeGreaterThan(mountain + 3);
  });

  it('refuses targets without a shared border and keeps the troops', () => {
    const g = world(60, 20, (x) => (x === 30 ? WATER : PLAINS));
    const me = human(g, 10, 10);
    const far = g.addFaction({ name: 'Fern', type: 'AI_TRIBE' }, at(g, 50, 10))!;
    const troops = me.troops;
    expect(g.attack(me.id, far.id, 100)).toBe(false);
    expect(me.troops).toBe(troops);
    expect(g.attacks.length).toBe(0);
  });

  it('returns unused troops when the front runs out of land', () => {
    const g = world(30, 30, (x, y) => (Math.abs(x - 15) < 8 && Math.abs(y - 15) < 8 ? PLAINS : WATER));
    const me = human(g, 15, 15);
    me.troops = 50_000;
    g.attack(me.id, NEUTRAL, 100);
    run(g, 100);
    expect(me.cells).toBe(g.landCells);
    expect(g.attacks.length).toBe(0);
    expect(me.troops).toBeGreaterThan(40_000);
  });
});

describe('factions', () => {
  it('lets a strong player overrun a standard tribe', () => {
    const g = world(60, 30);
    const me = human(g, 10, 15);
    const tribe = g.addFaction({ name: 'Stamm', type: 'AI_TRIBE' }, at(g, 19, 15))!;
    const home = at(g, 19, 15);
    expect(g.owner[home]).toBe(tribe.id);
    me.troops = 20_000;
    expect(g.attack(me.id, tribe.id, 100)).toBe(true);
    run(g, 300);
    expect(tribe.alive).toBe(false);
    expect(tribe.cells).toBe(0);
    expect(g.owner[home]).toBe(me.id);
  });

  it('makes elite tribes costlier to take and has them strike back', () => {
    const g = world(60, 30, () => FOREST);
    const me = human(g, 10, 15);
    const elite = g.addFaction({ name: 'Clan', type: 'AI_TRIBE', elite: true }, at(g, 20, 15))!;
    expect(elite.troops).toBeGreaterThan(me.troops);
    expect(elite.homeTerrain).toBe(FOREST);
    g.attack(me.id, elite.id, 50);
    let struckBack = false;
    for (let i = 0; i < 100; i++) {
      g.step();
      struckBack ||= g.attacks.some((a) => a.attacker === elite.id && a.target === me.id);
    }
    expect(struckBack).toBe(true);
    expect(elite.alive).toBe(true);
  });

  it('grows standard tribes far slower than nations', () => {
    const g = world(60, 20, (x) => (x === 30 ? WATER : PLAINS));
    const nation = human(g, 10, 10);
    const tribe = g.addFaction({ name: 'Stamm', type: 'AI_TRIBE' }, at(g, 50, 10))!;
    tribe.troops = nation.troops = 200;
    run(g, 19); // before the tribe's first AI decision
    expect(nation.troops - 200).toBeGreaterThan((tribe.troops - 200) * 2);
  });
});

describe('determinism', () => {
  const play = (seed: number) => {
    const g = world(90, 60, (x, y) => (x % 23 === 0 && y % 7 !== 0 ? WATER : (x + y) % 11 === 0 ? MOUNTAIN : PLAINS), seed);
    for (let i = 0; i < 4; i++) g.addFaction({ name: `N${i}`, type: 'AI_NATION' }, at(g, 12 + i * 22, 15 + (i % 2) * 30));
    for (let i = 0; i < 6; i++) g.addFaction({ name: `T${i}`, type: 'AI_TRIBE', elite: i === 0 }, at(g, 8 + i * 14, 30));
    run(g, 1200);
    return g;
  };

  it('replays identically from the same seed', () => {
    const a = play(7);
    const b = play(7);
    expect(a.owner).toEqual(b.owner);
    expect(a.factions.map((f) => f.troops)).toEqual(b.factions.map((f) => f.troops));
    expect(a.factions.map((f) => f.gold)).toEqual(b.factions.map((f) => f.gold));
    expect(a.buildings.map((x) => [x.def.id, x.owner, x.cell])).toEqual(b.buildings.map((x) => [x.def.id, x.owner, x.cell]));
    expect(a.units.map((u) => [u.def.id, u.x, u.y])).toEqual(b.units.map((u) => [u.def.id, u.x, u.y]));
    // ...and the AIs actually did something worth comparing: they grew, built and fought.
    expect(a.factions.some((f) => f.type === 'AI_NATION' && f.cells > 200)).toBe(true);
    expect(a.buildings.length).toBeGreaterThan(5);
    expect(a.factions.some((f) => f.id > 0 && !f.alive)).toBe(true);
  });

  it('keeps the per-faction bookkeeping consistent with the grid', () => {
    const g = play(3);
    const cells = new Array(g.factions.length).fill(0);
    for (const o of g.owner) cells[o]++;
    for (const f of g.factions.slice(1)) expect(f.cells).toBe(cells[f.id]);
    for (let i = 0; i < g.owner.length; i++) if (g.terrain[i] === WATER) expect(g.owner[i]).toBe(NEUTRAL);
  });
});

describe('difficulty', () => {
  const duel = (difficulty: 'easy' | 'normal' | 'hard', seed = 5) => {
    const terrain = new Uint8Array(60 * 30).fill(PLAINS);
    const g = new Game(60, 30, terrain, { seed, difficulty });
    const me = g.addFaction({ name: 'Mensch', type: 'HUMAN_NATION' }, at(g, 10, 15))!;
    const ai = g.addFaction({ name: 'KI', type: 'AI_NATION' }, at(g, 21, 15))!;
    return { g, me, ai };
  };

  it('lets the AI grow slower on easy and faster on hard, and leaves players alone', () => {
    const grown = (difficulty: 'easy' | 'normal' | 'hard') => {
      const { g, me, ai } = duel(difficulty);
      ai.troops = me.troops = 500;
      run(g, 10); // before the AI spends anything
      return [me.troops - 500, ai.troops - 500];
    };
    const [easy, normal, hard] = [grown('easy'), grown('normal'), grown('hard')];
    expect(easy[0]).toBe(normal[0]);
    expect(hard[0]).toBe(normal[0]);
    expect(easy[1] / normal[1]).toBeCloseTo(0.7, 1);
    expect(hard[1] / normal[1]).toBeCloseTo(1.25, 1);
  });

  it('gives players a head start before the AI may pick on them', () => {
    // Fenced in: the AI's only neighbour is the player, far weaker than itself.
    const attackedAt = (difficulty: 'easy' | 'normal' | 'hard') => {
      const terrain = new Uint8Array(40 * 13).fill(WATER);
      for (let y = 1; y < 12; y++) for (let x = 1; x < 39; x++) terrain[y * 40 + x] = PLAINS;
      const g = new Game(40, 13, terrain, { seed: 9, difficulty });
      const me = g.addFaction({ name: 'Mensch', type: 'HUMAN_NATION' }, at(g, 8, 6))!;
      const ai = g.addFaction({ name: 'KI', type: 'AI_NATION' }, at(g, 30, 6))!;
      ai.aggression = 100;
      for (let t = 0; t < 2000; t++) {
        me.troops = 100;
        g.step();
        if (g.attacks.some((a) => a.attacker === ai.id && a.target === me.id)) return g.tick;
      }
      return Infinity;
    };
    const hard = attackedAt('hard');
    const normal = attackedAt('normal');
    const easy = attackedAt('easy');
    expect(hard).toBeLessThan(450);
    expect(normal).toBeGreaterThanOrEqual(450);
    expect(normal).toBeLessThan(1200);
    expect(easy).toBeGreaterThanOrEqual(1200);
    expect(easy).toBeLessThan(2000);
  });
});
