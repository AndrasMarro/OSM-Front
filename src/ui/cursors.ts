/** What the mouse pointer over the map says about the click to come. */
export type CursorKind = 'default' | 'attack' | 'landing' | 'build' | 'target';

const svg = (body: string) => `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32' fill='none' stroke-linecap='round' stroke-linejoin='round'>${body}</svg>`;
/** Every stroke twice: dark and wide underneath, bright on top, so the pointer reads on any map colour. */
const outlined = (shapes: string, color: string) => `<g stroke='#0b0f14' stroke-width='4.5'>${shapes}</g><g stroke='${color}' stroke-width='2'>${shapes}</g>`;
const cross = (r: number, gap: number) =>
  `<path d='M16 ${16 - r}V${16 - gap}M16 ${16 + gap}V${16 + r}M${16 - r} 16H${16 - gap}M${16 + gap} 16H${16 + r}'/>`;

/** [image, hotspot x, hotspot y, fallback keyword] */
const CURSORS: Record<CursorKind, [string, number, number, string]> = {
  // A slim chevron pointer with a range tick: precise, and clearly not the browser's arrow.
  default: [svg(`<path d='M4 3 L4 23 L10 17 L15 28 L19 26 L14 16 L23 16 Z' fill='#e9eef5' stroke='#0b0f14' stroke-width='2'/><path d='M24 5h5M26.5 2.5v5' stroke='#0b0f14' stroke-width='3.5'/><path d='M24 5h5M26.5 2.5v5' stroke='#7db4ff' stroke-width='1.5'/>`), 4, 3, 'default'],
  // Crosshair with crossed blades in its corners.
  attack: [svg(outlined(`<circle cx='16' cy='16' r='8'/>${cross(14, 5)}<path d='M5 5l5 5M27 5l-5 5M5 27l5-5M27 27l-5-5'/>`, '#ffb347')), 16, 16, 'crosshair'],
  // An anchor: troops can come ashore here.
  landing: [svg(outlined(`<circle cx='16' cy='6' r='3'/><path d='M16 9V27M10 14H22M6 19c1 6 5 8 10 8s9-2 10-8M6 19l-2 3M6 19l3 2M26 19l2 3M26 19l-3 2'/>`, '#7fd4ff')), 16, 27, 'pointer'],
  // Corner brackets around a small cross: a plot to build on.
  build: [svg(outlined(`<path d='M5 11V5h6M21 5h6v6M27 21v6h-6M11 27H5v-6'/>${cross(5, 1)}`, '#8fe39a')), 16, 16, 'cell'],
  // Target lock: double ring, long ticks, a dot on the mark.
  target: [svg(`${outlined(`<circle cx='16' cy='16' r='11'/><circle cx='16' cy='16' r='5'/>${cross(15, 8)}`, '#ff4a3d')}<circle cx='16' cy='16' r='1.6' fill='#ff4a3d' stroke='#0b0f14' stroke-width='1'/>`), 16, 16, 'crosshair'],
};

const css = (kind: CursorKind) => {
  const [image, x, y, fallback] = CURSORS[kind];
  return `url("data:image/svg+xml,${encodeURIComponent(image)}") ${x} ${y}, ${fallback}`;
};

let current: CursorKind | null = null;

/** Sets the pointer over `element`. Cheap to call on every mouse move. */
export function setCursor(element: HTMLElement, kind: CursorKind): void {
  if (kind === current) return;
  current = kind;
  element.style.cursor = css(kind);
  element.dataset.cursor = kind;
}
