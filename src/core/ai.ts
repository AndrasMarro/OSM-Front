import { rulesOf, type Faction } from './faction';
import { NEUTRAL, type Game } from './game';

/**
 * One AI decision for an AI nation or tribe. Deterministic: reads only game
 * state and the game's seeded PRNG.
 *
 * - AI nations take free land, strike back when attacked and start wars
 *   against their weakest neighbour, as often as their aggression allows.
 * - Standard tribes settle a small area and otherwise keep to themselves.
 * - Elite tribes stay put too, but answer an attack with almost everything they have.
 */
export function decide(g: Game, f: Faction): void {
  const tribe = f.type === 'AI_TRIBE';

  if (f.lastAttacker) {
    const enemy = g.factions[f.lastAttacker];
    f.lastAttacker = 0;
    if (enemy.alive && (!tribe || f.elite)) {
      g.attack(f.id, enemy.id, f.elite ? 80 : 40);
      return;
    }
  }

  // Rebuild before doing anything else.
  if (f.troops * 5 < g.maxTroops(f) * 2) return;

  if (f.bordersNeutral && f.cells < rulesOf(f).maxCells) {
    g.attack(f.id, NEUTRAL, tribe ? 15 : 30);
    return;
  }

  if (f.elite || g.rng() * 100 >= f.aggression) return;
  let weakest: Faction | undefined;
  for (const id of f.neighbors) {
    const n = g.factions[id];
    if (n.alive && (!weakest || n.troops < weakest.troops)) weakest = n;
  }
  // Tribes only pick on the clearly weaker; nations accept a modest edge.
  if (weakest && f.troops * 10 > weakest.troops * (tribe ? 30 : 12)) g.attack(f.id, weakest.id, tribe ? 30 : 50);
}
