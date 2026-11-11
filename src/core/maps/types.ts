import type { TerrainName } from '../terrain';

export type BBox = [minLng: number, minLat: number, maxLng: number, maxLat: number];

export type SpawnKind = 'nation' | 'tribe' | 'eliteTribe';

export interface SpawnPoint {
  name: string;
  lngLat: [lng: number, lat: number];
  kind: SpawnKind;
}

/** Where the terrain grid of a map comes from. */
export type TerrainSource =
  /** Generated from OSM vector tiles (plus elevation) for the map's bounding box. */
  | { type: 'osm'; zoom?: number; mountainElevation?: number }
  /** PNG terrain mask, one pixel per cell, red channel = terrain id. Loader lands with the custom-map importer (phase 3). */
  | { type: 'mask'; url: string };

/**
 * Plain-JSON description of a map. Presets and custom maps use this one
 * schema, so a new region is data, not code: register it with the MapRegistry.
 */
export interface MapPackDefinition {
  id: string;
  name: string;
  bbox: BBox;
  /** Camera zoom limits. */
  zoom: { min: number; max: number };
  /** Grid width in cells; the height follows from the bounding box (Web Mercator). */
  grid: { width: number };
  terrain: TerrainSource;
  /** Multiplier on conquest delay and cost per terrain; 1 if omitted. */
  terrainWeights?: Partial<Record<TerrainName, number>>;
  /** Historic/regional starting points of AI nations and named tribes. */
  spawns: SpawnPoint[];
  /** Extra tribes the seeded PRNG scatters over the remaining land. */
  randomTribes: number;
}
