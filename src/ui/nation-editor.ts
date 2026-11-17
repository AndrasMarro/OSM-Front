import { DEFAULT_NATION, doctrineRegistry, EMBLEMS, FLAG_LAYOUTS, sanitizeNation, type NationProfile } from '../core/nation';
import { applyPreset, NATION_PRESETS } from '../core/nation-presets';
import { flagImage } from '../render/flag';

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

  // The library: today's states and historic empires, each a complete nation to start from.
  const group = (label: string, category: string) => {
    const g = Object.assign(document.createElement('optgroup'), { label });
    g.append(...NATION_PRESETS.filter((p) => p.category === category).map((p) => option(p.id, p.name)));
    return g;
  };
  field<HTMLSelectElement>('preset').replaceChildren(option('', 'Eigene Gestaltung'), group('Historische Reiche & alte Nationen', 'historic'), group('Heutige Staaten', 'modern'));

  const fill = (n: NationProfile) => {
    const values: Record<string, string> = {
      preset: n.flag.preset ?? '',
      name: n.name,
      ruler: n.ruler,
      primary: n.primary,
      secondary: n.secondary,
      layout: n.flag.layout,
      color1: n.flag.colors[0],
      color2: n.flag.colors[1],
      color3: n.flag.colors[2],
      emblem: n.flag.emblem,
      emblemColor: n.flag.emblemColor,
      doctrine: n.doctrine,
    };
    for (const [name, value] of Object.entries(values)) field(name).value = value;
  };
  fill(nation);

  const preview = form.querySelector('canvas')!;
  const paint = () => {
    const ctx = preview.getContext('2d')!;
    ctx.clearRect(0, 0, preview.width, preview.height);
    ctx.drawImage(flagImage(nation.flag).canvas, 1, 1, preview.width - 2, preview.height - 2);
  };
  paint();
  // A library flag is a picture that may arrive a moment after it was chosen.
  const repaintSoon = () => [150, 600, 1500].forEach((ms) => setTimeout(paint, ms));
  repaintSoon();

  form.addEventListener('submit', (e) => e.preventDefault());
  const FLAG_FIELDS = ['layout', 'color1', 'color2', 'color3', 'emblem', 'emblemColor'];
  form.addEventListener('input', (e) => {
    const v = (name: string) => field(name).value;
    const changed = (e.target as HTMLInputElement).name;
    // Picking a preset fills in the whole nation; it stays editable afterwards.
    const picked = changed === 'preset' ? NATION_PRESETS.find((p) => p.id === v('preset')) : undefined;
    if (picked) fill(applyPreset(picked, nation));
    // Whoever redesigns the flag by hand leaves the library flag behind.
    if (FLAG_FIELDS.includes(changed)) field('preset').value = '';
    nation = sanitizeNation({
      name: v('name'),
      ruler: v('ruler'),
      primary: v('primary'),
      secondary: v('secondary'),
      flag: { layout: v('layout'), colors: [v('color1'), v('color2'), v('color3')], emblem: v('emblem'), emblemColor: v('emblemColor'), preset: v('preset') || undefined },
      doctrine: v('doctrine'),
    });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nation));
    } catch {
      // Storage full or disabled: the nation still holds for this visit.
    }
    paint();
    repaintSoon();
    onChange(nation);
  });
  return nation;
}
