import type { CommandResult } from '../core/commands';
import { NEUTRAL } from '../core/game';
import type { PlayerCommand } from '../net/lockstep';

/** One step of the guided first game: what to tell the player, and which of their orders completes it. */
export interface TutorialStep {
  id: 'spawn' | 'attack' | 'economy' | 'diplomacy' | 'defence' | 'done';
  title: string;
  /** May contain `**bold**` and `` `key` `` marks. */
  text: string;
  /** Does this order, with this outcome, complete the step? The last step completes on nothing. */
  done: (cmd: PlayerCommand, ok: boolean) => boolean;
}

const builds = (cmd: PlayerCommand, ...ids: string[]) => cmd.type === 'build' && ids.includes(cmd.def);

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'spawn',
    title: 'Startgebiet wählen',
    text: 'Klicke mit **Links** auf ein Küstenfeld, um deine Nation zu gründen. Der pulsierende Kreis zeigt eine gute Stelle.',
    done: (cmd, ok) => ok && cmd.type === 'spawn',
  },
  {
    id: 'attack',
    title: 'Expandieren & Angreifen',
    text: 'Stelle unten deinen Angriffs-Regler auf 40 % (`Q`/`E`) und klicke mit **Links** auf den benachbarten Stamm, um ihn zu erobern. Ein Linksklick auf freies Land breitet dein Reich aus.',
    done: (cmd, ok) => ok && cmd.type === 'attack' && cmd.target !== NEUTRAL,
  },
  {
    id: 'economy',
    title: 'Wirtschaft aufbauen',
    text: 'Drücke `1` (Stadt) oder `2` (Fabrik) und platziere das Gebäude mit **Linksklick** im grünen Bereich deines Gebiets.',
    done: (cmd, ok) => ok && builds(cmd, 'City', 'Factory'),
  },
  {
    id: 'diplomacy',
    title: 'Spezial-Aktionen & Diplomatie',
    text: 'Mache einen **Rechtsklick** auf eine fremde Nation, um das Radialmenü zu öffnen, und schließe unter ✉ Diplomatie ein Handelsabkommen oder einen Nichtangriffspakt.',
    done: (cmd, ok) => ok && cmd.type === 'propose' && cmd.treaty !== 'Alliance',
  },
  {
    id: 'defence',
    title: 'Verteidigung & Militär',
    text: 'Drücke `3` für einen Bunker an deiner Grenze oder baue per **Rechtsklick** einen Hafen an der Küste.',
    done: (cmd, ok) => ok && builds(cmd, 'Bunker', 'Port'),
  },
  {
    id: 'done',
    title: 'Geschafft!',
    text: 'Du kennst jetzt Angriff, Wirtschaft, Diplomatie und Verteidigung. Mit `8` und `9` zielen Bomber und Raketen, `H` zeigt alle Tasten.',
    done: () => false,
  },
];

/**
 * The guided first game as a state machine: it watches the outcome of the
 * player's own orders and moves on only when the current step's action has
 * really been carried out. No DOM in here; the page shows `step` and feeds `observe`.
 */
export class Tutorial {
  index = 0;

  get step(): TutorialStep {
    return TUTORIAL_STEPS[this.index];
  }

  /** True on the closing step: nothing is left to do but to play on. */
  get finished(): boolean {
    return this.index === TUTORIAL_STEPS.length - 1;
  }

  /** Feeds one executed order. An offer that is on its way to another player counts as made. Returns whether the step changed. */
  observe(cmd: PlayerCommand, result: CommandResult): boolean {
    if (this.finished || !this.step.done(cmd, result === 'ok' || result === 'pending')) return false;
    this.index++;
    return true;
  }
}
