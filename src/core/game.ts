import { decide } from './ai';
import { rulesOf, type Faction, type FactionSpec } from './faction';
import { mulberry32 } from './rng';
import { CAPACITY, CONQUER_DELAY, DEFENSE_PCT, Terrain } from './terrain';

export const TICKS_PER_SECOND = 10;
/** Owner id of unowned cells. Also the "target" of an expansion into free land. */
export const NEUTRAL = 0;

/** Attack fronts are scheduled into a ring of per-tick buckets; delays must stay below this. */
const RING = 32;
const MAX_TERRAIN_DELAY = 12;

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
 * changes through `addFaction`, `attack` and `step`, and all randomness comes
 * from the seeded PRNG. Troop counts are fractional, but floating point use
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

  constructor(width: number, height: number, terrain: Uint8Array, options: GameOptions) {
    if (terrain.length !== width * height) throw new Error('terrain size does not match grid');
    this.width = width;
    this.height = height;
    this.terrain = terrain;
    this.owner = new Uint16Array(width * height);
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
    return rulesOf(f).baseCapacity + f.capacity;
  }

  /**
   * Spawns a faction on free land at or near `cell` (searching up to
   * `searchRadius` cells away). Returns null if there is no room.
   */
  addFaction(spec: FactionSpec, cell: number, searchRadius = 12): Faction | null {
    if (this.factions.length > 0xffff) return null;
    const centre = this.nearestFreeLand(cell, searchRadius);
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
    att.troops -= troops;
    atk.troops += troops;
    return true;
  }

  /** Advances the simulation by one tick (1 / TICKS_PER_SECOND seconds). */
  step(): void {
    if (this.tick % TICKS_PER_SECOND === 0) this.refreshNeighbors();

    for (let i = 1; i < this.factions.length; i++) {
      const f = this.factions[i];
      if (!f.alive) continue;
      const max = this.maxTroops(f);
      // Logistic growth, fastest at half capacity, plus a base rate so a drained empire recovers.
      if (f.troops < max) f.troops += ((max / 50 + (f.troops * (max - f.troops)) / max) * rulesOf(f).growth) / 1000;
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

  private nearestFreeLand(cell: number, radius: number): number {
    const { width: w, height: h } = this;
    const cx = cell % w;
    const cy = (cell - cx) / w;
    for (let r = 0; r <= radius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && y >= 0 && x < w && y < h && this.isFreeLand(y * w + x)) return y * w + x;
        }
      }
    }
    return -1;
  }

  private setOwner(cell: number, to: number): void {
    const from = this.owner[cell];
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
  private eachNeighbor(cell: number, fn: (n: number) => void): void {
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
    }
    atk.buckets[(this.tick + d) % RING].push(cell);
    atk.pending++;
  }

  /** Troops the attacker pays for one cell: terrain plus the defenders standing on it. */
  private cost(cell: number, target: number): number {
    const t = this.terrain[cell];
    let cost = this.delay[t] * 2;
    if (target !== NEUTRAL) {
      const def = this.factions[target];
      const pct = DEFENSE_PCT[t] + (def.elite && t === def.homeTerrain ? 50 : 0);
      cost += Math.ceil(((def.troops / def.cells) * pct) / 100);
    }
    return cost;
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
        if (atk.target !== NEUTRAL) {
          const def = this.factions[atk.target];
          def.troops -= Math.min(def.troops, Math.floor(def.troops / def.cells));
          def.lastAttacker = atk.attacker;
        }
        this.setOwner(cell, atk.attacker);
        if (atk.target !== NEUTRAL && this.factions[atk.target].cells === 0) {
          this.factions[atk.target].alive = false;
          this.factions[atk.target].troops = 0;
        }
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
