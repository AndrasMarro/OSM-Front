import { Map as MapLibreMap, setWorkerUrl, type CanvasSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Faction } from './core/faction';
import { NEUTRAL, TICKS_PER_SECOND, type Game } from './core/game';
import { GridProjection } from './core/maps/projection';
import { mapRegistry } from './core/maps/registry';
import type { MapPackDefinition } from './core/maps/types';
import { createGame } from './core/setup';
import { Terrain } from './core/terrain';
import { loadTerrain } from './osm/terrain';
import { drawLabels, factionIcon, formatTroops } from './render/labels';
import { factionColor, TerritoryPainter } from './render/territory';
import './style.css';

const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const LAYER = 'territory';
/** The player wins by holding this share of all land. */
const VICTORY_SHARE = 0.8;
const TERRAIN_LABEL = ['Wasser', 'Ebene', 'Stadt', 'Wald', 'Gebirge', 'Autobahn', 'Schiene', 'Eis'];

interface Session {
  pack: MapPackDefinition;
  proj: GridProjection;
  game: Game;
  painter: TerritoryPainter;
  /** The player's faction, once a starting area is chosen. */
  me: Faction | null;
  over: boolean;
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
/** Bumped on every map change so a slow terrain download cannot start a stale game. */
let generation = 0;

// --- small UI helpers --------------------------------------------------------

let toastTimer = 0;
function toast(text: string): void {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 3000);
}

function showBanner(text: string): void {
  banner.textContent = text;
  banner.hidden = !text;
}

const kindLabel = (f: Faction) =>
  f.type === 'HUMAN_NATION' ? 'Spieler' : f.type === 'AI_NATION' ? 'KI-Nation' : f.elite ? 'Elite-Stamm' : 'Stamm';

// --- map selection -------------------------------------------------------------

function showMenu(): void {
  generation++;
  session = null;
  if (map.getLayer(LAYER)) map.removeLayer(LAYER);
  if (map.getSource(LAYER)) map.removeSource(LAYER);
  hud.hidden = true;
  $('hover').textContent = '\u00a0';
  labels.canvas.width = 0; // clears the labels; drawLabels resizes it again
  showBanner('');
  status.textContent = '';
  menu.hidden = false;
  for (const b of menu.querySelectorAll('button')) b.disabled = false;
}

async function startMap(pack: MapPackDefinition): Promise<void> {
  const mine = ++generation;
  for (const b of menu.querySelectorAll('button')) b.disabled = true;
  status.textContent = `Lade Terrain für ${pack.name} …`;
  try {
    const proj = new GridProjection(pack.bbox, pack.grid.width);
    const [terrain] = await Promise.all([
      loadTerrain(pack, proj, (done, total) => (status.textContent = `Lade Terrain für ${pack.name} … ${Math.round((100 * done) / total)} %`)),
      mapReady,
    ]);
    if (mine !== generation) return;

    // The seed is the one thing a multiplayer host will have to share (phase 3).
    const game = createGame(pack, proj, terrain, (Math.random() * 2 ** 32) >>> 0);
    const painter = new TerritoryPainter(proj.width, proj.height);
    painter.paint(game);
    session = { pack, proj, game, painter, me: null, over: false };

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

    menu.hidden = true;
    hud.hidden = false;
    renderHud();
    showBanner('Wähle dein Startgebiet: Klicke auf freies Land.');
  } catch (err) {
    if (mine !== generation) return;
    console.error(err);
    status.textContent = `Terrain konnte nicht geladen werden (${err instanceof Error ? err.message : err}). Bitte erneut versuchen.`;
    for (const b of menu.querySelectorAll('button')) b.disabled = false;
  }
}

for (const pack of mapRegistry.list()) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = pack.name;
  button.dataset.map = pack.id;
  button.addEventListener('click', () => void startMap(pack));
  $('maps').append(button);
}
$('to-menu').addEventListener('click', showMenu);
strength.addEventListener('input', () => ($('strength-value').textContent = `${strength.value} %`));

// --- player input --------------------------------------------------------------

map.on('click', (e) => {
  if (!session) return;
  const { game, proj } = session;
  const { lng, lat } = e.lngLat.wrap();
  const cell = proj.cellAt(lng, lat);
  if (cell < 0) return;

  if (!session.me) {
    session.me = game.addFaction({ name: 'Du', type: 'HUMAN_NATION' }, cell, 2);
    if (!session.me) return toast('Hier ist kein freies Land für ein Startgebiet.');
    showBanner('');
    toast('Klicke auf angrenzendes Land, um es anzugreifen.');
    repaint(session);
    return;
  }
  if (!session.me.alive) return;
  if (game.terrain[cell] === Terrain.WATER) return toast('Wasser lässt sich erst mit Marine überqueren (Phase 2).');
  const target = game.owner[cell];
  if (target === session.me.id) return;
  const name = target === NEUTRAL ? 'Freies Land' : game.factions[target].name;
  const percent = Number(strength.value);
  if (game.attack(session.me.id, target, percent)) toast(`Angriff auf ${name} mit ${percent} % deiner Truppen.`);
  else toast(`${name} grenzt hier nicht an dein Gebiet.`);
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
    hover.textContent = `${who}${TERRAIN_LABEL[game.terrain[cell]]}`;
  }
});

// --- HUD and game loop ---------------------------------------------------------

function renderHud(): void {
  if (!session) return;
  const { game, me } = session;
  const stats = $('stats');
  if (me) {
    const share = ((100 * me.cells) / game.landCells).toFixed(1);
    stats.replaceChildren(
      Object.assign(document.createElement('strong'), { textContent: formatTroops(me.troops) }),
      ` / ${formatTroops(game.maxTroops(me))} Truppen`,
      document.createElement('br'),
      `${me.cells} Zellen · ${share} % der Landfläche`,
    );
  } else stats.textContent = `${session.pack.name}: ${game.factions.filter((f) => f.alive).length} Fraktionen warten.`;

  const ranked = game.factions.filter((f) => f.alive).sort((a, b) => b.cells - a.cells || a.id - b.id);
  $('leaderboard').replaceChildren(
    ...ranked.slice(0, 8).map((f) => {
      const li = document.createElement('li');
      if (f === me) li.className = 'me';
      const swatch = document.createElement('i');
      swatch.style.background = `rgb(${factionColor(f).join(' ')})`;
      const name = Object.assign(document.createElement('span'), { textContent: `${factionIcon(f)} ${f.name}` });
      li.append(swatch, name, `${f.cells}`);
      return li;
    }),
  );

  if (me && !session.over) {
    const rivals = game.factions.some((f) => f.alive && f !== me);
    if (!me.alive) {
      session.over = true;
      showBanner('Niederlage – dein Reich ist gefallen.');
    } else if (!rivals || me.cells >= game.landCells * VICTORY_SHARE) {
      session.over = true;
      showBanner('Sieg! Du beherrschst die Karte.');
    }
  }
}

function repaint(s: Session): void {
  s.painter.paint(s.game);
  // A paused canvas source re-reads its canvas exactly once per play/pause pair.
  const source = map.getSource<CanvasSource>(LAYER);
  source?.play();
  source?.pause();
  renderHud();
}

const TICK_MS = 1000 / TICKS_PER_SECOND;
let last = performance.now();
let owed = 0;
function frame(now: number): void {
  requestAnimationFrame(frame);
  const elapsed = now - last;
  last = now;
  if (!session) return;
  // The world stands still until the player has picked a starting area.
  if (session.me) {
    // After a hidden tab or a long frame, catch up a little instead of all at once.
    owed = Math.min(owed + elapsed, 5 * TICK_MS);
    if (owed >= TICK_MS) {
      for (; owed >= TICK_MS; owed -= TICK_MS) session.game.step();
      repaint(session);
    }
  }
  drawLabels(labels, map, session.game, session.proj);
}
requestAnimationFrame(frame);

// Handle for the browser console and automated browser tests.
Object.assign(window, { osmFront: { map, mapRegistry, session: () => session } });
