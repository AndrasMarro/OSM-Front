import { feature, mesh } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import atlasUrl from 'world-atlas/countries-50m.json?url';
import { worldX, worldY, type GridProjection } from '../core/maps/projection';
import type { MapPackDefinition } from '../core/maps/types';

/**
 * Country borders of the world: Natural Earth 1:50m, as packed by `world-atlas`.
 * Loaded on demand, once; the menu preview, the in-game outlines and the map mask share it.
 */
type Atlas = Topology<{ countries: GeometryCollection<{ name: string }> }>;
let atlas: Promise<Atlas> | null = null;
const load = () => (atlas ??= fetch(atlasUrl).then((r) => r.json() as Promise<Atlas>));

type Country = Atlas['objects']['countries']['geometries'][number];
/** A pack names its countries by ISO 3166 numeric code, or by Natural Earth name where there is no code (Kosovo). */
const memberOf = (pack: MapPackDefinition) => {
  const set = new Set(pack.countries ?? []);
  return (c: Country) => set.has(`${c.id ?? ''}`) || set.has((c.properties as { name?: string } | undefined)?.name ?? '');
};

/** Mercator has no poles. */
const lat = (v: number) => Math.max(-85, Math.min(85, v));

/** Outside the countries of the pack: 2. Inside: 1. Covered by no country at all (open sea, a stray islet): 0. */
export async function countryMask(pack: MapPackDefinition, proj: GridProjection): Promise<Uint8Array> {
  const topo = await load();
  const member = memberOf(pack);
  const { width: w, height: h } = proj;
  const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })!;
  ctx.lineJoin = 'round';
  const draw = (wanted: boolean, color: string, grow: number) => {
    ctx.beginPath();
    for (const c of topo.objects.countries.geometries) {
      if (member(c) !== wanted) continue;
      const geo = (feature(topo, c) as GeoJSON.Feature).geometry;
      const polygons: number[][][][] = geo.type === 'Polygon' ? [geo.coordinates] : geo.type === 'MultiPolygon' ? geo.coordinates : [];
      for (const rings of polygons) {
        for (const ring of rings) {
          ring.forEach(([lng, la], i) => {
            const [x, y] = proj.fromWorld(worldX(lng), worldY(lat(la)));
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.closePath();
        }
      }
    }
    ctx.fillStyle = ctx.strokeStyle = color;
    ctx.lineWidth = grow * 2;
    ctx.fill('evenodd');
    ctx.stroke();
  };
  // The borders in the data are coarser than the OSM coastline. Everything is grown a little so that no
  // strip of shore falls between the two; the pack's own countries are drawn last and win along the border.
  draw(false, '#f00', 3);
  draw(true, '#0f0', 1.5);
  const px = ctx.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4 + 1] >= 128 ? 1 : px[i * 4] >= 128 ? 2 : 0;
  return mask;
}

/**
 * Border lines for the map: every border between two countries, and - for a pack that is
 * about certain countries - the outer line around them (their coasts and their borders with others).
 */
export async function borderLines(pack: MapPackDefinition | null): Promise<GeoJSON.FeatureCollection> {
  const topo = await load();
  const countries = topo.objects.countries;
  const line = (kind: string, geometry: GeoJSON.MultiLineString): GeoJSON.Feature => ({ type: 'Feature', properties: { kind }, geometry });
  const features = [line('all', mesh(topo, countries, (a, b) => a !== b))];
  if (pack?.countries?.length) {
    const member = memberOf(pack);
    features.push(line('pack', mesh(topo, countries, (a, b) => (a === b ? member(a as Country) : member(a as Country) !== member(b as Country)))));
  }
  return { type: 'FeatureCollection', features };
}
