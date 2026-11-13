import { TRADE_INCOME } from './diplomacy';
import { rulesOf } from './faction';
import type { Game } from './game';
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
  linkBonusPct?: number;
  /** Cells within `radius` cost attackers `defensePct` more and fall `slow` ticks later (Bunker). */
  fort?: { radius: number; defensePct: number; slow: number };
  /** Shoots down flying units nearby (SAMSite). */
  intercept?: InterceptSpec;
}

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
}

export type OrderResult = 'ok' | 'gold' | 'place' | 'spacing' | 'coast' | 'base' | 'range' | 'target' | 'troops';

export type BuildingRegistry = Registry<BuildingDefinition>;
export const buildingRegistry: BuildingRegistry = new Registry<BuildingDefinition>();

buildingRegistry.register({ id: 'City', name: 'Stadt', icon: '⌂', cost: 250, hp: 4, capacity: 2500, growthPct: 15 });
buildingRegistry.register({ id: 'Factory', name: 'Fabrik', icon: '⚙', cost: 200, hp: 3, income: 0.4, linkBonusPct: 50 });
buildingRegistry.register({ id: 'Bunker', name: 'Bunker', icon: '♜', cost: 150, hp: 5, fort: { radius: 6, defensePct: 200, slow: 4 } });
buildingRegistry.register({ id: 'Port', name: 'Hafen', icon: '⚓', cost: 200, hp: 3, coastal: true });
buildingRegistry.register({ id: 'Airfield', name: 'Fliegerhorst', icon: '✈', cost: 400, hp: 3 });
buildingRegistry.register({ id: 'MissileSilo', name: 'Raketensilo', icon: '☢', cost: 800, hp: 4 });
buildingRegistry.register({
  id: 'SAMSite',
  name: 'SAM-Stellung',
  icon: '◎',
  cost: 500,
  hp: 2,
  intercept: { radius: 14, cooldown: 80, chancePct: 100, domains: ['air', 'missile'] },
});

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
  const b: Building = { id: g.nextId++, def, owner: factionId, cell, hp: def.hp, linked: false, intercept: def.intercept, interceptors: def.intercept ? 1 : 0, readyAt: 0 };
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
  const restamp = g.dirty;
  const relink = g.dirty || g.tick % 100 === 0;
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
  for (const b of g.buildings) {
    const f = g.factions[b.owner];
    const d = b.def;
    f.cityCapacity += d.capacity ?? 0;
    f.growthPct = Math.min(100, f.growthPct + (d.growthPct ?? 0));
    if (d.income) {
      if (relink) b.linked = linkedCity(g, b.owner, b.cell) >= 0;
      f.income += (d.income * (100 + (b.linked ? (d.linkBonusPct ?? 0) : 0)) * (100 + f.bonus.factoryIncomePct)) / 10000;
    }
    if (restamp && d.fort) {
      const r = d.fort.radius;
      const cx = b.cell % w;
      const cy = (b.cell - cx) / w;
      for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
        for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
          if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > r * r) continue;
          g.fortOwner[y * w + x] = b.owner;
          g.fortPct[y * w + x] = d.fort.defensePct;
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
