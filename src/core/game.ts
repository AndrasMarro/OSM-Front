import { decide } from './ai';
import { refreshEconomy, type Building } from './buildings';
import { Diplomacy, TRAITOR_DEFENSE_PCT } from './diplomacy';
import { rulesOf, type Faction, type FactionSpec } from './faction';
import { mulberry32 } from './rng';
import { CAPACITY, CONQUER_DELAY, DEFENSE_PCT, Terrain } from './terrain';
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
/** A tribe that pays tribute to a nation defends this much better. */
const PROTECTED_DEFENSE_PCT = 115;
/** Events older than this many ticks are dropped. */
const EVENT_TICKS = 40;

/** Something worth showing: explosions, interceptions, landings. No effect on the simulation. */
export interface GameEvent {
  type: 'explosion' | 'nuke' | 'intercept' | 'landing' | 'repelled' | 'hit' | 'sunk';
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
}

export interface GameOptions {
  seed: number;
  /** Per-terrain multiplier on conquest delay and cost, indexed by terrain id. */
  terrainWeights?: ArrayLike<number | undefined>;
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
    this.delay = CONQUER_DELAY.map((d, t) =>
      d === 0 ? 0 : Math.min(MAX_TERRAIN_DELAY, Math.max(1, Math.round(d * (options.terrainWeights?.[t] ?? 1)))),
    );
    let land = 0;
    for (let i = 0; i < terrain.length; i++) if (terrain[i] !== Terrain.WATER) land++;
    this.landCells = land;
    this.factions.push(this.blankFaction(0, { name: '', type: 'AI_TRIBE' }, 0));
    this.factions[0].alive = false;
  }

  isFreeLand(cell: number): boolean {
    return this.owner[cell] === NEUTRAL && this.terrain[cell] !== Terrain.WATER;
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
      atk = { attacker: attackerId, target: targetId, troops: 0, buckets: Array.from({ length: RING }, () => []), pending: 0 };
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
    if (!att.alive || this.terrain[cell] === Terrain.WATER) return false;
    if (target === attackerId) {
      att.troops += troops; // the shore is ours by now: reinforcements
      return true;
    }
    const cost = this.cost(cell, target);
    if (troops < cost) return false;
    this.diplo.hostile(this, attackerId, target);
    this.take(cell, attackerId, target);
    let atk = this.attacks.find((a) => a.attacker === attackerId && a.target === target);
    if (!atk) {
      atk = { attacker: attackerId, target, troops: 0, buckets: Array.from({ length: RING }, () => []), pending: 0 };
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
    if (this.events.length > 0 && this.events[0].tick + EVENT_TICKS < this.tick) this.events = this.events.filter((e) => e.tick + EVENT_TICKS >= this.tick);

    for (let i = 1; i < this.factions.length; i++) {
      const f = this.factions[i];
      if (!f.alive) continue;
      f.gold += f.income;
      const max = this.maxTroops(f);
      // Logistic growth, fastest at half capacity, plus a base rate so a drained empire recovers.
      if (f.troops < max) f.troops += ((max / 50 + (f.troops * (max - f.troops)) / max) * rulesOf(f).growth * (100 + f.growthPct)) / 100000;
      // Each AI thinks every two seconds, staggered by id.
      if (f.type !== 'HUMAN_NATION' && (this.tick + f.id * 3) % (2 * TICKS_PER_SECOND) === 0) decide(this, f);
    }

    let finished = false;
    for (const atk of this.attacks) {
      if (this.advance(atk)) {
        atk.pending = -1;
        finished = true;
      }
    }
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
      alive: true,
      aggression: spec.type === 'AI_NATION' ? 40 + Math.floor(this.rng() * 50) : 5,
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
  }

  private isTarget(cell: number, target: number): boolean {
    return this.owner[cell] === target && this.terrain[cell] !== Terrain.WATER;
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
    if (atk.target === NEUTRAL) d = (d + 1) >> 1;
    else {
      const def = this.factions[atk.target];
      const att = this.factions[atk.attacker];
      const attDensity = (att.troops + atk.troops) / att.cells;
      d += attDensity > 0 ? Math.min(8, Math.floor((2 * def.troops) / def.cells / attDensity)) : 8;
      if (this.fortOwner[cell] === atk.target) d += this.fortSlow[cell];
    }
    if (this.fallout[cell] > this.tick) d += FALLOUT_DELAY;
    atk.buckets[(this.tick + d) % RING].push(cell);
    atk.pending++;
  }

  /** Troops the attacker pays for one cell: terrain plus the defenders standing on it. */
  cost(cell: number, target: number): number {
    const t = this.terrain[cell];
    let cost = this.delay[t] * 2;
    if (this.fallout[cell] > this.tick) cost *= 3;
    if (target !== NEUTRAL) {
      const def = this.factions[target];
      let pct = DEFENSE_PCT[t] + (def.elite && t === def.homeTerrain ? 50 : 0);
      if (this.fortOwner[cell] === target) pct += this.fortPct[cell];
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
    this.buryIfGone(target);
  }

  /** Conquers this tick's cells of one attack. Returns true when the attack is over. */
  private advance(atk: Attack): boolean {
    const att = this.factions[atk.attacker];
    if (!att.alive) return true; // its troops are lost with it
    const slot = this.tick % RING;
    const bucket = atk.buckets[slot];
    let exhausted = false;
    if (bucket.length > 0) {
      atk.buckets[slot] = [];
      atk.pending -= bucket.length;
      for (const cell of bucket) {
        // Stale entries: the cell changed hands, or we lost the cells next to it.
        if (!this.isTarget(cell, atk.target) || !this.touches(cell, atk.attacker)) continue;
        const cost = this.cost(cell, atk.target);
        if (atk.troops < cost) {
          exhausted = true;
          break;
        }
        atk.troops -= cost;
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
        if (terrain[c2] !== Terrain.WATER) factions[a].bordersNeutral = true;
      } else if (terrain[c1] !== Terrain.WATER) {
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
