import { describe, expect, it } from 'vitest';
import { createGame } from '../setup';
import { Terrain } from '../terrain';
import { GridProjection } from './projection';
import { drawLine, fillPolygon } from './rasterize';
import { mapRegistry, MapRegistry, validateMapPack } from './registry';

const REQUIRED = ['World', 'Europe', 'Asia', 'Americas', 'NorthAmerica', 'SouthAmerica', 'Balkans', 'USA', 'China', 'Russia', 'Australia', 'Antarctica'];

describe('MapRegistry', () => {
  it('ships every required preset with valid data and spawns inside its box', () => {
    expect(mapRegistry.list().map((p) => p.id)).toEqual(REQUIRED);
    for (const pack of mapRegistry.list()) {
      expect(validateMapPack(pack)).toEqual([]);
      const [minLng, minLat, maxLng, maxLat] = pack.bbox;
      for (const s of pack.spawns) {
        expect(s.lngLat[0] > minLng && s.lngLat[0] < maxLng && s.lngLat[1] > minLat && s.lngLat[1] < maxLat, `${pack.id}: ${s.name}`).toBe(true);
      }
      expect(pack.spawns.filter((s) => s.kind === 'nation').length, pack.id).toBeGreaterThanOrEqual(8);
      expect(pack.spawns.some((s) => s.kind === 'eliteTribe'), pack.id).toBe(true);
    }
  });

  it('accepts custom maps as data and rejects broken ones', () => {
    const registry = new MapRegistry();
    const custom = { ...mapRegistry.get('Balkans')!, id: 'Custom', name: 'Eigene Karte', bbox: [5, 45, 11, 48] as [number, number, number, number] };
    registry.register(JSON.parse(JSON.stringify(custom)));
    expect(registry.get('Custom')?.name).toBe('Eigene Karte');
    expect(() => registry.register({ ...custom, bbox: [11, 45, 5, 48] })).toThrow(/bbox/);
    expect(() => registry.register({ ...custom, grid: { width: 99999 } })).toThrow(/grid/);
  });
});

describe('GridProjection', () => {
  const proj = new GridProjection([13, 34.5, 30, 48.5], 512);

  it('puts the north-west corner at cell 0 and rejects points outside', () => {
    expect(proj.cellAt(13.001, 48.499)).toBe(0);
    expect(proj.cellAt(29.999, 34.501)).toBe(proj.width * proj.height - 1);
    expect(proj.cellAt(12.9, 40)).toBe(-1);
    expect(proj.cellAt(20, 49)).toBe(-1);
  });

  it('round-trips cell centres', () => {
    for (const [x, y] of [[0, 0], [100, 37], [511, proj.height - 1]]) {
      const [lng, lat] = proj.lngLat(x + 0.5, y + 0.5);
      expect(proj.cellAt(lng, lat)).toBe(y * proj.width + x);
    }
  });
});

describe('rasterize', () => {
  it('fills a polygon and leaves its hole empty', () => {
    const grid = new Uint8Array(10 * 10);
    fillPolygon([[1, 1, 9, 1, 9, 9, 1, 9], [4, 4, 6, 4, 6, 6, 4, 6]], 10, 10, (c) => (grid[c] = 1));
    expect(grid.reduce((a, b) => a + b)).toBe(8 * 8 - 2 * 2);
    expect(grid[5 * 10 + 5]).toBe(0);
    expect(grid[2 * 10 + 2]).toBe(1);
    expect(grid[0]).toBe(0);
  });

  it('clips polygons to the grid', () => {
    const grid = new Uint8Array(4 * 4);
    fillPolygon([[-50, -50, 50, -50, 50, 50, -50, 50]], 4, 4, (c) => (grid[c] = 1));
    expect(grid.every((v) => v === 1)).toBe(true);
  });

  it('draws 4-connected lines', () => {
    const cells: number[] = [];
    drawLine([0.5, 0.5, 7.5, 4.5, 2.5, 9.5], 10, 10, (c) => cells.push(c));
    expect(cells[0]).toBe(0);
    expect(cells.at(-1)).toBe(9 * 10 + 2);
    for (let i = 1; i < cells.length; i++) {
      const step = Math.abs((cells[i] % 10) - (cells[i - 1] % 10)) + Math.abs(Math.floor(cells[i] / 10) - Math.floor(cells[i - 1] / 10));
      expect(step).toBeLessThanOrEqual(1);
    }
  });
});

describe('createGame', () => {
  const pack = mapRegistry.get('Europe')!;
  const proj = new GridProjection(pack.bbox, 256);
  const terrain = new Uint8Array(proj.width * proj.height).map((_, i) => (i % 5 === 0 ? Terrain.MOUNTAIN : Terrain.PLAINS));

  it('spawns nations plus mostly standard and a few elite tribes', () => {
    const g = createGame(pack, proj, terrain, 1);
    const nations = g.factions.filter((f) => f.type === 'AI_NATION');
    const tribes = g.factions.filter((f) => f.id > 0 && f.type === 'AI_TRIBE');
    const eliteShare = tribes.filter((f) => f.elite).length / tribes.length;
    expect(nations.length).toBeGreaterThan(20);
    expect(nations.some((f) => f.name === 'Deutschland')).toBe(true);
    expect(tribes.length).toBeGreaterThan(30);
    expect(eliteShare).toBeGreaterThan(0.1);
    expect(eliteShare).toBeLessThan(0.27);
  });

  it('is reproducible per seed', () => {
    const a = createGame(pack, proj, terrain, 5);
    const b = createGame(pack, proj, terrain, 5);
    expect(a.owner).toEqual(b.owner);
    expect(a.factions.map((f) => f.name)).toEqual(b.factions.map((f) => f.name));
    expect(createGame(pack, proj, terrain, 6).owner).not.toEqual(a.owner);
  });
});
