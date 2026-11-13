import { DEFAULT_NATION, doctrineRegistry, EMBLEMS, FLAG_LAYOUTS, sanitizeNation, type NationProfile } from '../core/nation';
import { drawFlag } from '../render/flag';

const STORAGE_KEY = 'osm-front:nation';
const LAYOUT_LABEL: Record<(typeof FLAG_LAYOUTS)[number], string> = { triH: 'Trikolore waagrecht', triV: 'Trikolore senkrecht', cross: 'Kreuz', diagonal: 'Diagonal', circle: 'Kreis' };
const EMBLEM_LABEL: Record<(typeof EMBLEMS)[number], string> = { none: 'Kein Emblem', star: 'Stern', eagle: 'Adler', crown: 'Krone', shield: 'Schild', gear: 'Zahnrad', anchor: 'Anker', bolt: 'Blitz' };
/** A first colour for players who have not chosen one, so that two newcomers rarely look alike. */
const STARTER_COLORS = ['#2478ff', '#e0452f', '#1fa860', '#c59b12', '#8d4be0', '#11a7b8', '#e0559d', '#e07a1f'];

/** The player's nation as saved in this browser - or a fresh default with a colour of its own. */
export function loadNation(): NationProfile {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return sanitizeNation(JSON.parse(saved));
  } catch {
    // Unreadable storage: start afresh.
  }
  const primary = STARTER_COLORS[Math.floor(Math.random() * STARTER_COLORS.length)];
  return sanitizeNation({ ...DEFAULT_NATION, primary, flag: { ...DEFAULT_NATION.flag, colors: [primary, '#ffffff', '#12264d'] } });
}

/**
 * Fills the nation form with the saved profile and keeps profile, storage and
 * flag preview in step with it. `onChange` gets the profile after every edit.
 */
export function setupNationEditor(form: HTMLFormElement, onChange: (nation: NationProfile) => void): NationProfile {
  let nation = loadNation();
  const field = <T extends HTMLElement = HTMLInputElement>(name: string) => form.elements.namedItem(name) as unknown as T;
  const option = (value: string, label: string) => Object.assign(document.createElement('option'), { value, textContent: label });
  field<HTMLSelectElement>('layout').replaceChildren(...FLAG_LAYOUTS.map((l) => option(l, LAYOUT_LABEL[l])));
  field<HTMLSelectElement>('emblem').replaceChildren(...EMBLEMS.map((e) => option(e, EMBLEM_LABEL[e])));
  field<HTMLSelectElement>('doctrine').replaceChildren(...doctrineRegistry.list().map((d) => option(d.id, `${d.name} – ${d.text}`)));

  const values: Record<string, string> = {
    name: nation.name,
    ruler: nation.ruler,
    primary: nation.primary,
    secondary: nation.secondary,
    layout: nation.flag.layout,
    color1: nation.flag.colors[0],
    color2: nation.flag.colors[1],
    color3: nation.flag.colors[2],
    emblem: nation.flag.emblem,
    emblemColor: nation.flag.emblemColor,
    doctrine: nation.doctrine,
  };
  for (const [name, value] of Object.entries(values)) field(name).value = value;

  const preview = form.querySelector('canvas')!;
  const paint = () => {
    const ctx = preview.getContext('2d')!;
    ctx.clearRect(0, 0, preview.width, preview.height);
    drawFlag(ctx, nation.flag, 1, 1, preview.width - 2, preview.height - 2);
  };
  paint();

  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('input', () => {
    const v = (name: string) => field(name).value;
    nation = sanitizeNation({
      name: v('name'),
      ruler: v('ruler'),
      primary: v('primary'),
      secondary: v('secondary'),
      flag: { layout: v('layout'), colors: [v('color1'), v('color2'), v('color3')], emblem: v('emblem'), emblemColor: v('emblemColor') },
      doctrine: v('doctrine'),
    });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nation));
    } catch {
      // Storage full or disabled: the nation still holds for this visit.
    }
    paint();
    onChange(nation);
  });
  return nation;
}
