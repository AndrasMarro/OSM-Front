import { Terrain } from '../terrain';

/**
 * Deterministic stand-ins for terrain the tiles do not carry at low zoom:
 * forests from a latitude/elevation biome model, and main rail axes between
 * the important cities. Pure functions of their inputs, no randomness.
 */

/** Integer hash of a lattice point to [0, 1). */
function hash(x: number, y: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1). */
function noise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const sx = (x - xi) * (x - xi) * (3 - 2 * (x - xi));
  const sy = (y - yi) * (y - yi) * (3 - 2 * (y - yi));
  const top = hash(xi, yi) + (hash(xi + 1, yi) - hash(xi, yi)) * sx;
  const bottom = hash(xi, yi + 1) + (hash(xi + 1, yi + 1) - hash(xi, yi + 1)) * sx;
  return top + (bottom - top) * sy;
}

/** [|latitude|, forest density]: rainforest, savanna, desert belt, temperate, boreal, tundra. */
const BIOMES = [
  [0, 0.62],
  [10, 0.62],
  [22, 0.3],
  [27, 0.1],
  [34, 0.1],
  [46, 0.4],
  [52, 0.55],
  [64, 0.55],
  [70, 0],
  [90, 0],
];

/** How wooded the land is at a latitude, 0..1. Not a land share: it is the noise threshold. */
export function forestDensity(lat: number): number {
  if (lat < -56) return 0; // nothing grows south of Tierra del Fuego
  const a = Math.abs(lat);
  let i = 1;
  while (BIOMES[i][0] < a) i++;
  const [a0, d0] = BIOMES[i - 1];
  const [a1, d1] = BIOMES[i];
  return d0 + ((d1 - d0) * (a - a0)) / (a1 - a0 || 1);
}

/**
 * Turns PLAINS into FOREST where the biome model says so. `elevation` (metres
 * per cell) makes foothills below `mountainElevation` more wooded.
 */
export function synthForest(
  terrain: Uint8Array,
  width: number,
  height: number,
  latOfRow: (y: number) => number,
  elevation?: ArrayLike<number>,
  mountainElevation = 1500,
): void {
  // ponytail: latitude and elevation only, so steppes and dry interiors come out too green.
  // A rainfall raster would fix that if the biomes ever need to be right rather than plausible.
  for (let y = 0; y < height; y++) {
    const base = forestDensity(latOfRow(y));
    if (base <= 0) continue;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (terrain[i] !== Terrain.PLAINS) continue;
      const hills = elevation && elevation[i] > mountainElevation * 0.35 ? 0.12 : 0;
      if (noise(x / 14, y / 14) * 0.65 + noise(x / 5, y / 5) * 0.35 < base + hills) terrain[i] = Terrain.FOREST;
    }
  }
}

/**
 * Cost of laying track per terrain. Water is expensive: the line looks for a road bridge first.
 * A motorway is no cheaper than open land, or the rails would simply vanish into the road network.
 */
const TRACK_COST = [60, 2, 1, 3, 8, 2, 1, 4];
const MAX_COST = 60;
/** Longest stretch of open water a line may bridge in total. */
const MAX_BRIDGE = 4;

/** Cheapest 4-connected route between two cells (Dijkstra in a window around them), or null. */
function route(terrain: Uint8Array, width: number, height: number, from: number, to: number): number[] | null {
  const ax = from % width;
  const ay = (from - ax) / width;
  const bx = to % width;
  const by = (to - bx) / width;
  const span = Math.abs(ax - bx) + Math.abs(ay - by);
  const pad = 12 + (span >> 2);
  const x0 = Math.max(0, Math.min(ax, bx) - pad);
  const y0 = Math.max(0, Math.min(ay, by) - pad);
  const ww = Math.min(width - 1, Math.max(ax, bx) + pad) - x0 + 1;
  const wh = Math.min(height - 1, Math.max(ay, by) + pad) - y0 + 1;
  const local = (x: number, y: number) => (y - y0) * ww + (x - x0);
  const global = (n: number) => (y0 + Math.floor(n / ww)) * width + x0 + (n % ww);

  const dist = new Int32Array(ww * wh).fill(0x7fffffff);
  const prev = new Int32Array(ww * wh).fill(-1);
  const buckets: number[][] = Array.from({ length: MAX_COST + 1 }, () => []);
  const start = local(ax, ay);
  const goal = local(bx, by);
  dist[start] = 0;
  buckets[0].push(start);
  const limit = span * 6 + MAX_COST * MAX_BRIDGE;
  for (let cost = 0, queued = 1; queued > 0 && cost <= limit; ) {
    const bucket = buckets[cost % (MAX_COST + 1)];
    const node = bucket.pop();
    if (node === undefined) {
      cost++;
      continue;
    }
    queued--;
    if (dist[node] !== cost) continue; // superseded by a cheaper visit
    if (node === goal) break;
    const x = node % ww;
    const y = (node - x) / ww;
    const visit = (n: number) => {
      const d = cost + TRACK_COST[terrain[global(n)]];
      if (d < dist[n]) {
        dist[n] = d;
        prev[n] = node;
        buckets[d % (MAX_COST + 1)].push(n);
        queued++;
      }
    };
    if (x > 0) visit(node - 1);
    if (x < ww - 1) visit(node + 1);
    if (y > 0) visit(node - ww);
    if (y < wh - 1) visit(node + ww);
  }
  if (prev[goal] < 0) return null;
  const path: number[] = [];
  let water = 0;
  for (let n = goal; n >= 0; n = prev[n]) {
    const cell = global(n);
    if (terrain[cell] === Terrain.WATER && ++water > MAX_BRIDGE) return null;
    path.push(cell);
  }
  return path;
}

/**
 * Lays RAIL between hubs (cell indices, most important first): every hub is
 * linked to its nearest neighbours, as long as a land route exists. Existing
 * roads and rails are reused, towns are passed through. Hubs further apart
 * than `maxDist` cells are not linked directly. Returns the cells laid.
 */
export function synthRail(terrain: Uint8Array, width: number, height: number, hubs: number[], links = 2, maxDist = width / 3): number {
  const done = new Set<number>();
  let laid = 0;
  hubs.forEach((a, i) => {
    const ax = a % width;
    const ay = (a - ax) / width;
    const near = hubs
      .map((b, j) => ({ b, j, d: Math.abs((b % width) - ax) + Math.abs(Math.floor(b / width) - ay) }))
      .filter((n) => n.j !== i && n.d <= maxDist)
      .sort((p, q) => p.d - q.d || p.j - q.j)
      .slice(0, links);
    for (const { b, j } of near) {
      const key = i < j ? i * hubs.length + j : j * hubs.length + i;
      if (done.has(key)) continue;
      done.add(key);
      for (const cell of route(terrain, width, height, a, b) ?? []) {
        if (terrain[cell] !== Terrain.URBAN && terrain[cell] !== Terrain.HIGHWAY && terrain[cell] !== Terrain.RAIL) {
          terrain[cell] = Terrain.RAIL;
          laid++;
        }
      }
    }
  });
  return laid;
}
