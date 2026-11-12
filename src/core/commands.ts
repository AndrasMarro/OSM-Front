import { build, type OrderResult } from './buildings';
import type { Treaty } from './diplomacy';
import type { Game } from './game';
import { launch } from './units';

/**
 * Everything a player can order, as plain JSON. In multiplayer these travel
 * over the network and are executed by every peer at the same tick, so
 * `execute` is the only door through which players change the game.
 */
export type Command =
  | { type: 'attack'; target: number; percent: number }
  | { type: 'build'; def: string; cell: number }
  | { type: 'launch'; unit: string; cell: number; percent: number }
  | { type: 'propose'; to: number; treaty: Treaty }
  | { type: 'accept'; from: number; treaty: Treaty }
  | { type: 'aid'; to: number; gold: number; troopsPct: number }
  | { type: 'embargo'; to: number; on: boolean };

/** `pending`: the offer went to a player, who has yet to answer. `refused`: declined, or not a valid order. */
export type CommandResult = OrderResult | 'pending' | 'refused';

const TREATIES: readonly unknown[] = ['NonAggressionPact', 'Alliance', 'TradeAgreement'];
const int = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/**
 * Executes one command for a faction. Commands arrive from other machines:
 * anything malformed is refused, never thrown on, so all peers stay in step.
 */
export function execute(g: Game, factionId: number, cmd: Command): CommandResult {
  if (!g.factions[factionId]?.alive || typeof cmd !== 'object' || cmd === null) return 'refused';
  const lastCell = g.owner.length - 1;
  const lastFaction = g.factions.length - 1;
  const d = g.diplo;
  switch (cmd.type) {
    case 'attack':
      if (!int(cmd.target, 0, lastFaction) || !int(cmd.percent, 1, 100)) return 'refused';
      return g.attack(factionId, cmd.target, cmd.percent) ? 'ok' : 'target';
    case 'build':
      if (typeof cmd.def !== 'string' || !int(cmd.cell, 0, lastCell)) return 'refused';
      return build(g, factionId, cmd.def, cmd.cell);
    case 'launch':
      if (typeof cmd.unit !== 'string' || !int(cmd.cell, 0, lastCell) || !int(cmd.percent, 0, 100)) return 'refused';
      return launch(g, factionId, cmd.unit, cmd.cell, cmd.percent);
    case 'propose':
      if (!int(cmd.to, 1, lastFaction) || !TREATIES.includes(cmd.treaty)) return 'refused';
      if (d.propose(g, factionId, cmd.to, cmd.treaty)) return 'ok';
      return d.offered(g, factionId, cmd.to, cmd.treaty) ? 'pending' : 'refused';
    case 'accept':
      if (!int(cmd.from, 1, lastFaction) || !TREATIES.includes(cmd.treaty)) return 'refused';
      return d.accept(g, factionId, cmd.from, cmd.treaty) ? 'ok' : 'refused';
    case 'aid': {
      if (!int(cmd.to, 1, lastFaction) || !int(cmd.gold, 0, 1e9) || !int(cmd.troopsPct, 0, 100)) return 'refused';
      const gold = cmd.gold > 0 && d.sendAid(g, factionId, cmd.to, 'gold', cmd.gold);
      const troops = cmd.troopsPct > 0 && d.sendAid(g, factionId, cmd.to, 'troops', (g.factions[factionId].troops * cmd.troopsPct) / 100);
      return gold || troops ? 'ok' : cmd.gold > 0 ? 'gold' : 'troops';
    }
    case 'embargo':
      if (!int(cmd.to, 1, lastFaction) || cmd.to === factionId) return 'refused';
      d.setEmbargo(factionId, cmd.to, cmd.on === true);
      return 'ok';
    default:
      return 'refused';
  }
}
