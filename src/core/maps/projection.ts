import type { BBox } from './types';

/** Longitude/latitude to Web Mercator world fractions (0..1, y pointing south). */
export const worldX = (lng: number) => (lng + 180) / 360;
export const worldY = (lat: number) => 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI);

/**
 * Maps a bounding box onto a cell grid. The grid is linear in Web Mercator,
 * so it lines up with the map as a plain rectangle.
 */
export class GridProjection {
  readonly bbox: BBox;
  readonly width: number;
  readonly height: number;
  private readonly x0: number;
  private readonly y0: number;
  private readonly sx: number;
  private readonly sy: number;

  constructor(bbox: BBox, width: number) {
    this.bbox = bbox;
    this.width = width;
    this.x0 = worldX(bbox[0]);
    this.y0 = worldY(bbox[3]);
    const spanX = worldX(bbox[2]) - this.x0;
    const spanY = worldY(bbox[1]) - this.y0;
    this.height = Math.max(1, Math.round((width * spanY) / spanX));
    this.sx = width / spanX;
    this.sy = this.height / spanY;
  }

  /** World fractions to fractional grid coordinates. */
  fromWorld(wx: number, wy: number): [x: number, y: number] {
    return [(wx - this.x0) * this.sx, (wy - this.y0) * this.sy];
  }

  /** World fractions of a fractional grid coordinate. */
  toWorld(x: number, y: number): [wx: number, wy: number] {
    return [this.x0 + x / this.sx, this.y0 + y / this.sy];
  }

  /** Cell index for a coordinate, or -1 outside the grid. */
  cellAt(lng: number, lat: number): number {
    // ponytail: Math.log/tan may differ in the last bit between JS engines. Fine while
    // one client turns clicks into cells; in lockstep, send cell indices, not coordinates.
    const [fx, fy] = this.fromWorld(worldX(lng), worldY(lat));
    const x = Math.floor(fx);
    const y = Math.floor(fy);
    return x < 0 || y < 0 || x >= this.width || y >= this.height ? -1 : y * this.width + x;
  }

  /** Coordinate of a fractional grid position. */
  lngLat(x: number, y: number): [lng: number, lat: number] {
    const [wx, wy] = this.toWorld(x, y);
    return [wx * 360 - 180, (Math.atan(Math.exp((0.5 - wy) * 2 * Math.PI)) * 360) / Math.PI - 90];
  }
}
