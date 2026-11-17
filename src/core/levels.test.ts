import { describe, expect, it } from 'vitest';
import { build, buildingRegistry, canUpgrade, MAX_LEVEL, reach, upgrade, upgradeCost } from './buildings';
import { execute } from './commands';
import { Terrain } from './terrain';
import { at, human, run, world } from './testkit';
import { launch, unitRegistry, type Unit } from './units';

const { WATER, PLAINS } = Terrain;

describe('building levels', () => {
  it('upgrades a building up to level 4, each level costing its price times the level reached so far', () => {
    const g = world(40, 20);
    const a = human(g, 10, 10);
    build(g, a.id, 'City', at(g, 10, 10));
    const city = g.buildingAt.get(at(g, 10, 10))!;
    expect(city.level).toBe(1);
    const costs: number[] = [];
    for (let level = 2; level <= MAX_LEVEL; level++) {
      costs.push(upgradeCost(city));
      const gold = a.gold;
      expect(execute(g, a.id, { type: 'upgrade', cell: city.cell })).toBe('ok');
      expect(a.gold).toBe(gold - costs[costs.length - 1]);
      expect(city.level).toBe(level);
    }
    expect(costs).toEqual([250, 500, 750]);
    expect(city.hp).toBe(4 + 3);
    expect(upgrade(g, a.id, city.cell)).toBe('level');
    // Only one's own building, and only with the gold for it.
    const b = human(g, 30, 10, 'B');
    expect(canUpgrade(g, b.id, city.cell)).toBe('place');
    build(g, b.id, 'Bunker', at(g, 30, 10));
    b.gold = 10;
    expect(upgrade(g, b.id, at(g, 30, 10))).toBe('gold');
    expect(execute(g, b.id, { type: 'upgrade', cell: -3 })).toBe('refused');
  });

  it('gives a higher level more effect: capacity, income and fort radius', () => {
    const g = world(60, 20);
    const a = human(g, 10, 10);
    for (let x = 0; x < 30; x++) g.setOwner(at(g, x, 10), a.id);
    build(g, a.id, 'City', at(g, 10, 10));
    build(g, a.id, 'Bunker', at(g, 20, 10));
    g.step();
    const [capacity1] = [a.cityCapacity];
    const fortEdge = at(g, 26, 10); // 6 cells: inside at level 1, the edge at level 2 is 7
    const beyond = at(g, 27, 10);
    expect(g.fortPct[fortEdge]).toBe(200);
    expect(g.fortPct[beyond]).toBe(0);
    upgrade(g, a.id, at(g, 10, 10));
    upgrade(g, a.id, at(g, 20, 10));
    g.step();
    expect(a.cityCapacity).toBe(capacity1 * 1.5);
    expect(g.fortPct[at(g, 20, 10)]).toBe(300);
    expect(g.fortPct[beyond]).toBe(300);
  });

  it('lets a SAM site work only once it is set up, and reach further at a higher level', () => {
    const g = world(90, 30);
    const a = human(g, 10, 15, 'A');
    const b = human(g, 70, 15, 'B');
    build(g, a.id, 'MissileSilo', at(g, 10, 15));
    build(g, b.id, 'City', at(g, 74, 15));
    expect(build(g, b.id, 'SAMSite', at(g, 66, 15))).toBe('ok'); // out of the blast
    const sam = g.buildingAt.get(at(g, 66, 15))!;
    expect(sam.armedAt).toBe(g.tick + buildingRegistry.get('SAMSite')!.arming!);
    // Not set up yet: the missile gets through.
    expect(launch(g, a.id, 'Missile', at(g, 74, 15))).toBe('ok');
    run(g, 20);
    expect(g.events.map((e) => e.type)).toEqual(['explosion']);
    expect(reach(sam, 14)).toBe(14);
    upgrade(g, b.id, sam.cell);
    upgrade(g, b.id, sam.cell);
    upgrade(g, b.id, sam.cell);
    expect(reach(sam, 14)).toBe(24.5);
  });

  it('shoots down a missile at a distance only a higher-level SAM site reaches', () => {
    const shotDown = (levels: number) => {
      const g = world(120, 30);
      const a = human(g, 10, 15, 'A');
      const b = human(g, 100, 15, 'B');
      build(g, a.id, 'MissileSilo', at(g, 10, 15));
      // The SAM site stands 18 cells beside the missile's path: out of reach at level 1 (14), in reach at 4 (24.5).
      for (let y = 0; y < 30; y++) for (let x = 60; x < 120; x++) g.setOwner(at(g, x, y), b.id);
      build(g, b.id, 'SAMSite', at(g, 90, 15 + 0));
      const sam = g.buildingAt.get(at(g, 90, 15))!;
      for (let i = 1; i < levels; i++) upgrade(g, b.id, sam.cell);
      sam.armedAt = sam.readyAt = 0;
      expect(launch(g, a.id, 'Missile', at(g, 70, 3))).toBe('ok');
      run(g, 40);
      return g.events.some((e) => e.type === 'intercept');
    };
    expect(shotDown(1)).toBe(false);
    expect(shotDown(4)).toBe(true);
  });

  it('fires as many missiles from a silo as its level, then reloads the whole magazine', () => {
    const g = world(90, 30);
    const a = human(g, 10, 15, 'A');
    human(g, 70, 15, 'B');
    build(g, a.id, 'MissileSilo', at(g, 10, 15));
    const silo = g.buildingAt.get(at(g, 10, 15))!;
    for (let i = 1; i < 4; i++) upgrade(g, a.id, silo.cell);
    expect(silo.charges).toBe(4);
    for (let i = 0; i < 4; i++) expect(launch(g, a.id, 'Missile', at(g, 70, 15))).toBe('ok');
    expect(launch(g, a.id, 'Missile', at(g, 70, 15))).toBe('reload');
    const reload = buildingRegistry.get('MissileSilo')!.magazine!.reload;
    run(g, reload - 20);
    expect(launch(g, a.id, 'Missile', at(g, 70, 15))).toBe('reload');
    run(g, 30);
    expect(silo.charges).toBe(4);
    expect(launch(g, a.id, 'Missile', at(g, 70, 15))).toBe('ok');
  });
});

describe('factory supply', () => {
  it('supplies the buildings around a factory: more effect, shorter reloads, and only its owner\'s', () => {
    const g = world(80, 20);
    const a = human(g, 10, 10, 'A');
    for (let y = 0; y < 20; y++) for (let x = 0; x < 50; x++) g.setOwner(at(g, x, y), a.id);
    const b = human(g, 70, 10, 'B');
    build(g, a.id, 'City', at(g, 10, 10));
    build(g, a.id, 'City', at(g, 40, 10)); // far from the factory
    build(g, a.id, 'MissileSilo', at(g, 14, 10));
    build(g, b.id, 'City', at(g, 70, 10));
    g.step();
    const capacity = a.cityCapacity;
    expect(build(g, a.id, 'Factory', at(g, 12, 14))).toBe('ok');
    g.step();
    const near = g.buildingAt.get(at(g, 10, 10))!;
    const silo = g.buildingAt.get(at(g, 14, 10))!;
    expect(near.supplier).toBe(at(g, 12, 14));
    expect(silo.supplier).toBe(at(g, 12, 14));
    expect(g.buildingAt.get(at(g, 40, 10))!.supplier).toBe(-1);
    expect(g.buildingAt.get(at(g, 70, 10))!.supplier).toBe(-1);
    expect(a.cityCapacity).toBe(capacity + 2500 * 0.25);
    // A supplied silo reloads a quarter faster.
    launch(g, a.id, 'Missile', at(g, 70, 10));
    expect(silo.readyAt - g.tick).toBe(Math.ceil((300 * 100) / 125));
    // A factory of a higher level reaches further.
    const factory = g.buildingAt.get(at(g, 12, 14))!;
    expect(g.buildingAt.get(at(g, 40, 10))!.supplier).toBe(-1);
    upgrade(g, a.id, factory.cell);
    upgrade(g, a.id, factory.cell);
    upgrade(g, a.id, factory.cell);
    build(g, a.id, 'City', at(g, 24, 10)); // 12 cells away: beyond 10, within 16
    g.step();
    expect(g.buildingAt.get(at(g, 24, 10))!.supplier).toBe(factory.cell);
  });
});

describe('navy: trade, capture and veteran warships', () => {
  /** Two shores with a sea between them, a port on each. */
  function harbours() {
    const g = world(80, 30, (x) => (x >= 30 && x < 50 ? WATER : PLAINS));
    const a = human(g, 24, 15, 'A');
    const b = human(g, 55, 15, 'B');
    build(g, a.id, 'Port', at(g, 29, 15));
    build(g, b.id, 'Port', at(g, 50, 15));
    return { g, a, b };
  }

  it('sends trade ships more often from a port of a higher level, but never more at sea than its level', () => {
    const runs = (level: number) => {
      const { g, a } = harbours();
      for (let i = 1; i < level; i++) upgrade(g, a.id, at(g, 29, 15));
      const seen = new Set<number>();
      let most = 0;
      for (let i = 0; i < 2400; i++) {
        g.step();
        const mine = g.units.filter((u) => u.def.trade && u.owner === a.id);
        for (const u of mine) seen.add(u.id);
        most = Math.max(most, mine.length);
      }
      return { runs: seen.size, most };
    };
    const one = runs(1);
    const three = runs(3);
    expect(one.runs).toBe(12); // every 200 ticks
    expect(three.runs).toBeGreaterThanOrEqual(one.runs * 2.5);
    expect(one.most).toBe(1);
    expect(three.most).toBeLessThanOrEqual(3);
  });

  it('lets a warship seize an enemy trade ship - the cargo is the captor\'s - and then rest', () => {
    const { g, a, b } = harbours();
    // A third nation in the south trades with A; B is at war with A and lies in wait.
    const tradeShip = unitRegistry.get('TradeShip')!;
    expect(launch(g, b.id, 'Warship', at(g, 40, 15))).toBe('ok');
    run(g, 40);
    g.diplo.hostile(g, b.id, a.id);
    const warship = g.units.find((u) => u.def.guns)!;
    const path = [];
    for (let x = 31; x <= 48; x++) path.push(at(g, x, 15));
    const ship: Unit = { id: g.nextId++, def: tradeShip, owner: a.id, hp: 1, troops: 0, targetOwner: 0, from: at(g, 29, 15), to: at(g, 50, 15), path, progress: 0, steps: 0, x: 31, y: 15, readyAt: 0, level: 1 };
    g.units.push(ship);
    const gold = b.gold;
    let captured = -1;
    for (let i = 0; i < 80 && captured < 0; i++) {
      g.step();
      if (g.events.some((e) => e.type === 'captured')) captured = g.tick;
    }
    expect(captured).toBeGreaterThan(0);
    expect(g.units.includes(ship)).toBe(false);
    expect(b.gold - gold).toBeGreaterThanOrEqual(20 + 0.5 * 17 - 0.01);
    expect(warship.readyAt).toBe(captured - 1 + 100);
  });

  it('raises a warship\'s level and hull for every warship it sinks', () => {
    const { g, a, b } = harbours();
    b.gold = a.gold = 100_000;
    expect(launch(g, b.id, 'Warship', at(g, 40, 15))).toBe('ok');
    run(g, 40);
    const veteran = g.units[0];
    g.diplo.hostile(g, a.id, b.id);
    const enemy = () => g.units.find((u) => u.owner === a.id && u.def.guns);
    const hull: number[] = [veteran.hp];
    for (let round = 0; round < 2; round++) {
      expect(launch(g, a.id, 'Warship', at(g, 36, 15))).toBe('ok');
      // An easy prey with silent guns, so that the veteran is not hit in return.
      enemy()!.hp = 1;
      enemy()!.readyAt = Infinity;
      for (let i = 0; i < 150 && enemy(); i++) g.step();
      expect(enemy()).toBeUndefined();
      hull.push(veteran.hp);
    }
    expect(veteran.level).toBe(3);
    expect(hull).toEqual([4, 6, 8]); // two more hit points for every level
    // An invasion fleet sunk is no warship: no level for that.
    expect(launch(g, a.id, 'TransportShip', at(g, 52, 15), 10)).toBe('ok');
    for (let i = 0; i < 150 && g.units.some((u) => u.owner === a.id && u.def.carriesTroops); i++) g.step();
    expect(veteran.level).toBe(3);
  });
});
