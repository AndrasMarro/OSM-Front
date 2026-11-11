import { describe, expect, it } from 'vitest';
import { build } from './buildings';
import { NEUTRAL } from './game';
import { Terrain } from './terrain';
import { at, human, run, world } from './testkit';
import { FALLOUT_TICKS, launch } from './units';

const { WATER, PLAINS } = Terrain;

/** Two shores with twenty cells of sea in between: A in the west, B (optional) in the east. */
function strait(withB = true) {
  const g = world(80, 30, (x) => (x >= 30 && x < 50 ? WATER : PLAINS));
  const a = human(g, 24, 15, 'A');
  const b = withB ? human(g, 55, 15, 'B') : null;
  expect(build(g, a.id, 'Port', at(g, 29, 15))).toBe('ok');
  return { g, a, b: b! };
}

const eastCells = (g: ReturnType<typeof world>, id: number) => {
  let n = 0;
  for (let i = 0; i < g.owner.length; i++) if (g.owner[i] === id && i % g.width >= 50) n++;
  return n;
};

describe('navy', () => {
  it('lands troops across the sea and floods on from the beachhead', () => {
    const { g, a } = strait(false);
    const troops = a.troops;
    expect(g.attack(a.id, NEUTRAL, 100)).toBe(true); // by land they only get the western shore
    run(g, 150);
    expect(eastCells(g, a.id)).toBe(0);

    a.troops = troops;
    expect(launch(g, a.id, 'TransportShip', at(g, 50, 15), 50)).toBe('ok');
    expect(a.troops).toBe(troops / 2);
    expect(g.units.length).toBe(1);
    run(g, 30);
    expect(eastCells(g, a.id)).toBe(0); // still at sea
    expect(g.units[0].x).toBeGreaterThan(30);
    run(g, 200);
    expect(g.units.length).toBe(0);
    expect(g.owner[at(g, 50, 15)]).toBe(a.id);
    expect(eastCells(g, a.id)).toBeGreaterThan(50);
    expect(g.events.length).toBe(0); // old events are dropped
  });

  it('invades an enemy coast, which is an act of war', () => {
    const { g, a, b } = strait();
    a.troops = 30_000;
    expect(launch(g, a.id, 'TransportShip', at(g, 55, 15), 100)).toBe('ok'); // inland click: nearest shore is used
    expect(g.diplo.status(g, a.id, b.id)).toBe('War');
    run(g, 400);
    expect(b.alive).toBe(false);
    expect(eastCells(g, a.id)).toBeGreaterThan(80);
  });

  it('needs a port, gold, troops and a way over water', () => {
    const g = world(80, 30, (x) => (x >= 30 && x < 50 ? WATER : PLAINS));
    const a = human(g, 24, 15, 'A');
    expect(launch(g, a.id, 'TransportShip', at(g, 50, 15), 50)).toBe('base');
    build(g, a.id, 'Port', at(g, 29, 15));
    a.gold = 10;
    expect(launch(g, a.id, 'TransportShip', at(g, 50, 15), 50)).toBe('gold');
    a.gold = 1000;
    expect(launch(g, a.id, 'TransportShip', at(g, 20, 15), 50)).toBe('target'); // our own land
    expect(launch(g, a.id, 'TransportShip', at(g, 79, 15), 50)).toBe('target'); // no shore near there
    a.troops = 0;
    expect(launch(g, a.id, 'TransportShip', at(g, 50, 15), 50)).toBe('troops');
    expect(a.gold).toBe(1000);
    expect(g.units.length).toBe(0);
  });

  it('lets a warship sink an invasion fleet', () => {
    const { g, a, b } = strait();
    build(g, b.id, 'Port', at(g, 50, 15));
    expect(launch(g, b.id, 'Warship', at(g, 44, 15))).toBe('ok');
    run(g, 20);
    const cells = b.cells;
    a.troops = 30_000;
    expect(launch(g, a.id, 'TransportShip', at(g, 52, 15), 100)).toBe('ok');
    const seen: string[] = [];
    for (let i = 0; i < 100; i++) {
      g.step();
      for (const e of g.events) if (e.tick === g.tick - 1) seen.push(e.type);
    }
    expect(seen).toContain('sunk');
    expect(g.units.map((u) => u.def.id)).toEqual(['Warship']);
    expect(b.cells).toBe(cells);
    expect(a.troops).toBeLessThan(5000); // the army went down with the ship
  });

  it('runs a trade ship between two ports and pays both', () => {
    const { g, a, b } = strait();
    build(g, b.id, 'Port', at(g, 50, 15));
    g.step();
    expect(launch(g, a.id, 'TradeShip', at(g, 29, 15))).toBe('ok');
    const gold = [a.gold, b.gold];
    run(g, 60);
    const earned = [a.gold - gold[0] - a.income * 60, b.gold - gold[1] - b.income * 60];
    expect(earned[0]).toBeCloseTo(20 + 0.5 * 19);
    expect(earned[1]).toBeCloseTo(earned[0] / 2);
    expect(g.units.length).toBe(1); // on its way back
    g.diplo.hostile(g, a.id, b.id);
    run(g, 60);
    expect(g.units.length).toBe(0); // war closes the route
  });
});

describe('air force and missiles', () => {
  /** A in the west with every launch site, B in the east; `sam` puts a SAM site next to B's city. */
  function duel(sam: boolean) {
    const g = world(90, 30);
    const a = human(g, 10, 15, 'A');
    const b = human(g, 70, 15, 'B');
    build(g, a.id, 'MissileSilo', at(g, 10, 15));
    build(g, a.id, 'Airfield', at(g, 13, 15));
    build(g, b.id, 'City', at(g, 73, 15));
    if (sam) expect(build(g, b.id, 'SAMSite', at(g, 70, 15))).toBe('ok');
    g.step();
    return { g, a, b, city: g.buildingAt.get(at(g, 73, 15))! };
  }
  const types = (g: ReturnType<typeof world>) => g.events.map((e) => e.type);

  it('lets a missile wreck buildings and troops when nothing stops it', () => {
    const { g, a, b, city } = duel(false);
    expect(launch(g, a.id, 'Missile', city.cell)).toBe('ok');
    expect(g.diplo.status(g, a.id, b.id)).toBe('War');
    let troops = b.troops;
    while (g.events.length === 0 && g.tick < 100) {
      troops = b.troops;
      g.step();
    }
    expect(types(g)).toEqual(['explosion']);
    expect(city.hp).toBe(1);
    expect(b.troops).toBeLessThan(troops * 0.97);
    expect(g.units.length).toBe(0);
  });

  it('has a SAM site shoot down missiles and bombers, one per reload', () => {
    const { g, a, b, city } = duel(true);
    const troops = b.troops;
    expect(launch(g, a.id, 'Missile', city.cell)).toBe('ok');
    run(g, 15);
    expect(types(g)).toEqual(['intercept']);
    expect(city.hp).toBe(4);
    expect(b.troops).toBeGreaterThanOrEqual(troops);

    run(g, 100); // reloaded
    expect(launch(g, a.id, 'Bomber', city.cell)).toBe('ok');
    run(g, 35);
    expect(types(g)).toEqual(['intercept']);
    expect(city.hp).toBe(4);

    // Two at once: the second one arrives while the launcher reloads.
    run(g, 100);
    launch(g, a.id, 'Missile', city.cell);
    launch(g, a.id, 'Missile', city.cell);
    run(g, 15);
    expect(types(g).sort()).toEqual(['explosion', 'intercept']);
    expect(city.hp).toBe(1);
    expect(g.buildingAt.has(at(g, 70, 15))).toBe(false); // the SAM site was in the blast
  });

  it('stations fighters at an airfield, where they guard the sky around it', () => {
    const { g, a, b } = duel(false);
    build(g, b.id, 'Airfield', at(g, 67, 15));
    const field = g.buildingAt.get(at(g, 67, 15))!;
    expect(launch(g, b.id, 'Fighter', field.cell)).toBe('ok');
    expect(launch(g, b.id, 'Fighter', field.cell)).toBe('ok');
    expect(field.interceptors).toBe(2);
    expect(g.units.length).toBe(0);
    // Sixty percent a shot: out of ten bombers some fall and some get through.
    let shot = 0;
    for (let i = 0; i < 10; i++) {
      launch(g, a.id, 'Bomber', at(g, 70, 12));
      for (let t = 0; t < 40; t++) {
        g.step();
        shot += g.events.filter((e) => e.type === 'intercept' && e.tick === g.tick - 1).length;
      }
    }
    expect(shot).toBeGreaterThan(2);
    expect(shot).toBeLessThan(10);
  });

  it('drops paratroopers behind a river, within range only', () => {
    const g = world(120, 30, (x) => (x === 30 ? WATER : PLAINS));
    const a = human(g, 20, 15, 'A');
    build(g, a.id, 'Airfield', at(g, 20, 15));
    expect(launch(g, a.id, 'Paratrooper', at(g, 110, 15), 50)).toBe('range');
    expect(launch(g, a.id, 'Paratrooper', at(g, 40, 15), 50)).toBe('ok');
    run(g, 120);
    expect(g.owner[at(g, 40, 15)]).toBe(a.id);
    let beyond = 0;
    for (let i = 0; i < g.owner.length; i++) if (g.owner[i] === a.id && i % g.width > 30) beyond++;
    expect(beyond).toBeGreaterThan(50);
  });

  it('turns the target of a nuke into irradiated no-mans-land', () => {
    const { g, a, b, city } = duel(false);
    const centre = at(g, 70, 15);
    const clean = g.cost(centre, NEUTRAL);
    expect(launch(g, a.id, 'Nuke', centre)).toBe('ok');
    run(g, 20);
    expect(types(g)).toEqual(['nuke']);
    expect(b.alive).toBe(false);
    expect(g.owner[centre]).toBe(NEUTRAL);
    expect(g.buildings.includes(city)).toBe(false);
    expect(g.fallout[centre]).toBeGreaterThan(g.tick);
    expect(g.cost(centre, NEUTRAL)).toBe(clean * 3);
    g.tick += FALLOUT_TICKS;
    expect(g.cost(centre, NEUTRAL)).toBe(clean);
  });
});
