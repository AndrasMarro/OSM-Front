import { describe, expect, it } from 'vitest';
import { build, buildingRegistry, price } from './buildings';
import { Registry } from './registry';
import { Terrain } from './terrain';
import { at, human, run, world } from './testkit';
import { unitRegistry } from './units';

const { WATER, PLAINS, RAIL } = Terrain;

describe('registries', () => {
  it('ship every building and unit the design asks for', () => {
    expect(buildingRegistry.list().map((d) => d.id)).toEqual(['City', 'Factory', 'Bunker', 'Port', 'Airfield', 'MissileSilo', 'SAMSite']);
    expect(unitRegistry.list().map((d) => d.id).sort()).toEqual(['Bomber', 'Fighter', 'Missile', 'Nuke', 'Paratrooper', 'TradeShip', 'TransportShip', 'Warship']);
    for (const u of unitRegistry.list()) expect(buildingRegistry.get(u.base), `${u.id} needs ${u.base}`).toBeDefined();
  });

  it('refuse duplicate ids', () => {
    const r = new Registry<{ id: string }>();
    r.register({ id: 'a' });
    expect(() => r.register({ id: 'a' })).toThrow();
    expect(r.get('a')).toEqual({ id: 'a' });
    expect(r.get('b')).toBeUndefined();
  });

  it('take a new building type as pure configuration', () => {
    buildingRegistry.register({ id: 'Palisade', name: 'Palisade', icon: '#', cost: 50, hp: 1, fort: { radius: 2, defensePct: 50, slow: 9 } });
    const g = world(40, 40);
    const me = human(g, 20, 20);
    expect(build(g, me.id, 'Palisade', at(g, 20, 20))).toBe('ok');
    g.step();
    expect(g.fortOwner[at(g, 21, 21)]).toBe(me.id);
    expect(g.fortPct[at(g, 21, 21)]).toBe(50);
    expect(g.fortSlow[at(g, 21, 21)]).toBe(4); // clamped: the attack scheduler has no room for more
    expect(g.fortOwner[at(g, 23, 20)]).toBe(0);
  });
});

describe('construction', () => {
  it('charges gold, escalates the price and enforces the site rules', () => {
    const g = world(60, 30, (x) => (x >= 40 ? WATER : PLAINS));
    const me = human(g, 20, 15);
    const other = human(g, 34, 15, 'Nachbar');
    const city = buildingRegistry.get('City')!;
    me.gold = 700;

    expect(build(g, me.id, 'City', at(g, 34, 15))).toBe('place'); // not ours
    expect(build(g, me.id, 'Port', at(g, 20, 15))).toBe('coast'); // inland
    expect(build(g, other.id, 'Port', at(g, 39, 15))).toBe('ok'); // on the shore
    expect(build(g, me.id, 'City', at(g, 20, 15))).toBe('ok');
    expect(me.gold).toBe(450);
    expect(build(g, me.id, 'City', at(g, 21, 16))).toBe('spacing'); // too close to the first
    expect(price(g, me.id, city)).toBe(375);
    expect(build(g, me.id, 'City', at(g, 23, 15))).toBe('ok');
    expect(me.gold).toBe(75);
    expect(build(g, me.id, 'Factory', at(g, 17, 15))).toBe('gold');
    expect(g.buildings.length).toBe(3);
  });

  it('gives cities capacity and growth', () => {
    const g = world(40, 40);
    const me = human(g, 20, 20);
    const twin = human(g, 20, 5, 'Zwilling');
    g.step();
    const max = g.maxTroops(me);
    const start = me.troops;
    build(g, me.id, 'City', at(g, 20, 20));
    g.step();
    expect(g.maxTroops(me)).toBe(max + 2500);
    expect(me.growthPct).toBe(15);
    run(g, 50);
    expect(me.troops - start).toBeGreaterThan((twin.troops - start) * 1.3);
  });

  it('pays factories more once a rail links them to a city', () => {
    const income = (rail: boolean) => {
      const g = world(40, 40, (_x, y) => (rail && y === 20 ? RAIL : PLAINS));
      const me = human(g, 20, 20);
      g.step();
      const base = me.income;
      expect(build(g, me.id, 'Factory', at(g, 16, 19))).toBe('ok');
      expect(build(g, me.id, 'City', at(g, 24, 21))).toBe('ok');
      g.step();
      return me.income - base;
    };
    expect(income(false)).toBeCloseTo(0.4);
    expect(income(true)).toBeCloseTo(0.6);
  });

  it('makes a bunker slow the flood down and raise its price', () => {
    const conquered = (bunker: boolean) => {
      const g = world(60, 30);
      const a = human(g, 10, 15, 'A');
      const b = human(g, 21, 15, 'B');
      const open = g.cost(at(g, 17, 15), b.id);
      if (bunker) {
        expect(build(g, b.id, 'Bunker', at(g, 18, 15))).toBe('ok');
        g.step();
        expect(g.cost(at(g, 17, 15), b.id)).toBeGreaterThan(open * 2);
      }
      a.troops = 6000;
      g.attack(a.id, b.id, 100);
      run(g, 40);
      return a.cells;
    };
    expect(conquered(true)).toBeLessThan(conquered(false) - 10);
  });

  it('hands buildings to whoever conquers their cell', () => {
    const g = world(60, 30);
    const a = human(g, 10, 15, 'A');
    const b = human(g, 21, 15, 'B');
    build(g, b.id, 'Bunker', at(g, 21, 15));
    build(g, b.id, 'City', at(g, 24, 15));
    a.troops = 80_000;
    g.attack(a.id, b.id, 100);
    run(g, 400);
    expect(b.alive).toBe(false);
    expect(g.buildings.map((x) => x.owner)).toEqual([a.id, a.id]);
    expect(g.fortOwner[at(g, 21, 15)]).toBe(a.id);
    expect(a.cityCapacity).toBe(2500);
  });
});
