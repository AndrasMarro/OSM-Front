import type { Map as MapLibreMap } from 'maplibre-gl';
import { NEUTRAL, RALLY_RADIUS, type Attack, type Game, type GameEvent } from '../core/game';
import type { GridProjection } from '../core/maps/projection';
import type { Unit } from '../core/units';
import { formatTroops } from './labels';
import { factionColor } from './territory';

/** Game ticks an explosion or interception stays visible. */
const EFFECT_TICKS = 12;

/** Outlines of the unit markers, pointing right: ship, aircraft, missile. */
const SHAPES: Record<Unit['def']['domain'], number[]> = {
  sea: [-8, -4, 4, -4, 9, 0, 4, 4, -8, 4],
  air: [9, 0, -6, -7, -2, 0, -6, 7],
  missile: [10, 0, -6, -3, -6, 3],
};

const EFFECT_COLOR: Record<GameEvent['type'], string> = {
  explosion: '255 150 40',
  nuke: '255 240 180',
  hit: '255 150 40',
  sunk: '255 90 60',
  intercept: '90 220 255',
  landing: '120 230 130',
  repelled: '255 90 60',
};

/** What would be built or hit at the cursor: a preview that follows the mouse. */
export interface Ghost {
  cell: number;
  icon: string;
  /** Green if the order would go through, red if not - and why, as a short note at the cursor. */
  ok: boolean;
  hint: string;
  /** Reach of the thing, in cells: defence, interception, weapon range, blast. */
  rings: { radius: number; label: string }[];
  /** Cells a connection runs to: the city a factory would be linked with. */
  links: number[];
}

export interface View {
  /** The local player's faction id, or -1. */
  me: number;
  /** Cell the context menu is open for, or -1. */
  selected: number;
  ghost: Ghost | null;
}

/** Front cells of one attack drawn at most; longer fronts are thinned out. */
const FRONT_SAMPLES = 500;

/** The cells an attack is about to take (thinned out), and the cell at their centre (-1 if there are none). */
export function frontOf(game: Game, atk: Attack): { cells: number[]; centre: number } {
  const stride = Math.max(1, Math.ceil(atk.pending / FRONT_SAMPLES));
  const cells: number[] = [];
  let sx = 0;
  let sy = 0;
  let i = 0;
  for (const bucket of atk.buckets) {
    for (const cell of bucket) {
      if (i++ % stride || game.owner[cell] !== atk.target) continue;
      cells.push(cell);
      sx += cell % game.width;
      sy += Math.floor(cell / game.width);
    }
  }
  if (cells.length === 0) return { cells, centre: -1 };
  // The front cell nearest to the mean: a point that really is on the front.
  const mx = sx / cells.length;
  const my = sy / cells.length;
  let centre = cells[0];
  let best = Infinity;
  for (const cell of cells) {
    const d = ((cell % game.width) - mx) ** 2 + (Math.floor(cell / game.width) - my) ** 2;
    if (d < best) {
      best = d;
      centre = cell;
    }
  }
  return { cells, centre };
}

/**
 * Draws everything that moves or stands on the map: building icons, ships,
 * aircraft and missiles with the route ahead of them, contested fronts,
 * danger zones, explosions and interceptions, the rally point, the selected
 * cell and the build preview. Call after `drawLabels`, which clears the
 * canvas and sets its scale.
 */
export function drawOverlay(ctx: CanvasRenderingContext2D, map: MapLibreMap, game: Game, proj: GridProjection, view: View, now: number): void {
  const { me, selected, ghost } = view;
  const w = game.width;
  const { clientWidth, clientHeight } = ctx.canvas;
  const at = (x: number, y: number) => map.project(proj.lngLat(x + 0.5, y + 0.5));
  const ofCell = (cell: number) => at(cell % w, Math.floor(cell / w));
  const visible = (p: { x: number; y: number }, margin = 40) => p.x > -margin && p.y > -margin && p.x < clientWidth + margin && p.y < clientHeight + margin;
  const cellPx = (at(w, 0).x - at(0, 0).x) / w;
  const rgb = (id: number) => factionColor(game.factions[id]).join(' ');
  const pulse = 0.5 + 0.5 * Math.sin(now / 160);
  const ring = (p: { x: number; y: number }, r: number) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  };
  const caption = (text: string, x: number, y: number, color = '#fff', size = 12) => {
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgb(0 0 0 / 80%)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };

  // Contested fronts the player is part of: the cells about to fall glow, with the forces at their centre.
  if (me >= 0) {
    for (const atk of game.attacks) {
      if (atk.target === NEUTRAL || (atk.attacker !== me && atk.target !== me)) continue;
      const front = frontOf(game, atk);
      if (front.centre < 0) continue;
      const size = Math.max(3, cellPx * 1.5);
      ctx.beginPath();
      for (const cell of front.cells) {
        const p = ofCell(cell);
        if (visible(p, 10)) ctx.rect(p.x - size / 2, p.y - size / 2, size, size);
      }
      ctx.save();
      ctx.shadowColor = 'rgb(255 80 20)';
      ctx.shadowBlur = 6 + 10 * pulse;
      ctx.fillStyle = `rgb(255 ${110 + Math.round(70 * pulse)} 30 / ${0.55 + 0.4 * pulse})`;
      ctx.fill();
      ctx.restore();
      const p = ofCell(front.centre);
      if (visible(p)) caption(`⚔ ${formatTroops(atk.troops)} vs ${formatTroops(game.factions[atk.target].troops)}`, p.x, p.y - 14, atk.target === me ? '#ffb199' : '#ffe0a3', 13);
    }
  }

  // Where a bomb or missile will come down: a blinking danger zone from the moment it is under way.
  for (const u of game.units) {
    if (!u.def.blast || u.path) continue;
    const p = ofCell(u.to);
    const r = Math.max(8, u.def.blast.radius * cellPx);
    if (!visible(p, r)) continue;
    ring(p, r);
    ctx.fillStyle = `rgb(255 30 30 / ${0.1 + 0.25 * pulse})`;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgb(255 60 60 / ${0.5 + 0.5 * pulse})`;
    ctx.stroke();
  }

  // The player's rally point and the land it stiffens.
  const rally = me >= 0 ? game.factions[me].rally : -1;
  if (rally >= 0 && game.owner[rally] === me) {
    const p = ofCell(rally);
    if (visible(p, 80)) {
      ring(p, RALLY_RADIUS * cellPx);
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgb(255 255 255 / 70%)';
      ctx.stroke();
      ctx.setLineDash([]);
      caption('⚑', p.x, p.y, '#fff', 18);
    }
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Buildings: a badge in the owner's colour.
  const size = Math.max(13, Math.min(22, cellPx * 2.5));
  for (const b of game.buildings) {
    const p = ofCell(b.cell);
    if (!visible(p)) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, size * 0.68, 0, Math.PI * 2);
    ctx.fillStyle = 'rgb(16 20 26 / 88%)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgb(${rgb(b.owner)})`;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `${size}px system-ui, sans-serif`;
    ctx.fillText(b.def.icon, p.x, p.y + 1);
  }

  // Units: the route ahead as marching dashes, then the marker turned into its heading.
  for (const u of game.units) {
    const p = at(u.x, u.y);
    const end = ofCell(u.path ? u.path[u.path.length - 1] : u.to);
    if (!visible(p, 200) && !visible(end, 200)) continue;
    const color = rgb(u.owner);
    let ahead = end;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    if (u.path) {
      const from = Math.floor(u.progress) + 1;
      if (from < u.path.length) ahead = ofCell(u.path[from]);
      for (let i = from; i < u.path.length; i += 3) {
        const q = ofCell(u.path[i]);
        ctx.lineTo(q.x, q.y);
      }
    }
    ctx.lineTo(end.x, end.y);
    ctx.setLineDash([6, 5]);
    ctx.lineDashOffset = -(now / 45) % 11;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgb(0 0 0 / 45%)';
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `rgb(${color})`;
    ctx.stroke();
    ctx.setLineDash([]);
    if (!u.path) {
      // Where it will come down.
      ctx.beginPath();
      ctx.arc(end.x, end.y, 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    const shape = SHAPES[u.def.domain];
    ctx.save();
    ctx.translate(p.x, p.y);
    if (ahead.x !== p.x || ahead.y !== p.y) ctx.rotate(Math.atan2(ahead.y - p.y, ahead.x - p.x));
    ctx.beginPath();
    for (let i = 0; i < shape.length; i += 2) ctx.lineTo(shape[i], shape[i + 1]);
    ctx.closePath();
    ctx.fillStyle = `rgb(${color})`;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.restore();
    if (u.troops > 0) {
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgb(0 0 0 / 80%)';
      ctx.strokeText(formatTroops(u.troops), p.x, p.y - 13);
      ctx.fillStyle = '#fff';
      ctx.fillText(formatTroops(u.troops), p.x, p.y - 13);
    }
  }

  // Effects: a ring that grows and fades; a cross where something was shot down or thrown back.
  for (const e of game.events) {
    const age = (game.tick - e.tick) / EFFECT_TICKS;
    const p = ofCell(e.cell);
    if (age > 1 || !visible(p, 100)) continue;
    const r = Math.max(14, e.radius * cellPx) * (0.35 + 0.65 * age);
    const color = EFFECT_COLOR[e.type];
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${color} / ${0.55 * (1 - age)})`;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgb(${color} / ${1 - age})`;
    ctx.stroke();
    if (e.type === 'intercept' || e.type === 'repelled' || e.type === 'sunk') {
      ctx.beginPath();
      ctx.moveTo(p.x - 6, p.y - 6);
      ctx.lineTo(p.x + 6, p.y + 6);
      ctx.moveTo(p.x + 6, p.y - 6);
      ctx.lineTo(p.x - 6, p.y + 6);
      ctx.stroke();
    }
  }

  if (selected >= 0) {
    const p = ofCell(selected);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9 + 2 * Math.sin(now / 200), 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgb(0 0 0 / 60%)';
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }

  if (ghost) {
    const p = ofCell(ghost.cell);
    const tone = ghost.ok ? '90 220 120' : '255 80 70';
    for (const cell of ghost.links) {
      const q = ofCell(cell);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgb(${tone} / 90%)`;
      ctx.stroke();
      ctx.setLineDash([]);
      ring(q, 5);
      ctx.fillStyle = `rgb(${tone})`;
      ctx.fill();
    }
    for (const { radius, label } of ghost.rings) {
      const r = radius * cellPx;
      ring(p, r);
      ctx.fillStyle = `rgb(${tone} / 10%)`;
      ctx.fill();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = `rgb(${tone} / 85%)`;
      ctx.stroke();
      ctx.setLineDash([]);
      // The caption sits on the ring, or at the top of the screen if the ring leaves it.
      caption(label, p.x, Math.max(14, p.y - r - 9), `rgb(${tone})`, 11);
    }
    ring(p, 15);
    ctx.fillStyle = `rgb(${tone} / 35%)`;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgb(${tone})`;
    ctx.stroke();
    ctx.globalAlpha = 0.75;
    caption(ghost.icon, p.x, p.y + 1, '#fff', 18);
    ctx.globalAlpha = 1;
    if (ghost.hint) caption(ghost.hint, p.x, p.y + 30, `rgb(${tone})`, 13);
  }
}
