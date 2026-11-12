import { Map as MapLibreMap, setWorkerUrl, type CanvasSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { buildingRegistry, price, type OrderResult } from './core/buildings';
import type { CommandResult } from './core/commands';
import type { DiplomaticStatus, Treaty } from './core/diplomacy';
import type { Faction } from './core/faction';
import { NEUTRAL, TICKS_PER_SECOND, type Game } from './core/game';
import { GridProjection } from './core/maps/projection';
import { mapRegistry, validateMapPack } from './core/maps/registry';
import type { MapPackDefinition } from './core/maps/types';
import { createGame } from './core/setup';
import { Terrain } from './core/terrain';
import { unitRegistry, type UnitDefinition } from './core/units';
import { Lobby } from './net/lobby';
import { Lockstep, type PlayerCommand } from './net/lockstep';
import { localTransport, trysteroTransport, type Transport } from './net/transport';
import { loadTerrain } from './osm/terrain';
import { drawLabels, factionIcon, formatTroops } from './render/labels';
import { drawOverlay } from './render/overlay';
import { factionColor, TerritoryPainter } from './render/territory';
import './style.css';
import { exportPack, setupCustomMaps } from './ui/custom-maps';

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
  place: 'Hier kann nicht gebaut werden: nur auf eigenem Gebiet und mit Abstand zu anderen Gebäuden.',
  coast: 'Dieses Gebäude muss direkt am Wasser stehen.',
  base: 'Dafür fehlt das passende Gebäude.',
  range: 'Außer Reichweite, oder es gibt keinen Seeweg dorthin.',
  target: 'Das ist kein gültiges Ziel.',
  troops: 'Dafür hast du keine Truppen übrig.',
};
/** Gold in one gift. */
const GOLD_GIFT = 100;

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
  /** Cell the action panel is open for, or -1. */
  selected: number;
  /** Factions the player is known to be at war with, to announce new wars once. */
  wars: Set<number>;
  /** What the offers panel currently shows, to rebuild it only on change. */
  offers: string;
  /** What to tell the player about each of their commands still on its way through the host. */
  feedback: ((result: CommandResult) => string)[];
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
}

function showMenu(): void {
  generation++;
  if (session && lobby?.isHost) void lobby.net.send('end', 1);
  lobby?.net.on('turn', () => {}); // a game we left no longer listens
  session = null;
  busy = false;
  if (map.getLayer(LAYER)) map.removeLayer(LAYER);
  if (map.getSource(LAYER)) map.removeSource(LAYER);
  hud.hidden = true;
  $('hover').textContent = ' ';
  $('action').hidden = true;
  $('offers').hidden = true;
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
async function begin(pack: MapPackDefinition, terrain: Uint8Array, seed: number, hostId?: string): Promise<void> {
  const mine = ++generation;
  const proj = new GridProjection(pack.bbox, pack.grid.width);
  const game = createGame(pack, proj, terrain, seed);
  const lockstep = new Lockstep(game, lobby?.net ?? null, hostId);
  const painter = new TerritoryPainter(proj.width, proj.height);
  const s: Session = { pack, proj, game, lockstep, painter, over: false, running: false, startedAt: performance.now(), selected: -1, wars: new Set(), offers: '', feedback: [] };
  lockstep.onResult = (_cmd, result) => toast(s.feedback.shift()?.(result) ?? '');
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
  map.fitBounds([west, south, east, north], { padding: 20, duration: 0 });

  busy = false;
  menu.hidden = true;
  hud.hidden = false;
  $('action').hidden = true;
  dirty = true;
}

/** Loads a map's terrain and starts the game - for everybody in the room, if there is one. */
async function startMap(pack: MapPackDefinition): Promise<void> {
  const mine = ++generation;
  busy = true;
  refreshMapButtons();
  status.textContent = `Lade Terrain für ${pack.name} …`;
  try {
    const proj = new GridProjection(pack.bbox, pack.grid.width);
    const terrain = await loadTerrain(pack, proj, (done, total) => (status.textContent = `Lade Terrain für ${pack.name} … ${Math.round((100 * done) / total)} %`));
    if (mine !== generation) return;
    const seed = (Math.random() * 2 ** 32) >>> 0;
    // Everybody plays on the host's grid: no peer derives terrain of its own that could differ.
    // A mask inside the pack would only be dead weight on the wire.
    if (lobby) {
      await lobby.net.send('start', { pack: { ...pack, terrain: { type: 'osm' } }, seed });
      await lobby.net.send('grid', terrain);
    }
    if (mine !== generation) return;
    await begin(pack, terrain, seed);
  } catch (err) {
    if (mine !== generation) return;
    console.error(err);
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

$('to-menu').addEventListener('click', showMenu);
$('export-map').addEventListener('click', () => {
  if (session) exportPack(session.pack, session.game.terrain, session.proj.width, session.proj.height);
});
strength.addEventListener('input', () => ($('strength-value').textContent = `${strength.value} %`));

// --- multiplayer lobby -----------------------------------------------------------

const roomOf = () => /^[\w-]{3,40}$/.exec(new URLSearchParams(location.hash.slice(1)).get('room') ?? '')?.[0] ?? null;
const hostKey = (room: string) => `osm-front:host:${room}`;
let room: string | null = null;

function renderLobby(): void {
  $('lobby-off').hidden = lobby !== null || room !== null;
  $('lobby-on').hidden = room === null;
  if (!lobby) return;
  const host = lobby.hostId;
  const row = (name: string, id: string) => Object.assign(document.createElement('li'), { textContent: `${name}${id === host ? ' (Host)' : ''}${id === lobby!.net.selfId ? ' – du' : ''}` });
  $('players').replaceChildren(row(lobby.name, lobby.net.selfId), ...[...lobby.roster].map(([id, p]) => row(p.name, id)));
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
  const name = $<HTMLInputElement>('player-name');
  name.value = localStorage.getItem('osm-front:name') ?? 'Spieler';
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
  lobby = new Lobby(net, sessionStorage.getItem(hostKey(id)) === '1', name.value);
  lobby.onChange = renderLobby;
  // The host's game arrives as the map and the seed, followed by its terrain grid.
  let announced: { pack: MapPackDefinition; seed: number } | null = null;
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
    void begin(start.pack, terrain, start.seed >>> 0, from);
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
$<HTMLInputElement>('player-name').addEventListener('change', (e) => {
  const value = (e.target as HTMLInputElement).value;
  localStorage.setItem('osm-front:name', value);
  lobby?.rename(value);
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

// --- player input --------------------------------------------------------------

let spawning = false;
map.on('click', (e) => {
  if (!session) return;
  const { game, proj } = session;
  const { lng, lat } = e.lngLat.wrap();
  const cell = proj.cellAt(lng, lat);
  if (cell < 0) return;

  const mine = me();
  if (!mine) {
    if (spawning) return;
    spawning = true;
    order({ type: 'spawn', cell, name: lobby?.name ?? 'Du' }, (result) => {
      spawning = false;
      return result === 'ok' ? 'Klicke auf angrenzendes Land, um es anzugreifen.' : 'Hier ist kein freies Land für ein Startgebiet.';
    });
    return;
  }
  if (!mine.alive) return;
  // Free land next door is simply taken; everything else is a choice, so the panel opens.
  if (game.isFreeLand(cell)) {
    const percent = Number(strength.value);
    order({ type: 'attack', target: NEUTRAL, percent }, (result) => (result === 'ok' ? `Vorstoß in freies Land mit ${percent} % deiner Truppen.` : ''));
  }
  openActions(cell);
});

map.on('mousemove', (e) => {
  if (!session) return;
  const { game, proj } = session;
  const { lng, lat } = e.lngLat.wrap();
  const cell = proj.cellAt(lng, lat);
  const hover = $('hover');
  if (cell < 0) hover.textContent = ' ';
  else {
    const f = game.factions[game.owner[cell]];
    const who = f.id === NEUTRAL ? (game.terrain[cell] === Terrain.WATER ? '' : 'Freies Land · ') : `${factionIcon(f)} ${f.name} (${kindLabel(f)}) · ${formatTroops(f.troops)} Truppen · `;
    const b = game.buildingAt.get(cell);
    hover.textContent = `${who}${TERRAIN_LABEL[game.terrain[cell]]}${b ? ` · ${b.def.icon} ${b.def.name}` : ''}${game.fallout[cell] > game.tick ? ' · verstrahlt' : ''}`;
  }
});

// --- action panel: build menu, target selection, diplomacy ----------------------

interface Action {
  /** Re-read on every refresh: prices, the slider and treaties change while the panel is open. */
  label: () => string;
  enabled?: () => boolean;
  /** Sends the order off; the outcome is reported once it has been executed. */
  run: () => void;
}
let liveActions: { button: HTMLButtonElement; action: Action }[] = [];
let actionInfo: () => string = () => '';
/** Owner of the selected cell when the panel was built; a change rebuilds it. */
let actionOwner = -1;
const refusal = (result: CommandResult) => (result === 'ok' || result === 'pending' || result === 'refused' ? 'Das geht gerade nicht.' : REFUSAL[result]);

function closeActions(): void {
  $('action').hidden = true;
  if (session) session.selected = -1;
}

function openActions(cell: number): void {
  const s = session;
  const me = s?.lockstep.me;
  if (!s || !me) return;
  const { game } = s;
  const d = game.diplo;
  const owner = game.owner[cell];
  const water = game.terrain[cell] === Terrain.WATER;
  const f = game.factions[owner];
  const percent = () => Number(strength.value);
  const hasBase = (id: string) => game.buildings.some((b) => b.owner === me.id && b.def.id === id);

  const unitAction = (def: UnitDefinition): Action => ({
    label: () => `${def.name} · ${def.cost} Gold${def.carriesTroops ? ` · ${percent()} % Truppen` : ''}${hasBase(def.base) ? '' : ` (braucht ${buildingRegistry.get(def.base)?.name})`}`,
    enabled: () => me.gold >= def.cost && hasBase(def.base),
    run: () =>
      order({ type: 'launch', unit: def.id, cell, percent: percent() }, (result) => {
        if (result === 'range' && def.trade) return 'Kein fremder Hafen ist über See erreichbar.';
        return result === 'ok' ? `${def.name}: Befehl erteilt.` : refusal(result);
      }),
  });
  const treaty = (kind: Treaty): Action => ({
    label: () => `${TREATY_LABEL[kind]} anbieten`,
    enabled: () => f.alive && (kind === 'TradeAgreement' ? !d.trading(me.id, owner) && !d.embargoed(me.id, owner) : d.status(game, me.id, owner) !== kind),
    run: () =>
      order({ type: 'propose', to: owner, treaty: kind }, (result) =>
        result === 'ok' ? `${f.name} nimmt an: ${TREATY_LABEL[kind]}.` : result === 'pending' ? `Angebot an ${f.name} gesendet: ${TREATY_LABEL[kind]}.` : `${f.name} lehnt ab.`,
      ),
  });

  const groups: [title: string, actions: Action[]][] = [];
  let title = 'Dein Gebiet';
  actionInfo = () => `${TERRAIN_LABEL[game.terrain[cell]]}${game.touchesWater(cell) ? ' · Küste' : ''}`;
  if (owner === me.id) {
    groups.push([
      'Bauen',
      buildingRegistry.list().map((def) => ({
        label: () => `${def.icon} ${def.name} · ${price(game, me.id, def)} Gold`,
        enabled: () => me.gold >= price(game, me.id, def),
        run: () => order({ type: 'build', def: def.id, cell }, (result) => (result === 'ok' ? `${def.name} gebaut.` : refusal(result))),
      })),
    ]);
    // Units that need no target: they stay at their base or find their own route.
    groups.push(['Stationieren', unitRegistry.list().filter((u) => u.intercept || u.trade).map(unitAction)]);
  } else {
    title = water ? 'Gewässer' : owner === NEUTRAL ? 'Freies Land' : `${factionIcon(f)} ${f.name}`;
    const military: Action[] = [];
    if (!water) {
      military.push({
        label: () => `Bodenangriff · ${percent()} % Truppen${d.allied(me.id, owner) ? ' – bricht das Bündnis!' : ''}`,
        run: () => {
          const sent = percent();
          order({ type: 'attack', target: owner, percent: sent }, (result) =>
            result === 'ok' ? `Angriff auf ${owner === NEUTRAL ? 'freies Land' : f.name} mit ${sent} % deiner Truppen.` : 'Das Ziel grenzt nicht an dein Gebiet – nutze Schiffe oder Fallschirmjäger.',
          );
        },
      });
    }
    // Open water is only a destination for ships that patrol.
    for (const def of unitRegistry.list()) if (!def.intercept && !def.trade && (!water || def.guns)) military.push(unitAction(def));
    groups.push(['Militär', military]);
    if (owner !== NEUTRAL) {
      actionInfo = () => {
        const pact = d.pactLeft(game, me.id, owner);
        const extras = [pact > 0 ? `noch ${Math.ceil(pact / TICKS_PER_SECOND)} s` : '', d.trading(me.id, owner) ? 'Handel' : '', d.embargoed(me.id, owner) ? 'Embargo' : ''].filter(Boolean);
        return `${kindLabel(f)} · ${formatTroops(f.troops)} Truppen\nBeziehung ${d.relation(me.id, owner)} · ${STATUS_LABEL[d.status(game, me.id, owner)]}${extras.length ? ` (${extras.join(', ')})` : ''}`;
      };
      groups.push([
        'Diplomatie',
        [
          treaty('NonAggressionPact'),
          treaty('Alliance'),
          treaty('TradeAgreement'),
          {
            label: () => `${GOLD_GIFT} Gold senden`,
            enabled: () => f.alive && me.gold >= GOLD_GIFT,
            run: () => order({ type: 'aid', to: owner, gold: GOLD_GIFT, troopsPct: 0 }, (result) => (result === 'ok' ? `${GOLD_GIFT} Gold an ${f.name} gesendet.` : refusal(result))),
          },
          {
            label: () => `Truppen senden · ${percent()} %`,
            enabled: () => f.alive,
            run: () => order({ type: 'aid', to: owner, gold: 0, troopsPct: percent() }, (result) => (result === 'ok' ? `Truppen an ${f.name} gesendet.` : refusal(result))),
          },
          {
            label: () => (d.embargoed(me.id, owner) ? 'Embargo aufheben' : 'Embargo verhängen'),
            run: () => {
              const on = !d.embargoed(me.id, owner);
              order({ type: 'embargo', to: owner, on }, () => (on ? `Embargo gegen ${f.name}: der Handel ruht.` : `Embargo gegen ${f.name} aufgehoben.`));
            },
          },
        ],
      ]);
    }
  }

  s.selected = cell;
  actionOwner = owner;
  $('action-title').textContent = title;
  liveActions = [];
  $('action-groups').replaceChildren(
    ...groups
      .filter(([, actions]) => actions.length > 0)
      .flatMap(([heading, actions]) => {
        const box = document.createElement('div');
        for (const action of actions) {
          const button = Object.assign(document.createElement('button'), { type: 'button' });
          button.addEventListener('click', action.run);
          liveActions.push({ button, action });
          box.append(button);
        }
        return [Object.assign(document.createElement('h2'), { textContent: heading }), box];
      }),
  );
  $('action').hidden = false;
  refreshActions();
}

/** Keeps labels and availability current without rebuilding the buttons under the player's cursor. */
function refreshActions(): void {
  const s = session;
  const mine = me();
  if (!s || !mine || s.selected < 0) return;
  if (!mine.alive) return closeActions();
  if (s.game.owner[s.selected] !== actionOwner) return openActions(s.selected);
  const info = actionInfo();
  if ($('action-info').textContent !== info) $('action-info').textContent = info;
  for (const { button, action } of liveActions) {
    const label = action.label();
    if (button.textContent !== label) button.textContent = label;
    button.disabled = action.enabled ? !action.enabled() : false;
  }
}

$('action-close').addEventListener('click', closeActions);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeActions();
});
strength.addEventListener('input', refreshActions);

// --- HUD and game loop ---------------------------------------------------------

/** Treaties other factions offer the player, each with a button to accept it. */
function renderOffers(game: Game, mine: Faction): void {
  const offers = game.diplo.offersTo(game, mine.id);
  const signature = offers.map((o) => `${o.from}:${o.treaty}`).join();
  if (!session || signature === session.offers) return;
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
      row.append(`${factionIcon(from)} ${from.name} bietet: ${TREATY_LABEL[o.treaty]}`, button);
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
      `${mine.cells} Zellen · ${share} % der Landfläche`,
      Object.assign(document.createElement('span'), { className: 'diplo', textContent: relations.length ? relations.map(([label, value]) => `${label}: ${value}`).join(' · ') : 'Keine Bündnisse, kein Krieg.' }),
    );
    renderOffers(game, mine);
  } else stats.textContent = `${session.pack.name}: ${game.factions.filter((f) => f.alive).length} Fraktionen warten.`;

  const ranked = game.factions.filter((f) => f.alive).sort((a, b) => b.cells - a.cells || a.id - b.id);
  $('leaderboard').replaceChildren(
    ...ranked.slice(0, 8).map((f) => {
      const li = document.createElement('li');
      if (f === mine) li.className = 'me';
      const swatch = document.createElement('i');
      swatch.style.background = `rgb(${factionColor(f, mine?.id).join(' ')})`;
      const name = Object.assign(document.createElement('span'), { textContent: `${factionIcon(f)} ${f.name}` });
      li.append(swatch, name, `${f.cells}`);
      return li;
    }),
  );

  if (session.over) return;
  if (session.lockstep.desynced) {
    session.over = true;
    showBanner('Die Synchronisation mit dem Host ist verloren gegangen – für dich ist dieses Spiel vorbei.');
  } else if (!mine) showBanner('Wähle dein Startgebiet: Klicke auf freies Land.');
  else if (!mine.alive) {
    session.over = true;
    showBanner('Niederlage – dein Reich ist gefallen.');
  } else if (!game.factions.some((f) => f.alive && f !== mine) || mine.cells >= game.landCells * VICTORY_SHARE) {
    session.over = true;
    showBanner('Sieg! Du beherrschst die Karte.');
  } else showBanner(game.tick === 0 && lobby ? 'Warte auf die Mitspieler – gleich geht es los.' : '');
}

function repaint(s: Session): void {
  s.painter.paint(s.game, me()?.id);
  // A paused canvas source re-reads its canvas exactly once per play/pause pair.
  const source = map.getSource<CanvasSource>(LAYER);
  source?.play();
  source?.pause();
  renderHud();
  refreshActions();
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
  drawOverlay(labels, map, session.game, session.proj, session.selected, now, me()?.id);
}
requestAnimationFrame(frame);

// Handle for the browser console and automated browser tests.
Object.assign(window, { osmFront: { map, mapRegistry, session: () => session && { ...session, me: me() }, lobby: () => lobby } });
