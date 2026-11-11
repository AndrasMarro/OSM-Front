import type { Game } from './game';

export type DiplomaticStatus = 'War' | 'Neutral' | 'NonAggressionPact' | 'Alliance';
export type Treaty = 'NonAggressionPact' | 'Alliance' | 'TradeAgreement';

/** A non-aggression pact runs out after two minutes. */
export const PACT_TICKS = 1200;
/** Two factions count as at war until a minute after the last hostile act. */
export const WAR_TICKS = 600;
/** Breaking an alliance weakens the traitor's defence to this percentage for a minute. */
export const TRAITOR_TICKS = 600;
export const TRAITOR_DEFENSE_PCT = 70;
/** Gold per tick each side earns from a trade agreement; a tribe pays a nation 1.5 times that as tribute. */
export const TRADE_INCOME = 0.2;

const key = (a: number, b: number) => (a < b ? a * 65536 + b : b * 65536 + a);
const clamp = (v: number) => Math.max(-100, Math.min(100, v));

/**
 * Relations and treaties between all factions. Every pair is one map entry,
 * and maps iterate in insertion order, so the same commands replay identically.
 */
export class Diplomacy {
  private readonly relations = new Map<number, number>();
  /** Expiry ticks. */
  private readonly pacts = new Map<number, number>();
  private readonly wars = new Map<number, number>();
  private readonly alliances = new Set<number>();
  private readonly trades = new Set<number>();
  private readonly embargoes = new Set<number>();

  /** -100 (hatred) to +100 (devotion); strangers start at 0. */
  relation(a: number, b: number): number {
    return this.relations.get(key(a, b)) ?? 0;
  }

  adjust(a: number, b: number, delta: number): void {
    if (a !== b && a && b) this.relations.set(key(a, b), clamp(this.relation(a, b) + delta));
  }

  status(g: Game, a: number, b: number): DiplomaticStatus {
    const k = key(a, b);
    if (this.alliances.has(k)) return 'Alliance';
    if ((this.wars.get(k) ?? 0) > g.tick) return 'War';
    return (this.pacts.get(k) ?? 0) > g.tick ? 'NonAggressionPact' : 'Neutral';
  }

  allied(a: number, b: number): boolean {
    return this.alliances.has(key(a, b));
  }

  trading(a: number, b: number): boolean {
    return this.trades.has(key(a, b));
  }

  embargoed(a: number, b: number): boolean {
    return this.embargoes.has(key(a, b));
  }

  /** Ticks left on the pact between two factions (0 = none). */
  pactLeft(g: Game, a: number, b: number): number {
    return Math.max(0, (this.pacts.get(key(a, b)) ?? 0) - g.tick);
  }

  allies(id: number): number[] {
    return others(this.alliances, id);
  }

  tradePartners(id: number): number[] {
    return others(this.trades, id);
  }

  /** Factions currently at war with `id`. */
  enemies(g: Game, id: number): number[] {
    const out: number[] = [];
    for (const [k, until] of this.wars) if (until > g.tick) pushOther(out, k, id);
    return out;
  }

  pactPartners(g: Game, id: number): number[] {
    const out: number[] = [];
    for (const [k, until] of this.pacts) if (until > g.tick) pushOther(out, k, id);
    return out;
  }

  /** All trade agreements as [a, b] pairs. */
  tradePairs(): [number, number][] {
    return [...this.trades].map((k) => [Math.floor(k / 65536), k % 65536]);
  }

  /**
   * How the AI of `to` judges an offer from `from`: the offer is accepted at
   * 0 or more. Deterministic: relation, relative strength and common enemies
   * against a threshold that depends on the treaty and the AI's temper.
   */
  acceptance(g: Game, from: number, to: number, treaty: Treaty): number {
    const a = g.factions[from];
    const b = g.factions[to];
    let score = this.relation(from, to);
    // A strong partner is worth having; a far weaker one is prey, not a partner.
    if (a.troops > b.troops * 1.5) score += 15;
    else if (a.troops * 2 < b.troops) score -= 15;
    const theirs = this.enemies(g, to);
    score += Math.min(40, 20 * this.enemies(g, from).filter((e) => theirs.includes(e)).length);
    if (a.traitorUntil > g.tick) score -= 40;
    if (this.status(g, from, to) === 'War') score -= 30;

    let threshold = treaty === 'Alliance' ? 50 : treaty === 'NonAggressionPact' ? 10 : 0;
    if (b.elite) threshold += 10; // proud
    if (treaty !== 'TradeAgreement') threshold += (b.aggression - 50) / 5;
    return score - threshold;
  }

  /**
   * `from` offers `to` a treaty. Returns whether it was accepted and is now in force.
   * A pact or alliance ends a war between the two and calls their attacks off.
   */
  propose(g: Game, from: number, to: number, treaty: Treaty): boolean {
    const k = key(from, to);
    if (from === to || !g.factions[from]?.alive || !g.factions[to]?.alive) return false;
    if (treaty === 'TradeAgreement' && this.embargoes.has(k)) return false;
    if (this.acceptance(g, from, to, treaty) < 0) return false;
    if (treaty === 'TradeAgreement') {
      this.trades.add(k);
      return true;
    }
    if (treaty === 'Alliance') this.alliances.add(k);
    else this.pacts.set(k, g.tick + PACT_TICKS);
    this.wars.delete(k);
    g.callOff(from, to);
    this.adjust(from, to, 10);
    return true;
  }

  /** Gift of gold or troops. Buys goodwill: up to +15 per gift. */
  sendAid(g: Game, from: number, to: number, kind: 'gold' | 'troops', amount: number): boolean {
    const a = g.factions[from];
    const b = g.factions[to];
    if (from === to || !a?.alive || !b?.alive) return false;
    const sent = Math.floor(Math.min(amount, a[kind]));
    if (sent < 1) return false;
    a[kind] -= sent;
    b[kind] += sent;
    this.adjust(from, to, Math.min(15, Math.floor(sent / (kind === 'gold' ? 20 : 100))));
    return true;
  }

  /** Imposes or lifts an embargo. Imposing it ends the trade agreement and sours the relation. */
  setEmbargo(from: number, to: number, on: boolean): void {
    const k = key(from, to);
    if (on && !this.embargoes.has(k)) {
      this.embargoes.add(k);
      this.trades.delete(k);
      this.adjust(from, to, -20);
    } else if (!on) this.embargoes.delete(k);
  }

  /**
   * Registers a hostile act of `a` against `b` (attack, landing, strike).
   * Breaks treaties between them - an alliance at the price of the traitor
   * malus - and pulls b's allies and protectors in.
   */
  hostile(g: Game, a: number, b: number): void {
    if (!a || !b || a === b) return;
    const k = key(a, b);
    const everyone = (delta: number) => {
      for (const f of g.factions) if (f.alive) this.adjust(a, f.id, delta);
    };
    if (this.alliances.delete(k)) {
      g.factions[a].traitorUntil = g.tick + TRAITOR_TICKS;
      everyone(-25);
      this.adjust(a, b, -100);
    } else if ((this.pacts.get(k) ?? 0) > g.tick) {
      this.pacts.delete(k);
      everyone(-10);
      this.adjust(a, b, -30);
    }
    if ((this.wars.get(k) ?? 0) <= g.tick) {
      this.adjust(a, b, -30);
      this.trades.delete(k);
      for (const ally of this.allies(b)) {
        if (ally === a || this.allied(ally, a)) continue;
        this.adjust(ally, a, -20);
        this.wars.set(key(ally, a), g.tick + WAR_TICKS);
        g.factions[ally].enemy = a;
      }
      // A nation that trades with a tribe protects it.
      if (g.factions[b].type === 'AI_TRIBE') for (const p of this.tradePartners(b)) if (p !== a) this.adjust(p, a, -15);
    }
    this.wars.set(k, g.tick + WAR_TICKS);
    g.factions[a].enemy = b;
    g.factions[b].enemy = a;
  }

  /** Slow relation changes, run every ten seconds: loyalty, trade, shared enemies, lasting wars. */
  drift(g: Game): void {
    for (const atk of g.attacks) if (atk.target) this.wars.set(key(atk.attacker, atk.target), g.tick + WAR_TICKS);
    const dead = (k: number) => !g.factions[Math.floor(k / 65536)].alive || !g.factions[k % 65536].alive;
    const bump = (k: number, delta: number) => this.relations.set(k, clamp((this.relations.get(k) ?? 0) + delta));

    const atWar = new Map<number, number[]>();
    for (const [k, until] of this.wars) {
      if (until <= g.tick || dead(k)) {
        this.wars.delete(k);
        continue;
      }
      bump(k, -2);
      for (const [me, foe] of [
        [Math.floor(k / 65536), k % 65536],
        [k % 65536, Math.floor(k / 65536)],
      ]) {
        const list = atWar.get(me);
        if (list) list.push(foe);
        else atWar.set(me, [foe]);
      }
    }
    for (const [k, until] of this.pacts) if (until <= g.tick || dead(k)) this.pacts.delete(k);
    for (const k of this.alliances) dead(k) ? this.alliances.delete(k) : bump(k, 2);
    for (const k of this.trades) dead(k) ? this.trades.delete(k) : bump(k, 1);
    // The enemy of my enemy.
    for (const foes of atWar.values()) {
      for (let i = 0; i < foes.length; i++) for (let j = i + 1; j < foes.length; j++) this.adjust(foes[i], foes[j], 3);
    }
  }
}

function pushOther(out: number[], k: number, id: number): void {
  const hi = Math.floor(k / 65536);
  const lo = k % 65536;
  if (hi === id) out.push(lo);
  else if (lo === id) out.push(hi);
}

function others(set: Set<number>, id: number): number[] {
  const out: number[] = [];
  for (const k of set) pushOther(out, k, id);
  return out;
}
