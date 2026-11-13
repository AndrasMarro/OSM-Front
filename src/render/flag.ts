import type { Flag } from '../core/nation';

/** Emblems as outlines in a box from -1 to 1 (y down), filled with the emblem colour. */
const SHAPES: Record<Exclude<Flag['emblem'], 'none' | 'gear' | 'anchor'>, number[]> = {
  star: [0, -1, 0.24, -0.31, 0.95, -0.31, 0.38, 0.12, 0.59, 0.81, 0, 0.4, -0.59, 0.81, -0.38, 0.12, -0.95, -0.31, -0.24, -0.31],
  // Spread wings, head and tail.
  eagle: [0, -0.75, 0.16, -0.5, 0.2, -0.2, 0.95, -0.6, 0.8, 0.05, 0.4, 0.2, 0.25, 0.45, 0.4, 0.9, 0, 0.7, -0.4, 0.9, -0.25, 0.45, -0.4, 0.2, -0.8, 0.05, -0.95, -0.6, -0.2, -0.2, -0.16, -0.5],
  crown: [-0.9, 0.7, -0.9, -0.6, -0.45, 0, 0, -0.8, 0.45, 0, 0.9, -0.6, 0.9, 0.7],
  shield: [-0.75, -0.85, 0.75, -0.85, 0.75, 0.05, 0.45, 0.6, 0, 0.95, -0.45, 0.6, -0.75, 0.05],
  bolt: [0.25, -1, -0.6, 0.15, -0.08, 0.15, -0.3, 1, 0.6, -0.2, 0.1, -0.2],
};

function emblem(ctx: CanvasRenderingContext2D, kind: Flag['emblem'], cx: number, cy: number, r: number): void {
  if (kind === 'none') return;
  ctx.beginPath();
  if (kind === 'gear') {
    // Teeth around a ring; the hole is cut out by the even-odd rule.
    for (let i = 0; i < 16; i++) {
      const a = (i * Math.PI) / 8;
      const rr = i % 2 ? r : r * 0.72;
      for (const da of [-0.14, 0.14]) ctx.lineTo(cx + Math.cos(a + da) * rr, cy + Math.sin(a + da) * rr);
    }
    ctx.closePath();
    ctx.moveTo(cx + r * 0.32, cy);
    ctx.arc(cx, cy, r * 0.32, 0, Math.PI * 2);
    ctx.fill('evenodd');
    return;
  }
  if (kind === 'anchor') {
    ctx.lineWidth = r * 0.24;
    ctx.lineCap = 'round';
    ctx.moveTo(cx, cy - r * 0.55);
    ctx.lineTo(cx, cy + r * 0.85);
    ctx.moveTo(cx - r * 0.45, cy - r * 0.2);
    ctx.lineTo(cx + r * 0.45, cy - r * 0.2);
    ctx.moveTo(cx - r * 0.75, cy + r * 0.2);
    ctx.quadraticCurveTo(cx - r * 0.6, cy + r * 0.85, cx, cy + r * 0.85);
    ctx.quadraticCurveTo(cx + r * 0.6, cy + r * 0.85, cx + r * 0.75, cy + r * 0.2);
    ctx.moveTo(cx + r * 0.2, cy - r * 0.78);
    ctx.arc(cx, cy - r * 0.78, r * 0.2, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  const shape = SHAPES[kind];
  for (let i = 0; i < shape.length; i += 2) ctx.lineTo(cx + shape[i] * r, cy + shape[i + 1] * r);
  ctx.closePath();
  ctx.fill();
}

/** Paints a flag into the rectangle: the layout in its three colours, the emblem on top. */
export function drawFlag(ctx: CanvasRenderingContext2D, flag: Flag, x: number, y: number, w: number, h: number): void {
  const [a, b, c] = flag.colors;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = a;
  ctx.fillRect(x, y, w, h);
  switch (flag.layout) {
    case 'triH':
      ctx.fillStyle = b;
      ctx.fillRect(x, y + h / 3, w, h / 3);
      ctx.fillStyle = c;
      ctx.fillRect(x, y + (2 * h) / 3, w, h / 3 + 1);
      break;
    case 'triV':
      ctx.fillStyle = b;
      ctx.fillRect(x + w / 3, y, w / 3, h);
      ctx.fillStyle = c;
      ctx.fillRect(x + (2 * w) / 3, y, w / 3 + 1, h);
      break;
    case 'cross':
      // A wide cross with a narrow one inside it.
      for (const [color, t] of [
        [c, h * 0.3],
        [b, h * 0.16],
      ] as const) {
        ctx.fillStyle = color;
        ctx.fillRect(x, y + (h - t) / 2, w, t);
        ctx.fillRect(x + (w - t) / 2, y, t, h);
      }
      break;
    case 'diagonal':
      ctx.fillStyle = b;
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w, y + h);
      ctx.fill();
      ctx.strokeStyle = c;
      ctx.lineWidth = h * 0.16;
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      ctx.lineTo(x + w, y);
      ctx.stroke();
      break;
    case 'circle':
      for (const [color, r] of [
        [c, h * 0.4],
        [b, h * 0.32],
      ] as const) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
  }
  ctx.fillStyle = ctx.strokeStyle = flag.emblemColor;
  emblem(ctx, flag.emblem, x + w / 2, y + h / 2, h * 0.27);
  ctx.restore();
  ctx.strokeStyle = 'rgb(0 0 0 / 55%)';
  ctx.lineWidth = Math.max(1, h / 24);
  ctx.strokeRect(x, y, w, h);
}

const cache = new Map<string, { canvas: HTMLCanvasElement; url: string }>();

/** The flag as a small image, rendered once per design: a canvas for the map, a data URL for the HUD. */
export function flagImage(flag: Flag): { canvas: HTMLCanvasElement; url: string } {
  const key = JSON.stringify(flag);
  let entry = cache.get(key);
  if (!entry) {
    const canvas = Object.assign(document.createElement('canvas'), { width: 96, height: 64 });
    drawFlag(canvas.getContext('2d')!, flag, 0, 0, 96, 64);
    cache.set(key, (entry = { canvas, url: canvas.toDataURL() }));
  }
  return entry;
}

/** An `<img>` of the flag, sized by CSS (`.flag`). */
export function flagElement(flag: Flag): HTMLImageElement {
  return Object.assign(new Image(), { src: flagImage(flag).url, className: 'flag', alt: '' });
}
