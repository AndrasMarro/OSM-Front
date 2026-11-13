import { Registry } from './registry';

/**
 * A nation's background. Each grants one light, permanent bonus; the engine
 * reads the numbers, never the id, so a new doctrine is one more entry.
 */
export interface DoctrineDefinition {
  id: string;
  /** Display name and one-line description (German UI). */
  name: string;
  text: string;
  /** Extra factory income in percent. */
  factoryIncomePct?: number;
  /** Discount in percent on coastal buildings and ships. */
  navalDiscountPct?: number;
  /** Extra strength in percent of the faction's forts. */
  fortDefensePct?: number;
  /** Extra population growth in percent. */
  growthPct?: number;
}

export const doctrineRegistry = new Registry<DoctrineDefinition>();
doctrineRegistry.register({ id: 'industry', name: 'Industriemacht', text: '+15 % Fabrik-Einkommen', factoryIncomePct: 15 });
doctrineRegistry.register({ id: 'navy', name: 'Seemacht', text: 'Häfen und Schiffe 20 % günstiger', navalDiscountPct: 20 });
doctrineRegistry.register({ id: 'fortress', name: 'Festungsdoktrin', text: 'Bunker verteidigen 20 % stärker', fortDefensePct: 20 });
doctrineRegistry.register({ id: 'expansion', name: 'Expansionsdrang', text: '+10 % Bevölkerungswachstum', growthPct: 10 });

/** The bonuses of a faction, with every field present. Factions without a doctrine have none. */
export type Bonus = Required<Omit<DoctrineDefinition, 'id' | 'name' | 'text'>>;
export const NO_BONUS: Bonus = { factoryIncomePct: 0, navalDiscountPct: 0, fortDefensePct: 0, growthPct: 0 };
export function bonusOf(doctrine: string | undefined): Bonus {
  const d = doctrineRegistry.get(doctrine ?? '');
  return { factoryIncomePct: d?.factoryIncomePct ?? 0, navalDiscountPct: d?.navalDiscountPct ?? 0, fortDefensePct: d?.fortDefensePct ?? 0, growthPct: d?.growthPct ?? 0 };
}

export const FLAG_LAYOUTS = ['triH', 'triV', 'cross', 'diagonal', 'circle'] as const;
export const EMBLEMS = ['none', 'star', 'eagle', 'crown', 'shield', 'gear', 'anchor', 'bolt'] as const;

export interface Flag {
  layout: (typeof FLAG_LAYOUTS)[number];
  /** Three colours as #rrggbb; what each one paints depends on the layout. */
  colors: [string, string, string];
  emblem: (typeof EMBLEMS)[number];
  emblemColor: string;
}

/** How a player presents their nation. Made in the editor, stored in the browser, sent to every peer. */
export interface NationProfile {
  name: string;
  ruler: string;
  /** Territory colour and border colour, #rrggbb. */
  primary: string;
  secondary: string;
  flag: Flag;
  doctrine: string;
}

export const DEFAULT_NATION: NationProfile = {
  name: 'Meine Nation',
  ruler: 'Du',
  primary: '#2478ff',
  secondary: '#ffffff',
  flag: { layout: 'triH', colors: ['#2478ff', '#ffffff', '#12264d'], emblem: 'star', emblemColor: '#ffd45e' },
  doctrine: 'industry',
};

const MAX_NAME = 20;
const text = (v: unknown, fallback: string) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim() : '') || fallback;
const color = (v: unknown, fallback: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback);
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T) => (options.includes(v as T) ? (v as T) : fallback);

/**
 * Turns whatever arrived - from storage, or from another player's machine -
 * into a valid profile. Anything missing or malformed falls back to the default.
 */
export function sanitizeNation(input: unknown): NationProfile {
  const n = (typeof input === 'object' && input !== null ? input : {}) as Partial<Record<keyof NationProfile, unknown>>;
  const f = (typeof n.flag === 'object' && n.flag !== null ? n.flag : {}) as Partial<Record<keyof Flag, unknown>>;
  const d = DEFAULT_NATION;
  const colors = Array.isArray(f.colors) ? f.colors : [];
  return {
    name: text(n.name, d.name),
    ruler: text(n.ruler, d.ruler),
    primary: color(n.primary, d.primary),
    secondary: color(n.secondary, d.secondary),
    flag: {
      layout: oneOf(f.layout, FLAG_LAYOUTS, d.flag.layout),
      colors: [color(colors[0], d.flag.colors[0]), color(colors[1], d.flag.colors[1]), color(colors[2], d.flag.colors[2])],
      emblem: oneOf(f.emblem, EMBLEMS, d.flag.emblem),
      emblemColor: color(f.emblemColor, d.flag.emblemColor),
    },
    doctrine: doctrineRegistry.get(typeof n.doctrine === 'string' ? n.doctrine : '') ? (n.doctrine as string) : d.doctrine,
  };
}
