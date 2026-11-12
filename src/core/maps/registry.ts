import { PRESETS } from './presets';
import type { MapPackDefinition } from './types';

/** Mercator cannot show the poles. */
const MAX_LAT = 85.05;

/** Returns what is wrong with a map pack; empty if it is usable. Custom maps arrive as untrusted JSON. */
export function validateMapPack(p: MapPackDefinition): string[] {
  if (typeof p !== 'object' || p === null) return ['a map pack must be an object'];
  const errors: string[] = [];
  const [minLng, minLat, maxLng, maxLat]: number[] = Array.isArray(p.bbox) ? p.bbox : [NaN, NaN, NaN, NaN];
  if (typeof p.id !== 'string' || typeof p.name !== 'string' || !p.id || !p.name || p.id.length > 100 || p.name.length > 60) errors.push('id and name are required (short strings)');
  if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite)) errors.push('bbox must be four numbers');
  else {
    if (minLng >= maxLng || minLat >= maxLat) errors.push('bbox must be [minLng, minLat, maxLng, maxLat]');
    if (minLng < -180 || maxLng > 180 || minLat < -MAX_LAT || maxLat > MAX_LAT) errors.push('bbox exceeds the Web Mercator world');
  }
  if (!Number.isInteger(p.grid?.width) || p.grid.width < 64 || p.grid.width > 2048) errors.push('grid.width must be an integer from 64 to 2048');
  if (!(p.zoom?.min >= 0 && p.zoom.min <= p.zoom.max && p.zoom.max <= 22)) errors.push('zoom must be 0 <= min <= max <= 22');
  if (p.terrain?.type === 'mask') {
    if (typeof p.terrain.url !== 'string' || !/^(data:image\/|https:\/\/|\.?\/)/.test(p.terrain.url)) errors.push('terrain.url must be a data:, https: or relative image URL');
  } else if (p.terrain?.type !== 'osm') errors.push('unknown terrain source');
  if (!Array.isArray(p.spawns) || p.spawns.length > 500) errors.push('spawns must be an array of at most 500 points');
  else if (!p.spawns.every((s) => typeof s?.name === 'string' && s.name.length <= 60 && Array.isArray(s.lngLat) && s.lngLat.slice(0, 2).every(Number.isFinite) && ['nation', 'tribe', 'eliteTribe'].includes(s.kind)))
    errors.push('every spawn needs a name, lngLat and a kind (nation, tribe, eliteTribe)');
  if (!(Number.isInteger(p.randomTribes) && p.randomTribes >= 0 && p.randomTribes <= 500)) errors.push('randomTribes must be an integer from 0 to 500');
  if (p.terrainWeights !== undefined && (typeof p.terrainWeights !== 'object' || p.terrainWeights === null || !Object.values(p.terrainWeights).every((w) => Number.isFinite(w) && (w as number) > 0)))
    errors.push('terrainWeights must map terrain names to positive numbers');
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
