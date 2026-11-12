import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Game, GameEvent } from '../core/game';
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

/**
 * Draws everything that moves or stands on the map: building icons, ships,
 * aircraft and missiles with the route ahead of them, explosions and
 * interceptions, and the selected cell. Call after `drawLabels`, which
 * clears the canvas and sets its scale.
 */
export function drawOverlay(ctx: CanvasRenderingContext2D, map: MapLibreMap, game: Game, proj: GridProjection, selected: number, now: number, me = -1): void {
  const w = game.width;
  const { clientWidth, clientHeight } = ctx.canvas;
  const at = (x: number, y: number) => map.project(proj.lngLat(x + 0.5, y + 0.5));
  const ofCell = (cell: number) => at(cell % w, Math.floor(cell / w));
  const visible = (p: { x: number; y: number }, margin = 40) => p.x > -margin && p.y > -margin && p.x < clientWidth + margin && p.y < clientHeight + margin;
  const cellPx = (at(w, 0).x - at(0, 0).x) / w;
  const rgb = (id: number) => factionColor(game.factions[id], me).join(' ');
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
}
