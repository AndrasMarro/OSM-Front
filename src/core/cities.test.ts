import { describe, expect, it } from 'vitest';
import { build, CITY_TIERS } from './buildings';
import { Game, type RealCity } from './game';
import { REAL_CITIES } from './maps/cities';
import { GridProjection } from './maps/projection';
import { mapRegistry } from './maps/registry';
import { applyPreset, flagFor, NATION_PRESETS } from './nation-presets';
import { sanitizeNation } from './nation';
import { createGame } from './setup';
import { Terrain } from './terrain';
import { at, run } from './testkit';

const CITIES: RealCity[] = [
  { cell: 10 + 10 * 60, name: 'Wien', tier: 1 },
  { cell: 30 + 10 * 60, name: 'Belgrad', tier: 2 },
  { cell: 50 + 10 * 60, name: 'Split', tier: 3 },
];

function land(cities: RealCity[] = CITIES) {
  const g = new Game(60, 20, new Uint8Array(60 * 20).fill(Terrain.PLAINS), { seed: 1, cities });
  const me = g.addFaction({ name: 'Mensch', type: 'HUMAN_NATION' }, at(g, 30, 10))!;
  for (let c = 0; c < g.owner.length; c++) g.setOwner(c, me.id);
  me.gold = 100_000;
  return { g, me };
}

describe('real-world cities', () => {
  it('merges a city built on a real city with it, by name and tier', () => {
    const { g, me } = land();
    expect(build(g, me.id, 'City', at(g, 10, 10))).toBe('ok');
    expect(g.buildingAt.get(at(g, 10, 10))!.city).toEqual({ cell: at(g, 10, 10), name: 'Wien', tier: 1 });
    // Right next to it counts too; a few cells away does not.
    expect(build(g, me.id, 'City', at(g, 32, 11))).toBe('ok');
    expect(g.buildingAt.get(at(g, 32, 11))!.city?.name).toBe('Belgrad');
    expect(build(g, me.id, 'City', at(g, 45, 10))).toBe('ok');
    expect(g.buildingAt.get(at(g, 45, 10))!.city).toBeNull();
  });

  it('gives tier 1 to 3 their growth and income bonus', () => {
    const effect = (x: number | null) => {
      const { g, me } = land();
      // A plain city for comparison stands far from every real one.
      expect(build(g, me.id, 'City', at(g, x ?? 20, x === null ? 3 : 10))).toBe('ok');
      g.step();
      return { growth: me.growthPct, income: me.income };
    };
    const plain = effect(null);
    const [t1, t2, t3] = [effect(10), effect(30), effect(50)];
    expect(plain.growth).toBe(15);
    expect(t1.growth).toBe(15 + 50);
    expect(t2.growth).toBe(15 + 30);
    expect(t3.growth).toBe(15 + 15);
    expect(t1.income / plain.income).toBeCloseTo(1.3, 5);
    expect(t2.income / plain.income).toBeCloseTo(1.15, 5);
    expect(t3.income).toBeCloseTo(plain.income, 10);
    expect(CITY_TIERS[1].label).toBe('Metropole');
  });

  it('makes the population grow faster in a metropolis', () => {
    const grown = (x: number, y: number) => {
      const { g, me } = land();
      build(g, me.id, 'City', at(g, x, y));
      me.troops = 1000;
      run(g, 100);
      return me.troops;
    };
    expect(grown(10, 10)).toBeGreaterThan(grown(20, 3) * 1.2);
  });

  it('merges a real city only once, frees it when the building is gone, and ignores other buildings', () => {
    const { g, me } = land();
    expect(build(g, me.id, 'Factory', at(g, 10, 10))).toBe('ok');
    expect(g.buildingAt.get(at(g, 10, 10))!.city).toBeNull();
    expect(g.realCityNear(at(g, 12, 12))?.name).toBe('Wien');
    build(g, me.id, 'City', at(g, 13, 10)); // too far (3 cells)
    expect(g.buildingAt.get(at(g, 13, 10))!.city).toBeNull();
    build(g, me.id, 'City', at(g, 30, 10));
    expect(g.realCityNear(at(g, 31, 13))).toBeNull(); // Belgrade is taken
    g.removeBuilding(g.buildingAt.get(at(g, 30, 10))!);
    expect(g.realCityNear(at(g, 30, 12))?.name).toBe('Belgrad');
  });

  it('keeps the bonus with the building when it is conquered', () => {
    const { g, me } = land();
    build(g, me.id, 'City', at(g, 10, 10));
    const foe = g.addFaction({ name: 'Feind', type: 'HUMAN_NATION' }, at(g, 30, 10), 0);
    expect(foe).toBeNull(); // no free land left: hand the cell over directly
    const other = g.factions.length;
    g.factions.push({ ...me, id: other, name: 'Feind', cells: 0, capacity: 0, sumX: 0, sumY: 0, neighbors: [] });
    g.setOwner(at(g, 10, 10), other);
    g.step();
    expect(g.factions[other].growthPct).toBe(65);
    expect(me.growthPct).toBe(0);
  });

  it('ships a catalogue of the world\'s cities and puts them on the maps', () => {
    expect(REAL_CITIES.length).toBeGreaterThanOrEqual(500);
    expect(REAL_CITIES.length).toBeLessThanOrEqual(1000);
    const tier = (name: string) => REAL_CITIES.find((c) => c[0] === name)?.[4];
    for (const name of ['Wien', 'Berlin', 'Paris', 'Rom', 'New York', 'Tokio', 'Moskau', 'Peking']) expect(tier(name)).toBe(1);
    expect(tier('Belgrad')).toBe(2);
    expect(tier('Split')).toBe(3);

    const pack = mapRegistry.get('Balkans')!;
    const proj = new GridProjection(pack.bbox, pack.grid.width);
    const game = createGame(pack, proj, new Uint8Array(proj.width * proj.height).fill(Terrain.PLAINS), 7);
    const names = game.cities.map((c) => c.name);
    for (const name of ['Belgrad', 'Athen', 'Sofia', 'Bukarest', 'Zagreb', 'Istanbul']) expect(names).toContain(name);
    expect(names).not.toContain('Paris');
    expect(new Set(game.cities.map((c) => c.cell)).size).toBe(game.cities.length);
  });
});

describe('nation presets', () => {
  it('offers today\'s states and the historic empires', () => {
    const names = NATION_PRESETS.filter((p) => p.category === 'historic').map((p) => p.name);
    for (const name of ['Österreich-Ungarn', 'Römisches Reich', 'Byzantinisches Reich', 'Preußen', 'Deutsches Kaiserreich', 'Osmanisches Reich', 'Sowjetunion', 'Britisches Weltreich', 'Heiliges Römisches Reich', 'Makedonien', 'Karthago', 'Mongolisches Reich', 'Jugoslawien', 'Kalmarer Union']) expect(names).toContain(name);
    for (const iso of ['de', 'at', 'ch', 'fr', 'it', 'gb', 'us', 'cn', 'ru', 'tr', 'br', 'jp']) expect(NATION_PRESETS.some((p) => p.id === iso && p.category === 'modern')).toBe(true);
    expect(new Set(NATION_PRESETS.map((p) => p.id)).size).toBe(NATION_PRESETS.length);
  });

  it('fills in name, colours, flag and doctrine, and survives the clean-up every peer applies', () => {
    const rome = NATION_PRESETS.find((p) => p.id === 'h-rome')!;
    const profile = applyPreset(rome, { ...sanitizeNation({}), ruler: 'Augustus' });
    expect(profile).toMatchObject({ name: 'Römisches Reich', ruler: 'Augustus', primary: '#8b0000', doctrine: 'expansion' });
    expect(profile.flag.preset).toBe('h-rome');
    expect(sanitizeNation(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
    for (const p of NATION_PRESETS) expect(sanitizeNation(applyPreset(p)).flag.preset).toBe(p.id);
    // Junk ids from another machine are dropped.
    expect(sanitizeNation({ flag: { preset: '../../x' } }).flag.preset).toBeUndefined();
    expect(sanitizeNation({ flag: { preset: 42 } }).flag.preset).toBeUndefined();
  });

  it('gives AI nations named after a real state its flag', () => {
    expect(flagFor('Österreich')).toBe('at');
    expect(flagFor('Stamm Kazan')).toBeUndefined();
    const pack = mapRegistry.get('Europe')!;
    const proj = new GridProjection(pack.bbox, pack.grid.width);
    const game = createGame(pack, proj, new Uint8Array(proj.width * proj.height).fill(Terrain.PLAINS), 7);
    expect(game.factions.find((f) => f.name === 'Frankreich')?.flag).toBe('fr');
    expect(game.factions.filter((f) => f.type === 'AI_NATION').every((f) => f.flag)).toBe(true);
    expect(game.factions.filter((f) => f.type === 'AI_TRIBE').every((f) => f.flag === null)).toBe(true);
  });
});
