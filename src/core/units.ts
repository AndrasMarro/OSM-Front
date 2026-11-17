import { damage, pace, reach, type Building, type OrderResult } from './buildings';
import { NEUTRAL, type Game } from './game';
import { Registry } from './registry';
import { isLand, Terrain } from './terrain';

export type Domain = 'sea' | 'air' | 'missile';

/** Air defence: shoots at flying units of the listed domains within `radius` cells. */
export interface InterceptSpec {
  radius: number;
  /** Ticks between shots; several interceptors at one site share it out. */
  cooldown: number;
  chancePct: number;
  domains: Domain[];
}

/**
 * A unit type. Its role follows from which optional block is set - troops to
 * land, a blast, guns, a trade run or an interceptor - never from its id.
 */
export interface UnitDefinition {
  id: string;
  /** Display name (German UI). */
  name: string;
  /** One character for menus. */
  icon: string;
  /** Gold per unit, sortie or shot. */
  cost: number;
  /** Id of the building it starts from. */
  base: string;
  domain: Domain;
  /** Cells per tick. */
  speed: number;
  /** Reach from the base in cells: sailing distance for ships, straight line otherwise. */
  range: number;
  hp: number;
  /** Carries a share of the owner's troops and puts them ashore at the target. */
  carriesTroops?: boolean;
  /** Explodes at the target. `troopsPct` of a faction's troops are lost if the whole blast hits it. */
  blast?: { radius: number; buildingDamage: number; troopsPct: number; neutralize?: boolean };
  /**
   * Patrols and fires on enemy ships and shores (warship). An enemy trade ship in range is seized instead,
   * after which the guns rest `captureCooldown` ticks. Every warship it sinks raises its level (up to `maxLevel`),
   * worth `hpPerLevel` more hit points.
   */
  guns?: { radius: number; cooldown: number; troops: number; captureCooldown: number; maxLevel: number; hpPerLevel: number };
  /** Sails to a foreign port and earns gold for the run (trade ship). */
  trade?: { gold: number; perCell: number };
  /**
   * Not for sale: every base sends one out on its own every `every` ticks - divided by its level - as long
   * as it has fewer than its level of them at sea (trade ships leaving a port).
   */
  auto?: { every: number };
  /** Stays at its base and intercepts (fighter). */
  intercept?: InterceptSpec;
}

export interface Unit {
  id: number;
  def: UnitDefinition;
  owner: number;
  hp: number;
  troops: number;
  /** Faction the mission is aimed at (0 = nobody). */
  targetOwner: number;
  from: number;
  /** Destination cell: where troops land or the blast goes off; for ships the last water cell. */
  to: number;
  /** Sea route over water cells; null for flying units, which go straight. */
  path: number[] | null;
  /** Ships: position along `path`. Flying units: ticks flown out of `steps`. */
  progress: number;
  steps: number;
  /** Current position in cells, for range checks and rendering. */
  x: number;
  y: number;
  /** Guns: tick of the next shot. */
  readyAt: number;
  /** Rises when a warship sinks another one. */
  level: number;
}

export type UnitRegistry = Registry<UnitDefinition>;
export const unitRegistry: UnitRegistry = new Registry<UnitDefinition>();

unitRegistry.register({ id: 'TransportShip', name: 'Truppentransporter', icon: '⛵', cost: 60, base: 'Port', domain: 'sea', speed: 0.5, range: 400, hp: 2, carriesTroops: true });
unitRegistry.register({
  id: 'Warship',
  name: 'Kriegsschiff',
  icon: '☸',
  cost: 250,
  base: 'Port',
  domain: 'sea',
  speed: 0.5,
  range: 400,
  hp: 4,
  guns: { radius: 7, cooldown: 15, troops: 40, captureCooldown: 100, maxLevel: 4, hpPerLevel: 2 },
});
unitRegistry.register({ id: 'TradeShip', name: 'Handelsschiff', icon: '⚖', cost: 0, base: 'Port', domain: 'sea', speed: 0.4, range: 400, hp: 1, trade: { gold: 20, perCell: 0.5 }, auto: { every: 200 } });
unitRegistry.register({
  id: 'Fighter',
  name: 'Jäger', icon: '➹',
  cost: 200,
  base: 'Airfield',
  domain: 'air',
  speed: 0,
  range: 0,
  hp: 1,
  intercept: { radius: 18, cooldown: 60, chancePct: 60, domains: ['air'] },
});
unitRegistry.register({ id: 'Bomber', name: 'Bomber', icon: '✹', cost: 120, base: 'Airfield', domain: 'air', speed: 2, range: 160, hp: 1, blast: { radius: 3, buildingDamage: 2, troopsPct: 4 } });
unitRegistry.register({ id: 'Paratrooper', name: 'Fallschirmjäger', icon: '☂', cost: 100, base: 'Airfield', domain: 'air', speed: 2, range: 70, hp: 1, carriesTroops: true });
unitRegistry.register({ id: 'Missile', name: 'Taktische Rakete', icon: '➤', cost: 300, base: 'MissileSilo', domain: 'missile', speed: 5, range: 300, hp: 1, blast: { radius: 4, buildingDamage: 3, troopsPct: 8 } });
unitRegistry.register({
  id: 'Nuke',
  name: 'Atomrakete', icon: '☢',
  cost: 2500,
  base: 'MissileSilo',
  domain: 'missile',
  speed: 4,
  range: 500,
  hp: 1,
  blast: { radius: 12, buildingDamage: 99, troopsPct: 30, neutralize: true },
});

/** Ticks a nuked cell stays irradiated: slow and costly to take. */
export const FALLOUT_TICKS = 600;

// --- sea routes ------------------------------------------------------------

interface Scratch {
  prev: Int32Array;
  mark: Uint32Array;
  queue: Int32Array;
  gen: number;
}
const scratch = new WeakMap<Game, Scratch>();

/**
 * Shortest route over water from the shore cell `from`, at most `maxSteps`
 * long, to the first water cell that `goal` accepts. Null if there is none.
 */
export function seaRoute(g: Game, from: number, maxSteps: number, goal: (water: number) => boolean): number[] | null {
  let s = scratch.get(g);
  if (!s) scratch.set(g, (s = { prev: new Int32Array(g.owner.length), mark: new Uint32Array(g.owner.length), queue: new Int32Array(g.owner.length), gen: 0 }));
  const { prev, mark, queue } = s;
  const gen = ++s.gen;
  let tail = 0;
  const push = (cell: number, via: number) => {
    if (mark[cell] === gen || g.terrain[cell] !== Terrain.WATER) return;
    mark[cell] = gen;
    prev[cell] = via;
    queue[tail++] = cell;
  };
  g.eachNeighbor(from, (n) => push(n, -1));
  for (let head = 0, steps = 0; head < tail && steps <= maxSteps; steps++) {
    for (const levelEnd = tail; head < levelEnd; head++) {
      const cell = queue[head];
      if (goal(cell)) {
        const path: number[] = [];
        for (let c = cell; c >= 0; c = prev[c]) path.push(c);
        return path.reverse();
      }
      g.eachNeighbor(cell, (n) => push(n, cell));
    }
  }
  return null;
}

const touchesCell = (g: Game, water: number, land: number) => {
  let hit = false;
  g.eachNeighbor(water, (n) => (hit ||= n === land));
  return hit;
};

const chebyshev = (g: Game, a: number, b: number) =>
  Math.max(Math.abs((a % g.width) - (b % g.width)), Math.abs(Math.floor(a / g.width) - Math.floor(b / g.width)));

// --- orders ----------------------------------------------------------------

/** What one unit of this type costs the faction: a naval doctrine makes ships cheaper. */
export function unitCost(g: Game, factionId: number, def: UnitDefinition): number {
  const discount = def.domain === 'sea' ? (g.factions[factionId]?.bonus.navalDiscountPct ?? 0) : 0;
  return (def.cost * (100 - discount)) / 100;
}

/**
 * Buys one unit of type `unitId` and sends it at `target` from the nearest of
 * the faction's bases that can reach it. `percent` is the share of the
 * faction's troops a troop carrier takes along.
 */
export function launch(g: Game, factionId: number, unitId: string, target: number, percent = 0): OrderResult {
  const def = unitRegistry.get(unitId);
  const f = g.factions[factionId];
  // Units that sail on their own are not for sale.
  if (!def || def.auto || !f?.alive || target < 0 || target >= g.owner.length) return 'target';
  const cost = unitCost(g, factionId, def);
  if (f.gold < cost) return 'gold';
  const all = g.buildings.filter((b) => b.owner === factionId && b.def.id === def.base);
  if (all.length === 0) return 'base';
  // A magazine that is empty is reloading.
  const bases = all.filter((b) => !b.def.magazine || b.charges > 0).sort((a, b) => chebyshev(g, a.cell, target) - chebyshev(g, b.cell, target) || a.id - b.id);
  if (bases.length === 0) return 'reload';

  if (def.intercept) {
    // Stationed at the base; several of them shorten its reload.
    bases[0].intercept = def.intercept;
    bases[0].interceptors++;
    f.gold -= cost;
    return 'ok';
  }

  const water = g.terrain[target] === Terrain.WATER;
  let base: Building | undefined;
  let path: number[] | null = null;
  let to = target;
  if (def.domain === 'sea') {
    let goal: (cell: number) => boolean;
    if (def.carriesTroops) {
      // Troops need a foreign or free shore: the clicked cell, or the nearest one - of the same owner, if there is one.
      const shore = (c: number) => isLand(g.terrain[c]) && g.owner[c] !== factionId && g.touchesWater(c);
      to = water ? -1 : g.nearest(target, 6, (c) => g.owner[c] === g.owner[target] && shore(c));
      if (to < 0) to = g.nearest(target, 6, shore);
      if (to < 0) return 'target';
      goal = (cell) => touchesCell(g, cell, to);
    } else {
      const station = water ? target : g.nearest(target, 6, (c) => g.terrain[c] === Terrain.WATER);
      if (station < 0) return 'target';
      to = station;
      goal = (cell) => cell === station;
    }
    for (const b of bases) if ((path = seaRoute(g, b.cell, def.range, goal))) {
      base = b;
      break;
    }
    if (!path) return 'range';
  } else {
    if (water || g.owner[target] === factionId) return 'target';
    base = bases.find((b) => chebyshev(g, b.cell, target) <= def.range);
    if (!base) return 'range';
  }

  let troops = 0;
  if (def.carriesTroops) {
    troops = Math.floor((f.troops * Math.min(100, Math.max(1, percent))) / 100);
    if (troops < 1) return 'troops';
    f.troops -= troops;
  }
  f.gold -= cost;
  if (base!.def.magazine) {
    // The reload starts with the first shot of a full magazine.
    if (base!.charges === base!.level) base!.readyAt = g.tick + pace(base!, base!.def.magazine.reload);
    base!.charges--;
  }
  // A patrol in open water or a trade run threatens nobody; everything else aimed at a faction does.
  const targetOwner = def.trade ? 0 : g.owner[def.guns ? target : to];
  if (targetOwner && targetOwner !== factionId) g.diplo.hostile(g, factionId, targetOwner);
  const start = path ? path[0] : base!.cell;
  g.units.push({
    id: g.nextId++,
    def,
    owner: factionId,
    hp: def.hp,
    troops,
    targetOwner,
    from: base!.cell,
    to,
    path,
    progress: 0,
    steps: path ? 0 : Math.max(1, Math.ceil(chebyshev(g, base!.cell, to) / def.speed)),
    x: start % g.width,
    y: Math.floor(start / g.width),
    readyAt: 0,
    level: 1,
  });
  return 'ok';
}

/** Ports (and any other base of a unit with `auto`) send out their own ships, free of charge. */
function dispatch(g: Game): void {
  for (const def of unitRegistry.list()) {
    if (!def.auto || !def.trade) continue;
    for (const b of g.buildings) {
      // Staggered by building id; more often at a higher level and with supply.
      if (b.def.id !== def.base || (g.tick + b.id * 7) % pace(b, Math.ceil(def.auto.every / b.level)) !== 0) continue;
      let afloat = 0;
      for (const u of g.units) if (u.def === def && u.from === b.cell) afloat++;
      if (afloat >= b.level) continue;
      let to = -1;
      // The nearest port of someone the owner is neither fighting nor boycotting.
      const path = seaRoute(g, b.cell, def.range, (cell) => {
        g.eachNeighbor(cell, (n) => {
          const port = g.buildingAt.get(n);
          if (to < 0 && port?.def.id === def.base && port.owner !== b.owner && g.diplo.status(g, b.owner, port.owner) !== 'War' && !g.diplo.embargoed(b.owner, port.owner)) to = n;
        });
        return to >= 0;
      });
      if (!path) continue;
      g.units.push({ id: g.nextId++, def, owner: b.owner, hp: def.hp, troops: 0, targetOwner: 0, from: b.cell, to, path, progress: 0, steps: 0, x: path[0] % g.width, y: Math.floor(path[0] / g.width), readyAt: 0, level: 1 });
    }
  }
}

/** Ticks until a unit reaches its target: along its sea route, or the rest of its flight. */
export const etaTicks = (u: Unit) => (u.path ? Math.ceil((u.path.length - 1 - u.progress) / u.def.speed) : u.steps - u.progress);

/** What a trade run along `path` is worth. */
const cargo = (u: Unit) => u.def.trade!.gold + u.def.trade!.perCell * (u.path!.length - 1);

// --- simulation ------------------------------------------------------------

/** Moves every unit by one tick and resolves arrivals, gunfire and interceptions. */
export function stepUnits(g: Game): void {
  if (g.buildings.length > 0) dispatch(g);
  if (g.units.length === 0) return;
  for (const u of g.units) {
    if (u.hp <= 0) continue; // sunk earlier this tick
    if (!g.factions[u.owner].alive) u.hp = 0;
    else if (u.path) sail(g, u);
    else fly(g, u);
  }
  if (g.units.some((u) => u.hp <= 0)) g.units = g.units.filter((u) => u.hp > 0);
}

function sail(g: Game, u: Unit): void {
  const path = u.path!;
  const end = path.length - 1;
  if (u.progress < end) {
    u.progress = Math.min(end, u.progress + u.def.speed);
    const cell = path[Math.floor(u.progress)];
    u.x = cell % g.width;
    u.y = Math.floor(cell / g.width);
  }
  if (u.def.guns && g.tick >= u.readyAt) fire(g, u, u.progress >= end);
  if (u.progress < end) return;

  if (u.def.carriesTroops) {
    g.emit(g.land(u.owner, u.to, u.troops) ? 'landing' : 'repelled', u.to, 2);
    u.hp = 0;
  } else if (u.def.trade) {
    // One run, paid on arrival: the far port earns half as much. Then the ship is done.
    u.hp = 0;
    const port = g.buildingAt.get(u.to);
    if (!port || port.owner === u.owner || g.diplo.status(g, u.owner, port.owner) === 'War' || g.diplo.embargoed(u.owner, port.owner)) return; // the route closed
    const gold = cargo(u);
    g.factions[u.owner].gold += gold;
    g.factions[port.owner].gold += gold / 2;
    g.diplo.adjust(u.owner, port.owner, 1);
  }
}

/**
 * One salvo: at the nearest enemy ship, otherwise (on station) at the nearest enemy shore.
 * An enemy trade ship is not sunk but seized - also under an embargo - and the guns then rest a while.
 */
function fire(g: Game, u: Unit, onStation: boolean): void {
  const guns = u.def.guns!;
  const r2 = guns.radius * guns.radius;
  const atWar = (other: number) => other !== u.owner && other !== NEUTRAL && g.diplo.status(g, u.owner, other) === 'War';
  const prey = (o: Unit) => (o.def.trade ? atWar(o.owner) || (o.owner !== u.owner && g.diplo.embargoed(u.owner, o.owner)) : atWar(o.owner));
  let ship: Unit | undefined;
  let best = r2 + 1;
  for (const o of g.units) {
    if (!o.path || o.hp <= 0 || !prey(o)) continue;
    const d = (o.x - u.x) * (o.x - u.x) + (o.y - u.y) * (o.y - u.y);
    if (d < best) {
      best = d;
      ship = o;
    }
  }
  if (ship) {
    const at = Math.floor(ship.y) * g.width + Math.floor(ship.x);
    if (ship.def.trade) {
      // Seized: the cargo goes to the captor.
      ship.hp = 0;
      g.factions[u.owner].gold += cargo(ship);
      g.diplo.adjust(u.owner, ship.owner, -5);
      g.emit('captured', at, 2);
      u.readyAt = g.tick + guns.captureCooldown;
      return;
    }
    ship.hp--;
    g.emit(ship.hp <= 0 ? 'sunk' : 'hit', at, 2);
    // A warship that sinks another one gains a level and with it a thicker hull.
    if (ship.hp <= 0 && ship.def.guns && u.level < guns.maxLevel) {
      u.level++;
      u.hp += guns.hpPerLevel;
    }
    u.readyAt = g.tick + guns.cooldown;
    return;
  }
  if (!onStation) return;
  const shore = g.nearest(Math.floor(u.y) * g.width + Math.floor(u.x), guns.radius, (c) => isLand(g.terrain[c]) && atWar(g.owner[c]));
  if (shore < 0) return;
  const victim = g.factions[g.owner[shore]];
  victim.troops -= Math.min(victim.troops, guns.troops);
  const b = g.buildingAt.get(shore);
  if (b) damage(g, b, 1);
  g.emit('hit', shore, 2);
  u.readyAt = g.tick + guns.cooldown;
}

function fly(g: Game, u: Unit): void {
  const w = g.width;
  u.progress++;
  const fx = u.from % w;
  const fy = Math.floor(u.from / w);
  u.x = fx + (((u.to % w) - fx) * u.progress) / u.steps;
  u.y = fy + ((Math.floor(u.to / w) - fy) * u.progress) / u.steps;

  for (const b of g.buildings) {
    const spec = b.intercept;
    if (!spec || b.readyAt > g.tick || b.owner === u.owner || !spec.domains.includes(u.def.domain)) continue;
    const r = reach(b, spec.radius);
    // Defends its owner, its owner's allies, and against anyone its owner is at war with.
    if (b.owner !== u.targetOwner && !g.diplo.allied(b.owner, u.targetOwner) && g.diplo.status(g, b.owner, u.owner) !== 'War') continue;
    const dx = (b.cell % w) - u.x;
    const dy = Math.floor(b.cell / w) - u.y;
    if (dx * dx + dy * dy > r * r) continue;
    b.readyAt = g.tick + pace(b, Math.ceil(spec.cooldown / Math.max(1, b.interceptors)));
    if (g.rng() * 100 < spec.chancePct) {
      u.hp = 0;
      g.emit('intercept', Math.floor(u.y) * w + Math.floor(u.x), 3);
      return;
    }
  }
  if (u.progress < u.steps) return;
  u.hp = 0;
  if (u.def.carriesTroops) g.emit(g.land(u.owner, u.to, u.troops) ? 'landing' : 'repelled', u.to, 2);
  if (u.def.blast) blast(g, u);
}

/** The explosion at `u.to`: damages buildings, kills troops and - for a nuke - leaves a wasteland. */
function blast(g: Game, u: Unit): void {
  const { radius: r, buildingDamage, troopsPct, neutralize } = u.def.blast!;
  const { width: w, height: h } = g;
  const cx = u.to % w;
  const cy = Math.floor(u.to / w);
  const hits = new Map<number, number>();
  let area = 0;
  for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
      const cell = y * w + x;
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > r * r || !isLand(g.terrain[cell])) continue;
      area++;
      const owner = g.owner[cell];
      if (owner) hits.set(owner, (hits.get(owner) ?? 0) + 1);
      const b = g.buildingAt.get(cell);
      if (b) damage(g, b, buildingDamage);
      if (neutralize) {
        g.fallout[cell] = g.tick + FALLOUT_TICKS;
        g.touch(cell);
        if (owner) g.setOwner(cell, NEUTRAL);
      }
    }
  }
  for (const [owner, n] of hits) {
    const f = g.factions[owner];
    f.troops -= Math.min(f.troops, (((f.troops * troopsPct) / 100) * n) / area);
    if (owner !== u.owner) g.diplo.hostile(g, u.owner, owner);
    g.buryIfGone(owner);
  }
  g.emit(neutralize ? 'nuke' : 'explosion', u.to, r);
}
