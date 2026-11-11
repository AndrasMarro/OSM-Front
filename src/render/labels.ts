import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Faction } from '../core/faction';
import type { Game } from '../core/game';
import type { GridProjection } from '../core/maps/projection';

/** Compact troop count: 950, 12.3k, 1.2M. */
export function formatTroops(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return `${Math.floor(n)}`;
}

/** Icon per faction kind: player, AI nation, elite tribe, standard tribe. */
export function factionIcon(f: Faction): string {
  if (f.type === 'HUMAN_NATION') return '♚';
  if (f.type === 'AI_NATION') return '★';
  return f.elite ? '▲' : '△';
}

/** Draws name and troop count over every territory big enough to hold them. */
export function drawLabels(ctx: CanvasRenderingContext2D, map: MapLibreMap, game: Game, proj: GridProjection): void {
  const canvas = ctx.canvas;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(canvas.clientWidth * dpr) || canvas.height !== Math.round(canvas.clientHeight * dpr)) {
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgb(0 0 0 / 80%)';

  const cellPx = (map.project(proj.lngLat(proj.width, 0)).x - map.project(proj.lngLat(0, 0)).x) / proj.width;
  for (const f of game.factions) {
    if (!f.alive || f.cells === 0) continue;
    const span = Math.sqrt(f.cells) * cellPx;
    const tribe = f.type === 'AI_TRIBE';
    if (span < (tribe ? 44 : 30) && f.type !== 'HUMAN_NATION') continue;
    const p = map.project(proj.lngLat(f.sumX / f.cells + 0.5, f.sumY / f.cells + 0.5));
    if (p.x < -100 || p.y < -50 || p.x > canvas.clientWidth + 100 || p.y > canvas.clientHeight + 50) continue;

    const size = Math.max(10, Math.min(tribe ? 15 : 24, span * (tribe ? 0.14 : 0.2)));
    ctx.lineWidth = size / 4;
    ctx.fillStyle = tribe ? '#efe6cf' : '#ffffff';
    const lines: [string, string][] = [
      [`${tribe ? 'italic 500' : '700'} ${size}px system-ui, sans-serif`, `${factionIcon(f)} ${tribe ? f.name : f.name.toUpperCase()}`],
      [`600 ${size * 0.85}px system-ui, sans-serif`, formatTroops(f.troops)],
    ];
    lines.forEach(([font, text], i) => {
      ctx.font = font;
      ctx.strokeText(text, p.x, p.y + (i - 0.5) * size * 1.15);
      ctx.fillText(text, p.x, p.y + (i - 0.5) * size * 1.15);
    });
  }
}
