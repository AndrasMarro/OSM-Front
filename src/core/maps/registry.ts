import { PRESETS } from './presets';
import type { MapPackDefinition } from './types';

/** Mercator cannot show the poles. */
const MAX_LAT = 85.05;

/** Returns what is wrong with a map pack; empty if it is usable. Custom maps arrive as untrusted JSON. */
export function validateMapPack(p: MapPackDefinition): string[] {
  const errors: string[] = [];
  const [minLng, minLat, maxLng, maxLat] = p.bbox ?? [];
  if (!p.id || !p.name) errors.push('id and name are required');
  if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite)) errors.push('bbox must be four numbers');
  else {
    if (minLng >= maxLng || minLat >= maxLat) errors.push('bbox must be [minLng, minLat, maxLng, maxLat]');
    if (minLng < -180 || maxLng > 180 || minLat < -MAX_LAT || maxLat > MAX_LAT) errors.push('bbox exceeds the Web Mercator world');
  }
  if (!Number.isInteger(p.grid?.width) || p.grid.width < 64 || p.grid.width > 2048) errors.push('grid.width must be an integer from 64 to 2048');
  if (!(p.zoom?.min <= p.zoom?.max)) errors.push('zoom.min must not exceed zoom.max');
  if (p.terrain?.type !== 'osm' && p.terrain?.type !== 'mask') errors.push('unknown terrain source');
  if (!Array.isArray(p.spawns)) errors.push('spawns must be an array');
  if (!(p.randomTribes >= 0)) errors.push('randomTribes must be >= 0');
  return errors;
}

/** All selectable maps. Presets are registered up front; custom maps are added at runtime through `register`. */
export class MapRegistry {
  private readonly packs = new Map<string, MapPackDefinition>();

  register(pack: MapPackDefinition): void {
    const errors = validateMapPack(pack);
    if (errors.length) throw new Error(`Invalid map pack "${pack.id}": ${errors.join('; ')}`);
    this.packs.set(pack.id, pack);
  }

  get(id: string): MapPackDefinition | undefined {
    return this.packs.get(id);
  }

  list(): MapPackDefinition[] {
    return [...this.packs.values()];
  }
}

export const mapRegistry = new MapRegistry();
for (const pack of PRESETS) mapRegistry.register(pack);
