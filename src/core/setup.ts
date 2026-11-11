import { Game } from './game';
import { GridProjection } from './maps/projection';
import type { MapPackDefinition } from './maps/types';
import { Terrain, type TerrainName } from './terrain';

/** Share of all tribes that are elite tribes (the brief asks for 15-20 %). */
const ELITE_SHARE = 0.17;

const SYLLABLES = ['ka', 'ro', 'vel', 'dun', 'mir', 'tas', 'gor', 'el', 'an', 'ur', 'sho', 'bek', 'li', 'zan', 'tor', 'ha', 'ne', 'yu', 'ol', 'dra'];
const ELITE_TITLE: Record<number, string> = {
  [Terrain.MOUNTAIN]: 'Bergclans',
  [Terrain.FOREST]: 'Waldkonföderation',
  [Terrain.ICE]: 'Eisclans',
};

function tribeName(rng: () => number): string {
  const pick = () => SYLLABLES[Math.floor(rng() * SYLLABLES.length)];
  const word = pick() + pick() + (rng() < 0.4 ? pick() : '');
  return word[0].toUpperCase() + word.slice(1);
}

/**
 * Builds a game on `terrain` and populates it from the map pack: nations and
 * named tribes at their spawn points, then random tribes on the land left over.
 */
export function createGame(pack: MapPackDefinition, proj: GridProjection, terrain: Uint8Array, seed: number): Game {
  const weights: number[] = [];
  for (const [name, w] of Object.entries(pack.terrainWeights ?? {})) weights[Terrain[name as TerrainName]] = w;
  const game = new Game(proj.width, proj.height, terrain, { seed, terrainWeights: weights });
  const { rng } = game;

  let elites = 0;
  for (const s of pack.spawns) {
    const cell = proj.cellAt(s.lngLat[0], s.lngLat[1]);
    if (cell < 0) continue;
    const elite = s.kind === 'eliteTribe';
    if (game.addFaction({ name: s.name, type: s.kind === 'nation' ? 'AI_NATION' : 'AI_TRIBE', elite }, cell) && elite) elites++;
  }

  // Top the named elite tribes up to the target share with random ones.
  const namedTribes = pack.spawns.filter((s) => s.kind !== 'nation').length;
  const randomElites = Math.round(ELITE_SHARE * (namedTribes + pack.randomTribes)) - elites;
  const rough = (cell: number) => terrain[cell] === Terrain.MOUNTAIN || terrain[cell] === Terrain.FOREST || terrain[cell] === Terrain.ICE;

  for (let i = 0; i < pack.randomTribes; i++) {
    const elite = i < randomElites;
    const name = tribeName(rng);
    // Elite tribes look for rough home terrain first; everybody takes what is free after that.
    for (let attempt = 0; attempt < 60; attempt++) {
      const cell = Math.floor(rng() * terrain.length);
      if (!game.isFreeLand(cell) || (elite && attempt < 40 && !rough(cell))) continue;
      const title = elite ? (ELITE_TITLE[terrain[cell]] ?? 'Horde') : '';
      if (game.addFaction({ name: elite ? `${name}-${title}` : `Stamm ${name}`, type: 'AI_TRIBE', elite }, cell, 0)) break;
    }
  }
  return game;
}
