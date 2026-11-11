import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { GridProjection } from '../core/maps/projection';
import { drawLine, fillPolygon } from '../core/maps/rasterize';
import { synthForest, synthRail } from '../core/maps/synth';
import type { MapPackDefinition } from '../core/maps/types';
import { Terrain } from '../core/terrain';

/** OpenFreeMap: OSM data in the OpenMapTiles schema, free and without an API key. */
const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
/** Mapzen Terrarium elevation tiles. OSM carries no elevation, so mountains come from here. */
const demUrl = (t: Tile) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${t.z}/${t.x}/${t.y}.png`;
const DEM_SIZE = 256;
const DEFAULT_MOUNTAIN_ELEVATION = 1500;

const URBAN_CLASSES = new Set(['residential', 'suburb', 'quarter', 'neighbourhood', 'commercial', 'industrial', 'retail']);
const POLYGON = 3;
const LINE = 2;
const POINT = 1;
/** Below these tile zooms OpenFreeMap carries no forests / no railways; they are synthesised instead. */
const FOREST_ZOOM = 7;
const RAIL_ZOOM = 8;

interface Tile {
  z: number;
  x: number;
  y: number;
}

/** The zoom at which one tile pixel is about one grid cell. */
function matchingZoom(proj: GridProjection): number {
  const [wx0] = proj.toWorld(0, 0);
  const [wx1] = proj.toWorld(proj.width, 0);
  return Math.min(12, Math.max(0, Math.ceil(Math.log2(proj.width / (wx1 - wx0) / DEM_SIZE))));
}

function tilesCovering(proj: GridProjection, z: number): Tile[] {
  const n = 2 ** z;
  const [wx0, wy0] = proj.toWorld(0, 0);
  const [wx1, wy1] = proj.toWorld(proj.width, proj.height);
  const tiles: Tile[] = [];
  for (let y = Math.max(0, Math.floor(wy0 * n)); y <= Math.min(n - 1, Math.ceil(wy1 * n) - 1); y++) {
    for (let x = Math.max(0, Math.floor(wx0 * n)); x <= Math.min(n - 1, Math.ceil(wx1 * n) - 1); x++) tiles.push({ z, x, y });
  }
  return tiles;
}

/** Affine map from tile-local units (0..extent) to fractional grid coordinates. */
function tileToGrid(proj: GridProjection, t: Tile, extent: number) {
  const n = 2 ** t.z;
  const [ox, oy] = proj.fromWorld(t.x / n, t.y / n);
  const [ex, ey] = proj.fromWorld((t.x + 1) / n, (t.y + 1) / n);
  return { ox, oy, kx: (ex - ox) / extent, ky: (ey - oy) / extent };
}

async function get(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} – ${url}`);
  return res;
}

async function elevationPixels(t: Tile): Promise<Uint8ClampedArray> {
  const blob = await (await get(demUrl(t))).blob();
  // No colour management: the RGB values are numbers, not colours.
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const ctx = new OffscreenCanvas(DEM_SIZE, DEM_SIZE).getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, DEM_SIZE, DEM_SIZE).data;
}

/**
 * Rail hubs, most important first: the capitals the map spawns nations on,
 * then the tiles' cities by rank. Hubs on water or right next to another are dropped.
 */
function railHubs(pack: MapPackDefinition, proj: GridProjection, vector: { t: Tile; layers: VectorTile['layers'] }[], terrain: Uint8Array): number[] {
  const w = proj.width;
  const cities: { cell: number; rank: number }[] = [];
  for (const { t, layers } of vector) {
    const layer = layers.place;
    if (!layer) continue;
    const g = tileToGrid(proj, t, layer.extent);
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      if (feature.type !== POINT || feature.properties.class !== 'city') continue;
      const [[p]] = feature.loadGeometry();
      const x = Math.floor(g.ox + p.x * g.kx);
      const y = Math.floor(g.oy + p.y * g.ky);
      if (x >= 0 && y >= 0 && x < w && y < proj.height) cities.push({ cell: y * w + x, rank: Number(feature.properties.rank ?? 99) });
    }
  }
  cities.sort((a, b) => a.rank - b.rank || a.cell - b.cell);
  const capitals = pack.spawns.filter((s) => s.kind === 'nation').map((s) => proj.cellAt(s.lngLat[0], s.lngLat[1]));
  const limit = Math.max(24, w >> 4);
  const hubs: number[] = [];
  for (const cell of [...capitals, ...cities.map((c) => c.cell)]) {
    if (hubs.length >= limit) break;
    if (cell < 0 || terrain[cell] === Terrain.WATER) continue;
    const x = cell % w;
    const y = (cell - x) / w;
    if (hubs.some((o) => Math.abs((o % w) - x) + Math.abs(Math.floor(o / w) - y) < 8)) continue;
    hubs.push(cell);
  }
  return hubs;
}

/**
 * Builds the terrain grid of a map from real-world data for its bounding box.
 * Later layers overwrite earlier ones: forest, ice, mountains, urban areas,
 * water, and finally roads and rail, which therefore bridge rivers and straits.
 *
 * What the tiles offer depends on the zoom the map resolves to: water and ice
 * always, urban areas and motorways from zoom 4, forests from 7, rail from 8.
 * Below that, forests come from a biome model and rail from axes between the
 * map's capitals and biggest cities (see core/maps/synth).
 */
export async function loadTerrain(
  pack: MapPackDefinition,
  proj: GridProjection,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<Uint8Array> {
  const source = pack.terrain;
  if (source.type !== 'osm') throw new Error('PNG-Terrain-Masken folgen mit dem Custom-Map-Importer (Phase 3).');
  // ponytail: every client derives the terrain itself, on every load. For lockstep the host
  // should ship its grid (or a hash of it); baking presets into PNG masks would also cut the download.

  const { width: w, height: h } = proj;
  const terrain = new Uint8Array(w * h).fill(Terrain.PLAINS);
  const auto = matchingZoom(proj);
  const vectorZoom = source.zoom ?? auto;
  const vectorTiles = tilesCovering(proj, vectorZoom);
  const demTiles = tilesCovering(proj, auto);

  let done = 0;
  const total = vectorTiles.length + demTiles.length;
  const counted = <T>(p: Promise<T>) =>
    p.then((v) => {
      onProgress(++done, total);
      return v;
    });

  const template: string = (await (await get(TILEJSON_URL)).json()).tiles[0];
  const [vector, dem] = await Promise.all([
    Promise.all(
      vectorTiles.map((t) =>
        counted(
          get(template.replace('{z}', `${t.z}`).replace('{x}', `${t.x}`).replace('{y}', `${t.y}`))
            .then((res) => res.arrayBuffer())
            .then((buf) => ({ t, layers: new VectorTile(new PbfReader(buf)).layers })),
        ),
      ),
    ),
    Promise.all(demTiles.map((t) => counted(elevationPixels(t).then((pixels) => ({ t, pixels }))))),
  ]);

  /** Rasterises all features of one layer whose class matches. */
  const paint = (layerName: string, type: number, classes: (c: unknown) => boolean, value: number) => {
    const put = (cell: number) => (terrain[cell] = value);
    for (const { t, layers } of vector) {
      const layer = layers[layerName];
      if (!layer) continue;
      const g = tileToGrid(proj, t, layer.extent);
      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i);
        if (feature.type !== type || !classes(feature.properties.class)) continue;
        const parts = feature.loadGeometry().map((ring) => ring.flatMap((p) => [g.ox + p.x * g.kx, g.oy + p.y * g.ky]));
        if (type === POLYGON) fillPolygon(parts, w, h, put);
        else if (type === LINE) for (const line of parts) drawLine(line, w, h, put);
        // A city without mapped land use still gets a small urban core.
        else for (const [x, y] of parts) drawLine([x - 1, y, x + 1, y, x, y, x, y - 1, x, y + 1], w, h, put);
      }
    }
  };

  const mountainElevation = source.mountainElevation ?? DEFAULT_MOUNTAIN_ELEVATION;
  const elevation = new Int16Array(w * h);
  for (const { t, pixels } of dem) {
    const g = tileToGrid(proj, t, DEM_SIZE);
    const x0 = Math.max(0, Math.ceil(g.ox - 0.5));
    const x1 = Math.min(w - 1, Math.ceil(g.ox + DEM_SIZE * g.kx - 0.5) - 1);
    const y0 = Math.max(0, Math.ceil(g.oy - 0.5));
    const y1 = Math.min(h - 1, Math.ceil(g.oy + DEM_SIZE * g.ky - 0.5) - 1);
    for (let y = y0; y <= y1; y++) {
      const py = Math.min(DEM_SIZE - 1, Math.floor((y + 0.5 - g.oy) / g.ky));
      for (let x = x0; x <= x1; x++) {
        const i = (py * DEM_SIZE + Math.min(DEM_SIZE - 1, Math.floor((x + 0.5 - g.ox) / g.kx))) * 4;
        elevation[y * w + x] = pixels[i] * 256 + pixels[i + 1] + pixels[i + 2] / 256 - 32768;
      }
    }
  }

  if (vectorZoom >= FOREST_ZOOM) paint('landcover', POLYGON, (c) => c === 'wood', Terrain.FOREST);
  else synthForest(terrain, w, h, (y) => proj.lngLat(0, y + 0.5)[1], elevation, mountainElevation);
  paint('landcover', POLYGON, (c) => c === 'ice', Terrain.ICE);
  for (let i = 0; i < elevation.length; i++) if (elevation[i] >= mountainElevation) terrain[i] = Terrain.MOUNTAIN;

  paint('landuse', POLYGON, (c) => URBAN_CLASSES.has(c as string), Terrain.URBAN);
  paint('place', POINT, (c) => c === 'city', Terrain.URBAN);
  paint('water', POLYGON, () => true, Terrain.WATER);
  paint('transportation', LINE, (c) => c === 'motorway', Terrain.HIGHWAY);
  if (vectorZoom >= RAIL_ZOOM) paint('transportation', LINE, (c) => c === 'rail', Terrain.RAIL);
  else synthRail(terrain, w, h, railHubs(pack, proj, vector, terrain));
  return terrain;
}
