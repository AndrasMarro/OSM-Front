import { describe, expect, it } from 'vitest';
import { NATION_PRESETS } from '../core/nation-presets';

const files = import.meta.glob<string>('/src/assets/flags/*', { query: '?raw', import: 'default', eager: true });

describe('flag files', () => {
  it('are all real SVG images, each for a historic empire of the library', () => {
    const ids = new Set(NATION_PRESETS.map((p) => p.id));
    expect(Object.keys(files).length).toBeGreaterThanOrEqual(10);
    for (const [path, text] of Object.entries(files)) {
      const id = path.replace(/^.*\//, '').replace(/\.svg$/, '');
      expect(path).toMatch(/\.svg$/);
      expect(ids.has(id)).toBe(true);
      // A download that was refused leaves an error page behind, not a picture.
      expect(text.slice(0, 400)).toMatch(/<svg|<\?xml/);
    }
  });
});
