import { describe, expect, it } from 'vitest';
import { build, buildingRegistry, canBuild, price } from './buildings';
import { execute } from './commands';
import { RALLY_RADIUS, type Game } from './game';
import { DEFAULT_NATION, doctrineRegistry, sanitizeNation } from './nation';
import { Terrain } from './terrain';
import { at, run, world } from './testkit';
import { launch, unitCost, unitRegistry } from './units';

/** A player nation with the given doctrine, rich enough to build anything. */
function nation(g: Game, x: number, y: number, doctrine: string, name = doctrine) {
  const f = g.addFaction({ name, type: 'HUMAN_NATION', nation: sanitizeNation({ name, doctrine }) }, at(g, x, y))!;
  f.gold = 100_000;
  return f;
}

describe('nation profiles', () => {
  it('pass a complete profile through unchanged', () => {
    const profile = {
      name: 'Hansebund',
      ruler: 'Ann',
      primary: '#c81e3a',
      secondary: '#101820',
      flag: { layout: 'diagonal', colors: ['#c81e3a', '#ffffff', '#101820'], emblem: 'gear', emblemColor: '#ffd45e' },
      doctrine: 'fortress',
    };
    expect(sanitizeNation(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
    expect(sanitizeNation(DEFAULT_NATION)).toEqual(DEFAULT_NATION);
  });

  it('repair whatever is missing or malformed', () => {
    for (const junk of [undefined, null, 7, 'nation', [], {}, { flag: 'red' }, { flag: { colors: 'abc' } }]) expect(sanitizeNation(junk)).toEqual(DEFAULT_NATION);
    const n = sanitizeNation({
      name: '  Viel   zu   langer   Name   für   eine   Nation  ',
      ruler: 42,
      primary: '#ABCDEF',
      secondary: 'url(javascript:alert(1))',
      flag: { layout: 'spiral', colors: ['#000000', 'blue'], emblem: 'skull', emblemColor: '#12345' },
      doctrine: 'omnipotence',
    });
    expect(n.name).toBe('Viel zu langer Name');
    expect(n.name.length).toBeLessThanOrEqual(20);
    expect(n.ruler).toBe(DEFAULT_NATION.ruler);
    expect(n.primary).toBe('#abcdef');
    expect(n.secondary).toBe(DEFAULT_NATION.secondary);
    expect(n.flag).toEqual({ ...DEFAULT_NATION.flag, colors: ['#000000', DEFAULT_NATION.flag.colors[1], DEFAULT_NATION.flag.colors[2]] });
    expect(n.doctrine).toBe(DEFAULT_NATION.doctrine);
  });
});

describe('doctrines', () => {
  it('offers the four backgrounds, and none of them to AI factions', () => {
    expect(doctrineRegistry.list().map((d) => d.id)).toEqual(['industry', 'navy', 'fortress', 'expansion']);
    const g = world(60, 30);
    const ai = g.addFaction({ name: 'KI', type: 'AI_NATION' }, at(g, 30, 15))!;
    expect(ai.nation).toBeNull();
    expect(Object.values(ai.bonus).every((v) => v === 0)).toBe(true);
  });

  it('industry: factories earn 15 % more', () => {
    const income = (doctrine: string) => {
      const g = world(40, 40);
      const f = nation(g, 20, 20, doctrine);
      g.step();
      const base = f.income;
      build(g, f.id, 'Factory', at(g, 20, 20));
      g.step();
      return f.income - base;
    };
    expect(income('expansion')).toBeCloseTo(0.4);
    expect(income('industry')).toBeCloseTo(0.46);
  });

  it('navy: ports and ships are 20 % cheaper, nothing else is', () => {
    const g = world(60, 30, (x) => (x >= 26 ? Terrain.WATER : Terrain.PLAINS));
    const sailor = nation(g, 20, 8, 'navy');
    const farmer = nation(g, 20, 22, 'industry');
    const port = buildingRegistry.get('Port')!;
    const city = buildingRegistry.get('City')!;
    expect(price(g, sailor.id, port)).toBe(160);
    expect(price(g, farmer.id, port)).toBe(200);
    expect(price(g, sailor.id, city)).toBe(price(g, farmer.id, city));
    for (const u of unitRegistry.list()) expect(unitCost(g, sailor.id, u), u.id).toBe(u.domain === 'sea' ? u.cost * 0.8 : u.cost);

    sailor.gold = farmer.gold = 1000;
    expect(build(g, sailor.id, 'Port', at(g, 25, 8))).toBe('ok');
    expect(build(g, farmer.id, 'Port', at(g, 25, 22))).toBe('ok');
    expect([sailor.gold, farmer.gold]).toEqual([840, 800]);
    expect(launch(g, sailor.id, 'Warship', at(g, 40, 8))).toBe('ok');
    expect(launch(g, farmer.id, 'Warship', at(g, 40, 22))).toBe('ok');
    expect([sailor.gold, farmer.gold]).toEqual([640, 550]);
  });

  it('fortress: bunkers defend 20 % harder', () => {
    const fortified = (doctrine: string) => {
      const g = world(40, 40);
      const f = nation(g, 20, 20, doctrine);
      const open = g.cost(at(g, 22, 20), f.id);
      build(g, f.id, 'Bunker', at(g, 20, 20));
      g.step();
      return g.cost(at(g, 22, 20), f.id) - open;
    };
    const plain = fortified('industry');
    expect(plain).toBeGreaterThan(20);
    expect(fortified('fortress') / plain).toBeCloseTo(1.2, 1);
  });

  it('expansion: the population grows 10 % faster', () => {
    const g = world(60, 30);
    const settlers = nation(g, 15, 15, 'expansion');
    const others = nation(g, 45, 15, 'industry');
    const start = settlers.troops;
    run(g, 50);
    expect((settlers.troops - start) / (others.troops - start)).toBeCloseTo(1.1, 2);
  });
});

describe('rally point and build check', () => {
  it('makes the land around the rally point costlier to take, while the point is held', () => {
    const g = world(60, 30);
    const a = nation(g, 20, 15, 'industry', 'A');
    const b = nation(g, 40, 15, 'industry', 'B');
    const near = at(g, 17, 15);
    const far = at(g, 25, 15); // ours too, but beyond the radius
    const open = [g.cost(near, a.id), g.cost(far, a.id)];
    expect(execute(g, a.id, { type: 'rally', cell: at(g, 40, 15) })).toBe('place'); // not ours
    expect(execute(g, a.id, { type: 'rally', cell: at(g, 15, 15) })).toBe('ok');
    expect(a.rally).toBe(at(g, 15, 15));
    expect(25 - 15).toBeGreaterThan(RALLY_RADIUS);
    expect(g.cost(near, a.id)).toBeGreaterThan(open[0] * 1.3);
    expect(g.cost(far, a.id)).toBe(open[1]);
    // Once the point itself has fallen, it protects nothing.
    g.setOwner(at(g, 15, 15), b.id);
    expect(g.cost(near, a.id)).toBeLessThanOrEqual(open[0] + 1);
    expect(execute(g, a.id, { type: 'rally', cell: -1 })).toBe('ok');
    expect(a.rally).toBe(-1);
  });

  it('tells in advance whether and why a building can go somewhere, without changing anything', () => {
    const g = world(60, 30, (x) => (x >= 26 ? Terrain.WATER : Terrain.PLAINS));
    const f = nation(g, 20, 15, 'industry');
    const before = [f.gold, g.buildings.length, g.hash()];
    expect(canBuild(g, f.id, 'City', at(g, 20, 15))).toBe('ok');
    expect(canBuild(g, f.id, 'City', at(g, 40, 15))).toBe('place');
    expect(canBuild(g, f.id, 'Port', at(g, 20, 15))).toBe('coast');
    expect(canBuild(g, f.id, 'Port', at(g, 25, 15))).toBe('ok');
    expect([f.gold, g.buildings.length, g.hash()]).toEqual(before);
    build(g, f.id, 'City', at(g, 20, 15));
    expect(canBuild(g, f.id, 'Factory', at(g, 21, 16))).toBe('spacing');
    f.gold = 10;
    expect(canBuild(g, f.id, 'Factory', at(g, 16, 15))).toBe('gold');
  });
});
