import type { Faction } from '../core/faction';
import type { Game } from '../core/game';

export type RGB = [r: number, g: number, b: number];

function hsl(h: number, s: number, l: number): RGB {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [channel(0), channel(8), channel(4)];
}

/** Nations get saturated colours, tribes muted ones (elite tribes dark), so the two read apart at a glance. */
export function factionColor(f: Faction): RGB {
  if (f.type === 'HUMAN_NATION') return [36, 120, 255];
  const hue = (f.id * 137.508) % 360; // golden angle: neighbouring ids land far apart
  if (f.type === 'AI_NATION') return hsl(hue, 0.72, 0.5);
  return f.elite ? hsl(hue, 0.5, 0.3) : hsl(hue, 0.28, 0.64);
}

/** Canvas pixels are little-endian ABGR when written through a Uint32Array. */
const pack = (r: number, g: number, b: number, a: number) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
const shade = ([r, g, b]: RGB, k: number, a: number) => pack(Math.min(255, r * k), Math.min(255, g * k), Math.min(255, b * k), a);

// Indexed by terrain id: WATER, PLAINS, URBAN, FOREST, MOUNTAIN, HIGHWAY, RAIL, ICE.
const TERRAIN_COUNT = 8;
/** Brightness of owned land per terrain, so terrain stays readable under a faction colour. */
const OWNED_SHADE = [1, 1, 1.15, 0.82, 0.66, 1.3, 0.55, 1.4];
/** Tint of free land. Plains and water stay transparent to show the map underneath. */
const FREE_TINT = [0, 0, pack(130, 125, 135, 110), pack(46, 120, 60, 95), pack(120, 98, 80, 125), pack(235, 160, 30, 170), pack(70, 70, 80, 170), pack(240, 248, 255, 150)];
/** Irradiated no-man's-land after a nuclear strike. */
const FALLOUT_TINT = pack(150, 215, 40, 150);

/**
 * Paints the ownership grid into a canvas with one pixel per cell. MapLibre
 * stretches that canvas over the map's bounding box, so it pans and zooms with the camera.
 */
export class TerritoryPainter {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly pixels: Uint32Array;
  private fill = new Uint32Array(0);
  private border = new Uint32Array(0);
  private dotted = new Uint8Array(0);

  constructor(width: number, height: number) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d')!;
    this.image = this.ctx.createImageData(width, height);
    this.pixels = new Uint32Array(this.image.data.buffer);
  }

  private buildPalette(factions: Faction[]): void {
    this.fill = new Uint32Array(factions.length * TERRAIN_COUNT);
    this.border = new Uint32Array(factions.length);
    this.dotted = new Uint8Array(factions.length);
    for (const f of factions) {
      const rgb = factionColor(f);
      for (let t = 0; t < TERRAIN_COUNT; t++) this.fill[f.id * TERRAIN_COUNT + t] = shade(rgb, OWNED_SHADE[t], 205);
      // Nations: solid dark border (the player's is white). Tribes: dotted border.
      this.border[f.id] = f.type === 'HUMAN_NATION' ? pack(255, 255, 255, 255) : shade(rgb, 0.4, 255);
      this.dotted[f.id] = f.type === 'AI_TRIBE' ? 1 : 0;
    }
  }

  paint(game: Game): void {
    // ponytail: repaints every cell on each change; track dirty rows if grids get much larger.
    const { owner, terrain, width: w, factions, fallout, tick } = game;
    if (this.border.length !== factions.length) this.buildPalette(factions);
    const { pixels, fill, border, dotted } = this;
    const n = owner.length;
    for (let i = 0, x = 0, y = 0; i < n; i++) {
      const o = owner[i];
      if (o === 0) pixels[i] = fallout[i] > tick ? FALLOUT_TINT : FREE_TINT[terrain[i]];
      else {
        const edge = (x > 0 && owner[i - 1] !== o) || (x < w - 1 && owner[i + 1] !== o) || (i >= w && owner[i - w] !== o) || (i < n - w && owner[i + w] !== o);
        pixels[i] = edge && !(dotted[o] && (x + y) & 1) ? border[o] : fill[o * TERRAIN_COUNT + terrain[i]];
      }
      if (++x === w) {
        x = 0;
        y++;
      }
    }
    this.ctx.putImageData(this.image, 0, 0);
  }
}
