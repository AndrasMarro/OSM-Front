import { Map as MapLibreMap, setWorkerUrl, type CanvasSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { build, buildingRegistry, price, type OrderResult } from './core/buildings';
import type { DiplomaticStatus, Treaty } from './core/diplomacy';
import type { Faction } from './core/faction';
import { NEUTRAL, TICKS_PER_SECOND, type Game } from './core/game';
import { GridProjection } from './core/maps/projection';
import { mapRegistry } from './core/maps/registry';
import type { MapPackDefinition } from './core/maps/types';
import { createGame } from './core/setup';
import { Terrain } from './core/terrain';
import { launch, unitRegistry, type UnitDefinition } from './core/units';
import { loadTerrain } from './osm/terrain';
import { drawLabels, factionIcon, formatTroops } from './render/labels';
import { drawOverlay } from './render/overlay';
import { factionColor, TerritoryPainter } from './render/territory';
import './style.css';

const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const LAYER = 'territory';
/** The player wins by holding this share of all land. */
const VICTORY_SHARE = 0.8;
const TERRAIN_LABEL = ['Wasser', 'Ebene', 'Stadt', 'Wald', 'Gebirge', 'Autobahn', 'Schiene', 'Eis'];
const STATUS_LABEL: Record<DiplomaticStatus, string> = { War: 'Krieg', Neutral: 'Neutral', NonAggressionPact: 'Nichtangriffspakt', Alliance: 'Bündnis' };
const TREATY_LABEL: Record<Treaty, string> = { NonAggressionPact: 'Nichtangriffspakt', Alliance: 'Bündnis', TradeAgreement: 'Handelsabkommen' };
/** Why an order was refused. */
const REFUSAL: Record<OrderResult, string> = {
  ok: '',
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
  painter: TerritoryPainter;
  /** The player's faction, once a starting area is chosen. */
  me: Faction | null;
  over: boolean;
  /** Cell the action panel is open for, or -1. */
  selected: number;
  /** Factions the player is known to be at war with, to announce new wars once. */
  wars: Set<number>;
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
  $('action').hidden = true;
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
    session = { pack, proj, game, painter, me: null, over: false, selected: -1, wars: new Set() };

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
  // Free land next door is simply taken; everything else is a choice, so the panel opens.
  if (game.isFreeLand(cell) && game.attack(session.me.id, NEUTRAL, Number(strength.value))) toast(`Vorstoß in freies Land mit ${strength.value} % deiner Truppen.`);
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
  /** Carries the order out and returns what to tell the player. */
  run: () => string;
}
let liveActions: { button: HTMLButtonElement; action: Action }[] = [];
let actionInfo: () => string = () => '';
/** Owner of the selected cell when the panel was built; a change rebuilds it. */
let actionOwner = -1;

function closeActions(): void {
  $('action').hidden = true;
  if (session) session.selected = -1;
}

function openActions(cell: number): void {
  const s = session;
  if (!s?.me) return;
  const { game, me } = s;
  const d = game.diplo;
  const owner = game.owner[cell];
  const water = game.terrain[cell] === Terrain.WATER;
  const f = game.factions[owner];
  const percent = () => Number(strength.value);
  const hasBase = (id: string) => game.buildings.some((b) => b.owner === me.id && b.def.id === id);

  const unitAction = (def: UnitDefinition): Action => ({
    label: () => `${def.name} · ${def.cost} Gold${def.carriesTroops ? ` · ${percent()} % Truppen` : ''}${hasBase(def.base) ? '' : ` (braucht ${buildingRegistry.get(def.base)?.name})`}`,
    enabled: () => me.gold >= def.cost && hasBase(def.base),
    run: () => {
      const result = launch(game, me.id, def.id, cell, percent());
      if (result === 'range' && def.trade) return 'Kein fremder Hafen ist über See erreichbar.';
      return result === 'ok' ? `${def.name}: Befehl erteilt.` : REFUSAL[result];
    },
  });
  const treaty = (kind: Treaty): Action => ({
    label: () => `${TREATY_LABEL[kind]} anbieten`,
    enabled: () => f.alive && (kind === 'TradeAgreement' ? !d.trading(me.id, owner) && !d.embargoed(me.id, owner) : d.status(game, me.id, owner) !== kind),
    run: () => (d.propose(game, me.id, owner, kind) ? `${f.name} nimmt an: ${TREATY_LABEL[kind]}.` : `${f.name} lehnt ab.`),
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
        run: () => {
          const result = build(game, me.id, def.id, cell);
          return result === 'ok' ? `${def.name} gebaut.` : REFUSAL[result];
        },
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
        run: () => (game.attack(me.id, owner, percent()) ? `Angriff auf ${owner === NEUTRAL ? 'freies Land' : f.name} mit ${percent()} % deiner Truppen.` : 'Das Ziel grenzt nicht an dein Gebiet – nutze Schiffe oder Fallschirmjäger.'),
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
            run: () => (d.sendAid(game, me.id, owner, 'gold', GOLD_GIFT) ? `${GOLD_GIFT} Gold an ${f.name} gesendet.` : REFUSAL.gold),
          },
          {
            label: () => `Truppen senden · ${percent()} %`,
            enabled: () => f.alive,
            run: () => (d.sendAid(game, me.id, owner, 'troops', (me.troops * percent()) / 100) ? `Truppen an ${f.name} gesendet.` : REFUSAL.troops),
          },
          {
            label: () => (d.embargoed(me.id, owner) ? 'Embargo aufheben' : 'Embargo verhängen'),
            run: () => {
              const on = !d.embargoed(me.id, owner);
              d.setEmbargo(me.id, owner, on);
              return on ? `Embargo gegen ${f.name}: der Handel ruht.` : `Embargo gegen ${f.name} aufgehoben.`;
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
          button.addEventListener('click', () => {
            toast(action.run());
            refreshActions();
          });
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
  if (!s?.me || s.selected < 0) return;
  if (!s.me.alive) return closeActions();
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

function renderHud(): void {
  if (!session) return;
  const { game, me } = session;
  const stats = $('stats');
  if (me) {
    const share = ((100 * me.cells) / game.landCells).toFixed(1);
    const d = game.diplo;
    const names = (ids: number[]) => {
      const alive = ids.map((id) => game.factions[id]).filter((f) => f.alive);
      return alive.length === 0 ? '' : alive.slice(0, 3).map((f) => f.name).join(', ') + (alive.length > 3 ? ` +${alive.length - 3}` : '');
    };
    const enemies = d.enemies(game, me.id);
    for (const id of enemies) if (!session.wars.has(id)) toast(`Krieg mit ${game.factions[id].name}!`);
    session.wars = new Set(enemies);
    const traitor = me.traitorUntil - game.tick;
    const relations = [
      ['Bündnis', names(d.allies(me.id))],
      ['Pakt', names(d.pactPartners(game, me.id))],
      ['Handel', names(d.tradePartners(me.id))],
      ['Krieg', names(enemies)],
      ['Verräter-Malus', traitor > 0 ? `noch ${Math.ceil(traitor / TICKS_PER_SECOND)} s (−30 % Verteidigung)` : ''],
    ].filter(([, value]) => value);
    stats.replaceChildren(
      Object.assign(document.createElement('strong'), { textContent: formatTroops(me.troops) }),
      ` / ${formatTroops(game.maxTroops(me))} Bevölkerung`,
      document.createElement('br'),
      Object.assign(document.createElement('span'), { className: 'gold', textContent: `${Math.floor(me.gold)} Gold` }),
      ` · +${me.income.toFixed(2)}/Tick`,
      document.createElement('br'),
      `${me.cells} Zellen · ${share} % der Landfläche`,
      Object.assign(document.createElement('span'), { className: 'diplo', textContent: relations.length ? relations.map(([label, value]) => `${label}: ${value}`).join(' · ') : 'Keine Bündnisse, kein Krieg.' }),
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
  refreshActions();
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
  drawOverlay(labels, map, session.game, session.proj, session.selected, now);
}
requestAnimationFrame(frame);

// Handle for the browser console and automated browser tests.
Object.assign(window, { osmFront: { map, mapRegistry, session: () => session } });
