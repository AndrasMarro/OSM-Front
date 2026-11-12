import { execute, type Command, type CommandResult } from '../core/commands';
import type { Faction } from '../core/faction';
import type { Game } from '../core/game';
import type { Transport } from './transport';

export type PlayerCommand = Command | { type: 'spawn'; cell: number; name: string };

/**
 * One step of the shared timeline, decided by the host: the commands to
 * execute, in order, and then how many ticks to simulate.
 */
interface Turn {
  /** Sequence number; a gap means messages were lost. */
  n: number;
  steps: number;
  cmds: [peer: string, cmd: PlayerCommand][];
  /** The host's state hash before this turn, sent now and then to catch a desync. */
  hash?: number;
}

/** The host adds its state hash to the turn that starts at every such tick. */
const HASH_EVERY = 50;
/** Commands the host takes from one peer per turn; more than that is a flood. */
const MAX_COMMANDS = 50;
const MAX_NAME = 20;

/**
 * Host-tick lockstep. Every peer runs the same deterministic game. Players
 * send their commands to the host; the host alone decides in which turn they
 * happen and broadcasts the turns; everybody executes them in the same order.
 * A game without a network is the same thing with a host and no peers.
 */
export class Lockstep {
  readonly game: Game;
  readonly host: boolean;
  readonly selfId: string;
  /** Which faction each peer plays, filled by their spawn commands. */
  readonly players = new Map<string, number>();
  /** Called with the outcome of each of the local player's own commands, in the order they were issued. */
  onResult: (cmd: PlayerCommand, result: CommandResult) => void = () => {};
  /** True once this peer's game no longer matches the host's. */
  desynced = false;
  private readonly net: Transport | null;
  private readonly hostId: string;
  private queue: [string, PlayerCommand][] = [];
  private inbox: Turn[] = [];
  private next = 0;

  constructor(game: Game, net: Transport | null = null, hostId = net?.selfId ?? 'local') {
    this.game = game;
    this.net = net;
    this.selfId = net?.selfId ?? 'local';
    this.hostId = hostId;
    this.host = hostId === this.selfId;
    if (this.host) {
      net?.on('cmd', (cmd, from) => {
        if (this.queue.filter(([peer]) => peer === from).length < MAX_COMMANDS) this.queue.push([from, cmd]);
      });
    } else {
      net!.on('turn', (turn, from) => {
        if (from === hostId) this.inbox.push(turn);
      });
    }
  }

  /** The local player's faction, once spawned. */
  get me(): Faction | null {
    const id = this.players.get(this.selfId);
    return id === undefined ? null : this.game.factions[id];
  }

  /** Orders something for the local player. It takes effect in one of the next turns. */
  issue(cmd: PlayerCommand): void {
    if (this.host) this.queue.push([this.selfId, cmd]);
    else void this.net!.send('cmd', cmd, this.hostId);
  }

  /**
   * Host: closes a turn - all commands received so far, then `steps` ticks - and sends it to everyone.
   * Returns false if there was nothing to do.
   */
  turn(steps: number): boolean {
    if (!this.host || (steps === 0 && this.queue.length === 0)) return false;
    const turn: Turn = { n: this.next, steps, cmds: this.queue };
    if (steps > 0 && this.game.tick % HASH_EVERY === 0) turn.hash = this.game.hash();
    this.queue = [];
    void this.net?.send('turn', turn);
    this.apply(turn);
    return true;
  }

  /** Client: plays every turn that has arrived. Returns whether the game moved. */
  pump(): boolean {
    if (this.inbox.length === 0 || this.desynced) return false;
    const turns = this.inbox;
    this.inbox = [];
    for (const turn of turns) if (!this.desynced) this.apply(turn);
    return true;
  }

  private apply(turn: Turn): void {
    const valid = turn && turn.n === this.next && Number.isInteger(turn.steps) && turn.steps >= 0 && turn.steps <= 10 && Array.isArray(turn.cmds);
    if (!valid || (turn.hash !== undefined && turn.hash !== this.game.hash())) {
      this.desynced = true;
      return;
    }
    this.next++;
    for (const entry of turn.cmds) {
      if (!Array.isArray(entry)) continue;
      const [peer, cmd] = entry;
      const result = this.execute(peer, cmd);
      if (peer === this.selfId) this.onResult(cmd, result);
    }
    for (let i = 0; i < turn.steps; i++) this.game.step();
  }

  private execute(peer: string, cmd: PlayerCommand): CommandResult {
    if (typeof cmd !== 'object' || cmd === null) return 'refused';
    const id = this.players.get(peer);
    if (cmd.type !== 'spawn') return id === undefined ? 'refused' : execute(this.game, id, cmd);
    if (id !== undefined || !Number.isInteger(cmd.cell) || cmd.cell < 0 || cmd.cell >= this.game.owner.length) return 'refused';
    const name = (typeof cmd.name === 'string' ? cmd.name.trim().slice(0, MAX_NAME) : '') || 'Spieler';
    const f = this.game.addFaction({ name, type: 'HUMAN_NATION' }, cmd.cell, 2);
    if (!f) return 'target';
    this.players.set(peer, f.id);
    return 'ok';
  }
}
