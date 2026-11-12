import type { Map as MapLibreMap } from 'maplibre-gl';
import { packFromBBox } from '../core/maps/custom';
import { mapRegistry, validateMapPack } from '../core/maps/registry';
import type { BBox, MapPackDefinition } from '../core/maps/types';

const STORAGE_KEY = 'osm-front:maps';
/** An imported file larger than this is not a map pack. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function stored(): MapPackDefinition[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function store(packs: MapPackDefinition[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(packs));
  } catch {
    // Storage full or disabled: the map still works until the page is closed.
  }
}

/** The pack as a file the player can keep, share and import again. The terrain travels inside it as a PNG mask. */
export function exportPack(pack: MapPackDefinition, terrain: Uint8Array, width: number, height: number): void {
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  for (let i = 0; i < terrain.length; i++) {
    image.data[i * 4] = terrain[i]; // red channel = terrain id
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const full: MapPackDefinition = { ...pack, grid: { width }, terrain: { type: 'mask', url: canvas.toDataURL('image/png') } };
  const link = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([JSON.stringify(full)], { type: 'application/json' })),
    download: `${pack.id}.osmfront.json`,
  });
  link.click();
  URL.revokeObjectURL(link.href);
}

/**
 * Wires up the "own map" part of the menu: a map for any bounding box (typed
 * in or picked on the map), JSON import, and the maps remembered from earlier
 * visits. `onAdd` is called for every pack that became selectable.
 */
export function setupCustomMaps(map: MapLibreMap, onAdd: (pack: MapPackDefinition) => void, say: (text: string) => void, showMenu: (visible: boolean) => void): void {
  const form = $<HTMLFormElement>('custom-form');
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;

  /** Validates, registers and remembers a pack. Returns false (and says why) if it is not usable. */
  const add = (pack: MapPackDefinition, remember = true): boolean => {
    const errors = validateMapPack(pack);
    if (errors.length) {
      say(`Karte nicht nutzbar: ${errors[0]}.`);
      return false;
    }
    mapRegistry.register(pack);
    if (remember) store([...stored().filter((p) => p?.id !== pack.id), pack]);
    onAdd(pack);
    return true;
  };
  for (const pack of stored()) if (validateMapPack(pack).length === 0) add(pack, false);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const bbox = ['west', 'south', 'east', 'north'].map((n) => Number(field(n).value)) as BBox;
    if (add(packFromBBox(field('name').value.trim(), bbox, Number(field('width').value), Number(field('tribes').value)))) say(`„${field('name').value.trim()}“ ist angelegt und steht in der Kartenliste.`);
  });

  // Picking the box on the map: the menu steps aside until the player confirms the view.
  const done = $<HTMLButtonElement>('custom-pick-done');
  $('custom-pick').addEventListener('click', () => {
    showMenu(false);
    done.hidden = false;
  });
  done.addEventListener('click', () => {
    const b = map.getBounds();
    const clamp = (v: number, limit: number) => Math.max(-limit, Math.min(limit, v));
    field('west').value = clamp(b.getWest(), 180).toFixed(2);
    field('south').value = clamp(b.getSouth(), 85).toFixed(2);
    field('east').value = clamp(b.getEast(), 180).toFixed(2);
    field('north').value = clamp(b.getNorth(), 85).toFixed(2);
    done.hidden = true;
    showMenu(true);
  });

  $<HTMLInputElement>('custom-import').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) return say('Die Datei ist zu groß für eine Karte.');
    try {
      const pack = JSON.parse(await file.text());
      if (add(pack)) say(`„${pack.name}“ importiert.`);
    } catch {
      say('Die Datei enthält kein gültiges JSON.');
    }
  });

  $('custom-clear').addEventListener('click', () => {
    store([]);
    location.reload();
  });
}
