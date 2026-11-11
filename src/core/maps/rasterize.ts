/**
 * Pure rasterisers that turn projected map geometry into grid cells.
 * Coordinates are fractional grid units; rings and lines are flat [x0, y0, x1, y1, ...].
 */

/** Calls `put(index)` for every cell whose centre lies inside the polygon (even-odd rule, so holes work). */
export function fillPolygon(rings: number[][], width: number, height: number, put: (cell: number) => void): void {
  // Per row, the x positions where polygon edges cross the row's centre line.
  const rows = new Map<number, number[]>();
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0; i < n; i += 2) {
      let x0 = ring[i];
      let y0 = ring[i + 1];
      let x1 = ring[(i + 2) % n];
      let y1 = ring[(i + 3) % n];
      if (y0 === y1) continue;
      if (y0 > y1) [x0, y0, x1, y1] = [x1, y1, x0, y0];
      // Half-open [y0, y1): a vertex shared by two edges counts exactly once.
      const first = Math.max(0, Math.ceil(y0 - 0.5));
      const last = Math.min(height - 1, Math.ceil(y1 - 0.5) - 1);
      const slope = (x1 - x0) / (y1 - y0);
      for (let r = first; r <= last; r++) {
        let xs = rows.get(r);
        if (!xs) rows.set(r, (xs = []));
        xs.push(x0 + (r + 0.5 - y0) * slope);
      }
    }
  }
  for (const [r, xs] of rows) {
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const first = Math.max(0, Math.ceil(xs[i] - 0.5));
      const last = Math.min(width - 1, Math.ceil(xs[i + 1] - 0.5) - 1);
      for (let x = first; x <= last; x++) put(r * width + x);
    }
  }
}

/**
 * Calls `put(index)` along a polyline. Steps one axis at a time, so the cells
 * are 4-connected: a road stays walkable for a front that only moves up/down/left/right.
 */
export function drawLine(line: number[], width: number, height: number, put: (cell: number) => void): void {
  const plot = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < width && y < height) put(y * width + x);
  };
  for (let i = 0; i + 3 < line.length; i += 2) {
    let x = Math.floor(line[i]);
    let y = Math.floor(line[i + 1]);
    const x1 = Math.floor(line[i + 2]);
    const y1 = Math.floor(line[i + 3]);
    const dx = Math.abs(x1 - x);
    const dy = Math.abs(y1 - y);
    const sx = x < x1 ? 1 : -1;
    const sy = y < y1 ? 1 : -1;
    let err = 0;
    for (let step = dx + dy; step > 0; step--) {
      plot(x, y);
      if (Math.abs(err + dy) < Math.abs(err - dx)) {
        x += sx;
        err += dy;
      } else {
        y += sy;
        err -= dx;
      }
    }
    plot(x, y);
  }
}
