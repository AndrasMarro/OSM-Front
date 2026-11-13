import { Map as MapLibreMap, setWorkerUrl, type CanvasSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { buildingRegistry, canBuild, linkedCity, price, type BuildingDefinition, type OrderResult } from './core/buildings';
import type { CommandResult } from './core/commands';
import type { DiplomaticStatus, Treaty } from './core/diplomacy';
import type { Faction } from './core/faction';
import type { NationProfile } from './core/nation';
import { DIFFICULTY, NEUTRAL, TICKS_PER_SECOND, type Difficulty, type Game, type GameEvent } from './core/game';
import { GridProjection } from './core/maps/projection';
import { mapRegistry, validateMapPack } from './core/maps/registry';
import type { MapPackDefinition } from './core/maps/types';
import { createGame } from './core/setup';
import { Terrain } from './core/terrain';
import { unitCost, unitRegistry, type UnitDefinition } from './core/units';
import { Lobby } from './net/lobby';
import { Lockstep, type PlayerCommand } from './net/lockstep';
import { localTransport, trysteroTransport, type Transport } from './net/transport';
import { loadTerrain } from './osm/terrain';
import { flagElement, flagImage } from './render/flag';
import { drawLabels, factionIcon, formatTroops } from './render/labels';
import { drawOverlay, frontOf, type Ghost } from './render/overlay';
import { factionColor, TerritoryPainter } from './render/territory';
import './style.css';
import { setCursor, type CursorKind } from './ui/cursors';
import { exportPack, setupCustomMaps } from './ui/custom-maps';
import { setupNationEditor } from './ui/nation-editor';
import { Radial, type RadialItem, type RadialSpec } from './ui/radial';
import { getVolume, play, played, setVolume, type Sound } from './ui/sound';

const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const LAYER = 'territory';
/** The player wins by holding this share of all land. */
const VICTORY_SHARE = 0.8;
/** In multiplayer the world starts moving once everybody has picked a start, or after this long. */
const SPAWN_WAIT_MS = 30_000;
const TERRAIN_LABEL = ['Wasser', 'Ebene', 'Stadt', 'Wald', 'Gebirge', 'Autobahn', 'Schiene', 'Eis'];
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
};
/** The same reasons, short enough to hang on the cursor while placing a building. */
const BUILD_HINT: Partial<Record<OrderResult, string>> = { place: 'Nicht dein Gebiet', spacing: 'Zu nah am nächsten Gebäude', coast: 'Kein Küstenfeld', gold: 'Zu wenig Gold' };
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
  pitchWithRotate: false,
  touchPitch: false,
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
const mapReady = new Promise<void>((resolve) => map.once('load', () => resolve()));

let session: Session | null = null;
/** The multiplayer room, if the player is in one. */
let lobby: Lobby | null = null;
/** Bumped on every map change so a slow terrain download cannot start a stale game. */
let generation = 0;
/** True while a map is loading: nothing else can be started. */
let busy = false;

const me = () => session?.lockstep.me ?? null;

const difficultySelect = $<HTMLSelectElement>('difficulty');
difficultySelect.value = localStorage.getItem('osm-front:difficulty') ?? 'normal';
difficultySelect.addEventListener('change', () => localStorage.setItem('osm-front:difficulty', difficultySelect.value));

// --- sound, help and the end of a game -------------------------------------------

/** What a successful order sounds like, by kind; anything else gets the plain confirmation. */
const ORDER_SOUND: Partial<Record<PlayerCommand['type'], Sound>> = { build: 'build', attack: 'attack', spawn: 'build' };
const EVENT_SOUND: Record<GameEvent['type'], Sound> = { explosion: 'explosion', nuke: 'nuke', intercept: 'intercept', landing: 'landing', repelled: 'hit', hit: 'hit', sunk: 'explosion' };

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

const kindLabel = (f: Faction) =>
  f.type === 'HUMAN_NATION' ? 'Spieler' : f.type === 'AI_NATION' ? 'KI-Nation' : f.elite ? 'Elite-Stamm' : 'Stamm';

/** Sends one of the player's orders on its way; `say` turns its outcome into a message once it has been executed. */
function order(cmd: PlayerCommand, say: (result: CommandResult) => string): void {
  if (!session) return;
  session.feedback.push(say);
  session.lockstep.issue(cmd);
}

// --- map selection -------------------------------------------------------------

/** Only the host of a room picks the map; while one loads, nobody picks anything. */
function refreshMapButtons(): void {
  const locked = busy || (lobby !== null && !lobby.isHost);
  for (const b of $('maps').querySelectorAll('button')) b.disabled = locked;
  difficultySelect.disabled = locked;
}

function showMenu(): void {
  generation++;
  if (session && lobby?.isHost) void lobby.net.send('end', 1);
  if (gameover.open) gameover.close('watch');
  lobby?.net.on('turn', () => {}); // a game we left no longer listens
  session = null;
  busy = false;
  if (map.getLayer(LAYER)) map.removeLayer(LAYER);
  if (map.getSource(LAYER)) map.removeSource(LAYER);
  hud.hidden = true;
  $('hover').textContent = ' ';
  $('offers').hidden = true;
  $('hotbar').hidden = true;
  $('alarms').replaceChildren();
  alarmButtons.clear();
  radial.close();
  setMode(null);
  labels.canvas.width = 0; // clears the labels; drawLabels resizes it again
  showBanner('');
  status.textContent = '';
  menu.hidden = false;
  refreshMapButtons();
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
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addLayer(
    { id: LAYER, type: 'raster', source: LAYER, paint: { 'raster-resampling': 'nearest', 'raster-fade-duration': 0, 'raster-opacity': 0.85 } },
    firstSymbol,
  );
  map.setMinZoom(pack.zoom.min);
  map.setMaxZoom(pack.zoom.max);
  // Room at the bottom for the hotkey bar.
  map.fitBounds([west, south, east, north], { padding: { top: 20, left: 20, right: 20, bottom: 90 }, duration: 0 });

  busy = false;
  menu.hidden = true;
  hud.hidden = false;
  $<HTMLProgressElement>('loading').hidden = true;
  dirty = true;
  // First game in this browser: show how it is played.
  if (!localStorage.getItem('osm-front:seen-help')) {
    localStorage.setItem('osm-front:seen-help', '1');
    help.showModal();
  }
}

/** Loads a map's terrain and starts the game - for everybody in the room, if there is one. */
async function startMap(pack: MapPackDefinition): Promise<void> {
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
    const difficulty = difficultySelect.value as Difficulty;
    // Everybody plays on the host's grid: no peer derives terrain of its own that could differ.
    // A mask inside the pack would only be dead weight on the wire.
    if (lobby) {
      await lobby.net.send('start', { pack: { ...pack, terrain: { type: 'osm' } }, seed, difficulty });
      await lobby.net.send('grid', terrain);
    }
    if (mine !== generation) return;
    await begin(pack, terrain, seed, difficulty);
  } catch (err) {
    if (mine !== generation) return;
    console.error(err);
    loading.hidden = true;
    status.textContent = `Terrain konnte nicht geladen werden (${err instanceof Error ? err.message : err}). Bitte erneut versuchen.`;
    busy = false;
    refreshMapButtons();
  }
}

function addMapButton(pack: MapPackDefinition): void {
  const button = Object.assign(document.createElement('button'), { type: 'button', textContent: pack.name });
  button.dataset.map = pack.id;
  button.addEventListener('click', () => void startMap(pack));
  // A re-imported map replaces its old button.
  const old = [...$('maps').querySelectorAll('button')].find((b) => b.dataset.map === pack.id);
  if (old) old.replaceWith(button);
  else $('maps').append(button);
  refreshMapButtons();
}
for (const pack of mapRegistry.list()) addMapButton(pack);
setupCustomMaps(map, addMapButton, (text) => (status.textContent = text), (visible) => (menu.hidden = !visible));

/** The player's own nation, as made in the editor. It goes out with the spawn command and to the room. */
let nation = setupNationEditor($<HTMLFormElement>('nation-form'), (edited) => {
  nation = edited;
  lobby?.present(edited);
});

$('to-menu').addEventListener('click', showMenu);
$('export-map').addEventListener('click', () => {
  if (session) exportPack(session.pack, session.game.terrain, session.proj.width, session.proj.height);
});
// One troop share, two sliders: the one in the HUD and the one on the context menu.
const share = $<HTMLInputElement>('share');
for (const [from, to] of [
  [strength, share],
  [share, strength],
]) {
  from.addEventListener('input', () => {
    to.value = from.value;
    $('strength-value').textContent = $('share-value').textContent = `${from.value} %`;
    radial.refresh();
  });
}

// --- multiplayer lobby -----------------------------------------------------------

const roomOf = () => /^[\w-]{3,40}$/.exec(new URLSearchParams(location.hash.slice(1)).get('room') ?? '')?.[0] ?? null;
const hostKey = (room: string) => `osm-front:host:${room}`;
let room: string | null = null;

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
  const reach = !relays ? '' : relays.open > 0 ? ` (${relays.open} von ${relays.total} Relays erreichbar)` : ' Kein Relay ist erreichbar: andere Spieler finden diesen Raum gerade nicht.';
  $('lobby-status').textContent =
    (lobby.isHost
      ? `Wähle oben eine Karte: das Spiel startet für alle ${lobby.roster.size + 1} im Raum.`
      : host
        ? 'Der Host wählt die Karte. Es geht los, sobald er startet.'
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
    net = new URLSearchParams(location.search).get('net') === 'local' ? localTransport(id) : await trysteroTransport(id);
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
    if (!proj || terrain.length !== proj.width * proj.height || terrain.some((t) => t > Terrain.ICE) || !Number.isInteger(start.seed)) {
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
if (roomOf()) void enterRoom(roomOf()!);
else renderLobby();
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
  if (unit.domain !== 'sea') {
    if (game.terrain[cell] === Terrain.WATER || game.owner[cell] === mine.id) return 'Kein gültiges Ziel';
    if (!bases.some((b) => distance(game, b.cell, cell) <= unit.range)) return 'Außer Reichweite';
  }
  return mine.gold < unitCost(game, mine.id, unit) ? 'Zu wenig Gold' : '';
}

/** The preview that follows the mouse in build or target mode: what, how far it reaches, and whether it works here. */
function updateGhost(): void {
  const mine = me();
  ghost = null;
  if (!session || !mine?.alive || !mode || hoverCell < 0) return;
  const { game } = session;
  if (mode.kind === 'target') {
    const hint = launchProblem(game, mine, mode.unit, hoverCell);
    ghost = { cell: hoverCell, icon: mode.unit.icon, ok: !hint, hint, rings: mode.unit.blast ? [{ radius: mode.unit.blast.radius, label: 'Wirkungsradius' }] : [], links: [] };
    return;
  }
  const def = mode.def;
  const result = canBuild(game, mine.id, def.id, hoverCell);
  const rings: Ghost['rings'] = [];
  if (def.fort) rings.push({ radius: def.fort.radius, label: `Verteidigung +${def.fort.defensePct} %` });
  if (def.intercept) rings.push({ radius: def.intercept.radius, label: 'Abfangradius' });
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
  ghost = { cell: hoverCell, icon: def.icon, ok: result === 'ok', hint, rings, links };
}

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
  const add = (key: number, slotMode: NonNullable<Mode>, icon: string, name: string) => {
    const button = Object.assign(document.createElement('button'), { type: 'button', title: name });
    const price = document.createElement('small');
    button.append(Object.assign(document.createElement('kbd'), { textContent: `${key}` }), Object.assign(document.createElement('b'), { textContent: icon }), price);
    button.setAttribute('aria-label', `${name} (Taste ${key})`);
    const slot: Slot = { key: `${key}`, mode: slotMode, button, price };
    button.addEventListener('click', () => toggleSlot(slot));
    slots.push(slot);
    return button;
  };
  const buildings = buildingRegistry.list().slice(0, 7);
  const units = TARGET_HOTKEYS.map((id) => unitRegistry.get(id)!);
  $('hotbar').append(
    ...buildings.map((def, i) => add(i + 1, { kind: 'build', def }, def.icon, def.name)),
    Object.assign(document.createElement('span'), { className: 'gap' }),
    ...units.map((unit, i) => add(buildings.length + 1 + i, { kind: 'target', unit }, unit.icon, unit.name)),
  );
}
const sameMode = (a: Mode, b: Mode) => a !== null && b !== null && (a.kind === 'build' ? b.kind === 'build' && a.def === b.def : b.kind === 'target' && a.unit === b.unit);
const toggleSlot = (slot: Slot) => setMode(sameMode(mode, slot.mode) ? null : slot.mode);

function refreshHotbar(): void {
  const mine = me();
  $('hotbar').hidden = !session || !mine?.alive;
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
});
// Right click leaves build and target mode.
map.on('contextmenu', (e) => {
  if (!mode) return;
  e.originalEvent.preventDefault();
  setMode(null);
});

// --- clicks ------------------------------------------------------------------------

let spawning = false;
map.on('click', (e) => {
  if (!session || radial.justDismissed) return;
  const { game, proj } = session;
  const { lng, lat } = e.lngLat.wrap();
  const cell = proj.cellAt(lng, lat);
  if (cell < 0) return;

  const mine = me();
  if (!mine) {
    if (spawning) return;
    spawning = true;
    order({ type: 'spawn', cell, nation }, (result) => {
      spawning = false;
      return result === 'ok' ? 'Klicke auf angrenzendes Land, um es anzugreifen.' : 'Hier ist kein freies Land für ein Startgebiet.';
    });
    return;
  }
  if (!mine.alive) return;
  if (mode?.kind === 'build') {
    const def = mode.def;
    return order({ type: 'build', def: def.id, cell }, (result) => (result === 'ok' ? `${def.name} gebaut.` : refusal(result)));
  }
  if (mode?.kind === 'target') {
    const unit = mode.unit;
    return order({ type: 'launch', unit: unit.id, cell, percent: Number(strength.value) }, (result) => (result === 'ok' ? `${unit.name}: Befehl erteilt.` : refusal(result)));
  }
  // Free land next door is simply taken; everything else is a choice, so the menu opens at the click.
  if (game.isFreeLand(cell)) {
    const percent = Number(strength.value);
    order({ type: 'attack', target: NEUTRAL, percent }, (result) => (result === 'ok' ? `Vorstoß in freies Land mit ${percent} % deiner Truppen.` : ''));
  }
  openMenu(cell, e.point.x, e.point.y);
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
    const who = f.id === NEUTRAL ? (game.terrain[cell] === Terrain.WATER ? '' : 'Freies Land · ') : `${f.nation ? `${f.nation.ruler} von ${f.name}` : `${factionIcon(f)} ${f.name}`} (${kindLabel(f)}) · ${formatTroops(f.troops)} Truppen · `;
    const b = game.buildingAt.get(cell);
    hover.textContent = `${who}${TERRAIN_LABEL[game.terrain[cell]]}${b ? ` · ${b.def.icon} ${b.def.name}` : ''}${game.fallout[cell] > game.tick ? ' · verstrahlt' : ''}`;
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
    label: unit.name,
    hint: () => [gold(unitCost(game, mine.id, unit)), unit.carriesTroops ? `${percent()} % Truppen` : '', launchProblem(game, mine, unit, cell)].filter(Boolean).join(' · '),
    enabled: () => !launchProblem(game, mine, unit, cell),
    run: () =>
      order({ type: 'launch', unit: unit.id, cell, percent: percent() }, (result) => {
        if (result === 'range' && unit.trade) return 'Kein fremder Hafen ist über See erreichbar.';
        return result === 'ok' ? `${unit.name}: Befehl erteilt.` : refusal(result);
      }),
  });

  let spec: RadialSpec;
  if (owner === mine.id) {
    spec = {
      title: 'Dein Gebiet',
      info: () => `${TERRAIN_LABEL[game.terrain[cell]]}${game.touchesWater(cell) ? ' · Küste' : ''}`,
      items: [
        ...buildingRegistry.list().map((def): RadialItem => {
          const problem = () => canBuild(game, mine.id, def.id, cell);
          return {
            icon: def.icon,
            label: def.name,
            hint: () => [gold(price(game, mine.id, def)), problem() === 'ok' ? '' : BUILD_HINT[problem()]].filter(Boolean).join(' · '),
            enabled: () => problem() === 'ok',
            run: () => order({ type: 'build', def: def.id, cell }, (result) => (result === 'ok' ? `${def.name} gebaut.` : refusal(result))),
          };
        }),
        {
          icon: '⚑',
          label: 'Sammelpunkt',
          hint: () => 'Truppen sammeln: +50 % Verteidigung im Umkreis',
          run: () => order({ type: 'rally', cell }, (result) => (result === 'ok' ? 'Sammelpunkt gesetzt.' : refusal(result))),
        },
        // Units that need no target: they stay at their base or find their own route.
        ...unitRegistry.list().filter((u) => u.intercept || u.trade).map(unitItem),
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
        image: f.nation ? flagImage(f.nation.flag).url : undefined,
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
    for (const unit of unitRegistry.list()) if (!unit.intercept && !unit.trade && (!water || unit.domain === 'sea')) items.push(unitItem(unit));
    if (owner !== NEUTRAL) items.push({ icon: '✉', label: 'Diplomatie', hint: () => 'Handel, Bündnis, Hilfe', stays: true, run: () => radial.open(x, y, diplomacy()) });
    spec = {
      title: water ? 'Gewässer' : owner === NEUTRAL ? 'Freies Land' : f.name,
      image: f.nation ? flagImage(f.nation.flag).url : undefined,
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

// --- alarms: who is coming for the player, and from where ---------------------------

const alarmButtons = new Map<string, HTMLButtonElement>();
const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
/** Alarms shown at once; more than that is noise. */
const MAX_ALARMS = 4;

function renderAlarms(game: Game, mine: Faction): void {
  const threats: { key: string; text: string; cell: number }[] = [];
  const name = (id: number) => game.factions[id].name.toUpperCase();
  // Nothing threatens the fallen.
  for (const atk of mine.alive ? game.attacks : []) {
    if (atk.target !== mine.id) continue;
    const { centre } = frontOf(game, atk);
    if (centre >= 0) threats.push({ key: `attack${atk.attacker}`, cell: centre, text: `⚠ ANGRIFF von ${name(atk.attacker)} (${formatTroops(atk.troops)} Truppen)` });
  }
  for (const u of mine.alive ? game.units : []) {
    if (u.targetOwner !== mine.id || u.owner === mine.id) continue;
    const troops = `(${formatTroops(u.troops)} Truppen)`;
    const text = u.def.blast
      ? u.def.domain === 'missile'
        ? `${u.def.blast.neutralize ? '☢ ATOMALARM!' : '➤ RAKETENALARM!'} ${u.def.name} von ${name(u.owner)}`
        : `✹ LUFTANGRIFF von ${name(u.owner)}`
      : u.def.carriesTroops
        ? `${u.path ? '⚓ LANDUNG' : '☂ LUFTLANDUNG'} von ${name(u.owner)} ${troops}`
        : `☸ KRIEGSSCHIFF von ${name(u.owner)}`;
    threats.push({ key: `unit${u.id}`, cell: u.to, text });
  }
  threats.length = Math.min(threats.length, MAX_ALARMS);

  const box = $('alarms');
  const { clientWidth, clientHeight } = map.getContainer();
  const seen = new Set<string>();
  for (const t of threats) {
    seen.add(t.key);
    let button = alarmButtons.get(t.key);
    if (!button) {
      button = Object.assign(document.createElement('button'), { type: 'button' });
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
    const arrow = inView ? '◎' : ARROWS[(Math.round(Math.atan2(p.y - clientHeight / 2, p.x - clientWidth / 2) / (Math.PI / 4)) + 8) % 8];
    const text = `${t.text} ${arrow}`;
    if (button.textContent !== text) button.textContent = text;
    button.dataset.cell = `${t.cell}`;
  }
  for (const [key, button] of alarmButtons) {
    if (seen.has(key)) continue;
    button.remove();
    alarmButtons.delete(key);
  }
}

// --- HUD and game loop ---------------------------------------------------------

/** Treaties other factions offer the player, each with a button to accept it. */
function renderOffers(game: Game, mine: Faction): void {
  const offers = game.diplo.offersTo(game, mine.id);
  const signature = offers.map((o) => `${o.from}:${o.treaty}`).join();
  if (!session || signature === session.offers) return;
  if (signature.length > session.offers.length) play('offer');
  session.offers = signature;
  $('offers').hidden = offers.length === 0;
  $('offers').replaceChildren(
    ...offers.map((o) => {
      const from = game.factions[o.from];
      const button = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Annehmen' });
      button.addEventListener('click', () =>
        order({ type: 'accept', from: o.from, treaty: o.treaty }, (result) => (result === 'ok' ? `${TREATY_LABEL[o.treaty]} mit ${from.name} geschlossen.` : 'Dieses Angebot gilt nicht mehr.')),
      );
      const row = document.createElement('div');
      row.append(from.nation ? flagElement(from.nation.flag) : factionIcon(from), ` ${from.name} bietet: ${TREATY_LABEL[o.treaty]}`, button);
      return row;
    }),
  );
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
  } else if (!mine) showBanner('Wähle dein Startgebiet: Klicke auf freies Land.');
  else if (!mine.alive) endGame(session, false, mine);
  else if (!game.factions.some((f) => f.alive && f !== mine) || mine.cells >= game.landCells * VICTORY_SHARE) endGame(session, true, mine);
  else showBanner(game.tick === 0 && lobby ? 'Warte auf die Mitspieler – gleich geht es los.' : '');
}

function renderLeaderboard(game: Game, mine: Faction | null): void {
  const ranked = game.factions.filter((f) => f.alive).sort((a, b) => b.cells - a.cells || a.id - b.id);
  // The top eight, and every player below them with their true rank.
  $('leaderboard').replaceChildren(
    ...ranked.flatMap((f, i) => {
      if (i >= 8 && f.type !== 'HUMAN_NATION') return [];
      const li = Object.assign(document.createElement('li'), { value: i + 1 });
      if (f === mine) li.className = 'me';
      const swatch = document.createElement('i');
      swatch.style.background = `rgb(${factionColor(f).join(' ')})`;
      const name = Object.assign(document.createElement('span'), { textContent: f.nation ? f.name : `${factionIcon(f)} ${f.name}` });
      li.append(swatch, ...(f.nation ? [flagElement(f.nation.flag)] : []), name, `${f.cells}`);
      return [li];
    }),
  );
}

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

const TICK_MS = 1000 / TICKS_PER_SECOND;
let last = performance.now();
let owed = 0;
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
    owed = 0;
    return;
  }
  // After a stalled tab, catch up a little instead of all at once.
  owed = Math.min(owed + elapsed, 5 * TICK_MS);
  for (; owed >= TICK_MS; owed -= TICK_MS) {
    ls.turn(1);
    dirty = true;
  }
}
// The clock lives in a worker: timers and animation frames of a background tab are throttled,
// and a host who switches tabs must not freeze the game for everybody.
const clock = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 50)'], { type: 'text/javascript' })));
clock.onmessage = advance;

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (!session || menu.hidden === false) return;
  if (dirty) {
    dirty = false;
    repaint(session);
  }
  drawLabels(labels, map, session.game, session.proj);
  drawOverlay(labels, map, session.game, session.proj, { me: me()?.id ?? -1, selected: session.selected, ghost }, now);
}
requestAnimationFrame(frame);

// Handle for the browser console and automated browser tests.
Object.assign(window, { osmFront: { map, mapRegistry, session: () => session && { ...session, me: me() }, lobby: () => lobby, mode: () => mode, ghost: () => ghost, sounds: played } });
