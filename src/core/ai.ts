import { build, buildingRegistry, price, type OrderResult } from './buildings';
import { rulesOf, type Faction } from './faction';
import { NEUTRAL, type Game } from './game';
import { Terrain } from './terrain';
import { launch, seaRoute, unitRegistry } from './units';

/**
 * One AI decision for an AI nation or tribe. Deterministic: reads only game
 * state and the game's seeded PRNG.
 *
 * - AI nations take free land, strike back when attacked, start wars against
 *   their weakest neighbour as often as their aggression allows, and use the
 *   whole toolbox: economy, navy, air force, missiles and diplomacy.
 * - Standard tribes settle a small area, keep to themselves and build next to nothing.
 * - Elite tribes stay put too, fortify, and answer an attack with almost everything they have.
 */
export function decide(g: Game, f: Faction): void {
  develop(g, f);
  if (f.type === 'AI_NATION') {
    negotiate(g, f);
    operate(g, f);
  }
  fight(g, f);
}

// --- ground war ------------------------------------------------------------

function fight(g: Game, f: Faction): void {
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
  if (tribe && !f.elite && g.rng() * 100 >= f.aggression) return;

  // A running war (ours or an ally's) is fought on; otherwise the weakest neighbour we have no treaty with is prey.
  let foe: Faction | undefined;
  let prey: Faction | undefined;
  for (const id of f.neighbors) {
    const n = g.factions[id];
    if (!n.alive) continue;
    const status = g.diplo.status(g, f.id, id);
    if (status === 'War') {
      if (!foe || n.troops < foe.troops) foe = n;
    } else if (status === 'Neutral' && g.diplo.relation(f.id, id) < 50 && (!prey || n.troops < prey.troops)) {
      // Players get a head start: for a while at the beginning the AI does not pick them as prey.
      if (n.type !== 'HUMAN_NATION' || g.tick >= g.level.peaceTicks) prey = n;
    }
  }
  if (foe && f.troops * 10 > foe.troops * 8) {
    g.attack(f.id, foe.id, f.elite ? 60 : 40);
    return;
  }
  // Elite tribes never start a war. Tribes only pick on the clearly weaker; nations accept a modest edge.
  if (f.elite || !prey || (!tribe && g.rng() * 100 >= f.aggression)) return;
  if (f.troops * 10 > prey.troops * (tribe ? 30 : 12)) g.attack(f.id, prey.id, tribe ? 30 : 50);
}

// --- construction ----------------------------------------------------------

/** What a nation builds, most wanted first: [building, cells it needs for the first one, cells per further one]. */
const NATION_WISHES: [id: string, first: number, every: number][] = [
  ['City', 0, 900],
  ['Factory', 150, 400],
  ['Port', 250, 2000],
  ['Bunker', 400, 900],
  ['Airfield', 700, 4000],
  ['SAMSite', 1000, 4000],
  ['MissileSilo', 1400, 6000],
];
/** Elite tribes fortify: bunkers and cities, this many in total. */
const ELITE_BUILDINGS = 5;

function develop(g: Game, f: Faction): void {
  const count = (id: string) => {
    let n = 0;
    for (const b of g.buildings) if (b.owner === f.id && b.def.id === id) n++;
    return n;
  };
  if (f.type === 'AI_TRIBE') {
    if (f.elite) {
      const bunkers = count('Bunker');
      const cities = count('City');
      if (bunkers + cities < ELITE_BUILDINGS) site(g, f, bunkers <= cities ? 'Bunker' : 'City');
    } else if (g.rng() < 0.05 && count('Bunker') === 0) site(g, f, 'Bunker'); // rarely, and only ever one
    return;
  }
  for (const [id, first, every] of NATION_WISHES) {
    if (f.cells < first || count(id) > (f.cells - first) / every) continue;
    const result = site(g, f, id);
    if (result === 'ok' || result === 'gold') return; // built it, or saving up for it
  }
}

/** Builds on a random own cell; coastal buildings walk from there to the shore first. */
function site(g: Game, f: Faction, id: string): OrderResult {
  const def = buildingRegistry.get(id)!;
  if (f.gold < price(g, f.id, def)) return 'gold';
  const w = g.width;
  for (let attempt = 0; attempt < 12; attempt++) {
    const x = f.minX + Math.floor(g.rng() * (f.maxX - f.minX + 1));
    let cell = (f.minY + Math.floor(g.rng() * (f.maxY - f.minY + 1))) * w + x;
    if (g.owner[cell] !== f.id) continue;
    if (def.coastal) {
      const step = [1, -1, w, -w][Math.floor(g.rng() * 4)];
      const row = Math.floor(cell / w);
      for (let n = cell + step; n >= 0 && n < g.owner.length && g.owner[n] === f.id && (step === w || step === -w || Math.floor(n / w) === row); n += step) cell = n;
    }
    if (build(g, f.id, id, cell) === 'ok') return 'ok';
  }
  return 'place';
}

// --- diplomacy -------------------------------------------------------------

function negotiate(g: Game, f: Faction): void {
  const d = g.diplo;
  // An ally on its knees gets troops.
  for (const id of d.allies(f.id)) {
    const ally = g.factions[id];
    if (ally.alive && ally.troops * 4 < g.maxTroops(ally) && f.troops * 2 > g.maxTroops(f)) {
      d.sendAid(g, f.id, id, 'troops', f.troops / 10);
      break;
    }
  }
  if (f.neighbors.length === 0 || g.rng() >= 0.15) return;
  const n = g.factions[f.neighbors[Math.floor(g.rng() * f.neighbors.length)]];
  if (!n.alive) return;
  const status = d.status(g, f.id, n.id);
  if (status === 'War' || (status === 'Neutral' && n.troops > f.troops * 1.3)) {
    // Sue the stronger side for peace, or keep a strong neighbour quiet.
    if (n.troops > f.troops * 1.3) d.propose(g, f.id, n.id, 'NonAggressionPact');
  } else if (!d.trading(f.id, n.id)) d.propose(g, f.id, n.id, 'TradeAgreement');
  else if (status !== 'Alliance' && d.relation(f.id, n.id) >= 40) d.propose(g, f.id, n.id, 'Alliance');
}

// --- navy, air force, missiles ---------------------------------------------

function operate(g: Game, f: Faction): void {
  const enemy = f.enemy && g.factions[f.enemy].alive && g.diplo.status(g, f.id, f.enemy) === 'War' ? g.factions[f.enemy] : undefined;

  if (enemy) {
    // Aim at a building, or failing that at the heart of the enemy's land.
    const heart = Math.round(enemy.sumY / enemy.cells) * g.width + Math.round(enemy.sumX / enemy.cells);
    const target = g.buildings.find((b) => b.owner === enemy.id)?.cell ?? g.nearest(heart, 12, (c) => g.owner[c] === enemy.id);
    if (target >= 0) {
      if (enemy.cells > 400 && launch(g, f.id, 'Nuke', target) === 'ok') return;
      if (launch(g, f.id, 'Missile', target) === 'ok' || launch(g, f.id, 'Bomber', target) === 'ok') return;
    }
  }
  const airfield = g.buildings.find((b) => b.owner === f.id && b.def.id === 'Airfield' && b.interceptors < 2);
  if (airfield && launch(g, f.id, 'Fighter', airfield.cell) === 'ok') return;

  // The navy thinks every fifth decision: its searches over open water are the costly ones.
  if ((Math.floor(g.tick / 20) + f.id) % 5 !== 0) return;
  const port = g.buildings.find((b) => b.owner === f.id && b.def.id === 'Port');
  if (!port) return;
  const afloat = (id: string) => g.units.some((u) => u.owner === f.id && u.def.id === id);
  if (!afloat('TradeShip') && launch(g, f.id, 'TradeShip', port.cell) === 'ok') return;
  if (enemy && !afloat('Warship') && launch(g, f.id, 'Warship', port.cell) === 'ok') return;

  // Invasion: the enemy's coast, or free land once there is none left to walk to.
  const transport = unitRegistry.get('TransportShip')!;
  if (f.troops * 2 < g.maxTroops(f) || f.gold < transport.cost) return;
  let shore = -1;
  // ponytail: launch() searches the same route again. Hand the path over if the navy ever shows up in profiles.
  seaRoute(g, port.cell, transport.range, (water) => {
    g.eachNeighbor(water, (n) => {
      const o = g.owner[n];
      if (shore < 0 && g.terrain[n] !== Terrain.WATER && o !== f.id && (o === NEUTRAL ? !f.bordersNeutral : o === enemy?.id)) shore = n;
    });
    return shore >= 0;
  });
  if (shore >= 0) launch(g, f.id, 'TransportShip', shore, 30);
}
