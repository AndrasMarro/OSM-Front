import type { Faction } from './faction';
import { Game } from './game';
import { Terrain } from './terrain';

/** Helpers shared by the engine tests. */

export function world(w: number, h: number, terrainAt: (x: number, y: number) => number = () => Terrain.PLAINS, seed = 1): Game {
  const terrain = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) terrain[y * w + x] = terrainAt(x, y);
  return new Game(w, h, terrain, { seed });
}

export const run = (g: Game, ticks: number) => {
  for (let i = 0; i < ticks; i++) g.step();
};

export const at = (g: Game, x: number, y: number) => y * g.width + x;

/** A player-controlled nation: it does nothing on its own, and it can afford everything. */
export function human(g: Game, x: number, y: number, name = 'Mensch'): Faction {
  const f = g.addFaction({ name, type: 'HUMAN_NATION' }, at(g, x, y))!;
  f.gold = 100_000;
  return f;
}
