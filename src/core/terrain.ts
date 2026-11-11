/** Terrain type of a grid cell, stored in a Uint8Array. */
export const Terrain = {
  WATER: 0,
  PLAINS: 1,
  URBAN: 2,
  FOREST: 3,
  MOUNTAIN: 4,
  HIGHWAY: 5,
  RAIL: 6,
  ICE: 7,
} as const;
export type TerrainName = keyof typeof Terrain;

// The tables below are indexed by terrain id.

/** Ticks a front needs to flood into a cell. Also drives the base troop cost. */
export const CONQUER_DELAY = [0, 2, 3, 4, 6, 1, 1, 5];
/** Defender strength in percent. */
export const DEFENSE_PCT = [0, 100, 120, 160, 200, 90, 90, 140];
/** Troops a cell can sustain. Growth is logistic, so more capacity also means faster growth. */
export const CAPACITY = [0, 30, 90, 20, 10, 30, 30, 5];
