import { TRADE_INCOME } from './diplomacy';
import { rulesOf } from './faction';
import type { Game, RealCity } from './game';
import { Registry } from './registry';
import { Terrain } from './terrain';
import type { InterceptSpec } from './units';

/**
 * A building type. Everything it does is declared here as data; the engine
 * reads the optional fields and never asks for a particular id.
 */
export interface BuildingDefinition {
  id: string;
  /** Display name (German UI). */
  name: string;
  /** One character for the map and the build menu. */
  icon: string;
  /** Gold. Every further building of the same type costs half the base price more. */
  cost: number;
  /** Hits it takes before it is destroyed. */
  hp: number;
  /** Must stand next to WATER. */
  coastal?: boolean;
  /** Extra troop capacity and growth in percent (City). */
  capacity?: number;
  growthPct?: number;
  /** Gold per tick, and the bonus in percent while a road or rail links it to a friendly city (Factory). */
  income?: number;
  /** Merges with a real city it is built on or next to, taking its name and a bonus by the city's size. */
  settles?: boolean;
  linkBonusPct?: number;
  /** Cells within `radius` cost attackers `defensePct` more and fall `slow` ticks later (Bunker). */
  fort?: { radius: number; defensePct: number; slow: number };
  /** Shoots down flying units nearby (SAMSite). Its radius grows with the building's level. */
  intercept?: InterceptSpec;
  /** Ticks after it is put up before it works (SAMSite: the battery has to be set up). */
  arming?: number;
  /** Launches from here draw on a magazine of one shot per level, refilled `reload` ticks after the first shot (MissileSilo). */
  magazine?: { reload: number };
  /** Supplies the faction's other buildings within `radius` (plus 2 per level): they work `pct` percent better (Factory). */
  supply?: { radius: number; pct: number };
}

/** Every building can be upgraded this far. */
export const MAX_LEVEL = 4;

export interface Building {
  id: number;
  def: BuildingDefinition;
  owner: number;
  cell: number;
  hp: number;
  /** Factory: currently linked to a friendly city by road or rail. */
  linked: boolean;
  /** Air defence at this site: the building's own, or that of the units stationed here. */
  intercept?: InterceptSpec;
  interceptors: number;
  /** Tick from which the air defence can fire again. */
  readyAt: number;
  /** The real city this building has merged with, if any. */
  city: RealCity | null;
  /** Tick from which it works at all (`def.arming`); before that its air defence is silent. */
  armedAt: number;
  /** 1 to MAX_LEVEL. Raises its effect, its reach and its hit points. */
  level: number;
  /** Shots left in the magazine (`def.magazine`). */
  charges: number;
  /** Cell of the factory that supplies it, or -1, and the bonus in percent it gets from it. Refreshed with the economy. */
  supplier: number;
  boost: number;
}

export type OrderResult = 'ok' | 'gold' | 'place' | 'spacing' | 'coast' | 'base' | 'range' | 'target' | 'troops' | 'reload' | 'level';

export type BuildingRegistry = Registry<BuildingDefinition>;
export const buildingRegistry: BuildingRegistry = new Registry<BuildingDefinition>();

buildingRegistry.register({ id: 'City', name: 'Stadt', icon: '⌂', cost: 250, hp: 4, capacity: 2500, growthPct: 15, settles: true });
buildingRegistry.register({ id: 'Factory', name: 'Fabrik', icon: '⚙', cost: 200, hp: 3, income: 0.4, linkBonusPct: 50, supply: { radius: 10, pct: 25 } });
buildingRegistry.register({ id: 'Bunker', name: 'Bunker', icon: '♜', cost: 150, hp: 5, fort: { radius: 6, defensePct: 200, slow: 4 } });
buildingRegistry.register({ id: 'Port', name: 'Hafen', icon: '⚓', cost: 200, hp: 3, coastal: true });
buildingRegistry.register({ id: 'Airfield', name: 'Fliegerhorst', icon: '✈', cost: 400, hp: 3 });
buildingRegistry.register({ id: 'MissileSilo', name: 'Raketensilo', icon: '☢', cost: 800, hp: 4, magazine: { reload: 300 } });
buildingRegistry.register({
  id: 'SAMSite',
  name: 'SAM-Stellung',
  icon: '◎',
  cost: 500,
  hp: 2,
  intercept: { radius: 14, cooldown: 80, chancePct: 100, domains: ['air', 'missile'] },
  arming: 150,
});

/** What merging with a real city is worth, by tier: extra population growth and tax income in percent. */
export const CITY_TIERS: Record<1 | 2 | 3, { label: string; growthPct: number; incomePct: number }> = {
  1: { label: 'Metropole', growthPct: 50, incomePct: 30 },
  2: { label: 'Großstadt', growthPct: 30, incomePct: 15 },
  3: { label: 'Regionalstadt', growthPct: 15, incomePct: 0 },
};
/** Buildings add up to at most this much extra growth. */
const MAX_GROWTH_PCT = 75;
// --- levels and supply -----------------------------------------------------

/** How much a level and a supplying factory scale a building's effect: level 1 is 1, every level adds half. */
const strength = (b: Building) => ((1 + (b.level - 1) / 2) * (100 + b.boost)) / 100;

/** Reach of a radius that grows with the level: a quarter more per level (14 cells at level 1, 24.5 at level 4). */
export const reach = (b: Building, radius: number) => (radius * (3 + b.level)) / 4;

/** Cooldowns and reloads of a supplied building run faster by the supply bonus. */
export const pace = (b: Building, ticks: number) => Math.ceil((ticks * 100) / (100 + b.boost));

/** Supply radius of a factory at its level. */
export const supplyRadius = (b: Building) => (b.def.supply ? b.def.supply.radius + 2 * (b.level - 1) : 0);

/** What upgrading this building to the next level costs: its base price times its current level. */
export const upgradeCost = (b: Building) => b.def.cost * b.level;

/** Whether the faction could upgrade the building on this cell right now. Changes nothing. */
export function canUpgrade(g: Game, factionId: number, cell: number): OrderResult {
  const b = g.buildingAt.get(cell);
  if (!b || b.owner !== factionId || !g.factions[factionId]?.alive) return 'place';
  if (b.level >= MAX_LEVEL) return 'level';
  return g.factions[factionId].gold < upgradeCost(b) ? 'gold' : 'ok';
}

/** Raises a building one level: more effect and reach, one more hit point, one more shot in its magazine. */
export function upgrade(g: Game, factionId: number, cell: number): OrderResult {
  const check = canUpgrade(g, factionId, cell);
  if (check !== 'ok') return check;
  const b = g.buildingAt.get(cell)!;
  g.factions[factionId].gold -= upgradeCost(b);
  b.level++;
  b.hp++;
  if (b.def.magazine) b.charges++;
  g.dirty = true;
  return 'ok';
}

/** Minimum distance between two buildings, in cells (Chebyshev). */
const SPACING = 2;
/** A fort may hold a front up by at most this many ticks; the attack scheduler has no room for more. */
const MAX_FORT_SLOW = 4;
/** Cells a factory's road search may visit before it gives up. */
const LINK_SEARCH = 3000;

/** What the next building of this type costs the faction. */
export function price(g: Game, factionId: number, def: BuildingDefinition): number {
  let owned = 0;
  for (const b of g.buildings) if (b.owner === factionId && b.def === def) owned++;
  const discount = def.coastal ? (g.factions[factionId]?.bonus.navalDiscountPct ?? 0) : 0;
  return (def.cost * (2 + owned) * (100 - discount)) / 200;
}

/** Whether the faction could put this building on this cell right now, and if not, why not. Changes nothing. */
export function canBuild(g: Game, factionId: number, defId: string, cell: number): OrderResult {
  const def = buildingRegistry.get(defId);
  const f = g.factions[factionId];
  if (!def || !f?.alive || g.owner[cell] !== factionId) return 'place';
  const w = g.width;
  const x = cell % w;
  const y = (cell - x) / w;
  for (const b of g.buildings) {
    if (Math.abs((b.cell % w) - x) <= SPACING && Math.abs(Math.floor(b.cell / w) - y) <= SPACING) return 'spacing';
  }
  if (def.coastal && !g.touchesWater(cell)) return 'coast';
  return f.gold < price(g, factionId, def) ? 'gold' : 'ok';
}

/** Puts up a building on one of the faction's own cells. */
export function build(g: Game, factionId: number, defId: string, cell: number): OrderResult {
  const check = canBuild(g, factionId, defId, cell);
  if (check !== 'ok') return check;
  const def = buildingRegistry.get(defId)!;
  g.factions[factionId].gold -= price(g, factionId, def);
  const b: Building = { id: g.nextId++, def, owner: factionId, cell, hp: def.hp, linked: false, intercept: def.intercept, interceptors: def.intercept ? 1 : 0,
    // A battery that has to be set up first is not ready until then.
    readyAt: def.arming ? g.tick + def.arming : 0,
    armedAt: def.arming ? g.tick + def.arming : 0,
    city: def.settles ? g.realCityNear(cell) : null,
    level: 1,
    charges: def.magazine ? 1 : 0,
    supplier: -1,
    boost: 0,
  };
  g.buildings.push(b);
  g.buildingAt.set(cell, b);
  g.dirty = true;
  return 'ok';
}

/** Damages a building; at 0 hit points it is gone. */
export function damage(g: Game, b: Building, hits: number): void {
  b.hp -= hits;
  if (b.hp <= 0) g.removeBuilding(b);
}

/**
 * The cell of a friendly city that a road or rail in friendly hands leads to
 * from `from`, or -1. This is what earns a factory there its link bonus.
 */
export function linkedCity(g: Game, owner: number, from: number): number {
  const friendly = (o: number) => o === owner || g.diplo.allied(o, owner);
  const cities = g.buildings.filter((b) => b.def.capacity && friendly(b.owner));
  if (cities.length === 0) return -1;
  const w = g.width;
  const road = (c: number) => (g.terrain[c] === Terrain.HIGHWAY || g.terrain[c] === Terrain.RAIL) && friendly(g.owner[c]);
  const near = (c: number, b: Building) => Math.abs((c % w) - (b.cell % w)) <= 2 && Math.abs(Math.floor(c / w) - Math.floor(b.cell / w)) <= 2;

  // Start on the road cells next to the factory, then follow the network.
  const seen = new Set<number>();
  const queue: number[] = [];
  const fx = from % w;
  const fy = Math.floor(from / w);
  for (let y = Math.max(0, fy - 2); y <= Math.min(g.height - 1, fy + 2); y++) {
    for (let x = Math.max(0, fx - 2); x <= Math.min(w - 1, fx + 2); x++) {
      if (road(y * w + x)) seen.add(queue[queue.length] = y * w + x);
    }
  }
  for (let i = 0; i < queue.length && seen.size < LINK_SEARCH; i++) {
    const c = queue[i];
    const city = cities.find((b) => near(c, b));
    if (city) return city.cell;
    g.eachNeighbor(c, (n) => {
      if (!seen.has(n) && road(n)) seen.add(queue[queue.length] = n);
    });
  }
  return -1;
}

/**
 * Recomputes everything derived from buildings and treaties: income, city
 * bonuses, fortified cells and factory links. Runs once per second, and at
 * once after a building changed hands.
 */
export function refreshEconomy(g: Game): void {
  const relink = g.dirty || g.tick % 100 === 0;
  // Forts depend on level and supply, so they are restamped whenever links are.
  const restamp = relink;
  g.dirty = false;
  for (const f of g.factions) {
    const r = rulesOf(f);
    f.income = f.alive ? r.income + f.cells * r.cellIncome : 0;
    f.cityCapacity = 0;
    f.growthPct = 0;
    f.protected = false;
  }
  if (restamp) {
    g.fortOwner.fill(0);
    g.fortPct.fill(0);
    g.fortSlow.fill(0);
  }
  const { width: w, height: h } = g;
  // Supply: each building is served by the nearest factory of its owner that reaches it.
  // ponytail: factories x buildings per refresh; index factories per owner if empires grow past a few hundred buildings.
  if (relink) {
    const factories = g.buildings.filter((b) => b.def.supply);
    for (const b of g.buildings) {
      b.supplier = -1;
      b.boost = 0;
      if (b.def.supply) continue;
      let best = Infinity;
      for (const fac of factories) {
        if (fac.owner !== b.owner) continue;
        const dx = (fac.cell % w) - (b.cell % w);
        const dy = Math.floor(fac.cell / w) - Math.floor(b.cell / w);
        const d2 = dx * dx + dy * dy;
        const r = supplyRadius(fac);
        if (d2 <= r * r && d2 < best) {
          best = d2;
          b.supplier = fac.cell;
          b.boost = fac.def.supply!.pct;
        }
      }
    }
  }
  for (const b of g.buildings) {
    const f = g.factions[b.owner];
    const d = b.def;
    const k = strength(b);
    if (d.magazine && b.charges < b.level && g.tick >= b.readyAt) b.charges = b.level; // reloaded
    f.cityCapacity += (d.capacity ?? 0) * k;
    f.growthPct = Math.min(MAX_GROWTH_PCT, f.growthPct + (d.growthPct ?? 0) * k + (b.city ? CITY_TIERS[b.city.tier].growthPct : 0));
    if (b.city) f.income += ((rulesOf(f).income + f.cells * rulesOf(f).cellIncome) * CITY_TIERS[b.city.tier].incomePct) / 100;
    if (d.income) {
      if (relink) b.linked = linkedCity(g, b.owner, b.cell) >= 0;
      f.income += (d.income * (1 + (b.level - 1) / 2) * (100 + (b.linked ? (d.linkBonusPct ?? 0) : 0)) * (100 + f.bonus.factoryIncomePct)) / 10000;
    }
    if (restamp && d.fort) {
      const r = d.fort.radius + b.level - 1;
      const cx = b.cell % w;
      const cy = (b.cell - cx) / w;
      for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
        for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
          if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > r * r) continue;
          g.fortOwner[y * w + x] = b.owner;
          g.fortPct[y * w + x] = Math.round(d.fort.defensePct * k);
          g.fortSlow[y * w + x] = Math.min(MAX_FORT_SLOW, d.fort.slow);
        }
      }
    }
  }
  for (const [a, b] of g.diplo.tradePairs()) {
    const fa = g.factions[a];
    const fb = g.factions[b];
    if (!fa.alive || !fb.alive) continue;
    // Nation and tribe: the tribe pays tribute and is protected in return.
    const tribute = (payer: typeof fa, taker: typeof fa) => payer.type === 'AI_TRIBE' && taker.type !== 'AI_TRIBE';
    fa.income += tribute(fb, fa) ? TRADE_INCOME * 1.5 : tribute(fa, fb) ? TRADE_INCOME / 2 : TRADE_INCOME;
    fb.income += tribute(fa, fb) ? TRADE_INCOME * 1.5 : tribute(fb, fa) ? TRADE_INCOME / 2 : TRADE_INCOME;
    fa.protected ||= tribute(fa, fb);
    fb.protected ||= tribute(fb, fa);
  }
}
