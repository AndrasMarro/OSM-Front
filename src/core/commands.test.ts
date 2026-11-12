import { describe, expect, it } from 'vitest';
import { execute, type Command } from './commands';
import { NEUTRAL } from './game';
import { Terrain } from './terrain';
import { at, human, world } from './testkit';

function setup() {
  const g = world(80, 30, (x) => (x >= 60 ? Terrain.WATER : Terrain.PLAINS));
  const a = human(g, 10, 15, 'A');
  const b = human(g, 21, 15, 'B');
  const tribe = g.addFaction({ name: 'Stamm', type: 'AI_TRIBE' }, at(g, 45, 15))!;
  return { g, a, b, tribe };
}

describe('commands', () => {
  it('carry every kind of order into the game', () => {
    const { g, a, b, tribe } = setup();
    expect(execute(g, a.id, { type: 'attack', target: NEUTRAL, percent: 50 })).toBe('ok');
    expect(a.troops).toBe(1000);
    expect(execute(g, a.id, { type: 'attack', target: tribe.id, percent: 50 })).toBe('target'); // no shared border

    expect(execute(g, a.id, { type: 'build', def: 'City', cell: at(g, 10, 15) })).toBe('ok');
    expect(execute(g, a.id, { type: 'build', def: 'City', cell: at(g, 21, 15) })).toBe('place');
    expect(execute(g, a.id, { type: 'launch', unit: 'Bomber', cell: at(g, 21, 15), percent: 0 })).toBe('base');
    expect(execute(g, a.id, { type: 'build', def: 'Airfield', cell: at(g, 13, 15) })).toBe('ok');
    expect(execute(g, a.id, { type: 'launch', unit: 'Bomber', cell: at(g, 21, 15), percent: 0 })).toBe('ok');
    expect(g.units.length).toBe(1);

    // An AI answers at once, a player gets an offer to accept.
    expect(execute(g, a.id, { type: 'propose', to: tribe.id, treaty: 'TradeAgreement' })).toBe('ok');
    expect(execute(g, a.id, { type: 'propose', to: tribe.id, treaty: 'Alliance' })).toBe('refused');
    expect(execute(g, a.id, { type: 'propose', to: b.id, treaty: 'NonAggressionPact' })).toBe('pending');
    expect(execute(g, a.id, { type: 'accept', from: b.id, treaty: 'NonAggressionPact' })).toBe('refused'); // not theirs to accept
    expect(execute(g, b.id, { type: 'accept', from: a.id, treaty: 'NonAggressionPact' })).toBe('ok');
    expect(g.diplo.status(g, a.id, b.id)).toBe('NonAggressionPact');

    const gold = tribe.gold;
    expect(execute(g, a.id, { type: 'aid', to: tribe.id, gold: 100, troopsPct: 0 })).toBe('ok');
    expect(tribe.gold).toBe(gold + 100);
    const troops = a.troops;
    expect(execute(g, a.id, { type: 'aid', to: tribe.id, gold: 0, troopsPct: 50 })).toBe('ok');
    expect(a.troops).toBe(troops / 2);
    a.gold = 0;
    expect(execute(g, a.id, { type: 'aid', to: tribe.id, gold: 100, troopsPct: 0 })).toBe('gold');

    expect(execute(g, a.id, { type: 'embargo', to: tribe.id, on: true })).toBe('ok');
    expect(g.diplo.trading(a.id, tribe.id)).toBe(false);
  });

  it('refuse anything malformed without throwing or changing the game', () => {
    const { g, a } = setup();
    const before = g.hash();
    const junk: unknown[] = [
      null,
      42,
      'attack',
      {},
      { type: 'nonsense' },
      { type: 'attack', target: 'x', percent: 50 },
      { type: 'attack', target: 9999, percent: 50 },
      { type: 'attack', target: 0, percent: 1e9 },
      { type: 'attack', target: 0, percent: NaN },
      { type: 'build', def: 7, cell: 3 },
      { type: 'build', def: 'City', cell: -1 },
      { type: 'build', def: 'City', cell: 1.5 },
      { type: 'build', def: 'City', cell: 1e12 },
      { type: 'launch', unit: 'Nuke', cell: 'here', percent: 10 },
      { type: 'launch', unit: {}, cell: 3, percent: 10 },
      { type: 'propose', to: a.id + 50, treaty: 'Alliance' },
      { type: 'propose', to: 2, treaty: 'Marriage' },
      { type: 'accept', from: null, treaty: 'Alliance' },
      { type: 'aid', to: 2, gold: -100, troopsPct: 0 },
      { type: 'aid', to: 2, gold: 0, troopsPct: 500 },
      { type: 'embargo', to: a.id, on: true },
      { type: 'embargo', to: 0, on: true },
    ];
    for (const cmd of junk) expect(execute(g, a.id, cmd as Command), JSON.stringify(cmd)).toBe('refused');
    expect(execute(g, 0, { type: 'attack', target: a.id, percent: 50 })).toBe('refused'); // nobody
    expect(execute(g, 99, { type: 'attack', target: a.id, percent: 50 })).toBe('refused');
    expect(g.hash()).toBe(before);
  });
});
