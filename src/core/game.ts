import { decide } from './ai';
import { refreshEconomy, type Building } from './buildings';
import { Diplomacy, TRAITOR_DEFENSE_PCT } from './diplomacy';
import { rulesOf, type Faction, type FactionSpec } from './faction';
import { bonusOf } from './nation';
import { mulberry32 } from './rng';
import { CAPACITY, CONQUER_DELAY, DEFENSE_PCT, isLand, Terrain } from './terrain';
import { stepUnits, type Unit } from './units';

export const TICKS_PER_SECOND = 10;
/** Owner id of unowned cells. Also the "target" of an expansion into free land. */
export const NEUTRAL = 0;

/**
 * Attack fronts are scheduled into a ring of per-tick buckets; delays must stay below this.
 * Worst case: terrain 12 + jitter 1 + defenders 8 + fort 4 + fallout 6 = 31.
 */
const RING = 32;
const MAX_TERRAIN_DELAY = 12;
const FALLOUT_DELAY = 6;
/** A fresh beachhead (a landing from the sea or the air) holds out this long, ... */
export const BEACHHEAD_TICKS = 300;
/** ... within this radius ... */
export const BEACHHEAD_RADIUS = 6;
/** ... with this much extra defence, and this much slower to retake. */
const BEACHHEAD_DEFENSE_PCT = 200;
const BEACHHEAD_SLOW = 4;
/** Troops it takes to settle a cell of free land, on top of its terrain cost. */
const SETTLE_COST = 10;
/** Around its rally point (within this many cells) a faction's land costs attackers this much more. */
export const RALLY_RADIUS = 8;
const RALLY_DEFENSE_PCT = 50;
/** A tribe that pays tribute to a nation defends this much better. */
const PROTECTED_DEFENSE_PCT = 115;
/** Events older than this many ticks are dropped. */
const EVENT_TICKS = 40;

/** Something worth showing: explosions, interceptions, landings. No effect on the simulation. */
export interface GameEvent {
  type: 'explosion' | 'nuke' | 'intercept' | 'landing' | 'repelled' | 'hit' | 'sunk' | 'captured';
  cell: number;
  radius: number;
  tick: number;
}

/** A front flooding from `attacker` into the territory of `target`. */
export interface Attack {
  attacker: number;
  target: number;
  troops: number;
  /** buckets[tick % RING] holds the cells that become conquerable at that tick. */
  buckets: number[][];
  /** Number of cells queued in all buckets. */
  pending: number;
  /** Set for one tick while a stronger counter-attack pins this one down. */
  held: boolean;
  /** Ticks since this attack last took a cell. */
  idle: number;
}

/** A real city of the world on this map. A city building on or next to it merges with it. */
export interface RealCity {
  cell: number;
  name: string;
  /** 1 world metropolis, 2 big city, 3 regional centre. */
  tier: 1 | 2 | 3;
}
/** How far from a real city (in cells, Chebyshev) a building still merges with it. */
export const CITY_REACH = 2;
/** A cell falls only if this many of its eight neighbours are the attacker's already: no spikes, no speckles. */
const COHESION = 2;
/** An attack that has taken nothing for this long may ignore cohesion, so that it can never get stuck. */
const COHESION_PATIENCE = 6;
/** Where attack and counter-attack meet, each side loses this share of the weaker force per tick. */
const CLASH_DIVISOR = 20;

export type Difficulty = 'easy' | 'normal' | 'hard' | 'impossible';

/** How the AI is held back or favoured. */
export interface Level {
  /** The AI's population growth and gold income, in percent of the normal rate. */
  aiGrowthPct: number;
  aiIncomePct: number;
  /** Ticks before the AI may pick a player as prey. */
  peaceTicks: number;
  /** The AI's appetite for war, in percent. */
  aggressionPct: number;
  /** Land an AI nation needs before it builds something, in percent: lower means it arms earlier and more densely. */
  armsPct: number;
  /** AI nations close ranks against a player who has outgrown them. */
  coalition: boolean;
}

export const DIFFICULTY: Record<Difficulty, Level> = {
  easy: { aiGrowthPct: 60, aiIncomePct: 100, peaceTicks: 1200, aggressionPct: 60, armsPct: 100, coalition: false },
  normal: { aiGrowthPct: 85, aiIncomePct: 100, peaceTicks: 450, aggressionPct: 100, armsPct: 100, coalition: false },
  hard: { aiGrowthPct: 110, aiIncomePct: 100, peaceTicks: 0, aggressionPct: 120, armsPct: 100, coalition: false },
  impossible: { aiGrowthPct: 135, aiIncomePct: 140, peaceTicks: 0, aggressionPct: 150, armsPct: 60, coalition: true },
};

export interface GameOptions {
  seed: number;
  /** Default: normal. */
  difficulty?: Difficulty;
  /** Per-terrain multiplier on conquest delay and cost, indexed by terrain id. */
  terrainWeights?: ArrayLike<number | undefined>;
  /** Real cities on the map, as cells. */
  cities?: RealCity[];
}

/**
 * The deterministic simulation. No DOM, no network, no wall clock: state only
 * changes through `step` and the commands (`addFaction`, `attack`, `build`,
 * `launch`, the diplomacy calls), and all randomness comes from the seeded PRNG. Troop counts are fractional, but floating point use
 * is limited to + - * / so results are bit-identical across JS engines.
 */
export class Game {
  readonly width: number;
  readonly height: number;
  readonly terrain: Uint8Array;
  readonly owner: Uint16Array;
  /** factions[0] is a placeholder so that the index equals the faction id. */
  readonly factions: Faction[] = [];
  attacks: Attack[] = [];
  tick = 0;
  readonly landCells: number;
  readonly rng: () => number;
  readonly level: Level;
  private readonly delay: number[];

  buildings: Building[] = [];
  readonly buildingAt = new Map<number, Building>();
  units: Unit[] = [];
  readonly diplo = new Diplomacy();
  /** Per cell: the faction whose fort covers it, the defence bonus in percent and the delay it adds. */
  readonly fortOwner: Uint16Array;
  readonly fortPct: Uint16Array;
  readonly fortSlow: Uint8Array;
  /** Per cell: tick until which it is irradiated. */
  readonly fallout: Uint32Array;
  events: GameEvent[] = [];
  /** Ids for buildings and units. */
  nextId = 1;
  /** Set when buildings changed; the derived economy is refreshed on the next tick. */
  dirty = false;
  /** Bounding box of the cells that changed since `takeChanges` was last called. */
  private changed = [Infinity, Infinity, -1, -1];
  readonly cities: RealCity[];
  /** Landings of the last BEACHHEAD_TICKS: the troops dig in around them. */
  beachheads: { owner: number; cell: number; until: number }[] = [];
  private readonly cityAt = new Map<number, RealCity>();
  /** Cells that changed hands by conquest in this tick, for the smoothing pass. */
  private flipped: number[] = [];

  constructor(width: number, height: number, terrain: Uint8Array, options: GameOptions) {
    if (terrain.length !== width * height) throw new Error('terrain size does not match grid');
    this.width = width;
    this.height = height;
    this.terrain = terrain;
    this.owner = new Uint16Array(width * height);
    this.fortOwner = new Uint16Array(width * height);
    this.fortPct = new Uint16Array(width * height);
    this.fortSlow = new Uint8Array(width * height);
    this.fallout = new Uint32Array(width * height);
    this.rng = mulberry32(options.seed);
    this.level = DIFFICULTY[options.difficulty ?? 'normal'] ?? DIFFICULTY.normal;
    this.delay = CONQUER_DELAY.map((d, t) =>
      d === 0 ? 0 : Math.min(MAX_TERRAIN_DELAY, Math.max(1, Math.round(d * (options.terrainWeights?.[t] ?? 1)))),
    );
    this.cities = options.cities ?? [];
    for (const c of this.cities) if (!this.cityAt.has(c.cell)) this.cityAt.set(c.cell, c);
    let land = 0;
    for (let i = 0; i < terrain.length; i++) if (isLand(terrain[i])) land++;
    this.landCells = land;
    this.factions.push(this.blankFaction(0, { name: '', type: 'AI_TRIBE' }, 0));
    this.factions[0].alive = false;
  }

  isFreeLand(cell: number): boolean {
    return this.owner[cell] === NEUTRAL && isLand(this.terrain[cell]);
  }

  /** The real city a building on `cell` would merge with: on it or right next to it, and not built on yet. */
  realCityNear(cell: number): RealCity | null {
    if (this.cityAt.size === 0) return null;
    const at = this.nearest(cell, CITY_REACH, (c) => {
      const city = this.cityAt.get(c);
      return city !== undefined && !this.buildings.some((b) => b.city === city);
    });
    return at < 0 ? null : this.cityAt.get(at)!;
  }

  maxTroops(f: Faction): number {
    return rulesOf(f).baseCapacity + f.capacity + f.cityCapacity;
  }

  touchesWater(cell: number): boolean {
    let water = false;
    this.eachNeighbor(cell, (n) => (water ||= this.terrain[n] === Terrain.WATER));
    return water;
  }

  /** The cell nearest to `cell` (itself included, at most `radius` away) that `ok` accepts, or -1. */
  nearest(cell: number, radius: number, ok: (cell: number) => boolean): number {
    const { width: w, height: h } = this;
    const cx = cell % w;
    const cy = (cell - cx) / w;
    for (let r = 0; r <= radius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && y >= 0 && x < w && y < h && ok(y * w + x)) return y * w + x;
        }
      }
    }
    return -1;
  }

  /** Notes that a cell looks different now (new owner, fallout). */
  touch(cell: number): void {
    const x = cell % this.width;
    const y = (cell - x) / this.width;
    const c = this.changed;
    if (x < c[0]) c[0] = x;
    if (y < c[1]) c[1] = y;
    if (x > c[2]) c[2] = x;
    if (y > c[3]) c[3] = y;
  }

  /**
   * The box [minX, minY, maxX, maxY] around everything that changed since the
   * last call, or null. For a renderer that wants to repaint only that part.
   */
  takeChanges(): number[] | null {
    const c = this.changed;
    this.changed = [Infinity, Infinity, -1, -1];
    return c[2] < 0 ? null : c;
  }

  emit(type: GameEvent['type'], cell: number, radius: number): void {
    this.events.push({ type, cell, radius, tick: this.tick });
  }

  /**
   * Spawns a faction on free land at or near `cell` (searching up to
   * `searchRadius` cells away). Returns null if there is no room.
   */
  addFaction(spec: FactionSpec, cell: number, searchRadius = 12): Faction | null {
    if (this.factions.length > 0xffff) return null;
    const centre = this.nearest(cell, searchRadius, (c) => this.isFreeLand(c));
    if (centre < 0) return null;
    const { width: w, height: h } = this;
    const r = rulesOf(spec).spawnRadius;
    const cx = centre % w;
    const cy = (centre - cx) / w;
    const claim: number[] = [];
    for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r && this.isFreeLand(y * w + x)) claim.push(y * w + x);
      }
    }
    // A crowded spot (less than about a third of the disc free) is no place to start.
    if (claim.length < r * r) return null;

    const f = this.blankFaction(this.factions.length, spec, this.terrain[centre]);
    this.factions.push(f);
    for (const c of claim) this.setOwner(c, f.id);
    return f;
  }

  /**
   * Sends `percent` of the attacker's troops against `target` (a faction id, or
   * NEUTRAL for free land). Reinforces a running attack on the same target.
   * Returns false if the two do not share a land border.
   */
  attack(attackerId: number, targetId: number, percent: number): boolean {
    const att = this.factions[attackerId];
    if (!att?.alive || attackerId === targetId) return false;
    if (targetId !== NEUTRAL && !this.factions[targetId]?.alive) return false;
    const troops = Math.floor((att.troops * Math.min(100, Math.max(1, percent))) / 100);
    if (troops < 1) return false;

    let atk = this.attacks.find((a) => a.attacker === attackerId && a.target === targetId);
    if (!atk) {
      atk = { attacker: attackerId, target: targetId, troops: 0, buckets: Array.from({ length: RING }, () => []), pending: 0, held: false, idle: 0 };
      this.seedFront(atk, att);
      if (atk.pending === 0) return false;
      this.attacks.push(atk);
    }
    this.diplo.hostile(this, attackerId, targetId);
    att.troops -= troops;
    atk.troops += troops;
    return true;
  }

  /**
   * Puts `troops` of a faction ashore on `cell`, from a ship or from the air.
   * They take the cell and flood on from it. False if they were too few to take it.
   */
  land(attackerId: number, cell: number, troops: number): boolean {
    const att = this.factions[attackerId];
    const target = this.owner[cell];
    if (!att.alive || !isLand(this.terrain[cell])) return false;
    if (target === attackerId) {
      att.troops += troops; // the shore is ours by now: reinforcements
      return true;
    }
    // The shore was free when the ships set out; if a treaty partner has taken it since, nobody lands.
    const treaty = target === NEUTRAL ? 'War' : this.diplo.status(this, attackerId, target);
    if (treaty === 'NonAggressionPact' || treaty === 'Alliance') {
      att.troops += troops;
      return false;
    }
    const cost = this.cost(cell, target);
    if (troops < cost) return false;
    this.diplo.hostile(this, attackerId, target);
    this.take(cell, attackerId, target);
    this.beachheads.push({ owner: attackerId, cell, until: this.tick + BEACHHEAD_TICKS });
    let atk = this.attacks.find((a) => a.attacker === attackerId && a.target === target);
    if (!atk) {
      atk = { attacker: attackerId, target, troops: 0, buckets: Array.from({ length: RING }, () => []), pending: 0, held: false, idle: 0 };
      this.attacks.push(atk);
    }
    atk.troops += troops - cost;
    const front = atk;
    this.eachNeighbor(cell, (n) => {
      if (this.isTarget(n, target)) this.enqueue(front, n);
    });
    return true;
  }

  /** Ends the attacks two factions run against each other; the troops go home. */
  callOff(a: number, b: number): void {
    this.attacks = this.attacks.filter((atk) => {
      if (!((atk.attacker === a && atk.target === b) || (atk.attacker === b && atk.target === a))) return true;
      this.factions[atk.attacker].troops += atk.troops;
      return false;
    });
  }

  removeBuilding(b: Building): void {
    this.buildingAt.delete(b.cell);
    this.buildings = this.buildings.filter((o) => o !== b);
    this.dirty = true;
  }

  /**
   * Fingerprint of the state that matters: who owns what, and every faction's
   * troops and gold. Lockstep peers compare it to notice a desync.
   */
  hash(): number {
    let h = 2166136261 ^ this.tick;
    for (let i = 0; i < this.owner.length; i++) h = Math.imul(h ^ this.owner[i], 16777619);
    for (const f of this.factions) h = Math.imul(Math.imul(h ^ Math.floor(f.troops), 16777619) ^ Math.floor(f.gold), 16777619);
    return h >>> 0;
  }

  /** A faction without land is out of the game. */
  buryIfGone(id: number): void {
    const f = this.factions[id];
    if (id !== NEUTRAL && f.alive && f.cells === 0) {
      f.alive = false;
      f.troops = 0;
    }
  }

  /** Advances the simulation by one tick (1 / TICKS_PER_SECOND seconds). */
  step(): void {
    const second = this.tick % TICKS_PER_SECOND === 0;
    if (second) this.refreshNeighbors();
    if (second || this.dirty) refreshEconomy(this);
    if (this.tick % (10 * TICKS_PER_SECOND) === 0) this.diplo.drift(this);
    if (this.beachheads.length > 0 && this.beachheads[0].until <= this.tick) this.beachheads = this.beachheads.filter((b) => b.until > this.tick);
    if (this.events.length > 0 && this.events[0].tick + EVENT_TICKS < this.tick) this.events = this.events.filter((e) => e.tick + EVENT_TICKS >= this.tick);

    for (let i = 1; i < this.factions.length; i++) {
      const f = this.factions[i];
      if (!f.alive) continue;
      f.gold += f.type === 'HUMAN_NATION' ? f.income : (f.income * this.level.aiIncomePct) / 100;
      const max = this.maxTroops(f);
      // Logistic growth, fastest at half capacity, plus a base rate so a drained empire recovers.
      if (f.troops < max) {
        const grown = ((max / 50 + (f.troops * (max - f.troops)) / max) * rulesOf(f).growth * (100 + f.growthPct + f.bonus.growthPct)) / 100000;
        f.troops += f.type === 'HUMAN_NATION' ? grown : (grown * this.level.aiGrowthPct) / 100;
      }
      // Each AI thinks every two seconds, staggered by id.
      if (f.type !== 'HUMAN_NATION' && (this.tick + f.id * 3) % (2 * TICKS_PER_SECOND) === 0) decide(this, f);
    }

    this.clash();
    let finished = false;
    for (const atk of this.attacks) {
      if (this.advance(atk)) {
        atk.pending = -1;
        finished = true;
      }
    }
    this.smooth();
    if (finished) this.attacks = this.attacks.filter((a) => a.pending >= 0);
    stepUnits(this);
    this.tick++;
  }

  // --- internals -----------------------------------------------------------

  private blankFaction(id: number, spec: FactionSpec, homeTerrain: number): Faction {
    const elite = spec.type === 'AI_TRIBE' && !!spec.elite;
    return {
      id,
      name: spec.name,
      type: spec.type,
      elite,
      homeTerrain,
      troops: rulesOf({ type: spec.type, elite }).startTroops,
      cells: 0,
      capacity: 0,
      gold: rulesOf({ type: spec.type, elite }).startGold,
      income: 0,
      cityCapacity: 0,
      growthPct: 0,
      traitorUntil: 0,
      enemy: 0,
      protected: false,
      nation: spec.nation ?? null,
      flag: spec.flag ?? null,
      bonus: bonusOf(spec.nation?.doctrine),
      rally: -1,
      alive: true,
      aggression: spec.type === 'AI_NATION' ? Math.min(100, Math.floor(((40 + Math.floor(this.rng() * 50)) * this.level.aggressionPct) / 100)) : 5,
      lastAttacker: 0,
      neighbors: [],
      bordersNeutral: false,
      sumX: 0,
      sumY: 0,
      minX: this.width,
      minY: this.height,
      maxX: -1,
      maxY: -1,
    };
  }

  /** Changes the owner of a cell and keeps the per-faction bookkeeping; a building on it changes hands. */
  setOwner(cell: number, to: number): void {
    const from = this.owner[cell];
    const b = this.buildingAt.size > 0 ? this.buildingAt.get(cell) : undefined;
    if (b) {
      if (to === NEUTRAL) this.removeBuilding(b);
      else {
        b.owner = to;
        b.interceptors = b.def.intercept ? 1 : 0; // stationed units do not survive the capture
        if (!b.def.intercept) b.intercept = undefined;
        this.dirty = true;
      }
    }
    const x = cell % this.width;
    const y = (cell - x) / this.width;
    const cap = CAPACITY[this.terrain[cell]];
    if (from) {
      const f = this.factions[from];
      f.cells--;
      f.capacity -= cap;
      f.sumX -= x;
      f.sumY -= y;
    }
    if (to) {
      const f = this.factions[to];
      f.cells++;
      f.capacity += cap;
      f.sumX += x;
      f.sumY += y;
      if (x < f.minX) f.minX = x;
      if (x > f.maxX) f.maxX = x;
      if (y < f.minY) f.minY = y;
      if (y > f.maxY) f.maxY = y;
    }
    this.owner[cell] = to;
    const c = this.changed;
    if (x < c[0]) c[0] = x;
    if (y < c[1]) c[1] = y;
    if (x > c[2]) c[2] = x;
    if (y > c[3]) c[3] = y;
  }

  private isTarget(cell: number, target: number): boolean {
    return this.owner[cell] === target && isLand(this.terrain[cell]);
  }

  /** Calls `fn` for the 4-neighbours of `cell` that are inside the grid. */
  eachNeighbor(cell: number, fn: (n: number) => void): void {
    const w = this.width;
    const x = cell % w;
    if (x > 0) fn(cell - 1);
    if (x < w - 1) fn(cell + 1);
    if (cell >= w) fn(cell - w);
    if (cell < this.owner.length - w) fn(cell + w);
  }

  private touches(cell: number, faction: number): boolean {
    const { owner, width: w } = this;
    const x = cell % w;
    return (
      (x > 0 && owner[cell - 1] === faction) ||
      (x < w - 1 && owner[cell + 1] === faction) ||
      (cell >= w && owner[cell - w] === faction) ||
      (cell < owner.length - w && owner[cell + w] === faction)
    );
  }

  /** Queues every target cell that borders the attacker. */
  private seedFront(atk: Attack, att: Faction): void {
    // ponytail: scans the attacker's grow-only bounding box; keep a per-faction border set if this shows up in profiles.
    for (let y = att.minY; y <= att.maxY; y++) {
      for (let x = att.minX; x <= att.maxX; x++) {
        const cell = y * this.width + x;
        if (this.owner[cell] !== atk.attacker) continue;
        this.eachNeighbor(cell, (n) => {
          if (this.isTarget(n, atk.target)) this.enqueue(atk, n);
        });
      }
    }
  }

  /**
   * Schedules `cell` for conquest. Rough terrain and dense defenders hold the
   * front up longer; undefended land falls twice as fast.
   */
  private enqueue(atk: Attack, cell: number): void {
    let d = this.delay[this.terrain[cell]] + Math.floor(this.rng() * 2);
    if (atk.target !== NEUTRAL) {
      const def = this.factions[atk.target];
      const att = this.factions[atk.attacker];
      const attDensity = (att.troops + atk.troops) / att.cells;
      d += attDensity > 0 ? Math.min(8, Math.floor((2 * def.troops) / def.cells / attDensity)) : 8;
      if (this.fortOwner[cell] === atk.target) d += this.fortSlow[cell];
      else if (this.beachheadAt(cell, atk.target)) d += BEACHHEAD_SLOW;
    }
    if (this.fallout[cell] > this.tick) d += FALLOUT_DELAY;
    atk.buckets[(this.tick + d) % RING].push(cell);
    atk.pending++;
  }

  /** Is `cell` within a fresh beachhead of `owner`? */
  beachheadAt(cell: number, owner: number): boolean {
    if (this.beachheads.length === 0) return false;
    const w = this.width;
    const x = cell % w;
    const y = (cell - x) / w;
    for (const b of this.beachheads) {
      if (b.owner !== owner || b.until <= this.tick) continue;
      const dx = (b.cell % w) - x;
      const dy = Math.floor(b.cell / w) - y;
      if (dx * dx + dy * dy <= BEACHHEAD_RADIUS * BEACHHEAD_RADIUS) return true;
    }
    return false;
  }

  /** Troops the attacker pays for one cell: terrain plus the defenders standing on it. */
  cost(cell: number, target: number): number {
    const t = this.terrain[cell];
    // Free land is not free: settling it takes troops, so expansion is a choice and not a formality.
    let cost = this.delay[t] * 2 + (target === NEUTRAL ? SETTLE_COST : 0);
    if (this.fallout[cell] > this.tick) cost *= 3;
    if (target !== NEUTRAL) {
      const def = this.factions[target];
      let pct = DEFENSE_PCT[t] + (def.elite && t === def.homeTerrain ? 50 : 0);
      if (this.fortOwner[cell] === target) pct += (this.fortPct[cell] * (100 + def.bonus.fortDefensePct)) / 100;
      if (def.rally >= 0 && this.owner[def.rally] === target) {
        const dx = (cell % this.width) - (def.rally % this.width);
        const dy = Math.floor(cell / this.width) - Math.floor(def.rally / this.width);
        if (dx * dx + dy * dy <= RALLY_RADIUS * RALLY_RADIUS) pct += RALLY_DEFENSE_PCT;
      }
      if (this.beachheadAt(cell, target)) pct += BEACHHEAD_DEFENSE_PCT;
      if (def.traitorUntil > this.tick) pct = (pct * TRAITOR_DEFENSE_PCT) / 100;
      if (def.protected) pct = (pct * PROTECTED_DEFENSE_PCT) / 100;
      cost += Math.ceil(((def.troops / def.cells) * pct) / 100);
    }
    return cost;
  }

  /** Hands one conquered cell to the attacker: the defenders on it are lost. */
  private take(cell: number, attacker: number, target: number): void {
    if (target !== NEUTRAL) {
      const def = this.factions[target];
      def.troops -= Math.min(def.troops, Math.floor(def.troops / def.cells));
      def.lastAttacker = attacker;
    }
    this.setOwner(cell, attacker);
    this.flipped.push(cell);
    this.buryIfGone(target);
  }

  /**
   * Tug of war: where two factions attack each other, the two offensives are set against each
   * other instead of flooding past one another. Both lose troops; only the stronger one moves
   * in this tick, and with equal forces the front stands still while both bleed.
   */
  private clash(): void {
    for (const a of this.attacks) {
      if (a.target === NEUTRAL || a.attacker > a.target) continue; // each pair once
      const b = this.attacks.find((o) => o.attacker === a.target && o.target === a.attacker);
      if (!b) continue;
      const weaker = Math.min(a.troops, b.troops);
      const loss = Math.min(weaker, Math.max(5, Math.ceil(weaker / CLASH_DIVISOR)));
      a.troops -= loss;
      b.troops -= loss;
      a.held = a.troops <= b.troops;
      b.held = b.troops <= a.troops;
    }
  }

  /** Counts the eight neighbours of `cell` that `faction` owns, and those that are land at all. */
  private around(cell: number, faction: number): [own: number, land: number] {
    const { owner, terrain, width: w, height: h } = this;
    const x = cell % w;
    const y = (cell - x) / w;
    let own = 0;
    let land = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx === 0 && dy === 0) || x + dx < 0 || x + dx >= w || y + dy < 0 || y + dy >= h) continue;
        const n = cell + dy * w + dx;
        if (owner[n] === faction) own++;
        if (isLand(terrain[n])) land++;
      }
    }
    return [own, land];
  }

  /**
   * Cohesion: a cell only falls to an attacker who already holds enough of the cells around it.
   * Narrow land (a bridge, a spit) needs one, and so does the first step out of a lone beachhead.
   */
  private backed(cell: number, attacker: number): boolean {
    const [own, land] = this.around(cell, attacker);
    if (own >= COHESION || (own >= 1 && land < 4)) return true;
    let lone = false;
    this.eachNeighbor(cell, (n) => {
      if (this.owner[n] === attacker && this.around(n, attacker)[0] === 0) lone = true;
    });
    return lone;
  }

  /** Conquers this tick's cells of one attack. Returns true when the attack is over. */
  private advance(atk: Attack): boolean {
    const att = this.factions[atk.attacker];
    if (!att.alive) return true; // its troops are lost with it
    const slot = this.tick % RING;
    const bucket = atk.buckets[slot];
    if (atk.held) {
      // Pinned down by the counter-attack: this tick's cells wait for the next one.
      atk.held = false;
      if (atk.troops <= 0) return true;
      if (bucket.length > 0) {
        atk.buckets[slot] = [];
        const next = atk.buckets[(slot + 1) % RING];
        for (const cell of bucket) next.push(cell);
      }
      return false;
    }
    let exhausted = false;
    atk.idle++;
    if (bucket.length > 0) {
      atk.buckets[slot] = [];
      atk.pending -= bucket.length;
      const strict = atk.idle < COHESION_PATIENCE;
      for (const cell of bucket) {
        // Stale entries: the cell changed hands, or we lost the cells next to it.
        if (!this.isTarget(cell, atk.target) || !this.touches(cell, atk.attacker)) continue;
        if (strict && !this.backed(cell, atk.attacker)) {
          // Not yet: it comes up again once its neighbours have fallen.
          atk.buckets[(slot + 2) % RING].push(cell);
          atk.pending++;
          continue;
        }
        const cost = this.cost(cell, atk.target);
        if (atk.troops < cost) {
          exhausted = true;
          break;
        }
        atk.troops -= cost;
        atk.idle = 0;
        this.take(cell, atk.attacker, atk.target);
        this.eachNeighbor(cell, (n) => {
          if (this.isTarget(n, atk.target)) this.enqueue(atk, n);
        });
      }
    }
    if (!exhausted && atk.pending > 0) return false;
    att.troops += atk.troops; // survivors return home
    return true;
  }

  /**
   * Tidies the front after a tick of fighting: a pocket of one or two cells that is enclosed by a
   * single other faction falls to it at once - if the two are fighting, or if the pocket is free land.
   * This is what keeps front lines in one piece instead of dissolving into a checkerboard.
   */
  private smooth(): void {
    if (this.flipped.length === 0) return;
    const flipped = this.flipped;
    this.flipped = [];
    const { owner, terrain, width: w, height: h } = this;
    const seen = new Set<number>();
    for (const c of flipped) {
      const x = c % w;
      const y = (c - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (x + dx < 0 || x + dx >= w || y + dy < 0 || y + dy >= h) continue;
          const q = c + dy * w + dx;
          if (seen.has(q) || !isLand(terrain[q])) continue;
          seen.add(q);
          const o = owner[q];
          // The pocket: this cell, and at most one more of the same owner next to it.
          let mate = -1;
          let mates = 0;
          this.eachNeighbor(q, (n) => {
            if (owner[n] === o && isLand(terrain[n])) {
              mates++;
              mate = n;
            }
          });
          if (mates > 1) continue;
          let open = false;
          let around = -1;
          const look = (cell: number, other: number) =>
            this.eachNeighbor(cell, (n) => {
              if (n === other || !isLand(terrain[n])) return;
              if (owner[n] === o) open = true;
              else if (around < 0) around = owner[n];
              else if (around !== owner[n]) open = true;
            });
          look(q, mate);
          if (mate >= 0) look(mate, q);
          const by: number = around;
          if (open || by <= NEUTRAL) continue;
          if (o !== NEUTRAL && !this.attacks.some((a) => (a.attacker === by && a.target === o) || (a.attacker === o && a.target === by))) continue;
          this.setOwner(q, by);
          if (mate >= 0) this.setOwner(mate, by);
          this.buryIfGone(o);
        }
      }
    }
  }

  /** Recomputes who borders whom. */
  private refreshNeighbors(): void {
    // ponytail: full grid scan once per second; maintain borders incrementally if grids grow past ~2M cells.
    const { owner, terrain, width: w, height: h, factions } = this;
    for (const f of factions) {
      f.neighbors = [];
      f.bordersNeutral = false;
    }
    const seen = new Set<number>();
    const pair = (c1: number, c2: number) => {
      const a = owner[c1];
      const b = owner[c2];
      if (a === b) return;
      if (a && b) {
        const key = a < b ? a * 65536 + b : b * 65536 + a;
        if (!seen.has(key)) {
          seen.add(key);
          factions[a].neighbors.push(b);
          factions[b].neighbors.push(a);
        }
      } else if (a) {
        if (isLand(terrain[c2])) factions[a].bordersNeutral = true;
      } else if (isLand(terrain[c1])) {
        factions[b].bordersNeutral = true;
      }
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = y * w + x;
        if (x < w - 1) pair(c, c + 1);
        if (y < h - 1) pair(c, c + w);
      }
    }
  }
}
