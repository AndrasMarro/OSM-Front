import { describe, expect, it } from 'vitest';
import { Game, NEUTRAL } from './game';
import { isLand, Terrain } from './terrain';
import { at, human, run, world } from './testkit';

/** Cells of `a` or `b` whose land neighbours all belong to the other one: the checkerboard speckles. */
function speckles(g: Game, a: number, b: number): number {
  let n = 0;
  for (let c = 0; c < g.owner.length; c++) {
    const o = g.owner[c];
    if (o !== a && o !== b) continue;
    const foe = o === a ? b : a;
    let enclosed = true;
    let neighbours = 0;
    g.eachNeighbor(c, (m) => {
      if (!isLand(g.terrain[m])) return;
      neighbours++;
      if (g.owner[m] !== foe) enclosed = false;
    });
    if (enclosed && neighbours > 0) n++;
  }
  return n;
}

/** Two nations side by side that have filled a plain between them. */
function neighbours(seed = 1) {
  const g = world(60, 30, undefined, seed);
  const a = human(g, 18, 15, 'A');
  const b = human(g, 41, 15, 'B');
  a.troops = b.troops = 20_000;
  g.attack(a.id, NEUTRAL, 50);
  g.attack(b.id, NEUTRAL, 50);
  run(g, 250);
  return { g, a, b };
}

describe('front line: tug of war and smoothing', () => {
  it('leaves no isolated enclaves when attack and counter-attack meet', () => {
    for (const seed of [1, 2, 3]) {
      const { g, a, b } = neighbours(seed);
      expect(a.neighbors).toContain(b.id);
      a.troops = b.troops = 30_000;
      let worst = 0;
      for (let i = 0; i < 300; i++) {
        // Both keep pushing, as two players (or a player and a retaliating AI) would.
        if (i % 15 === 0) {
          g.attack(a.id, b.id, 20);
          g.attack(b.id, a.id, 20);
        }
        g.step();
        worst = Math.max(worst, speckles(g, a.id, b.id));
      }
      expect(worst).toBe(0);
      expect(a.alive && b.alive).toBe(true);
    }
  });

  it('sets the two offensives against each other: equal forces bleed and the front stands still', () => {
    const { g, a, b } = neighbours();
    const before = g.owner.slice();
    a.troops = b.troops = 10_000;
    expect(g.attack(a.id, b.id, 50)).toBe(true);
    expect(g.attack(b.id, a.id, 50)).toBe(true);
    const committed = g.attacks.reduce((sum, atk) => sum + atk.troops, 0);
    run(g, 20);
    let moved = 0;
    for (let c = 0; c < before.length; c++) if (before[c] !== g.owner[c]) moved++;
    expect(moved).toBe(0);
    expect(g.attacks.reduce((sum, atk) => sum + atk.troops, 0)).toBeLessThan(committed / 2);
  });

  it('lets only the side with the net advantage push forward', () => {
    const { g, a, b } = neighbours();
    const [cellsA, cellsB] = [a.cells, b.cells];
    a.troops = 30_000;
    b.troops = 10_000;
    g.attack(a.id, b.id, 60); // 18 000
    g.attack(b.id, a.id, 60); // 6 000
    run(g, 150);
    expect(a.cells).toBeGreaterThan(cellsA + 20);
    expect(b.cells).toBeLessThan(cellsB);
    // Nothing of A's fell to the weaker counter-attack.
    expect(speckles(g, a.id, b.id)).toBe(0);
  });

  it('only lets a cell fall that the attacker already surrounds on two sides', () => {
    const g = world(40, 20);
    const a = human(g, 10, 10, 'A');
    const b = human(g, 21, 10, 'B');
    a.troops = 50_000;
    g.attack(a.id, b.id, 100);
    let taken = 0;
    let unbacked = 0;
    for (let i = 0; i < 150; i++) {
      const before = g.owner.slice();
      g.step();
      for (let c = 0; c < before.length; c++) {
        if (before[c] !== b.id || g.owner[c] !== a.id) continue;
        taken++;
        let own = 0;
        for (const d of [-41, -40, -39, -1, 1, 39, 40, 41]) if (g.owner[c + d] === a.id) own++;
        if (own < 2) unbacked++;
      }
    }
    // The exceptions are the first step where two borders meet at a point, never the rule.
    expect(taken).toBeGreaterThan(40);
    expect(unbacked).toBeLessThanOrEqual(2);
  });

  it('still crosses a bridge one cell wide and grows from a lone beachhead', () => {
    // Two islands joined by a single row of land.
    const g = world(40, 11, (x, y) => (x < 15 || x > 24 || y === 5 ? Terrain.PLAINS : Terrain.WATER));
    const a = human(g, 6, 5, 'A');
    a.troops = 50_000;
    for (let i = 0; i < 40; i++) {
      g.attack(a.id, NEUTRAL, 20);
      run(g, 20);
    }
    expect(g.owner[at(g, 20, 5)]).toBe(a.id);
    expect(g.owner[at(g, 35, 5)]).toBe(a.id);

    const h = world(30, 30);
    const c = human(h, 5, 5, 'C');
    expect(h.land(c.id, at(h, 22, 22), 3000)).toBe(true);
    run(h, 100);
    expect(c.cells).toBeGreaterThan(90);
  });

  it('swallows a pocket of free land once it is enclosed', () => {
    const g = world(40, 20);
    const a = human(g, 20, 10, 'A');
    a.troops = 100_000;
    for (let i = 0; i < 30; i++) {
      g.attack(a.id, NEUTRAL, 30);
      run(g, 20);
    }
    let holes = 0;
    for (let c = 0; c < g.owner.length; c++) if (g.owner[c] === NEUTRAL) holes++;
    expect(holes).toBe(0);
  });

  it('keeps land outside the map borders out of reach', () => {
    const g = world(40, 20, (x) => (x >= 20 ? Terrain.OUT_OF_BOUNDS : Terrain.PLAINS));
    const a = human(g, 10, 10, 'A');
    a.troops = 100_000;
    for (let i = 0; i < 20; i++) {
      g.attack(a.id, NEUTRAL, 30);
      run(g, 20);
    }
    expect(a.cells).toBe(20 * 20);
    expect(g.landCells).toBe(20 * 20);
    expect(g.land(a.id, at(g, 30, 10), 5000)).toBe(false);
    expect(g.addFaction({ name: 'X', type: 'AI_TRIBE' }, at(g, 30, 10), 0)).toBeNull();
    expect(g.touchesWater(at(g, 19, 10))).toBe(false);
  });
});
