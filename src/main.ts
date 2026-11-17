import { Map as MapLibreMap, setWorkerUrl, type CanvasSource, type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { buildingRegistry, canBuild, canUpgrade, CITY_TIERS, linkedCity, MAX_LEVEL, price, upgradeCost, type Building, type BuildingDefinition, type OrderResult } from './core/buildings';
import type { CommandResult } from './core/commands';
import type { DiplomaticStatus, Treaty } from './core/diplomacy';
import type { Faction } from './core/faction';
import { doctrineRegistry, type NationProfile } from './core/nation';
import { DIFFICULTY, NEUTRAL, TICKS_PER_SECOND, type Difficulty, type Game, type GameEvent, type RealCity } from './core/game';
import { GridProjection } from './core/maps/projection';
import { mapRegistry, validateMapPack } from './core/maps/registry';
import type { MapPackDefinition } from './core/maps/types';
import { createGame } from './core/setup';
import { isLand, Terrain } from './core/terrain';
import { etaTicks, unitCost, unitRegistry, type UnitDefinition } from './core/units';
import { Lobby } from './net/lobby';
import { Lockstep, SPEEDS, type PlayerCommand } from './net/lockstep';
import { localTransport, relayTransport, trysteroTransport, type Transport } from './net/transport';
import { borderLines } from './osm/countries';
import { loadTerrain } from './osm/terrain';
import { factionFlag, flagElement, flagImage } from './render/flag';
import { buildingIconUrl, unitIconUrl } from './render/icons';
import { drawLabels, factionIcon, formatTroops } from './render/labels';
import { drawOverlay, frontOf, type Ghost } from './render/overlay';
import { factionColor, TerritoryPainter } from './render/territory';
import './style.css';
import { setCursor, type CursorKind } from './ui/cursors';
import { exportPack, setupCustomMaps } from './ui/custom-maps';
import { setupNationEditor } from './ui/nation-editor';
import { Radial, type RadialItem, type RadialSpec } from './ui/radial';
import { getVolume, play, played, setVolume, type Sound } from './ui/sound';
import { Tutorial, TUTORIAL_STEPS } from './ui/tutorial';

const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const LAYER = 'territory';
/** The player wins by holding this share of all land. */
const VICTORY_SHARE = 0.8;
/** In multiplayer the world starts moving once everybody has picked a start, or after this long. */
const SPAWN_WAIT_MS = 30_000;
const TERRAIN_LABEL = ['Wasser', 'Ebene', 'Stadt', 'Wald', 'Gebirge', 'Autobahn', 'Schiene', 'Eis', 'Außerhalb der Karte'];
const STATUS_LABEL: Record<DiplomaticStatus, string> = { War: 'Krieg', Neutral: 'Neutral', NonAggressionPact: 'Nichtangriffspakt', Alliance: 'Bündnis' };
const TREATY_LABEL: Record<Treaty, string> = { NonAggressionPact: 'Nichtangriffspakt', Alliance: 'Bündnis', TradeAgreement: 'Handelsabkommen' };
/** Why an order was refused. */
const REFUSAL: Record<Exclude<OrderResult, 'ok'>, string> = {
  gold: 'Nicht genug Gold.',
  place: 'Das geht nur auf deinem eigenen Gebiet.',
  spacing: 'Zu nah am nächsten Gebäude.',
  coast: 'Dieses Gebäude muss direkt am Wasser stehen.',
  base: 'Dafür fehlt das passende Gebäude.',
  range: 'Außer Reichweite, oder es gibt keinen Seeweg dorthin.',
  target: 'Das ist kein gültiges Ziel.',
  troops: 'Dafür hast du keine Truppen übrig.',
  reload: 'Das Raketensilo lädt nach.',
  level: 'Das Gebäude hat schon die höchste Stufe.',
};
/** The same reasons, short enough to hang on the cursor while placing a building. */
const BUILD_HINT: Partial<Record<OrderResult, string>> = { place: 'Nicht dein Gebiet', spacing: 'Zu nah am nächsten Gebäude', coast: 'Kein Küstenfeld', gold: 'Zu wenig Gold', level: 'Höchste Stufe erreicht' };
/** Gold in one gift. */
const GOLD_GIFT = 100;
/** Units that get a key of their own (after the buildings) to aim them straight at the map. */
const TARGET_HOTKEYS = ['Bomber', 'Missile'];

interface Session {
  pack: MapPackDefinition;
  proj: GridProjection;
  game: Game;
  lockstep: Lockstep;
  painter: TerritoryPainter;
  over: boolean;
  /** False while players are still picking their starting areas. */
  running: boolean;
  startedAt: number;
  /** Cell the context menu is open for, or -1. */
  selected: number;
  /** Factions the player is known to be at war with, to announce new wars once. */
  wars: Set<number>;
  /** What the offers panel currently shows, to rebuild it only on change. */
  offers: string;
  /** What to tell the player about each of their commands still on its way through the host. */
  feedback: ((result: CommandResult) => string)[];
  /** Events up to this tick have been heard. */
  heardTick: number;
  /** The most land the player ever held, for the summary at the end. */
  peakCells: number;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const menu = $('menu');
const hud = $('hud');
const banner = $('banner');
const toastEl = $('toast');
const status = $('status');
const strength = $<HTMLInputElement>('strength');
const labels = $<HTMLCanvasElement>('labels').getContext('2d')!;

// MapLibre looks for its worker next to its own module, which no longer exists once bundled.
setWorkerUrl(workerUrl);
const map = new MapLibreMap({
  container: 'map',
  style: BASEMAP_STYLE,
  center: [10, 30],
  zoom: 1.5,
  dragRotate: false,
  // A press that moves less than this many pixels is a click; anything more pans the map.
  clickTolerance: 5,
  pitchWithRotate: false,
  touchPitch: false,
});
map.touchZoomRotate.disableRotation();
// The keyboard moves the camera through our own handler (WASD and arrows, smoothly), and a fast
// series of attack clicks must never zoom the map.
map.keyboard.disable();
map.doubleClickZoom.disable();
const mapReady = new Promise<void>((resolve) => map.once('load', () => resolve()));

/**
 * Real country borders as glowing lines: every border faintly, the outer line of the map's own
 * countries brightly. Strong behind the menu, subdued during a game.
 */
const BORDER_LAYERS = ['borders-all', 'borders-glow', 'borders-pack'];
let bordersFor: string | null | undefined;
async function showBorders(pack: MapPackDefinition | null, subdued: boolean): Promise<void> {
  await mapReady;
  try {
    const key = pack?.countries?.length ? pack.id : null;
    if (!map.getSource('borders')) {
      map.addSource('borders', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
      map.addLayer({ id: 'borders-all', type: 'line', source: 'borders', filter: ['==', ['get', 'kind'], 'all'], paint: { 'line-color': '#9fd0ff', 'line-width': 0.8 } }, before);
      map.addLayer({ id: 'borders-glow', type: 'line', source: 'borders', filter: ['==', ['get', 'kind'], 'pack'], paint: { 'line-color': '#ffd45e', 'line-width': 7, 'line-blur': 6 } }, before);
      map.addLayer({ id: 'borders-pack', type: 'line', source: 'borders', filter: ['==', ['get', 'kind'], 'pack'], paint: { 'line-color': '#fff1c4', 'line-width': 1.6 } }, before);
    }
    if (bordersFor !== key) {
      bordersFor = key;
      const data = await borderLines(pack);
      if (bordersFor === key) map.getSource<GeoJSONSource>('borders')?.setData(data);
    }
    const opacity = subdued ? [0.25, 0.3, 0.7] : [0.6, 1, 1];
    map.setPaintProperty('borders-glow', 'line-width', subdued ? 7 : 12);
    map.setPaintProperty('borders-pack', 'line-width', subdued ? 1.6 : 2.4);
    BORDER_LAYERS.forEach((id, i) => map.setPaintProperty(id, 'line-opacity', opacity[i]));
  } catch (err) {
    console.warn('country borders unavailable', err);
  }
}

let session: Session | null = null;
/** The multiplayer room, if the player is in one. */
let lobby: Lobby | null = null;
/** Id of the room in the address bar, also while the connection to it is still being made. */
let room: string | null = null;
/** Bumped on every map change so a slow terrain download cannot start a stale game. */
let generation = 0;
/** True while a map is loading: nothing else can be started. */
let busy = false;

const me = () => session?.lockstep.me ?? null;

/** The level picked in the menu; in a room the host's choice counts. */
let difficulty: Difficulty = (localStorage.getItem('osm-front:difficulty') ?? 'normal') as Difficulty;
if (!(difficulty in DIFFICULTY)) difficulty = 'normal';
const levelButtons = [...$('difficulty').querySelectorAll('button')];
function showDifficulty(): void {
  for (const b of levelButtons) b.setAttribute('aria-checked', `${b.dataset.level === difficulty}`);
}
for (const b of levelButtons) {
  b.addEventListener('click', () => {
    difficulty = b.dataset.level as Difficulty;
    localStorage.setItem('osm-front:difficulty', difficulty);
    showDifficulty();
  });
}
showDifficulty();

// --- sound, help and the end of a game -------------------------------------------

/** What a successful order sounds like, by kind; anything else gets the plain confirmation. */
const ORDER_SOUND: Partial<Record<PlayerCommand['type'], Sound>> = { build: 'build', attack: 'attack', spawn: 'build' };
const EVENT_SOUND: Record<GameEvent['type'], Sound> = { explosion: 'explosion', nuke: 'nuke', intercept: 'intercept', landing: 'landing', repelled: 'hit', hit: 'hit', sunk: 'explosion', captured: 'offer' };

const volumeSlider = $<HTMLInputElement>('volume');
/** The volume before muting, to come back to. */
let unmuted = getVolume() || 0.6;
function showVolume(): void {
  volumeSlider.value = `${Math.round(getVolume() * 100)}`;
  $('volume-value').textContent = getVolume() === 0 ? 'aus' : `${volumeSlider.value} %`;
}
volumeSlider.addEventListener('input', () => {
  setVolume(Number(volumeSlider.value) / 100);
  if (getVolume() > 0) unmuted = getVolume();
  showVolume();
  play('click');
});
showVolume();

const help = $<HTMLDialogElement>('help');
$('help-open').addEventListener('click', () => help.showModal());
const gameover = $<HTMLDialogElement>('gameover');
gameover.addEventListener('close', () => {
  if (gameover.returnValue === 'menu') showMenu();
});

/** The game is decided for this player: say so, with what they achieved. */
function endGame(s: Session, won: boolean, mine: Faction): void {
  s.over = true;
  radial.close();
  setMode(null);
  play(won ? 'victory' : 'defeat');
  const seconds = Math.floor(s.game.tick / TICKS_PER_SECOND);
  const rank = s.game.factions.filter((f) => f.alive && f.cells > mine.cells).length + 1;
  const stats: [string, string][] = [
    ['Spielzeit', `${Math.floor(seconds / 60)}:${`${seconds % 60}`.padStart(2, '0')} min`],
    ['Größte Ausdehnung', `${s.peakCells} Zellen (${((100 * s.peakCells) / s.game.landCells).toFixed(1)} % der Landfläche)`],
    ['Gebäude am Ende', `${s.game.buildings.filter((b) => b.owner === mine.id).length}`],
    ...(won ? [] : ([['Stärkste Macht', s.game.factions.filter((f) => f.alive).sort((a, b) => b.cells - a.cells)[0]?.name ?? '–']] as [string, string][])),
    ...(mine.alive ? ([['Rang', `${rank}`]] as [string, string][]) : []),
  ];
  $('gameover-title').textContent = won ? 'Sieg!' : 'Niederlage';
  $('gameover-text').textContent = won ? `${mine.name} beherrscht die Karte.` : `Das Reich ${mine.name} ist gefallen.`;
  $('gameover-stats').replaceChildren(...stats.flatMap(([label, value]) => [Object.assign(document.createElement('dt'), { textContent: label }), Object.assign(document.createElement('dd'), { textContent: value })]));
  showBanner('');
  gameover.showModal();
}

// --- small UI helpers --------------------------------------------------------

let toastTimer = 0;
function toast(text: string): void {
  if (!text) return;
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 3000);
}

function showBanner(text: string): void {
  if (banner.textContent !== text) banner.textContent = text;
  banner.hidden = !text;
}

const flagOf = (f: Faction) => {
  const flag = factionFlag(f);
  return flag ? flagImage(flag).url : undefined;
};
const kindLabel = (f: Faction) =>
  f.type === 'HUMAN_NATION' ? 'Spieler' : f.type === 'AI_NATION' ? 'KI-Nation' : f.elite ? 'Elite-Stamm' : 'Stamm';

/** Sends one of the player's orders on its way; `say` turns its outcome into a message once it has been executed. */
function order(cmd: PlayerCommand, say: (result: CommandResult) => string): void {
  if (!session) return;
  session.feedback.push(say);
  session.lockstep.issue(cmd);
}

// --- map selection -------------------------------------------------------------

/** Only the host of a room picks map and level; while a map loads, nobody picks anything. */
function refreshMapButtons(): void {
  const locked = busy || (lobby !== null && !lobby.isHost);
  for (const b of [...$('maps').querySelectorAll('button'), ...levelButtons]) b.disabled = locked;
  const play = $<HTMLButtonElement>('play');
  play.disabled = locked || !selectedPack();
  play.textContent = room === null ? '⚔️ Einzelspieler starten' : lobby?.isHost ? '⚔️ Spiel für alle starten' : 'Warte auf den Host …';
  // The tutorial is a game of one.
  $<HTMLButtonElement>('tutorial-start').disabled = busy || room !== null;
}

function showMenu(): void {
  generation++;
  if (session && lobby?.isHost) void lobby.net.send('end', 1);
  if (gameover.open) gameover.close('watch');
  lobby?.net.on('turn', () => {}); // a game we left no longer listens
  session = null;
  tutorial = null;
  renderGuide();
  busy = false;
  if (map.getLayer(LAYER)) map.removeLayer(LAYER);
  if (map.getSource(LAYER)) map.removeSource(LAYER);
  hud.hidden = true;
  $('hover').textContent = '';
  $('offers').hidden = true;
  $('hotbar').hidden = $('troops').hidden = $('speed').hidden = $('ranking').hidden = $('game-menu').hidden = true;
  $<HTMLDetailsElement>('game-menu').open = false;
  $('alarms').replaceChildren();
  alarmButtons.clear();
  radial.close();
  setMode(null);
  labels.canvas.width = 0; // clears the labels; drawLabels resizes it again
  showBanner('');
  status.textContent = '';
  menu.hidden = false;
  refreshMapButtons();
  flyToSelected();
}

/**
 * Starts a game on a finished terrain grid. Runs for the host, for a player
 * alone and for a client alike; the game and its lockstep exist before the
 * first await, so no turn sent right after the start can be missed.
 */
async function begin(pack: MapPackDefinition, terrain: Uint8Array, seed: number, difficulty: Difficulty, hostId?: string): Promise<void> {
  const mine = ++generation;
  const proj = new GridProjection(pack.bbox, pack.grid.width);
  const game = createGame(pack, proj, terrain, seed, difficulty);
  const lockstep = new Lockstep(game, lobby?.net ?? null, hostId);
  const painter = new TerritoryPainter(proj.width, proj.height);
  const s: Session = { pack, proj, game, lockstep, painter, over: false, running: false, startedAt: performance.now(), selected: -1, wars: new Set(), offers: '', feedback: [], heardTick: -1, peakCells: 0 };
  lockstep.onResult = (cmd, result) => {
    toast(s.feedback.shift()?.(result) ?? '');
    watchTutorial(s, cmd, result);
    // The free-land shortcut fires on every click there; its refusals are not worth a buzz.
    if (result === 'ok' || result === 'pending') play(ORDER_SOUND[cmd.type] ?? 'order');
    else if (!(cmd.type === 'attack' && cmd.target === NEUTRAL)) play('refuse');
  };
  if (map.getLayer(LAYER)) map.removeLayer(LAYER);
  if (map.getSource(LAYER)) map.removeSource(LAYER);
  session = s;
  painter.paint(game);

  await mapReady;
  if (mine !== generation) return;
  const [west, south, east, north] = pack.bbox;
  map.addSource(LAYER, {
    type: 'canvas',
    canvas: painter.canvas,
    animate: false,
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
  });
  // Below the basemap's labels, so place names stay readable on top of territories.
  // The border lines stay on top of the territories.
  const above = map.getLayer(BORDER_LAYERS[0]) ? BORDER_LAYERS[0] : map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addLayer({ id: LAYER, type: 'raster', source: LAYER, paint: { 'raster-resampling': 'nearest', 'raster-fade-duration': 0, 'raster-opacity': 0.85 } }, above);
  void showBorders(pack, true);
  map.setMinZoom(pack.zoom.min);
  map.setMaxZoom(pack.zoom.max);
  // Room at the bottom for the hotkey bar.
  map.fitBounds([west, south, east, north], { padding: { top: 20, left: 20, right: 20, bottom: 90 }, duration: 0 });

  busy = false;
  menu.hidden = true;
  hud.hidden = false;
  $<HTMLProgressElement>('loading').hidden = true;
  dirty = true;
  for (const id of ['nation-dialog', 'lobby-dialog']) $<HTMLDialogElement>(id).close();
  // Whoever has started a game no longer needs the tutorial pointed out.
  localStorage.setItem('osm-front:seen-help', '1');
  $('tutorial-start').classList.remove('suggest');
  if (tutorial) prepareTutorial(s);
  renderGuide();
}

/** Loads a map's terrain and starts the game - for everybody in the room, if there is one. */
async function startMap(pack: MapPackDefinition, level: Difficulty = difficulty): Promise<void> {
  const mine = ++generation;
  busy = true;
  refreshMapButtons();
  status.textContent = `Lade Terrain für ${pack.name} …`;
  const loading = $<HTMLProgressElement>('loading');
  loading.removeAttribute('value'); // indeterminate until the first tile is in
  loading.hidden = false;
  try {
    const proj = new GridProjection(pack.bbox, pack.grid.width);
    const terrain = await loadTerrain(pack, proj, (done, total) => (loading.value = done / total));
    if (mine !== generation) return;
    const seed = (Math.random() * 2 ** 32) >>> 0;
    // Everybody plays on the host's grid: no peer derives terrain of its own that could differ.
    // A mask inside the pack would only be dead weight on the wire.
    if (lobby) {
      await lobby.net.send('start', { pack: { ...pack, terrain: { type: 'osm' } }, seed, difficulty: level });
      await lobby.net.send('grid', terrain);
    }
    if (mine !== generation) return;
    await begin(pack, terrain, seed, level);
  } catch (err) {
    if (mine !== generation) return;
    console.error(err);
    loading.hidden = true;
    status.textContent = `Terrain konnte nicht geladen werden (${err instanceof Error ? err.message : err}). Bitte erneut versuchen.`;
    busy = false;
    tutorial = null;
    refreshMapButtons();
  }
}

// --- start screen: nation card, map tiles, launch buttons ---------------------------

const CONTINENTS = new Set(['World', 'Europe', 'Asia', 'Americas', 'NorthAmerica', 'SouthAmerica', 'Australia', 'Antarctica']);
const PRESET_IDS = new Set(mapRegistry.list().map((p) => p.id));
type Tab = 'continents' | 'regions' | 'custom';
const tabOf = (id: string): Tab => (CONTINENTS.has(id) ? 'continents' : PRESET_IDS.has(id) ? 'regions' : 'custom');
let selectedMap = localStorage.getItem('osm-front:map') ?? 'Europe';
const selectedPack = () => mapRegistry.get(selectedMap);
let tab: Tab = 'continents';

/** Where on the globe a map lies: its box on a small plate carrée. */
function locator(pack: MapPackDefinition): string {
  const [w, s, e, n] = pack.bbox;
  const lines = [-120, -60, 0, 60, 120].map((x) => `<path d="M${x + 180} 0V180"/>`).join('') + [-45, 0, 45].map((y) => `<path d="M0 ${90 - y}H360"/>`).join('');
  return `<svg viewBox="0 0 360 180" aria-hidden="true"><g stroke="#27496b" stroke-width="1">${lines}</g><rect x="${w + 180}" y="${90 - n}" width="${Math.max(6, e - w)}" height="${Math.max(6, n - s)}" rx="3" fill="#ffd45e55" stroke="#ffd45e" stroke-width="3"/></svg>`;
}

/** The background map travels to the selected map while the menu is open. */
function flyToSelected(): void {
  const pack = selectedPack();
  if (!pack || menu.hidden) return;
  const [w, s, e, n] = pack.bbox;
  map.setMinZoom(0);
  map.setMaxZoom(22);
  map.fitBounds([w, s, e, n], { padding: 40, duration: 1500 });
  void showBorders(pack, false);
}

function showMaps(): void {
  for (const b of $('map-tabs').querySelectorAll('button')) b.setAttribute('aria-selected', `${b.dataset.tab === tab}`);
  for (const b of $('maps').querySelectorAll('button')) {
    b.hidden = tabOf(b.dataset.map!) !== tab;
    b.setAttribute('aria-pressed', `${b.dataset.map === selectedMap}`);
  }
  $('custom').hidden = tab !== 'custom';
  refreshMapButtons();
}

function selectMap(id: string): void {
  if (!mapRegistry.get(id)) return;
  selectedMap = id;
  localStorage.setItem('osm-front:map', id);
  tab = tabOf(id);
  showMaps();
  flyToSelected();
}

function addMapButton(pack: MapPackDefinition): void {
  const proj = new GridProjection(pack.bbox, pack.grid.width);
  const nations = pack.spawns.filter((sp) => sp.kind === 'nation').length;
  const button = Object.assign(document.createElement('button'), { type: 'button' });
  button.dataset.map = pack.id;
  // The locator is built from numbers only; names go in as text.
  button.innerHTML = locator(pack);
  button.append(Object.assign(document.createElement('strong'), { textContent: pack.name }), Object.assign(document.createElement('small'), { textContent: `${proj.width} × ${proj.height} · ${nations} Nationen` }));
  button.addEventListener('click', () => selectMap(pack.id));
  // A re-imported map replaces its old tile.
  const old = [...$('maps').querySelectorAll('button')].find((b) => b.dataset.map === pack.id);
  if (old) old.replaceWith(button);
  else $('maps').append(button);
  // A map the player has just made is the one they want.
  if (menuReady && !PRESET_IDS.has(pack.id)) selectMap(pack.id);
  else showMaps();
}
let menuReady = false;
for (const pack of mapRegistry.list()) addMapButton(pack);
setupCustomMaps(map, addMapButton, (text) => (status.textContent = text), (visible) => (menu.hidden = !visible));
menuReady = true;
for (const b of $('map-tabs').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    tab = b.dataset.tab as Tab;
    showMaps();
  });
}
if (!selectedPack()) selectedMap = 'Europe';
tab = tabOf(selectedMap);
showMaps();
void mapReady.then(flyToSelected);

/** The player's own nation, as made in the editor. It goes out with the spawn command and to the room. */
let nation = setupNationEditor($<HTMLFormElement>('nation-form'), (edited) => {
  nation = edited;
  showNation();
  lobby?.present(edited);
});
function showNation(): void {
  $<HTMLImageElement>('nation-flag').src = flagImage(nation.flag).url;
  $('nation-name').textContent = nation.name;
  $('nation-ruler').textContent = `Herrscher: ${nation.ruler}`;
  $('nation-doctrine').textContent = doctrineRegistry.get(nation.doctrine)?.name ?? '';
  $('nation-card').style.setProperty('--nation', nation.primary);
}
showNation();
$('nation-edit').addEventListener('click', () => $<HTMLDialogElement>('nation-dialog').showModal());
$('lobby-open').addEventListener('click', () => $<HTMLDialogElement>('lobby-dialog').showModal());
$('play').addEventListener('click', () => {
  const pack = selectedPack();
  if (pack) void startMap(pack);
});
$('tutorial-start').addEventListener('click', () => {
  const pack = mapRegistry.get('Balkans');
  if (!pack) return;
  tutorial = new Tutorial();
  void startMap(pack, 'easy');
});
// First visit: point at the tutorial.
if (!localStorage.getItem('osm-front:seen-help')) {
  $('tutorial-start').classList.add('suggest');
  status.textContent = 'Neu hier? Das Tutorial zeigt dir in einer Minute, wie gespielt wird.';
}

$('to-menu').addEventListener('click', showMenu);
// The game menu closes after a pick, and when the player clicks anywhere else.
for (const id of ['help-open', 'export-map']) $(id).addEventListener('click', () => ($<HTMLDetailsElement>('game-menu').open = false));
addEventListener('pointerdown', (e) => {
  const gm = $<HTMLDetailsElement>('game-menu');
  if (gm.open && !gm.contains(e.target as Node)) gm.open = false;
});
$('export-map').addEventListener('click', () => {
  if (session) exportPack(session.pack, session.game.terrain, session.proj.width, session.proj.height);
});
// One troop share, two sliders: the one above the hotkey bar and the one on the context menu.
const share = $<HTMLInputElement>('share');
function setStrength(percent: number): void {
  const value = `${Math.max(5, Math.min(100, Math.round(percent / 5) * 5))}`;
  strength.value = share.value = value;
  $('strength-value').textContent = $('share-value').textContent = `${value} %`;
  radial.refresh();
}
for (const slider of [strength, share]) slider.addEventListener('input', () => setStrength(Number(slider.value)));
// The wheel sets the share over the slider, and anywhere with Shift held; otherwise it zooms the map.
addEventListener(
  'wheel',
  (e) => {
    if (!session || !menu.hidden || !(e.shiftKey || $('troops').contains(e.target as Node))) return;
    e.preventDefault();
    e.stopPropagation();
    setStrength(Number(strength.value) + ((e.deltaY || e.deltaX) < 0 ? 5 : -5));
  },
  { capture: true, passive: false },
);

// --- multiplayer lobby -----------------------------------------------------------

const roomOf = () => /^[\w-]{3,40}$/.exec(new URLSearchParams(location.hash.slice(1)).get('room') ?? '')?.[0] ?? null;
const hostKey = (room: string) => `osm-front:host:${room}`;

function renderLobby(): void {
  $('lobby-off').hidden = lobby !== null || room !== null;
  $('lobby-on').hidden = room === null;
  if (!lobby) return;
  const host = lobby.hostId;
  const row = (n: NationProfile, id: string) => {
    const li = document.createElement('li');
    li.append(flagElement(n.flag), `${n.ruler} von ${n.name}${id === host ? ' (Host)' : ''}${id === lobby!.net.selfId ? ' – du' : ''}`);
    return li;
  };
  $('players').replaceChildren(row(lobby.nation, lobby.net.selfId), ...[...lobby.roster].map(([id, p]) => row(p.nation, id)));
  const relays = lobby.net.relays?.();
  const reach =
    lobby.net.kind === 'server'
      ? relays?.open
        ? ' (über den OSM-Front-Server)'
        : ' Die Verbindung zum Server ist abgerissen – Raum neu laden.'
      : !relays
        ? ''
        : relays.open > 0
          ? ` (Peer-to-Peer, ${relays.open} von ${relays.total} Vermittlungs-Relays erreichbar)`
          : ' Kein Vermittlungs-Relay ist erreichbar: andere Spieler finden diesen Raum gerade nicht.';
  $('lobby-status').textContent =
    (lobby.isHost
      ? `Schließe dieses Fenster, wähle Karte und Schwierigkeit und drücke „Spiel für alle starten“ (${lobby.roster.size + 1} im Raum).`
      : host
        ? 'Der Host wählt Karte und Schwierigkeit. Es geht los, sobald er startet.'
        : 'Warte auf den Host …') + reach;
  refreshMapButtons();
  if (session && !session.over && !lobby.isHost && !host) {
    session.over = true;
    showBanner('Der Host hat das Spiel verlassen.');
  }
}

async function enterRoom(id: string): Promise<void> {
  room = id;
  $<HTMLInputElement>('room-link').value = location.href;
  $('lobby-status').textContent = 'Verbinde …';
  renderLobby();
  refreshMapButtons();
  let net: Transport;
  try {
    // `?net=local` connects the tabs of one browser, for development and tests without relays.
    const params = new URLSearchParams(location.search);
    // The relay server, if this build knows one (or the address bar names one); peer to peer otherwise,
    // and as the fallback when the server cannot be reached. `?net=p2p` skips the server.
    const relay = params.get('relay') ?? import.meta.env.VITE_RELAY_URL;
    if (params.get('net') === 'local') net = localTransport(id);
    else if (relay && params.get('net') !== 'p2p') {
      net = await relayTransport(relay, id).catch((err) => {
        console.warn('relay server unreachable, falling back to peer-to-peer', err);
        return trysteroTransport(id);
      });
    } else net = await trysteroTransport(id);
  } catch (err) {
    console.error(err);
    $('lobby-status').textContent = 'Die Verbindung zum Raum ist fehlgeschlagen.';
    return;
  }
  lobby = new Lobby(net, sessionStorage.getItem(hostKey(id)) === '1', nation);
  lobby.onChange = renderLobby;
  // The host's game arrives as the map and the seed, followed by its terrain grid.
  let announced: { pack: MapPackDefinition; seed: number; difficulty: Difficulty } | null = null;
  net.on('start', (data, from) => {
    if (from === lobby!.hostId && !lobby!.isHost) announced = data;
  });
  net.on('grid', (data, from) => {
    const start = announced;
    announced = null;
    if (from !== lobby!.hostId || lobby!.isHost || !start) return;
    const terrain = new Uint8Array(data);
    const proj = validateMapPack(start.pack).length ? null : new GridProjection(start.pack.bbox, start.pack.grid.width);
    if (!proj || terrain.length !== proj.width * proj.height || terrain.some((t) => t > Terrain.OUT_OF_BOUNDS) || !Number.isInteger(start.seed)) {
      $('lobby-status').textContent = 'Der Host hat eine ungültige Karte gesendet.';
      return;
    }
    void begin(start.pack, terrain, start.seed >>> 0, start.difficulty in DIFFICULTY ? start.difficulty : 'normal', from);
  });
  net.on('end', (_data, from) => {
    if (from === lobby!.hostId && session) {
      showMenu();
      status.textContent = 'Der Host hat das Spiel beendet.';
    }
  });
  renderLobby();
}

$('room-create').addEventListener('click', () => {
  const id = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => (b % 36).toString(36)).join('');
  sessionStorage.setItem(hostKey(id), '1');
  room = id;
  location.hash = `room=${id}`;
  void enterRoom(id);
});
$('room-copy').addEventListener('click', () => {
  const link = $<HTMLInputElement>('room-link');
  link.select();
  navigator.clipboard?.writeText(link.value).then(
    () => ($('lobby-status').textContent = 'Link kopiert.'),
    () => {},
  );
});
$('room-leave').addEventListener('click', () => {
  lobby?.net.leave();
  location.href = location.pathname + location.search;
});
// Another room in the address bar is another session.
addEventListener('hashchange', () => {
  if (roomOf() !== room) location.reload();
});
if (roomOf()) {
  void enterRoom(roomOf()!);
  $<HTMLDialogElement>('lobby-dialog').showModal();
} else renderLobby();
// Relays connect and drop in the background; keep the lobby's picture of them current.
setInterval(() => {
  if (lobby && !menu.hidden) renderLobby();
}, 3000);

// --- player input: modes, preview and pointer -----------------------------------

/** What the next click on the map does instead of opening the context menu. */
type Mode = { kind: 'build'; def: BuildingDefinition } | { kind: 'target'; unit: UnitDefinition } | null;
let mode: Mode = null;
/** Cell under the mouse, or -1. */
let hoverCell = -1;
let ghost: Ghost | null = null;
const refusal = (result: CommandResult) => (result === 'ok' || result === 'pending' || result === 'refused' ? 'Das geht gerade nicht.' : REFUSAL[result]);
const distance = (game: Game, a: number, b: number) => Math.max(Math.abs((a % game.width) - (b % game.width)), Math.abs(Math.floor(a / game.width) - Math.floor(b / game.width)));
const basesFor = (game: Game, owner: number, unit: UnitDefinition) => game.buildings.filter((b) => b.owner === owner && b.def.id === unit.base);

/** Why this unit cannot be sent at this cell right now ('' if it can). Sea routes are only known once ordered. */
function launchProblem(game: Game, mine: Faction, unit: UnitDefinition, cell: number): string {
  const bases = basesFor(game, mine.id, unit);
  if (bases.length === 0) return `Braucht ${buildingRegistry.get(unit.base)?.name}`;
  if (!bases.some((b) => !b.def.magazine || b.charges > 0)) {
    const ready = Math.min(...bases.map((b) => b.readyAt)) - game.tick;
    return `Lädt nach (${Math.max(1, Math.ceil(ready / TICKS_PER_SECOND))} s)`;
  }
  if (unit.domain !== 'sea') {
    if (game.terrain[cell] === Terrain.WATER || game.owner[cell] === mine.id) return 'Kein gültiges Ziel';
    if (!bases.some((b) => distance(game, b.cell, cell) <= unit.range)) return 'Außer Reichweite';
  }
  return mine.gold < unitCost(game, mine.id, unit) ? 'Zu wenig Gold' : '';
}

/** The preview that follows the mouse in build or target mode: what, how far it reaches, and whether it works here. */
/** The player's building on or right next to a cell: badges are bigger than one cell. */
function buildingNear(game: Game, owner: number, cell: number): Building | undefined {
  const at = game.nearest(cell, 1, (c) => game.buildingAt.get(c)?.owner === owner);
  return at < 0 ? undefined : game.buildingAt.get(at);
}

/** What a building does at a level, for previews and the hover line. */
function describe(b: Building | null, def: BuildingDefinition, level: number): string[] {
  const parts: string[] = [];
  const k = 1 + (level - 1) / 2;
  if (def.capacity) parts.push(`+${Math.round(def.capacity * k)} Bevölkerung`);
  if (def.income) parts.push(`${(def.income * k).toFixed(1)} Gold/Tick`);
  if (def.fort) parts.push(`Radius ${def.fort.radius + level - 1}`);
  if (def.intercept) parts.push(`Abfangradius ${Math.round((def.intercept.radius * (3 + level)) / 4)}`);
  if (def.magazine) parts.push(`${level} ${level === 1 ? 'Schuss' : 'Schüsse'} je Ladung`);
  if (def.supply) parts.push(`versorgt im Umkreis ${def.supply.radius + 2 * (level - 1)}`);
  if (b && b.supplier >= 0) parts.push(`versorgt: +${b.boost} %`);
  return parts;
}

function updateGhost(): void {
  const mine = me();
  ghost = null;
  // The marks show for as long as a city is being placed, wherever the pointer is.
  cityMarks = session && mine?.alive && mode?.kind === 'build' && mode.def.settles ? freeCities(session.game) : [];
  if (!session || !mine?.alive || !mode || hoverCell < 0) return;
  const { game } = session;
  if (mode.kind === 'target') {
    const hint = launchProblem(game, mine, mode.unit, hoverCell);
    ghost = { cell: hoverCell, icon: mode.unit.icon, ok: !hint, hint, rings: mode.unit.blast ? [{ radius: mode.unit.blast.radius, label: 'Wirkungsradius' }] : [], links: [] };
    return;
  }
  const def = mode.def;
  // On one of the player's own buildings of this kind, the next click upgrades it.
  const own = buildingNear(game, mine.id, hoverCell);
  if (own && own.def === def) {
    const result = canUpgrade(game, mine.id, own.cell);
    const next = Math.min(MAX_LEVEL, own.level + 1);
    const rings: Ghost['rings'] = [];
    if (def.intercept) rings.push({ radius: (def.intercept.radius * (3 + next)) / 4, label: `Abfangradius Stufe ${next}` });
    if (def.fort) rings.push({ radius: def.fort.radius + next - 1, label: `Verteidigung Stufe ${next}` });
    if (def.supply) rings.push({ radius: def.supply.radius + 2 * (next - 1), label: `Versorgung Stufe ${next}` });
    const hint = result === 'ok' ? `⬆ Stufe ${next}: ${Math.ceil(upgradeCost(own))} Gold · ${describe(null, def, next).join(', ')}` : result === 'level' ? 'Höchste Stufe erreicht' : `⬆ Stufe ${next}: zu wenig Gold (${Math.ceil(upgradeCost(own))})`;
    ghost = { cell: own.cell, icon: '⬆', ok: result === 'ok', hint, rings, links: [] };
    return;
  }
  const result = canBuild(game, mine.id, def.id, hoverCell);
  const rings: Ghost['rings'] = [];
  if (def.supply) rings.push({ radius: def.supply.radius, label: `Versorgt Gebäude: +${def.supply.pct} %` });
  if (def.fort) rings.push({ radius: def.fort.radius, label: `Verteidigung +${def.fort.defensePct} %` });
  if (def.intercept) rings.push({ radius: def.intercept.radius, label: def.arming ? `Abfangradius · aktiv nach ${def.arming / TICKS_PER_SECOND} s` : 'Abfangradius' });
  // What the units based here would cover.
  for (const u of unitRegistry.list()) {
    if (u.base !== def.id) continue;
    if (u.intercept) rings.push({ radius: u.intercept.radius, label: `${u.name}: Abfangradius` });
    else if (u.domain !== 'sea') rings.push({ radius: u.range, label: `${u.name}: Reichweite` });
  }
  let hint = result === 'ok' ? '' : (BUILD_HINT[result] ?? 'Hier nicht möglich');
  const links: number[] = [];
  if (def.income && def.linkBonusPct && game.owner[hoverCell] === mine.id) {
    const city = linkedCity(game, mine.id, hoverCell);
    if (city >= 0) links.push(city);
    if (result === 'ok') hint = city >= 0 ? `Anschluss an eine Stadt: +${def.linkBonusPct} %` : 'Ohne Straßen-/Schienenanschluss';
  }
  // A city on a real city merges with it.
  cityMarks = def.settles ? freeCities(game) : [];
  const city = def.settles ? game.realCityNear(hoverCell) : null;
  if (city && result === 'ok') hint = `Standort-Bonus: ${city.name} (${cityBonus(city)})`;
  ghost = { cell: hoverCell, icon: def.icon, ok: result === 'ok', hint, rings, links };
}

/** Real cities to mark on the map while a city is being placed. */
let cityMarks: { cell: number; label: string }[] = [];
const cityBonus = (c: RealCity) => {
  const t = CITY_TIERS[c.tier];
  return `+${t.growthPct} % Wachstum${t.incomePct ? `, +${t.incomePct} % Gold` : ''}`;
};
const freeCities = (game: Game) => game.cities.filter((c) => !game.buildings.some((b) => b.city === c)).map((c) => ({ cell: c.cell, label: `${c.name} +${CITY_TIERS[c.tier].growthPct} %` }));

const canvasEl = map.getCanvas();
function updateCursor(): void {
  let kind: CursorKind = 'default';
  const mine = me();
  if (session && mine?.alive) {
    const { game } = session;
    const owner = hoverCell < 0 ? mine.id : game.owner[hoverCell];
    if (mode) kind = mode.kind;
    else if (owner !== NEUTRAL && owner !== mine.id && mine.neighbors.includes(owner)) kind = 'attack';
    else if (owner !== mine.id && game.terrain[hoverCell] !== Terrain.WATER && game.touchesWater(hoverCell) && game.buildings.some((b) => b.owner === mine.id && b.def.coastal)) kind = 'landing';
  }
  setCursor(canvasEl, kind);
}

function setMode(next: Mode): void {
  if (next) {
    radial.close();
    play('click');
  }
  mode = next;
  refreshHotbar();
  updateGhost();
  updateCursor();
}

// --- hotkey bar -------------------------------------------------------------------

interface Slot {
  key: string;
  mode: NonNullable<Mode>;
  button: HTMLButtonElement;
  price: HTMLElement;
}
const slots: Slot[] = [];
{
  const add = (key: number, slotMode: NonNullable<Mode>, icon: string, name: string, art: string) => {
    const button = Object.assign(document.createElement('button'), { type: 'button', title: name });
    const price = document.createElement('small');
    const picture = art ? Object.assign(new Image(), { src: art, alt: '', className: 'art' }) : Object.assign(document.createElement('b'), { textContent: icon });
    button.append(Object.assign(document.createElement('kbd'), { textContent: `${key}` }), picture, price);
    button.setAttribute('aria-label', `${name} (Taste ${key})`);
    const slot: Slot = { key: `${key}`, mode: slotMode, button, price };
    button.addEventListener('click', () => toggleSlot(slot));
    slots.push(slot);
    return button;
  };
  const buildings = buildingRegistry.list().slice(0, 7);
  const units = TARGET_HOTKEYS.map((id) => unitRegistry.get(id)!);
  $('hotbar').append(
    ...buildings.map((def, i) => add(i + 1, { kind: 'build', def }, def.icon, def.name, buildingIconUrl(def.id))),
    Object.assign(document.createElement('span'), { className: 'gap' }),
    ...units.map((unit, i) => add(buildings.length + 1 + i, { kind: 'target', unit }, unit.icon, unit.name, unitIconUrl(unit.id))),
  );
}
const sameMode = (a: Mode, b: Mode) => a !== null && b !== null && (a.kind === 'build' ? b.kind === 'build' && a.def === b.def : b.kind === 'target' && a.unit === b.unit);
const toggleSlot = (slot: Slot) => setMode(sameMode(mode, slot.mode) ? null : slot.mode);

function refreshHotbar(): void {
  const mine = me();
  $('hotbar').hidden = $('troops').hidden = !session || !mine?.alive;
  if (!session || !mine) return;
  for (const slot of slots) {
    const cost = slot.mode.kind === 'build' ? price(session.game, mine.id, slot.mode.def) : unitCost(session.game, mine.id, slot.mode.unit);
    const text = `${Math.ceil(cost)}`;
    if (slot.price.textContent !== text) slot.price.textContent = text;
    slot.button.classList.toggle('poor', mine.gold < cost);
    slot.button.setAttribute('aria-pressed', `${sameMode(mode, slot.mode)}`);
  }
}

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setMode(null);
  if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest?.('input:not([type=range]), select, textarea, dialog')) return;
  if (e.key === 'm' || e.key === 'M') {
    setVolume(getVolume() > 0 ? 0 : unmuted);
    showVolume();
    toast(getVolume() > 0 ? 'Ton an.' : 'Ton aus.');
  }
  if (!session || !menu.hidden) return;
  if (e.key === 'h' || e.key === 'H') help.showModal();
  if (!me()?.alive) return;
  const slot = slots.find((s) => s.key === e.key);
  if (slot) toggleSlot(slot);
  const turn = { q: -10, e: 10 }[e.key.toLowerCase()];
  if (turn) setStrength(Number(strength.value) + turn);
});

// --- camera keys: WASD and arrows -----------------------------------------------------

const PAN_KEYS: Record<string, [number, number]> = { w: [0, -1], arrowup: [0, -1], s: [0, 1], arrowdown: [0, 1], a: [-1, 0], arrowleft: [-1, 0], d: [1, 0], arrowright: [1, 0] };
/** Screen pixels per second: the same on every zoom level, so the ground covered follows the zoom. */
const PAN_SPEED = 700;
const held = new Set<string>();
addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (!(key in PAN_KEYS) || e.ctrlKey || e.metaKey || e.altKey || !session || !menu.hidden || (e.target as HTMLElement).closest?.('input, select, textarea, dialog')) return;
  e.preventDefault();
  held.add(key);
});
addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));
addEventListener('blur', () => held.clear());
let panAt = 0;
/** Moves the camera for the keys held down; called once per frame. */
function panCamera(now: number): void {
  const dt = Math.min(0.1, (now - panAt) / 1000);
  panAt = now;
  if (held.size === 0 || !session || !menu.hidden) return held.clear();
  let dx = 0;
  let dy = 0;
  for (const key of held) {
    dx += PAN_KEYS[key][0];
    dy += PAN_KEYS[key][1];
  }
  if (dx || dy) map.panBy([dx * PAN_SPEED * dt, dy * PAN_SPEED * dt], { animate: false });
}

// --- game speed -------------------------------------------------------------------------

const SPEED_LABEL: Record<number, string> = { 0: '⏸', 0.5: '0.5x', 1: '1x', 2: '2x', 4: '4x' };
const speedButtons = SPEEDS.map((speed) => {
  const button = Object.assign(document.createElement('button'), { type: 'button', textContent: SPEED_LABEL[speed] });
  button.dataset.speed = `${speed}`;
  button.setAttribute('aria-label', speed === 0 ? 'Pause (Leertaste)' : `Geschwindigkeit ${SPEED_LABEL[speed]}`);
  button.addEventListener('click', () => {
    setSpeed(speed);
    button.blur(); // the space bar pauses the game, not this button again
  });
  return button;
});
$('speed').append(...speedButtons);
/** The speed to come back to from a pause. */
let resumeSpeed = 1;
/** Only the host of a game sets its speed; in a game of one that is the player. */
function setSpeed(speed: number): void {
  const ls = session?.lockstep;
  if (!ls) return;
  if (!ls.host) return toast('Nur der Host kann das Spieltempo ändern.');
  if (speed !== 0) resumeSpeed = speed;
  if (ls.setSpeed(speed)) play('click');
}
function refreshSpeed(): void {
  const ls = session?.lockstep;
  $('speed').hidden = $('game-menu').hidden = !ls || !menu.hidden;
  if (!ls) return;
  for (const b of speedButtons) {
    const pressed = `${Number(b.dataset.speed) === ls.speed}`;
    if (b.getAttribute('aria-pressed') !== pressed) b.setAttribute('aria-pressed', pressed);
    if (b.disabled !== !ls.host) b.disabled = !ls.host;
  }
  const title = ls.host ? 'Leertaste: Pause · + / − : schneller / langsamer' : 'Der Host bestimmt das Spieltempo.';
  if ($('speed').title !== title) $('speed').title = title;
}
addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  // A focused button takes the space bar for itself; everything else is ours.
  if (!session || !menu.hidden || e.ctrlKey || e.metaKey || e.altKey || target.closest?.('input:not([type=range]), select, textarea, dialog') || (e.key === ' ' && target.closest?.('button'))) return;
  const speed = session.lockstep.speed;
  const i = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
  if (e.key === ' ') {
    e.preventDefault();
    setSpeed(speed === 0 ? resumeSpeed : 0);
  } else if (e.key === '+' || e.key === '.') setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, i + 1)]);
  else if (e.key === '-' || e.key === ',') setSpeed(SPEEDS[Math.max(1, i - 1)]);
});
// Right click: out of build or target mode - or the context menu, where the pointer is.
map.on('contextmenu', (e) => {
  e.originalEvent.preventDefault();
  if (mode) return setMode(null);
  if (!session || !me()?.alive) return;
  const { lng, lat } = e.lngLat.wrap();
  const cell = session.proj.cellAt(lng, lat);
  if (cell >= 0) openMenu(cell, e.point.x, e.point.y);
});
// The middle button drags the map like the left one.
{
  const el = map.getCanvasContainer();
  let grab: { x: number; y: number } | null = null;
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    grab = { x: e.clientX, y: e.clientY };
  });
  addEventListener('mousemove', (e) => {
    if (!grab) return;
    map.panBy([grab.x - e.clientX, grab.y - e.clientY], { animate: false });
    grab = { x: e.clientX, y: e.clientY };
  });
  addEventListener('mouseup', () => (grab = null));
}

// --- left click: act at once ---------------------------------------------------------

let spawning = false;
map.on('click', (e) => {
  // The click that closes the context menu does nothing else.
  if (!session || radial.justDismissed) return;
  const s = session;
  const { game, proj } = s;
  const { lng, lat } = e.lngLat.wrap();
  const cell = proj.cellAt(lng, lat);
  if (cell < 0) return;

  const mine = me();
  if (!mine) {
    if (spawning) return;
    spawning = true;
    order({ type: 'spawn', cell, nation }, (result) => {
      spawning = false;
      return result === 'ok' ? 'Linksklick auf Nachbarland greift an, Rechtsklick öffnet das Menü.' : 'Hier ist kein freies Land für ein Startgebiet.';
    });
    return;
  }
  if (!mine.alive) return;
  if (mode?.kind === 'build') {
    const def = mode.def;
    const own = buildingNear(game, mine.id, cell);
    if (own && own.def === def) return order({ type: 'upgrade', cell: own.cell }, (result) => (result === 'ok' ? `${def.name} auf Stufe ${own.level} ausgebaut.` : refusal(result)));
    return order({ type: 'build', def: def.id, cell }, (result) => {
      const city = s.game.buildingAt.get(cell)?.city;
      return result !== 'ok' ? refusal(result) : city ? `🏙️ ${city.name} (${CITY_TIERS[city.tier].label}): ${cityBonus(city)}.` : `${def.name} gebaut.`;
    });
  }
  if (mode?.kind === 'target') {
    const unit = mode.unit;
    return order({ type: 'launch', unit: unit.id, cell, percent: Number(strength.value) }, (result) => (result === 'ok' ? `${unit.name}: Befehl erteilt.` : refusal(result)));
  }
  const owner = game.owner[cell];
  if (owner === mine.id) {
    // Own land: nothing to attack. A building there is picked out.
    const b = buildingNear(game, mine.id, cell);
    s.selected = b ? b.cell : -1;
    if (b) toast(`${b.def.icon} ${b.def.name} · Stufe ${b.level} · ${b.hp}/${b.def.hp + b.level - 1} Treffer${describe(b, b.def, b.level).length ? ` · ${describe(b, b.def, b.level).join(', ')}` : ''} – Rechtsklick zum Ausbauen`);
    return;
  }
  s.selected = -1;
  if (!isLand(game.terrain[cell])) return;
  const f = game.factions[owner];
  const percent = Number(strength.value);
  if (owner === NEUTRAL) return order({ type: 'attack', target: NEUTRAL, percent }, (result) => (result === 'ok' ? `Vorstoß in freies Land mit ${percent} % deiner Truppen.` : ''));
  // A treaty is not broken by a slip of the finger: that takes the context menu.
  const treaty = game.diplo.status(game, mine.id, owner);
  if (treaty === 'Alliance' || treaty === 'NonAggressionPact') {
    play('refuse');
    return toast(`Mit ${f.name} gilt: ${STATUS_LABEL[treaty]}. Ein Angriff geht nur über das Rechtsklick-Menü.`);
  }
  order({ type: 'attack', target: owner, percent }, (result) =>
    result === 'ok' ? `Angriff auf ${f.name} mit ${percent} % deiner Truppen.` : 'Das Ziel grenzt nicht an dein Gebiet – Rechtsklick für Schiffe, Luftwaffe und Raketen.',
  );
});

map.on('mousemove', (e) => {
  if (!session) return;
  const { game, proj } = session;
  const { lng, lat } = e.lngLat.wrap();
  const cell = proj.cellAt(lng, lat);
  if (cell !== hoverCell) {
    hoverCell = cell;
    updateGhost();
    updateCursor();
  }
  const hover = $('hover');
  if (cell < 0) hover.textContent = ' ';
  else {
    const f = game.factions[game.owner[cell]];
    const who = f.id === NEUTRAL ? (isLand(game.terrain[cell]) ? 'Freies Land · ' : '') : `${f.nation ? `${f.nation.ruler} von ${f.name}` : `${factionIcon(f)} ${f.name}`} (${kindLabel(f)}) · ${formatTroops(f.troops)} Truppen · `;
    const b = game.buildingAt.get(cell);
    hover.textContent = `${who}${TERRAIN_LABEL[game.terrain[cell]]}${b ? ` · ${b.def.icon} ${b.city ? `${b.city.name} (${CITY_TIERS[b.city.tier].label})` : b.def.name} Stufe ${b.level}${b.armedAt > game.tick ? ` (aktiv in ${Math.ceil((b.armedAt - game.tick) / TICKS_PER_SECOND)} s)` : ''}${b.supplier >= 0 ? ' · versorgt' : ''}` : ''}${game.fallout[cell] > game.tick ? ' · verstrahlt' : ''}`;
  }
});
map.on('mouseout', () => {
  hoverCell = -1;
  updateGhost();
});

// --- context menu at the click: build wheel, target selection, diplomacy -------------

const radial = new Radial($('radial'));
radial.onClose = () => {
  if (session) session.selected = -1;
};
map.on('movestart', () => radial.close());
/** Owner of the cell the menu was opened for; when the cell changes hands the menu is stale. */
let menuOwner = -1;

function openMenu(cell: number, x: number, y: number): void {
  const s = session;
  const mine = s?.lockstep.me;
  if (!s || !mine) return;
  const { game } = s;
  const d = game.diplo;
  const owner = game.owner[cell];
  const water = game.terrain[cell] === Terrain.WATER;
  const f = game.factions[owner];
  const percent = () => Number(strength.value);
  const gold = (cost: number) => `${Math.ceil(cost)} Gold`;

  const unitItem = (unit: UnitDefinition): RadialItem => ({
    icon: unit.icon,
    art: unitIconUrl(unit.id),
    label: unit.name,
    hint: () => [gold(unitCost(game, mine.id, unit)), unit.carriesTroops ? `${percent()} % Truppen` : '', launchProblem(game, mine, unit, cell)].filter(Boolean).join(' · '),
    enabled: () => !launchProblem(game, mine, unit, cell),
    run: () =>
      order({ type: 'launch', unit: unit.id, cell, percent: percent() }, (result) => {
        if (result === 'range' && unit.trade) return 'Kein fremder Hafen ist über See erreichbar.';
        return result === 'ok' ? `${unit.name}: Befehl erteilt.` : refusal(result);
      }),
  });

  const target = owner === mine.id ? buildingNear(game, mine.id, cell) : undefined;
  const upgradeItem = (b: Building): RadialItem => ({
    icon: '⬆',
    label: b.level >= MAX_LEVEL ? `${b.def.name}: höchste Stufe` : `${b.def.name} ausbauen (Stufe ${b.level + 1})`,
    hint: () => (b.level >= MAX_LEVEL ? describe(b, b.def, b.level).join('\n') : `${Math.ceil(upgradeCost(b))} Gold\n${describe(null, b.def, b.level + 1).join('\n')}`),
    enabled: () => canUpgrade(game, mine.id, b.cell) === 'ok',
    run: () => order({ type: 'upgrade', cell: b.cell }, (result) => (result === 'ok' ? `${b.def.name} auf Stufe ${b.level} ausgebaut.` : refusal(result))),
  });
  let spec: RadialSpec;
  if (owner === mine.id) {
    spec = {
      title: target ? `${target.def.icon} ${target.def.name} · Stufe ${target.level}` : 'Dein Gebiet',
      info: () => (target ? describe(target, target.def, target.level).join('\n') : `${TERRAIN_LABEL[game.terrain[cell]]}${game.touchesWater(cell) ? ' · Küste' : ''}`),
      items: [
        ...buildingRegistry.list().map((def): RadialItem => {
          const problem = () => canBuild(game, mine.id, def.id, cell);
          return {
            icon: def.icon,
            art: buildingIconUrl(def.id),
            label: def.name,
            hint: () => [gold(price(game, mine.id, def)), problem() === 'ok' ? '' : BUILD_HINT[problem()]].filter(Boolean).join(' · '),
            enabled: () => problem() === 'ok',
            run: () => order({ type: 'build', def: def.id, cell }, (result) => (result === 'ok' ? `${def.name} gebaut.` : refusal(result))),
          };
        }),
        // The building under the pointer can be upgraded from here.
        ...(target ? [upgradeItem(target)] : []),
        {
          icon: '⚑',
          label: 'Sammelpunkt',
          hint: () => 'Truppen sammeln: +50 % Verteidigung im Umkreis',
          run: () => order({ type: 'rally', cell }, (result) => (result === 'ok' ? 'Sammelpunkt gesetzt.' : refusal(result))),
        },
        // Units that need no target: they stay at their base or find their own route.
        ...unitRegistry.list().filter((u) => u.intercept && !u.auto).map(unitItem),
      ],
    };
  } else {
    const diplomacy = (): RadialSpec => {
      const treaty = (kind: Treaty, icon: string): RadialItem => ({
        icon,
        label: `${TREATY_LABEL[kind]} anbieten`,
        enabled: () => f.alive && (kind === 'TradeAgreement' ? !d.trading(mine.id, owner) && !d.embargoed(mine.id, owner) : d.status(game, mine.id, owner) !== kind),
        run: () =>
          order({ type: 'propose', to: owner, treaty: kind }, (result) =>
            result === 'ok' ? `${f.name} nimmt an: ${TREATY_LABEL[kind]}.` : result === 'pending' ? `Angebot an ${f.name} gesendet: ${TREATY_LABEL[kind]}.` : `${f.name} lehnt ab.`,
          ),
      });
      return {
        title: f.name,
        image: flagOf(f),
        slider: true,
        info: () => {
          const pact = d.pactLeft(game, mine.id, owner);
          const extras = [pact > 0 ? `noch ${Math.ceil(pact / TICKS_PER_SECOND)} s` : '', d.trading(mine.id, owner) ? 'Handel' : '', d.embargoed(mine.id, owner) ? 'Embargo' : ''].filter(Boolean);
          return `Beziehung ${d.relation(mine.id, owner)}\n${STATUS_LABEL[d.status(game, mine.id, owner)]}${extras.length ? ` (${extras.join(', ')})` : ''}`;
        },
        items: [
          treaty('NonAggressionPact', '☮'),
          treaty('Alliance', '♥'),
          treaty('TradeAgreement', '⚖'),
          {
            icon: '¤',
            label: `${GOLD_GIFT} Gold senden`,
            enabled: () => f.alive && mine.gold >= GOLD_GIFT,
            run: () => order({ type: 'aid', to: owner, gold: GOLD_GIFT, troopsPct: 0 }, (result) => (result === 'ok' ? `${GOLD_GIFT} Gold an ${f.name} gesendet.` : refusal(result))),
          },
          {
            icon: '♟',
            label: 'Truppen senden',
            hint: () => `${percent()} % deiner Truppen`,
            enabled: () => f.alive,
            run: () => order({ type: 'aid', to: owner, gold: 0, troopsPct: percent() }, (result) => (result === 'ok' ? `Truppen an ${f.name} gesendet.` : refusal(result))),
          },
          {
            icon: '✖',
            label: d.embargoed(mine.id, owner) ? 'Embargo aufheben' : 'Embargo verhängen',
            run: () => {
              const on = !d.embargoed(mine.id, owner);
              order({ type: 'embargo', to: owner, on }, () => (on ? `Embargo gegen ${f.name}: der Handel ruht.` : `Embargo gegen ${f.name} aufgehoben.`));
            },
          },
          { icon: '↩', label: 'Zurück', stays: true, run: () => radial.open(x, y, spec) },
        ],
      };
    };
    const items: RadialItem[] = [];
    if (!water) {
      items.push({
        icon: '⚔',
        label: 'Bodenangriff',
        hint: () => (d.allied(mine.id, owner) ? 'Bricht das Bündnis!' : `${percent()} % Truppen`),
        enabled: () => (owner === NEUTRAL ? mine.bordersNeutral : mine.neighbors.includes(owner)),
        run: () => {
          const sent = percent();
          order({ type: 'attack', target: owner, percent: sent }, (result) =>
            result === 'ok' ? `Angriff auf ${owner === NEUTRAL ? 'freies Land' : f.name} mit ${sent} % deiner Truppen.` : 'Das Ziel grenzt nicht an dein Gebiet – nutze Schiffe oder Fallschirmjäger.',
          );
        },
      });
    }
    // Open water is a destination for ships only: a patrol, or an invasion of the nearest shore.
    for (const unit of unitRegistry.list()) if (!unit.intercept && !unit.auto && (!water || unit.domain === 'sea')) items.push(unitItem(unit));
    if (owner !== NEUTRAL) items.push({ icon: '✉', label: 'Diplomatie', hint: () => 'Handel, Bündnis, Hilfe', stays: true, run: () => radial.open(x, y, diplomacy()) });
    spec = {
      title: water ? 'Gewässer' : owner === NEUTRAL ? 'Freies Land' : f.name,
      image: flagOf(f),
      slider: true,
      info: () => (owner === NEUTRAL ? TERRAIN_LABEL[game.terrain[cell]] : `${kindLabel(f)}\n${formatTroops(f.troops)} Truppen`),
      items,
    };
  }
  radial.open(x, y, spec);
  play('click');
  s.selected = cell;
  menuOwner = owner;
}

/** Keeps the open menu honest: availability changes with every tick, and a conquered cell needs another menu. */
function refreshMenu(): void {
  if (!session || !radial.isOpen) return;
  if (!me()?.alive || session.game.owner[session.selected] !== menuOwner) radial.close();
  else radial.refresh();
}

// --- tutorial: a guided first game ---------------------------------------------------

/** The guided game in progress, if this one is it. */
let tutorial: Tutorial | null = null;
/** Where the guide points on the map right now. */
let tutorialHint: { cell: number; radius: number } | null = null;
/** Gold the pupil gets, so that no step has to wait for the treasury. */
const TUTORIAL_GOLD = 2000;
/** A good place to start on the tutorial map: the Dalmatian coast. */
const TUTORIAL_START: [number, number] = [16.6, 43.6];

/** Marks a stretch of free coast as the recommended starting area. */
function prepareTutorial(s: Session): void {
  const { game, proj } = s;
  const cell = game.nearest(Math.max(0, proj.cellAt(...TUTORIAL_START)), 40, (c) => game.isFreeLand(c) && game.touchesWater(c));
  tutorialHint = cell < 0 ? null : { cell, radius: 6 };
  // Close enough to see single cells: the whole map would make the first nation a speck.
  if (cell >= 0) map.easeTo({ center: proj.lngLat((cell % game.width) + 0.5, Math.floor(cell / game.width) + 0.5), zoom: Math.min(s.pack.zoom.max, 7.5), duration: 1200 });
}

/**
 * Moves the guide on when one of the player's orders completes its step. The tutorial is a game
 * of one, so it may set the stage directly: gold for the lessons and a weak tribe next door.
 */
function watchTutorial(s: Session, cmd: PlayerCommand, result: CommandResult): void {
  if (!tutorial?.observe(cmd, result)) return;
  const { game } = s;
  const mine = s.lockstep.me;
  tutorialHint = null;
  if (tutorial.step.id === 'attack' && mine && cmd.type === 'spawn') {
    mine.gold += TUTORIAL_GOLD;
    const w = game.width;
    const far = (c: number) => Math.max(Math.abs((c % w) - (cmd.cell % w)), Math.abs(Math.floor(c / w) - Math.floor(cmd.cell / w)));
    // Just outside the new nation's own disc, so that the two touch.
    let tribe: Faction | null = null;
    for (let d = 5; d <= 14 && !tribe; d++) {
      const spot = game.nearest(cmd.cell, 20, (c) => far(c) === d && game.isFreeLand(c));
      if (spot >= 0) tribe = game.addFaction({ name: 'Übungsstamm', type: 'AI_TRIBE' }, spot, 0);
    }
    if (tribe) tutorialHint = { cell: Math.round(tribe.sumY / tribe.cells) * w + Math.round(tribe.sumX / tribe.cells), radius: 5 };
  }
  play(tutorial.finished ? 'victory' : 'offer');
  renderGuide();
}

function renderGuide(): void {
  const guide = $('guide');
  guide.hidden = !tutorial || !session;
  if (!tutorial) {
    tutorialHint = null;
    return;
  }
  const step = tutorial.step;
  guide.classList.toggle('finished', tutorial.finished);
  $('guide-progress').textContent = `Schritt ${tutorial.index + 1}/${TUTORIAL_STEPS.length}`;
  $('guide-title').textContent = step.title;
  // The step texts are our own; `**bold**` and `key` marks become elements, everything else stays text.
  $('guide-text').replaceChildren(
    ...step.text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part) =>
      part.startsWith('**') ? Object.assign(document.createElement('b'), { textContent: part.slice(2, -2) }) : part.startsWith('`') ? Object.assign(document.createElement('kbd'), { textContent: part.slice(1, -1) }) : part,
    ),
  );
  $('guide-button').textContent = tutorial.finished ? 'Freies Spiel starten' : 'Tutorial überspringen';
}
// Either way the game goes on as a free one.
$('guide-button').addEventListener('click', () => {
  tutorial = null;
  renderGuide();
  toast('Freies Spiel – viel Erfolg!');
});

// --- alarms: who is coming for the player, and from where ---------------------------

const alarmButtons = new Map<string, HTMLButtonElement>();
const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
/** Alarms shown at once; more than that is noise. */
const MAX_ALARMS = 4;

/** A threat as the alarm shows it: what is coming, from whom, how many, and how long until it hits. */
interface Threat {
  key: string;
  cell: number;
  icon: string;
  title: string;
  from: string;
  troops: number;
  /** Seconds until it arrives, or -1 for a front that is already moving. */
  eta: number;
}

function renderAlarms(game: Game, mine: Faction): void {
  const threats: Threat[] = [];
  const name = (id: number) => game.factions[id].name.toUpperCase();
  // Nothing threatens the fallen.
  for (const atk of mine.alive ? game.attacks : []) {
    if (atk.target !== mine.id) continue;
    const { centre } = frontOf(game, atk);
    if (centre >= 0) threats.push({ key: `attack${atk.attacker}`, cell: centre, icon: '', title: 'ANGRIFF', from: name(atk.attacker), troops: atk.troops, eta: -1 });
  }
  for (const u of mine.alive ? game.units : []) {
    if (u.targetOwner !== mine.id || u.owner === mine.id) continue;
    const title = u.def.blast
      ? u.def.domain === 'missile'
        ? u.def.blast.neutralize
          ? 'ATOMALARM'
          : 'RAKETE'
        : 'LUFTANGRIFF'
      : u.def.carriesTroops
        ? u.path
          ? 'LANDUNG'
          : 'LUFTLANDUNG'
        : 'KRIEGSSCHIFF';
    threats.push({ key: `unit${u.id}`, cell: u.to, icon: unitIconUrl(u.def.id, '#ff8a7a'), title, from: name(u.owner), troops: u.troops, eta: Math.ceil(etaTicks(u) / TICKS_PER_SECOND) });
  }
  // The most urgent first.
  threats.sort((a, b) => (a.eta < 0 ? 0 : a.eta) - (b.eta < 0 ? 0 : b.eta));
  threats.length = Math.min(threats.length, MAX_ALARMS);

  const box = $('alarms');
  const { clientWidth, clientHeight } = map.getContainer();
  const seen = new Set<string>();
  const set = (el: Element, text: string) => {
    if (el.textContent !== text) el.textContent = text;
  };
  for (const t of threats) {
    seen.add(t.key);
    let button = alarmButtons.get(t.key);
    if (!button) {
      button = Object.assign(document.createElement('button'), { type: 'button' });
      const art = t.icon ? Object.assign(new Image(), { src: t.icon, alt: '' }) : Object.assign(document.createElement('span'), { className: 'art', textContent: '⚔' });
      button.append(art, Object.assign(document.createElement('b'), { className: 'eta' }), Object.assign(document.createElement('span'), { className: 'what' }), Object.assign(document.createElement('span'), { className: 'arrow' }));
      // The click jumps to wherever the threat is by then.
      button.addEventListener('click', (e) => {
        const cell = Number((e.currentTarget as HTMLElement).dataset.cell);
        if (session) map.easeTo({ center: session.proj.lngLat((cell % game.width) + 0.5, Math.floor(cell / game.width) + 0.5), duration: 300 });
      });
      alarmButtons.set(t.key, button);
      box.append(button);
      play('alarm');
    }
    // Which way to look: an arrow towards the threat, or a mark if it is already in view.
    const p = map.project(session!.proj.lngLat((t.cell % game.width) + 0.5, Math.floor(t.cell / game.width) + 0.5));
    const inView = p.x >= 0 && p.y >= 0 && p.x <= clientWidth && p.y <= clientHeight;
    const [, eta, what, arrow] = button.children;
    set(eta, t.eta < 0 ? 'JETZT' : `${t.eta} s`);
    set(what, `${t.title} von ${t.from}${t.troops > 0 ? ` · ${Math.round(t.troops).toLocaleString('de-DE')} Mann` : ''}`);
    set(arrow, inView ? '◎' : ARROWS[(Math.round(Math.atan2(p.y - clientHeight / 2, p.x - clientWidth / 2) / (Math.PI / 4)) + 8) % 8]);
    button.classList.toggle('soon', t.eta >= 0 && t.eta <= 10);
    button.dataset.cell = `${t.cell}`;
  }
  for (const [key, button] of alarmButtons) {
    if (seen.has(key)) continue;
    button.remove();
    alarmButtons.delete(key);
  }
}

// --- HUD and game loop ---------------------------------------------------------

/** What each treaty means for the player, said in one line on the offer card. */
const TREATY_TEXT: Record<Treaty, string> = {
  TradeAgreement: 'Handelsabkommen: Gold für beide Seiten, solange es gilt.',
  NonAggressionPact: 'Nichtangriffspakt: zwei Minuten keine Angriffe aufeinander.',
  Alliance: 'Bündnis: gemeinsame Feinde, gegenseitige Verteidigung.',
};
/** Offers the player has turned down; they simply run out on the other side. */
const declined = new Set<string>();

/** Treaties other factions offer the player: a card each, with the time left, to accept or decline. */
function renderOffers(game: Game, mine: Faction): void {
  const offers = game.diplo.offersTo(game, mine.id).filter((o) => !declined.has(`${o.from}:${o.treaty}:${o.until}`));
  const signature = offers.map((o) => `${o.from}:${o.treaty}:${o.until}`).join();
  const box = $('offers');
  if (session && signature !== session.offers) {
    if (offers.length > session.offers.split(',').filter(Boolean).length) play('offer');
    session.offers = signature;
    box.hidden = offers.length === 0;
    box.replaceChildren(
      ...offers.map((o) => {
        const from = game.factions[o.from];
        const key = `${o.from}:${o.treaty}:${o.until}`;
        const accept = Object.assign(document.createElement('button'), { type: 'button', className: 'yes', textContent: '✔ Annehmen' });
        accept.addEventListener('click', () =>
          order({ type: 'accept', from: o.from, treaty: o.treaty }, (result) => (result === 'ok' ? `${TREATY_LABEL[o.treaty]} mit ${from.name} geschlossen.` : 'Dieses Angebot gilt nicht mehr.')),
        );
        const decline = Object.assign(document.createElement('button'), { type: 'button', className: 'no', textContent: '✖ Ablehnen' });
        decline.addEventListener('click', () => {
          declined.add(key);
          session!.offers = '';
          renderOffers(game, mine);
        });
        const flag = factionFlag(from);
        const card = Object.assign(document.createElement('article'), { className: 'offer' });
        card.dataset.until = `${o.until}`;
        card.append(
          flag ? flagElement(flag) : Object.assign(document.createElement('span'), { className: 'flag icon', textContent: factionIcon(from) }),
          Object.assign(document.createElement('strong'), { textContent: `${from.name} bietet dir ${o.treaty === 'NonAggressionPact' ? 'einen' : 'ein'} ${TREATY_LABEL[o.treaty]} an` }),
          Object.assign(document.createElement('p'), { textContent: TREATY_TEXT[o.treaty] }),
          Object.assign(document.createElement('small'), { className: 'left' }),
          accept,
          decline,
        );
        return card;
      }),
    );
  }
  // The time each offer has left.
  for (const card of box.querySelectorAll<HTMLElement>('article')) {
    const left = `noch ${Math.max(0, Math.ceil((Number(card.dataset.until) - game.tick) / TICKS_PER_SECOND))} s`;
    const el = card.querySelector('.left')!;
    if (el.textContent !== left) el.textContent = left;
  }
}

function renderHud(): void {
  if (!session) return;
  const { game } = session;
  const mine = me();
  const stats = $('stats');
  if (mine) {
    const share = ((100 * mine.cells) / game.landCells).toFixed(1);
    session.peakCells = Math.max(session.peakCells, mine.cells);
    const seconds = Math.floor(game.tick / TICKS_PER_SECOND);
    const d = game.diplo;
    const names = (ids: number[]) => {
      const alive = ids.map((id) => game.factions[id]).filter((f) => f.alive);
      return alive.length === 0 ? '' : alive.slice(0, 3).map((f) => f.name).join(', ') + (alive.length > 3 ? ` +${alive.length - 3}` : '');
    };
    const enemies = d.enemies(game, mine.id);
    for (const id of enemies) if (!session.wars.has(id)) toast(`Krieg mit ${game.factions[id].name}!`);
    session.wars = new Set(enemies);
    const traitor = mine.traitorUntil - game.tick;
    const relations = [
      ['Bündnis', names(d.allies(mine.id))],
      ['Pakt', names(d.pactPartners(game, mine.id))],
      ['Handel', names(d.tradePartners(mine.id))],
      ['Krieg', names(enemies)],
      ['Verräter-Malus', traitor > 0 ? `noch ${Math.ceil(traitor / TICKS_PER_SECOND)} s (−30 % Verteidigung)` : ''],
    ].filter(([, value]) => value);
    stats.replaceChildren(
      Object.assign(document.createElement('strong'), { textContent: formatTroops(mine.troops) }),
      ` / ${formatTroops(game.maxTroops(mine))} Bevölkerung`,
      document.createElement('br'),
      Object.assign(document.createElement('span'), { className: 'gold', textContent: `${Math.floor(mine.gold)} Gold` }),
      ` · +${mine.income.toFixed(2)}/Tick`,
      document.createElement('br'),
      `${mine.cells} Zellen · ${share} % der Landfläche · ${Math.floor(seconds / 60)}:${`${seconds % 60}`.padStart(2, '0')}`,
      Object.assign(document.createElement('span'), { className: 'diplo', textContent: relations.length ? relations.map(([label, value]) => `${label}: ${value}`).join(' · ') : 'Keine Bündnisse, kein Krieg.' }),
    );
    renderOffers(game, mine);
    renderAlarms(game, mine);
  } else stats.textContent = `${session.pack.name}: ${game.factions.filter((f) => f.alive).length} Fraktionen warten.`;

  // The ranking is rebuilt twice a second: often enough to follow, rarely enough to stay cheap.
  if (game.tick % 5 === 0 || !$('leaderboard').hasChildNodes()) renderLeaderboard(game, mine);

  if (session.over) return;
  if (session.lockstep.desynced) {
    session.over = true;
    showBanner('Die Synchronisation mit dem Host ist verloren gegangen – für dich ist dieses Spiel vorbei.');
  } else if (!mine) showBanner(tutorial ? '' : 'Wähle dein Startgebiet: Klicke auf freies Land.');
  else if (!mine.alive) endGame(session, false, mine);
  else if (!game.factions.some((f) => f.alive && f !== mine) || mine.cells >= game.landCells * VICTORY_SHARE) endGame(session, true, mine);
  else showBanner(session.lockstep.speed === 0 ? '⏸ Pausiert – Karte, Bau-Planung und Diplomatie bleiben bedienbar.' : game.tick === 0 && lobby ? 'Warte auf die Mitspieler – gleich geht es los.' : '');
}

function renderLeaderboard(game: Game, mine: Faction | null): void {
  $('ranking').hidden = false;
  const ranked = game.factions.filter((f) => f.alive).sort((a, b) => b.cells - a.cells || a.id - b.id);
  const el = (tag: string, className: string, text = '') => Object.assign(document.createElement(tag), { className, textContent: text });
  // The top eight, and every player below them with their true rank.
  $('leaderboard').replaceChildren(
    ...ranked.flatMap((f, i) => {
      if (i >= 8 && f.type !== 'HUMAN_NATION') return [];
      const row = Object.assign(document.createElement('button'), { type: 'button', className: f === mine ? 'me' : '' });
      row.dataset.faction = `${f.id}`;
      const share = (100 * f.cells) / game.landCells;
      const flag = factionFlag(f);
      const bar = el('i', 'bar');
      // Bars are relative to the leader, so that a race at 0.3 % still shows who is ahead.
      bar.style.width = `${Math.max(4, (100 * f.cells) / ranked[0].cells)}%`;
      bar.style.background = `rgb(${factionColor(f).join(' ')})`;
      const land = el('span', 'land', `${share.toFixed(1)} %`);
      land.prepend(bar);
      row.append(el('span', 'rank', `${i + 1}`), flag ? flagElement(flag) : el('span', 'flag icon', factionIcon(f)), el('span', 'name', f.name), land, el('span', 'troops', formatTroops(f.troops)), el('span', 'gold', formatTroops(f.gold)));
      row.title = `${f.name}: ${share.toFixed(1)} % der Landfläche · ${formatTroops(f.troops)} Truppen · ${Math.floor(f.gold)} Gold – Klick fliegt hin`;
      return [row];
    }),
  );
}
// A click on a row flies to that faction's land.
$('leaderboard').addEventListener('click', (e) => {
  const id = Number((e.target as HTMLElement).closest<HTMLElement>('[data-faction]')?.dataset.faction);
  const f = session?.game.factions[id];
  if (!session || !f?.alive || f.cells === 0) return;
  const { proj, pack } = session;
  const [west, north] = proj.lngLat(f.minX, f.minY);
  const [east, south] = proj.lngLat(f.maxX + 1, f.maxY + 1);
  // The bounding box only ever grows, so it gives the zoom; the centre of the land held now gives the place.
  const zoom = Math.min(pack.zoom.max - 0.5, map.cameraForBounds([west, south, east, north], { padding: 120 })?.zoom ?? map.getZoom());
  map.flyTo({ center: proj.lngLat(f.sumX / f.cells + 0.5, f.sumY / f.cells + 0.5), zoom, duration: 1200 });
});

/** Plays what happened in the world since the last look: loud if it is on screen, faint if it is not. */
function hearEvents(s: Session): void {
  const { game, proj } = s;
  const { clientWidth, clientHeight } = map.getContainer();
  for (const e of game.events) {
    if (e.tick <= s.heardTick) continue;
    const p = map.project(proj.lngLat((e.cell % game.width) + 0.5, Math.floor(e.cell / game.width) + 0.5));
    const inView = p.x >= 0 && p.y >= 0 && p.x <= clientWidth && p.y <= clientHeight;
    // A nuclear blast is heard everywhere.
    play(EVENT_SOUND[e.type], inView ? 1 : e.type === 'nuke' ? 0.6 : 0.15);
  }
  s.heardTick = game.tick - 1;
}

function repaint(s: Session): void {
  if (s.painter.paint(s.game)) {
    // A paused canvas source re-reads its canvas exactly once per play/pause pair.
    const source = map.getSource<CanvasSource>(LAYER);
    source?.play();
    source?.pause();
  }
  renderHud();
  hearEvents(s);
  refreshMenu();
  refreshHotbar();
  updateGhost();
  updateCursor();
}

let last = performance.now();
/** Set when the game moved; the next frame repaints. */
let dirty = false;

/** Moves the game on: the host (or a player alone) closes turns by the clock, a client plays what the host sent. */
function advance(): void {
  const now = performance.now();
  const elapsed = now - last;
  last = now;
  const s = session;
  if (!s) return;
  const ls = s.lockstep;
  if (!ls.host) {
    if (ls.pump() || ls.desynced) dirty = true;
    return;
  }
  if (!s.running) {
    // The world stands still while starting areas are picked; only those commands go out.
    if (ls.turn(0)) dirty = true;
    const waiting = [ls.selfId, ...(lobby?.net.peers() ?? [])].some((peer) => !ls.players.has(peer));
    s.running = ls.players.size > 0 && (!waiting || now - s.startedAt > SPAWN_WAIT_MS);
    return;
  }
  // The ticks due at the host's speed go out as one turn; while paused only orders and speed changes do.
  if (ls.turn(ls.due(elapsed))) dirty = true;
}
// The clock lives in a worker: timers and animation frames of a background tab are throttled,
// and a host who switches tabs must not freeze the game for everybody.
const clock = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 50)'], { type: 'text/javascript' })));
clock.onmessage = advance;

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (!session || menu.hidden === false) return;
  panCamera(now);
  refreshSpeed(); // a pause changes no cell, so this cannot wait for a repaint
  if (dirty) {
    dirty = false;
    repaint(session);
  }
  drawLabels(labels, map, session.game, session.proj);
  drawOverlay(labels, map, session.game, session.proj, { me: me()?.id ?? -1, selected: session.selected, ghost, hint: tutorialHint, cities: cityMarks }, now);
}
requestAnimationFrame(frame);

// Handle for the browser console and automated browser tests.
Object.assign(window, { osmFront: { map, mapRegistry, session: () => session && { ...session, me: me() }, lobby: () => lobby, mode: () => mode, ghost: () => ghost, cityMarks: () => cityMarks, sounds: played, tutorial: () => tutorial && { index: tutorial.index, step: tutorial.step.id, hint: tutorialHint } } });
