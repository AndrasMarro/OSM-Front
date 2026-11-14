import { describe, expect, it } from 'vitest';
import { DEFAULT_NATION } from '../core/nation';
import type { PlayerCommand } from '../net/lockstep';
import { Tutorial, TUTORIAL_STEPS } from './tutorial';

const spawn: PlayerCommand = { type: 'spawn', cell: 5, nation: DEFAULT_NATION };
const attack = (target: number): PlayerCommand => ({ type: 'attack', target, percent: 40 });
const build = (def: string): PlayerCommand => ({ type: 'build', def, cell: 5 });
const propose = (treaty: 'NonAggressionPact' | 'Alliance' | 'TradeAgreement'): PlayerCommand => ({ type: 'propose', to: 2, treaty });

describe('tutorial state machine', () => {
  it('has six steps and starts at the first', () => {
    const t = new Tutorial();
    expect(TUTORIAL_STEPS).toHaveLength(6);
    expect(t.step.id).toBe('spawn');
    expect(t.finished).toBe(false);
  });

  it('walks through all steps when each action is carried out', () => {
    const t = new Tutorial();
    const path: [PlayerCommand, string][] = [
      [spawn, 'attack'],
      [attack(3), 'economy'],
      [build('Factory'), 'diplomacy'],
      [propose('TradeAgreement'), 'defence'],
      [build('Port'), 'done'],
    ];
    for (const [cmd, next] of path) {
      expect(t.observe(cmd, 'ok')).toBe(true);
      expect(t.step.id).toBe(next);
    }
    expect(t.finished).toBe(true);
    expect(t.observe(build('City'), 'ok')).toBe(false);
    expect(t.index).toBe(5);
  });

  it('only moves on when the action succeeded', () => {
    const t = new Tutorial();
    expect(t.observe(spawn, 'target')).toBe(false);
    expect(t.step.id).toBe('spawn');
    t.observe(spawn, 'ok');
    expect(t.observe(attack(3), 'refused')).toBe(false);
    t.observe(attack(3), 'ok');
    expect(t.observe(build('City'), 'gold')).toBe(false);
    expect(t.step.id).toBe('economy');
  });

  it('ignores actions that belong to another step', () => {
    const t = new Tutorial();
    expect(t.observe(build('City'), 'ok')).toBe(false); // nothing before the nation exists
    t.observe(spawn, 'ok');
    expect(t.observe(attack(0), 'ok')).toBe(false); // free land is not the neighbouring tribe
    expect(t.observe(build('City'), 'ok')).toBe(false);
    t.observe(attack(7), 'ok');
    expect(t.observe(build('Bunker'), 'ok')).toBe(false); // economy first
    t.observe(build('City'), 'ok');
    expect(t.observe(propose('Alliance'), 'ok')).toBe(false); // the step asks for trade or a pact
    expect(t.step.id).toBe('diplomacy');
  });

  it('counts an offer that is waiting for another player as made', () => {
    const t = new Tutorial();
    t.index = 3;
    expect(t.observe(propose('NonAggressionPact'), 'refused')).toBe(false);
    expect(t.observe(propose('NonAggressionPact'), 'pending')).toBe(true);
    expect(t.step.id).toBe('defence');
  });
});
