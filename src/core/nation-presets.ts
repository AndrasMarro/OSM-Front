import { DEFAULT_NATION, type NationProfile } from './nation';

/**
 * A ready-made nation for the editor: a real state of today or a historic empire.
 * Picking one fills in name, colours, flag and doctrine; everything stays editable.
 * The flag's picture belongs to the renderer (`src/render/flag.ts`); here it is only an id.
 */
export interface NationPreset {
  /** ISO 3166 alpha-2 code for a state, `h-...` for an empire. Also the id of its flag. */
  id: string;
  name: string;
  category: 'modern' | 'historic';
  /** Territory and border colour. */
  primary: string;
  secondary: string;
  doctrine: string;
}

type Row = [id: string, name: string, primary: string, secondary?: string, doctrine?: string];

// Names match the spawn catalogue of the maps, so AI nations find their flag by name.
// prettier-ignore
const MODERN: Row[] = [
  ['de', 'Deutschland', '#3c3c3c', '#ffce00', 'industry'], ['at', 'Österreich', '#c8102e', '#ffffff', 'fortress'], ['ch', 'Schweiz', '#d52b1e', '#ffffff', 'fortress'],
  ['fr', 'Frankreich', '#0055a4', '#ffffff', 'expansion'], ['it', 'Italien', '#008c45', '#ffffff', 'navy'], ['gb', 'Vereinigtes Königreich', '#012169', '#c8102e', 'navy'],
  ['us', 'USA', '#3c3b6e', '#ffffff', 'industry'], ['cn', 'China', '#de2910', '#ffde00', 'industry'], ['ru', 'Russland', '#0039a6', '#ffffff', 'expansion'],
  ['tr', 'Türkei', '#e30a17', '#ffffff', 'fortress'], ['br', 'Brasilien', '#009c3b', '#ffdf00', 'expansion'], ['jp', 'Japan', '#bc002d', '#ffffff', 'navy'],
  ['es', 'Spanien', '#aa151b', '#f1bf00', 'navy'], ['pl', 'Polen', '#dc143c', '#ffffff'], ['ua', 'Ukraine', '#0057b7', '#ffd700'], ['se', 'Schweden', '#006aa7', '#fecc00'],
  ['pt', 'Portugal', '#046a38', '#da291c', 'navy'], ['ie', 'Irland', '#169b62', '#ff883e'], ['nl', 'Niederlande', '#f36c21', '#21468b', 'navy'], ['be', 'Belgien', '#fdda24', '#000000'],
  ['cz', 'Tschechien', '#11457e', '#d7141a'], ['hu', 'Ungarn', '#477050', '#ce2939'], ['ro', 'Rumänien', '#002b7f', '#fcd116'], ['bg', 'Bulgarien', '#00966e', '#d62612'],
  ['gr', 'Griechenland', '#0d5eaf', '#ffffff', 'navy'], ['rs', 'Serbien', '#c6363c', '#0c4076'], ['hr', 'Kroatien', '#171796', '#ff0000'], ['no', 'Norwegen', '#ba0c2f', '#00205b', 'navy'],
  ['fi', 'Finnland', '#003580', '#ffffff'], ['dk', 'Dänemark', '#c60c30', '#ffffff', 'navy'], ['by', 'Belarus', '#ce1720', '#007c30'], ['lt', 'Litauen', '#fdb913', '#006a44'],
  ['lv', 'Lettland', '#9e3039', '#ffffff'], ['ee', 'Estland', '#0072ce', '#000000'], ['sk', 'Slowakei', '#0b4ea2', '#ee1c25'], ['is', 'Island', '#02529c', '#dc1e35'],
  ['ba', 'Bosnien', '#002395', '#fecb00'], ['al', 'Albanien', '#e41e20', '#000000'], ['mk', 'Nordmazedonien', '#d20000', '#ffe600'], ['me', 'Montenegro', '#c40308', '#d3ae3b'],
  ['xk', 'Kosovo', '#244aa5', '#d0a650'], ['si', 'Slowenien', '#005da4', '#ed1c24'], ['md', 'Moldau', '#0046ae', '#ffd200'],
  ['in', 'Indien', '#ff9933', '#138808', 'expansion'], ['mn', 'Mongolei', '#c4272f', '#015197'], ['kz', 'Kasachstan', '#00afca', '#fec50c'], ['ir', 'Iran', '#239f40', '#da0000'],
  ['sa', 'Saudi-Arabien', '#006c35', '#ffffff'], ['pk', 'Pakistan', '#01411c', '#ffffff'], ['id', 'Indonesien', '#ce1126', '#ffffff', 'navy'], ['th', 'Thailand', '#2d2a4a', '#a51931'],
  ['kr', 'Südkorea', '#0047a0', '#cd2e3a', 'industry'], ['kp', 'Nordkorea', '#ed1c27', '#024fa2', 'fortress'], ['iq', 'Irak', '#007a3d', '#ce1126'], ['af', 'Afghanistan', '#000000', '#d32011', 'fortress'],
  ['vn', 'Vietnam', '#da251d', '#ffff00'], ['ph', 'Philippinen', '#0038a8', '#ce1126', 'navy'], ['mm', 'Myanmar', '#fecb00', '#34b233'], ['bd', 'Bangladesch', '#006a4e', '#f42a41'],
  ['uz', 'Usbekistan', '#0099b5', '#1eb53a'], ['my', 'Malaysia', '#010066', '#cc0001'], ['il', 'Israel', '#0038b8', '#ffffff', 'fortress'], ['sy', 'Syrien', '#007a3d', '#ce1126'],
  ['np', 'Nepal', '#dc143c', '#003893', 'fortress'], ['lk', 'Sri Lanka', '#8d153a', '#ffbe29'],
  ['eg', 'Ägypten', '#c8a951', '#ce1126'], ['ng', 'Nigeria', '#008751', '#ffffff'], ['za', 'Südafrika', '#007a4d', '#ffb612'], ['et', 'Äthiopien', '#078930', '#fcdd09'],
  ['cd', 'DR Kongo', '#007fff', '#f7d618'], ['dz', 'Algerien', '#006233', '#d21034'], ['ma', 'Marokko', '#c1272d', '#006233'], ['ke', 'Kenia', '#922529', '#008c51'],
  ['tz', 'Tansania', '#1eb53a', '#00a3dd'], ['ao', 'Angola', '#cc092f', '#000000'], ['sd', 'Sudan', '#007229', '#d21034'], ['ly', 'Libyen', '#239e46', '#e70013'],
  ['ml', 'Mali', '#14b53a', '#fcd116'], ['gh', 'Ghana', '#006b3f', '#fcd116'], ['mg', 'Madagaskar', '#007e3a', '#fc3d32'], ['sn', 'Senegal', '#00853f', '#fdef42'],
  ['ca', 'Kanada', '#d80621', '#ffffff'], ['mx', 'Mexiko', '#006847', '#ce1126'], ['ar', 'Argentinien', '#74acdf', '#ffffff'], ['co', 'Kolumbien', '#fcd116', '#003893'],
  ['pe', 'Peru', '#d91023', '#ffffff'], ['cl', 'Chile', '#0039a6', '#d52b1e'], ['ve', 'Venezuela', '#ffcc00', '#00247d'], ['cu', 'Kuba', '#002a8f', '#cf142b'],
  ['bo', 'Bolivien', '#007934', '#f9e300'], ['ec', 'Ecuador', '#ffdd00', '#034ea2'], ['py', 'Paraguay', '#d52b1e', '#0038a8'], ['uy', 'Uruguay', '#0038a8', '#fcd116'],
  ['gt', 'Guatemala', '#4997d0', '#ffffff'], ['ni', 'Nicaragua', '#0067c6', '#ffffff'], ['pa', 'Panama', '#005293', '#d21034'], ['do', 'Dominikanische Republik', '#002d62', '#ce1126'],
  ['gl', 'Grönland', '#d00c33', '#ffffff'], ['au', 'Australien', '#00008b', '#ffffff'], ['nz', 'Neuseeland', '#00247d', '#cc142b'], ['pg', 'Papua-Neuguinea', '#ce1126', '#fcd116'],
];

// prettier-ignore
const HISTORIC: Row[] = [
  ['h-austria-hungary', 'Österreich-Ungarn', '#b8860b', '#c8102e', 'fortress'],
  ['h-rome', 'Römisches Reich', '#8b0000', '#d4af37', 'expansion'],
  ['h-byzantium', 'Byzantinisches Reich', '#6a0dad', '#ffd700', 'fortress'],
  ['h-german-empire', 'Deutsches Kaiserreich', '#2b2b2b', '#dd0000', 'industry'],
  ['h-prussia', 'Preußen', '#1c2a44', '#ffffff', 'fortress'],
  ['h-ottoman', 'Osmanisches Reich', '#a01020', '#ffffff', 'expansion'],
  ['h-ussr', 'Sowjetunion', '#cc0000', '#ffd700', 'industry'],
  ['h-british-empire', 'Britisches Weltreich', '#9c1b30', '#012169', 'navy'],
  ['h-hre', 'Heiliges Römisches Reich', '#d9a400', '#000000', 'fortress'],
  ['h-macedon', 'Makedonien', '#1f4fa3', '#ffd700', 'expansion'],
  ['h-carthage', 'Karthago', '#5b2a86', '#f5f0e1', 'navy'],
  ['h-mongol', 'Mongolisches Reich', '#2a6fb0', '#f2c230', 'expansion'],
  ['h-yugoslavia', 'Jugoslawien', '#003893', '#de0000', 'industry'],
  ['h-kalmar', 'Kalmarer Union', '#e8b400', '#c8102e', 'navy'],
];

const preset = (category: NationPreset['category']) => ([id, name, primary, secondary = '#ffffff', doctrine = 'industry']: Row): NationPreset => ({ id, name, category, primary, secondary, doctrine });

export const NATION_PRESETS: NationPreset[] = [...MODERN.map(preset('modern')), ...HISTORIC.map(preset('historic'))];

const byName = new Map(NATION_PRESETS.map((p) => [p.name, p]));
/** The flag a faction of this name flies: the real state's, if it is named after one. */
export const flagFor = (name: string): string | undefined => byName.get(name)?.id;

/** The profile a preset stands for. `ruler` and anything else the player has set stays theirs. */
export function applyPreset(p: NationPreset, current: NationProfile = DEFAULT_NATION): NationProfile {
  return {
    ...current,
    name: p.name.slice(0, 20),
    primary: p.primary,
    secondary: p.secondary,
    doctrine: p.doctrine,
    flag: { layout: 'triH', colors: [p.primary, p.secondary, p.primary], emblem: 'none', emblemColor: p.secondary, preset: p.id },
  };
}
