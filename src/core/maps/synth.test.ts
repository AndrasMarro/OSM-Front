import { describe, expect, it } from 'vitest';
import { Terrain } from '../terrain';
import { forestDensity, synthForest, synthRail } from './synth';

const { WATER, PLAINS, FOREST, MOUNTAIN, HIGHWAY, RAIL, URBAN } = Terrain;

const share = (terrain: Uint8Array, value: number) => terrain.filter((t) => t === value).length / terrain.length;

describe('forest synthesis', () => {
  it('follows the biomes: rainforest and taiga are wooded, deserts and the far south are not', () => {
    expect(forestDensity(0)).toBeGreaterThan(forestDensity(30));
    expect(forestDensity(58)).toBeGreaterThan(forestDensity(30));
    expect(forestDensity(-3)).toBe(forestDensity(3));
    expect(forestDensity(80)).toBe(0);
    expect(forestDensity(-70)).toBe(0);

    const band = (lat: number) => {
      const t = new Uint8Array(120 * 80).fill(PLAINS);
      synthForest(t, 120, 80, () => lat);
      return share(t, FOREST);
    };
    expect(band(58)).toBeGreaterThan(0.4);
    expect(band(2)).toBeGreaterThan(0.5);
    expect(band(30)).toBeLessThan(0.02);
    expect(band(45)).toBeGreaterThan(band(30));
  });

  it('is deterministic, touches only plains and prefers the foothills', () => {
    const make = (elevation?: Int16Array) => {
      const t = new Uint8Array(100 * 100).fill(PLAINS);
      for (let i = 0; i < 100; i++) t[i * 100 + 50] = WATER;
      for (let i = 0; i < 100; i++) t[i * 100 + 20] = MOUNTAIN;
      synthForest(t, 100, 100, (y) => 60 - y * 0.2, elevation, 1500);
      return t;
    };
    const a = make();
    expect(a).toEqual(make());
    for (let i = 0; i < 100; i++) {
      expect(a[i * 100 + 50]).toBe(WATER);
      expect(a[i * 100 + 20]).toBe(MOUNTAIN);
    }
    expect(share(make(new Int16Array(100 * 100).fill(900)), FOREST)).toBeGreaterThan(share(a, FOREST));
  });
});

describe('rail synthesis', () => {
  const grid = (w: number, h: number, at: (x: number, y: number) => number) => {
    const t = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) t[y * w + x] = at(x, y);
    return t;
  };
  /** Is there a 4-connected chain of rail/urban/highway cells from a to b? */
  const linked = (t: Uint8Array, w: number, a: number, b: number) => {
    const track = (c: number) => t[c] === RAIL || t[c] === URBAN || t[c] === HIGHWAY;
    const seen = new Set([a]);
    const queue = [a];
    for (const c of queue) {
      if (c === b) return true;
      for (const n of [c - 1, c + 1, c - w, c + w]) if (n >= 0 && n < t.length && !seen.has(n) && track(n)) seen.add(n) && queue.push(n);
    }
    return false;
  };

  it('links hubs with a continuous line that bridges a river', () => {
    const w = 60;
    const t = grid(w, 30, (x) => (x === 30 ? WATER : PLAINS));
    const a = 15 * w + 10;
    const b = 12 * w + 50;
    t[a] = t[b] = URBAN;
    expect(synthRail(t, w, 30, [a, b], 2, 100)).toBeGreaterThan(38);
    expect(linked(t, w, a, b)).toBe(true);
    expect(t[a]).toBe(URBAN); // towns are passed through, not paved over
  });

  it('goes around a mountain range and uses an existing road bridge', () => {
    const w = 60;
    const t = grid(w, 30, (x, y) => (Math.abs(x - 30) <= 1 ? (y === 25 ? HIGHWAY : WATER) : x === 20 && y < 20 ? MOUNTAIN : PLAINS));
    const a = 5 * w + 10;
    const b = 5 * w + 50;
    synthRail(t, w, 30, [a, b], 2, 100);
    expect(linked(t, w, a, b)).toBe(true);
    expect(t[25 * w + 30]).toBe(HIGHWAY);
    for (let y = 0; y < 30; y++) if (y !== 25) expect(t[y * w + 30]).toBe(WATER);
    for (let y = 0; y < 20; y++) expect(t[y * w + 20]).toBe(MOUNTAIN);
  });

  it('does not build across the sea, and is deterministic', () => {
    const w = 80;
    const make = () => grid(w, 30, (x) => (x >= 30 && x < 45 ? WATER : PLAINS));
    const t = make();
    const hubs = [15 * w + 5, 15 * w + 25, 15 * w + 60, 5 * w + 75];
    synthRail(t, w, 30, hubs, 2, 100);
    expect(linked(t, w, hubs[0], hubs[1])).toBe(true);
    expect(linked(t, w, hubs[2], hubs[3])).toBe(true);
    expect(linked(t, w, hubs[1], hubs[2])).toBe(false);
    expect(t.filter((c, i) => c === RAIL && i % w >= 30 && i % w < 45).length).toBe(0);
    const again = make();
    synthRail(again, w, 30, hubs, 2, 100);
    expect(again).toEqual(t);
  });
});
