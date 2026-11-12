import { describe, expect, it } from 'vitest';
import { OFFER_TICKS, PACT_TICKS, TRADE_INCOME, TRAITOR_TICKS, type Treaty } from './diplomacy';
import { rulesOf } from './faction';
import { at, human, run, world } from './testkit';

/** Offer and acceptance in one go, for treaties between players. */
const agree = (g: ReturnType<typeof world>, from: number, to: number, treaty: Treaty) => {
  g.diplo.propose(g, from, to, treaty);
  return g.diplo.accept(g, to, from, treaty);
};

/** Three players in a row: A borders B, C stands apart. Players never act on their own. */
function trio() {
  const g = world(80, 30);
  const a = human(g, 10, 15, 'A');
  const b = human(g, 21, 15, 'B');
  const c = human(g, 60, 15, 'C');
  return { g, a, b, c, d: g.diplo };
}

describe('relations and treaties', () => {
  it('keeps relations within -100..100 and starts everyone as neutral strangers', () => {
    const { g, a, b, d } = trio();
    expect(d.relation(a.id, b.id)).toBe(0);
    expect(d.status(g, a.id, b.id)).toBe('Neutral');
    d.adjust(a.id, b.id, 500);
    expect(d.relation(b.id, a.id)).toBe(100);
    d.adjust(a.id, b.id, -500);
    expect(d.relation(a.id, b.id)).toBe(-100);
  });

  it('lets the AI weigh offers by relation, strength and common enemies', () => {
    const g = world(80, 30);
    const me = human(g, 10, 15);
    const tribe = g.addFaction({ name: 'Stamm', type: 'AI_TRIBE' }, at(g, 40, 15))!;
    const d = g.diplo;
    // Far stronger than the tribe: a pact is welcome, an alliance needs goodwill first.
    expect(d.propose(g, me.id, tribe.id, 'Alliance')).toBe(false);
    expect(d.propose(g, me.id, tribe.id, 'NonAggressionPact')).toBe(true);
    expect(d.status(g, me.id, tribe.id)).toBe('NonAggressionPact');
    expect(d.sendAid(g, me.id, tribe.id, 'gold', 300)).toBe(true);
    expect(d.sendAid(g, me.id, tribe.id, 'gold', 300)).toBe(true);
    expect(tribe.gold).toBe(600);
    expect(d.propose(g, me.id, tribe.id, 'Alliance')).toBe(true);
    expect(d.status(g, me.id, tribe.id)).toBe('Alliance');

    // A weakling is turned down where an equal is not, and a shared enemy tips the scales.
    const t = trio();
    const base = t.d.acceptance(t.g, t.a.id, t.b.id, 'Alliance');
    t.a.troops = 100;
    expect(t.d.acceptance(t.g, t.a.id, t.b.id, 'Alliance')).toBeLessThan(base);
    t.a.troops = t.b.troops;
    t.d.hostile(t.g, t.c.id, t.a.id);
    t.d.hostile(t.g, t.c.id, t.b.id);
    expect(t.d.acceptance(t.g, t.a.id, t.b.id, 'Alliance')).toBe(base + 20);
  });

  it('lets a non-aggression pact run out', () => {
    const { g, a, b, d } = trio();
    expect(agree(g, a.id, b.id, 'NonAggressionPact')).toBe(true);
    g.tick += PACT_TICKS - 1;
    expect(d.status(g, a.id, b.id)).toBe('NonAggressionPact');
    g.tick++;
    expect(d.status(g, a.id, b.id)).toBe('Neutral');
  });

  it('punishes attacking an ally with the traitor malus', () => {
    const { g, a, b, c, d } = trio();
    d.adjust(a.id, b.id, 100);
    expect(agree(g, a.id, b.id, 'Alliance')).toBe(true);
    expect(g.attack(a.id, b.id, 20)).toBe(true);

    expect(d.status(g, a.id, b.id)).toBe('War');
    expect(a.traitorUntil).toBe(g.tick + TRAITOR_TICKS);
    expect(d.relation(a.id, c.id)).toBe(-25); // everybody saw it
    expect(d.relation(a.id, b.id)).toBeLessThan(-50); // from devoted ally to enemy

    // 30 % weaker defence while the malus lasts.
    const cell = at(g, 10, 15);
    const weak = g.cost(cell, a.id);
    g.tick += TRAITOR_TICKS;
    const normal = g.cost(cell, a.id);
    expect(weak).toBeLessThan(normal);
    const density = a.troops / a.cells;
    expect(normal - weak).toBeCloseTo(density * 0.3, 0);
  });

  it('draws the allies of the victim into the war', () => {
    const { g, a, b, c, d } = trio();
    agree(g, b.id, c.id, 'Alliance');
    g.attack(a.id, b.id, 20);
    expect(d.status(g, c.id, a.id)).toBe('War');
    expect(d.relation(c.id, a.id)).toBe(-20);
    expect(c.enemy).toBe(a.id);
  });

  it('ends a war and calls the attacks off when the two make peace', () => {
    const { g, a, b, d } = trio();
    g.attack(a.id, b.id, 50);
    const sent = g.attacks[0].troops;
    const home = a.troops;
    expect(agree(g, a.id, b.id, 'NonAggressionPact')).toBe(true);
    expect(g.attacks.length).toBe(0);
    expect(a.troops).toBe(home + sent);
    expect(d.status(g, a.id, b.id)).toBe('NonAggressionPact');
  });
});

describe('offers to players', () => {
  it('wait for the player instead of being answered by the AI formula', () => {
    const { g, a, b, c, d } = trio();
    expect(d.propose(g, a.id, b.id, 'Alliance')).toBe(false);
    expect(d.status(g, a.id, b.id)).toBe('Neutral');
    expect(d.offersTo(g, b.id)).toEqual([{ from: a.id, to: b.id, treaty: 'Alliance', until: OFFER_TICKS }]);
    expect(d.accept(g, c.id, a.id, 'Alliance')).toBe(false); // not addressed to C
    expect(d.accept(g, b.id, a.id, 'NonAggressionPact')).toBe(false); // not what was offered
    expect(d.accept(g, b.id, a.id, 'Alliance')).toBe(true);
    expect(d.status(g, a.id, b.id)).toBe('Alliance');
    expect(d.accept(g, b.id, a.id, 'Alliance')).toBe(false); // used up
    expect(d.offersTo(g, b.id)).toEqual([]);
  });

  it('lapse after a while', () => {
    const { g, a, b, d } = trio();
    d.propose(g, a.id, b.id, 'TradeAgreement');
    d.propose(g, a.id, b.id, 'TradeAgreement'); // asking twice is still one offer
    expect(d.offersTo(g, b.id).length).toBe(1);
    g.tick += OFFER_TICKS;
    expect(d.offersTo(g, b.id)).toEqual([]);
    expect(d.accept(g, b.id, a.id, 'TradeAgreement')).toBe(false);
    expect(d.trading(a.id, b.id)).toBe(false);
  });

  it('reach players from AI nations too', () => {
    const g = world(80, 30);
    const me = human(g, 10, 15);
    const nation = g.addFaction({ name: 'Nation', type: 'AI_NATION' }, at(g, 40, 15))!;
    expect(g.diplo.propose(g, nation.id, me.id, 'NonAggressionPact')).toBe(false);
    expect(g.diplo.accept(g, me.id, nation.id, 'NonAggressionPact')).toBe(true);
    expect(g.diplo.status(g, me.id, nation.id)).toBe('NonAggressionPact');
  });
});

describe('trade and aid', () => {
  it('pays both sides of a trade agreement, with tribute from a protected tribe', () => {
    const g = world(80, 30);
    const me = human(g, 10, 15);
    const tribe = g.addFaction({ name: 'Stamm', type: 'AI_TRIBE' }, at(g, 40, 15))!;
    g.step();
    const before = [me.income, tribe.income];
    expect(before[0]).toBeCloseTo(rulesOf(me).income + me.cells * rulesOf(me).cellIncome);
    expect(g.diplo.propose(g, me.id, tribe.id, 'TradeAgreement')).toBe(true);
    run(g, 10);
    expect(me.income - before[0]).toBeCloseTo(TRADE_INCOME * 1.5);
    expect(tribe.income - before[1]).toBeCloseTo(TRADE_INCOME / 2);
    expect(tribe.protected).toBe(true);

    // Gold really arrives every tick.
    const gold = me.gold;
    run(g, 5);
    expect(me.gold - gold).toBeCloseTo(me.income * 5);
  });

  it('cuts trade with an embargo and refuses new agreements while it stands', () => {
    const { g, a, b, d } = trio();
    expect(agree(g, a.id, b.id, 'TradeAgreement')).toBe(true);
    d.setEmbargo(a.id, b.id, true);
    expect(d.trading(a.id, b.id)).toBe(false);
    expect(d.relation(a.id, b.id)).toBe(-20);
    expect(agree(g, a.id, b.id, 'TradeAgreement')).toBe(false);
    d.setEmbargo(a.id, b.id, false);
    expect(agree(g, a.id, b.id, 'TradeAgreement')).toBe(true);
  });

  it('hands over troops as aid and never more than the giver has', () => {
    const { g, a, b, d } = trio();
    const total = a.troops + b.troops;
    expect(d.sendAid(g, a.id, b.id, 'troops', 500)).toBe(true);
    expect(b.troops).toBe(2500);
    expect(d.relation(a.id, b.id)).toBe(5);
    expect(d.sendAid(g, a.id, b.id, 'troops', 1e9)).toBe(true);
    expect(a.troops).toBe(0);
    expect(a.troops + b.troops).toBe(total);
    expect(d.sendAid(g, a.id, b.id, 'troops', 10)).toBe(false);
  });
});
