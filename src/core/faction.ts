export type FactionType = 'HUMAN_NATION' | 'AI_NATION' | 'AI_TRIBE';

/** Every entity on the map: human players, AI nations and tribes. Index in `Game.factions` equals `id`. */
export interface Faction {
  id: number;
  name: string;
  type: FactionType;
  /** Elite/great tribe (warlord clan, confederation). Only meaningful for AI_TRIBE. */
  elite: boolean;
  /** Terrain at the spawn point. Elite tribes get a defence bonus on it. */
  homeTerrain: number;
  troops: number;
  cells: number;
  /** Sum of CAPACITY over all owned cells. */
  capacity: number;
  alive: boolean;
  /** AI personality, 0..100: how readily it starts wars. */
  aggression: number;
  /** Faction that last took a cell from us (0 = none). Cleared once the AI has reacted. */
  lastAttacker: number;
  /** Bordering factions and free land, refreshed once per second. */
  neighbors: number[];
  bordersNeutral: boolean;
  /** Coordinate sums for the label centroid, and a grow-only bounding box. */
  sumX: number;
  sumY: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface FactionSpec {
  name: string;
  type: FactionType;
  elite?: boolean;
}

interface Rules {
  /** Growth per tick in per-mille of the logistic term. */
  growth: number;
  startTroops: number;
  /** Troop capacity independent of territory. */
  baseCapacity: number;
  spawnRadius: number;
  /** AI stops grabbing free land beyond this many cells. */
  maxCells: number;
}

const NATION: Rules = { growth: 6, startTroops: 2000, baseCapacity: 3000, spawnRadius: 5, maxCells: Infinity };
const TRIBE: Rules = { growth: 2, startTroops: 300, baseCapacity: 500, spawnRadius: 3, maxCells: 220 };
const ELITE_TRIBE: Rules = { growth: 4, startTroops: 6000, baseCapacity: 8000, spawnRadius: 4, maxCells: 400 };

export function rulesOf(f: { type: FactionType; elite?: boolean }): Rules {
  return f.type !== 'AI_TRIBE' ? NATION : f.elite ? ELITE_TRIBE : TRIBE;
}
