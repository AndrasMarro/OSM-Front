import { spawnsIn } from './presets';
import type { BBox, MapPackDefinition } from './types';

/**
 * Describes a map for any region of the world: terrain from OSM, the known
 * capitals and great tribes inside the box as spawn points, and random tribes
 * for the rest. The result is plain JSON, ready to register, export or share.
 */
export function packFromBBox(name: string, bbox: BBox, width = 768, randomTribes = 30): MapPackDefinition {
  // Zoomed out, the whole box fits a screen about 1000 px wide; players may zoom in six levels from there.
  let min = 0;
  while (min < 12 && (bbox[2] - bbox[0]) * 2 ** (min + 1) < 360 * 2) min++;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return {
    id: `custom-${slug || 'map'}-${bbox.map((v) => Math.round(v * 10)).join('_')}`,
    name,
    bbox,
    zoom: { min, max: Math.min(14, min + 6) },
    grid: { width },
    terrain: { type: 'osm' },
    spawns: spawnsIn(bbox),
    randomTribes,
  };
}
