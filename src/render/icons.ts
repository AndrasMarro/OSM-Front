/**
 * Vector art for buildings and units, drawn on a 32 x 32 grid. `C` stands for the owner's colour,
 * `D` for a darker shade of it; everything else is fixed. The engine knows nothing of this:
 * a type without art here falls back to the one-character icon of its definition.
 */
const BUILDINGS: Record<string, string> = {
  // A skyline: a tower with windows between two lower blocks.
  City: `<path d="M3 28V15h6v13zM12 28V6l5-3 5 3v22zM24 28V11h5v17z" fill="C"/><path d="M14 9h2v2h-2zM18 9h2v2h-2zM14 14h2v2h-2zM18 14h2v2h-2zM14 19h2v2h-2zM18 19h2v2h-2zM5 18h2v2H5zM5 23h2v2H5zM26 14h1.5v2H26zM26 19h1.5v2H26z" fill="#fff" opacity=".85"/><path d="M2 28h28v2H2z" fill="D"/>`,
  // A works hall with a saw-tooth roof and a smoking chimney.
  Factory: `<path d="M3 29V15l6 4v-4l6 4v-4l6 4V5h4v24z" fill="C"/><path d="M25 5h4v24h-4z" fill="D"/><path d="M6 23h3v3H6zM12 23h3v3h-3zM18 23h3v3h-3z" fill="#fff" opacity=".85"/><circle cx="27" cy="3" r="1.6" fill="#cfd6df"/><circle cx="24.5" cy="1.8" r="1.2" fill="#cfd6df" opacity=".7"/>`,
  // A squat fortress tower with battlements and a gate.
  Bunker: `<path d="M5 29V12h3V8h3v4h3V8h4v4h3V8h3v4h3v17z" fill="C"/><path d="M13 29v-7a3 3 0 0 1 6 0v7z" fill="D"/><path d="M8 17h3v2H8zM21 17h3v2h-3z" fill="#fff" opacity=".8"/><path d="M3 29h26v2H3z" fill="D"/>`,
  // An anchor over a wave.
  Port: `<circle cx="16" cy="6" r="3" fill="none" stroke="C" stroke-width="2.4"/><path d="M14.8 9h2.4v14h-2.4zM10 12h12v2.4H10z" fill="C"/><path d="M6 17c0 6 4 9 10 9s10-3 10-9l-3 2c-.5 3.5-3 5-7 5s-6.5-1.5-7-5z" fill="C"/><path d="M2 29c2.5-2 4.5-2 7 0s4.5 2 7 0 4.5-2 7 0 4.5 2 7 0v2c-2.5 2-4.5 2-7 0s-4.5-2-7 0-4.5 2-7 0-4.5-2-7 0z" fill="#5fb0ff"/>`,
  // A jet over a runway.
  Airfield: `<path d="M16 2c1.2 0 2 1.4 2 3v6l10 6v3l-10-3v6l3 2.5V27l-5-1.5-5 1.5v-2.5l3-2.5v-6L4 20v-3l10-6V5c0-1.6.8-3 2-3z" fill="C"/><path d="M3 29h26v2H3z" fill="D"/><path d="M6 29.6h3v.8H6zM12 29.6h3v.8h-3zM18 29.6h3v.8h-3zM24 29.6h3v.8h-3z" fill="#fff"/>`,
  // A rocket rising out of its silo.
  MissileSilo: `<path d="M16 1c3 3 4 7 4 11v10h-8V12c0-4 1-8 4-11z" fill="#e8ecf1"/><path d="M12 15l-3 4v4h3zM20 15l3 4v4h-3z" fill="C"/><path d="M14.5 9h3v3h-3z" fill="C"/><path d="M4 22h24v8H4z" fill="D"/><path d="M8 24h16v4H8z" fill="#11161d"/><path d="M12 22h8v2h-8z" fill="C"/>`,
  // A radar dish on a launcher with two missiles.
  SAMSite: `<path d="M5 12a9 9 0 0 1 14-7.5L11 13z" fill="C"/><path d="M11 13l-1.5 4h3z" fill="D"/><circle cx="14" cy="6" r="1.3" fill="#fff"/><path d="M16 21l10-8 2 2-10 8zM18 25l10-8 1.5 2-10 8z" fill="#e8ecf1"/><path d="M4 26h24v4H4z" fill="D"/><path d="M8 17h8v9H8z" fill="C"/>`,
};

/**
 * Units seen from above, pointing right (heading 0), centred on the origin of a 32 x 32 box.
 */
const UNITS: Record<string, string> = {
  // A landing craft: a blunt bow ramp and troops on deck.
  TransportShip: `<path d="M-13-6h20l6 3v6l-6 3h-20z" fill="C" stroke="#fff" stroke-width="1.4"/><path d="M8-5h3v10H8z" fill="D"/><circle cx="-8" cy="-2" r="1.6" fill="#fff"/><circle cx="-3" cy="-2" r="1.6" fill="#fff"/><circle cx="2" cy="-2" r="1.6" fill="#fff"/><circle cx="-8" cy="2.5" r="1.6" fill="#fff"/><circle cx="-3" cy="2.5" r="1.6" fill="#fff"/><circle cx="2" cy="2.5" r="1.6" fill="#fff"/>`,
  // A destroyer: pointed bow, superstructure and two gun turrets.
  Warship: `<path d="M-14-4.5h18l10 4.5-10 4.5h-18l-2-4.5z" fill="C" stroke="#fff" stroke-width="1.4"/><path d="M-6-2.5h7v5h-7z" fill="D"/><circle cx="6" cy="0" r="2.2" fill="#e8ecf1"/><path d="M6-.6h6v1.2H6z" fill="#e8ecf1"/><circle cx="-10" cy="0" r="2" fill="#e8ecf1"/><path d="M-16-.5h6v1h-6z" fill="#e8ecf1"/>`,
  // A cargo ship with a row of containers.
  TradeShip: `<path d="M-12-5h17l7 5-7 5h-17z" fill="#f2f4f7" stroke="C" stroke-width="2"/><path d="M-10-3h4v6h-4z" fill="#e0452f"/><path d="M-5.5-3h4v6h-4z" fill="#ffd45e"/><path d="M-1-3h4v6h-4z" fill="#1fa860"/><path d="M4-2.5h3v5H4z" fill="C"/>`,
  // A fighter jet: delta wings, twin fins.
  Fighter: `<path d="M14 0L4-2.5-4-12h-3l3 10-8 1-3-4h-2l1.5 5-1.5 5h2l3-4 8 1-3 10h3l8-9.5z" fill="C" stroke="#fff" stroke-width="1.2"/>`,
  // A heavy bomber: long straight wings, four engines.
  Bomber: `<path d="M15 0L10-2H2L-3-15h-3l1 13h-8l-3-5h-2l1 7-1 7h2l3-5h8l-1 13h3l5-13h8z" fill="C" stroke="#fff" stroke-width="1.2"/><circle cx="-2" cy="-8" r="1.4" fill="#fff"/><circle cx="-2" cy="8" r="1.4" fill="#fff"/>`,
  // A transport plane with a parachute behind it.
  Paratrooper: `<path d="M13 0L9-2H2L-2-12h-3l1 10h-7l-2-4h-2l1 6-1 6h2l2-4h7l-1 10h3l4-10h7z" fill="C" stroke="#fff" stroke-width="1.2"/><path d="M-18-5a6 6 0 0 1 0 10" fill="none" stroke="#fff" stroke-width="2"/>`,
  // A tactical missile: slim body, nose cone, tail fins and a flame.
  Missile: `<path d="M12 0L7-2.6H-8v5.2H7z" fill="#e8ecf1" stroke="C" stroke-width="1.4"/><path d="M-8-2.6l-4-4h3l3 4zM-8 2.6l-4 4h3l3-4z" fill="C"/><path d="M-10-1.5h-5l-2 1.5 2 1.5h5z" fill="#ffb347"/>`,
  // A nuclear missile: fat body with the trefoil.
  Nuke: `<path d="M14 0L8-4H-9v8H8z" fill="#ffd45e" stroke="C" stroke-width="1.6"/><path d="M-9-4l-5-5h3l4 5zM-9 4l-5 5h3l4-5z" fill="C"/><circle cx="1" cy="0" r="2.6" fill="#11161d"/><path d="M-11-2h-5l-2 2 2 2h5z" fill="#ff7a3d"/>`,
};

const shade = (hex: string, k: number) => {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `#${[c(n >> 16), c((n >> 8) & 255), c(n & 255)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};
const paint = (art: string, color: string) => art.replaceAll('"C"', `"${color}"`).replaceAll('"D"', `"${shade(color, 0.55)}"`);
const svg = (body: string, box: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" width="64" height="64">${body}</svg>`)}`;

export const hasBuildingArt = (id: string) => id in BUILDINGS;
export const hasUnitArt = (id: string) => id in UNITS;

/** A building's art in a colour (#rrggbb), as an image URL for the HUD and menus. */
export const buildingIconUrl = (id: string, color = '#d7dee8') => (BUILDINGS[id] ? svg(paint(BUILDINGS[id], color), '0 0 32 32') : '');

const images = new Map<string, HTMLImageElement>();
function image(key: string, url: string): HTMLImageElement | null {
  let img = images.get(key);
  if (!img) images.set(key, (img = Object.assign(new Image(), { src: url })));
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/** A building's art for the map canvas; null until it has loaded (or if there is none). */
export const buildingImage = (id: string, color: string) => (BUILDINGS[id] ? image(`b|${id}|${color}`, buildingIconUrl(id, color)) : null);

/** A unit's art for the map canvas, centred and pointing right; null until it has loaded. */
export const unitImage = (id: string, color: string) => (UNITS[id] ? image(`u|${id}|${color}`, svg(paint(UNITS[id], color), '-16 -16 32 32')) : null);

/** A unit's art as an image URL, for alarms and menus. */
export const unitIconUrl = (id: string, color = '#d7dee8') => (UNITS[id] ? svg(paint(UNITS[id], color), '-16 -16 32 32') : '');
