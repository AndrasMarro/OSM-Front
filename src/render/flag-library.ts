/**
 * The flag library: pictures for the ids in `src/core/nation-presets.ts`.
 * Today's states come from the `flag-icons` package (MIT); historic empires from Wikimedia Commons
 * (`src/assets/flags/`, public domain or CC BY-SA, see the file pages there). Where Commons has no
 * flag (Carthage) - or a file is missing - a small drawing of our own stands in.
 */
const wikimedia = import.meta.glob<string>('/src/assets/flags/*.svg', { query: '?url', import: 'default', eager: true });
/** The Vergina sun is an emblem, not a flag: it goes on royal blue. */
const verginaSun = Object.values(import.meta.glob<string>('/src/assets/flags/h-macedon.svg', { query: '?raw', import: 'default', eager: true }))[0];
// Only the flags the presets use are bundled.
// prettier-ignore
const modern = import.meta.glob<string>(
  '/node_modules/flag-icons/flags/4x3/{de,at,ch,fr,it,gb,us,cn,ru,tr,br,jp,es,pl,ua,se,pt,ie,nl,be,cz,hu,ro,bg,gr,rs,hr,no,fi,dk,by,lt,lv,ee,sk,is,ba,al,mk,me,xk,si,md,in,mn,kz,ir,sa,pk,id,th,kr,kp,iq,af,vn,ph,mm,bd,uz,my,il,sy,np,lk,eg,ng,za,et,cd,dz,ma,ke,tz,ao,sd,ly,ml,gh,mg,sn,ca,mx,ar,co,pe,cl,ve,cu,bo,ec,py,uy,gt,ni,pa,do,gl,au,nz,pg}.svg',
  { query: '?url', import: 'default', eager: true },
);

const GOLD = '#f2c230';
const star = (cx: number, cy: number, r: number, fill: string, extra = '') => {
  const pts = Array.from({ length: 10 }, (_, i) => {
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    const rr = i % 2 ? r * 0.4 : r;
    return `${(cx + Math.cos(a) * rr).toFixed(2)},${(cy + Math.sin(a) * rr).toFixed(2)}`;
  });
  return `<polygon points="${pts.join(' ')}" fill="${fill}" ${extra}/>`;
};
/** A heraldic eagle, wings spread; `heads` 2 makes it the imperial double eagle. */
const eagle = (cx: number, cy: number, r: number, fill: string, heads = 1) => {
  const body = [0, -0.45, 0.2, -0.2, 0.95, -0.6, 0.8, 0.05, 0.4, 0.2, 0.25, 0.45, 0.4, 0.9, 0, 0.7, -0.4, 0.9, -0.25, 0.45, -0.4, 0.2, -0.8, 0.05, -0.95, -0.6, -0.2, -0.2];
  const pts = (shape: number[], sx = 1) => shape.map((v, i) => (i % 2 ? cy + v * r : cx + v * r * sx).toFixed(2)).join(' ');
  const head = [0.02, -0.3, 0.1, -0.85, 0.42, -0.72, 0.24, -0.62, 0.3, -0.3];
  const headsSvg = heads === 2 ? `<polygon points="${pts(head)}" fill="${fill}"/><polygon points="${pts(head, -1)}" fill="${fill}"/>` : `<polygon points="${pts([-0.14, -0.3, -0.1, -0.85, 0.3, -0.75, 0.1, -0.62, 0.14, -0.3])}" fill="${fill}"/>`;
  return `<polygon points="${pts(body)}" fill="${fill}"/>${headsSvg}`;
};
const bands = (...colors: string[]) => colors.map((c, i) => `<rect y="${(40 * i) / colors.length}" width="60" height="${40 / colors.length + 0.2}" fill="${c}"/>`).join('');
const svg = (body: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 40">${body}</svg>`)}`;
/** A small crowned shield with three bands. */
const shield = (x: number, a: string, b: string, c: string) =>
  `<g transform="translate(${x} 13)"><rect x="-4" y="-5" width="8" height="2.2" fill="${GOLD}"/><path d="M-5-2h10v9q0 5-5 7q-5-2-5-7z" fill="${a}" stroke="${GOLD}" stroke-width=".8"/><rect x="-5" y="2.5" width="10" height="4" fill="${b}"/><path d="M-5 6.5h10v.5q0 5-5 7q-5-2-5-7z" fill="${c}"/></g>`;
const rays = (cx: number, cy: number, n: number, inner: number, outer: number, fill: string) =>
  Array.from({ length: n }, (_, i) => {
    const a = (i * 2 * Math.PI) / n;
    const len = i % 2 ? outer * 0.72 : outer;
    const p = (ang: number, rad: number) => `${(cx + Math.cos(ang) * rad).toFixed(2)},${(cy + Math.sin(ang) * rad).toFixed(2)}`;
    return `<polygon points="${p(a - 0.13, inner)} ${p(a, len)} ${p(a + 0.13, inner)}" fill="${fill}"/>`;
  }).join('');

const historic: Record<string, string> = {
  // Civil ensign of the Dual Monarchy: Austria's bands at the hoist, Hungary's at the fly, a crowned shield on each.
  'h-austria-hungary': svg(`${bands('#c8102e', '#fff', '#c8102e')}<rect x="30" y="26.6" width="30" height="13.6" fill="#477050"/>${shield(15, '#c8102e', '#fff', '#c8102e')}${shield(45, '#c8102e', '#fff', '#477050')}`),
  // Purple-red with a golden laurel wreath, the eagle and SPQR.
  'h-rome': svg(
    `<rect width="60" height="40" fill="#8b0000"/>${Array.from({ length: 22 }, (_, i) => {
      const a = (i / 22) * 2 * Math.PI + 0.14;
      if (Math.abs(Math.sin(a) + 1) < 0.05) return '';
      return `<ellipse cx="${(30 + Math.cos(a) * 15).toFixed(2)}" cy="${(20 + Math.sin(a) * 15).toFixed(2)}" rx="2.6" ry="1.1" fill="${GOLD}" transform="rotate(${((a * 180) / Math.PI + 70).toFixed(1)} ${(30 + Math.cos(a) * 15).toFixed(2)} ${(20 + Math.sin(a) * 15).toFixed(2)})"/>`;
    }).join('')}${eagle(30, 15, 8, GOLD)}<text x="30" y="31" font-family="Georgia,serif" font-weight="700" font-size="7.5" text-anchor="middle" fill="${GOLD}">SPQR</text>`,
  ),
  // The Palaiologan banner: a golden cross between four firesteels, the "four Bs".
  'h-byzantium': svg(
    `<rect width="60" height="40" fill="#a3122a"/><rect x="26.5" width="7" height="40" fill="${GOLD}"/><rect y="16.5" width="60" height="7" fill="${GOLD}"/>${[
      [13, 8.5, -1],
      [47, 8.5, 1],
      [13, 31.5, -1],
      [47, 31.5, 1],
    ]
      .map(([x, y, s]) => `<text transform="translate(${x} ${y + 4.6}) scale(${s} 1)" font-family="Georgia,serif" font-weight="700" font-size="13" text-anchor="middle" fill="${GOLD}">B</text>`)
      .join('')}`,
  ),
  'h-german-empire': svg(bands('#000', '#fff', '#dd0000')),
  'h-prussia': svg(`<rect width="60" height="40" fill="#fff"/><rect width="60" height="5" fill="#000"/><rect y="35" width="60" height="5" fill="#000"/>${eagle(30, 21, 11, '#000')}<rect x="27" y="7.5" width="6" height="2" fill="${GOLD}"/>`),
  'h-ottoman': svg(`<rect width="60" height="40" fill="#c8102e"/><circle cx="25" cy="20" r="10" fill="#fff"/><circle cx="28" cy="20" r="8" fill="#c8102e"/>${star(39, 20, 5, '#fff', 'transform="rotate(-18 39 20)"')}`),
  // Red banner, hammer and sickle under a gold-edged star.
  'h-ussr': svg(
    `<rect width="60" height="40" fill="#cc0000"/>${star(12, 6.5, 3, '#cc0000', `stroke="${GOLD}" stroke-width=".8"`)}<path d="M8.5 19.5a6 6 0 1 0 7-7.6a7.6 7.6 0 0 1-5.6 9.2z" fill="${GOLD}"/><g transform="rotate(-45 12 15)"><rect x="11.2" y="11" width="1.6" height="9.5" fill="${GOLD}"/><rect x="9.6" y="9.6" width="5.2" height="2.4" fill="${GOLD}"/></g>`,
  ),
  'h-british-empire': modern['/node_modules/flag-icons/flags/4x3/gb.svg'],
  // The imperial banner: the black double eagle on gold.
  'h-hre': svg(`<rect width="60" height="40" fill="#f7d117"/>${eagle(30, 22, 14, '#000', 2)}<circle cx="24.6" cy="11.5" r="2.2" fill="none" stroke="#c8102e" stroke-width=".7"/><circle cx="35.4" cy="11.5" r="2.2" fill="none" stroke="#c8102e" stroke-width=".7"/>`),
  // The Vergina sun.
  'h-macedon': svg(`<rect width="60" height="40" fill="#1f4fa3"/>${rays(30, 20, 16, 5, 17, GOLD)}<circle cx="30" cy="20" r="5.2" fill="${GOLD}"/><circle cx="30" cy="20" r="3.4" fill="#1f4fa3"/><circle cx="30" cy="20" r="2.4" fill="${GOLD}"/>`),
  // No banner of Carthage survives; this is the sign of Tanit on Tyrian purple.
  'h-carthage': svg(`<rect width="60" height="40" fill="#5b2a86"/><g fill="#f5f0e1"><path d="M30 14l11 19h-22z"/><rect x="17" y="14.5" width="26" height="2.6"/><rect x="17" y="11.5" width="2.6" height="4"/><rect x="40.4" y="11.5" width="2.6" height="4"/><circle cx="30" cy="9.5" r="4.2"/></g><path d="M24 5a6 3 0 0 0 12 0a6 5 0 0 1-12 0z" fill="#f5f0e1"/>`),
  // Flame, sun and moon of the Soyombo on the eternal blue sky.
  'h-mongol': svg(`<rect width="60" height="40" fill="#2a6fb0"/><g fill="${GOLD}"><path d="M30 6q3 4 0 8q-3-4 0-8zM25.5 9q3 3 1.5 6q-3-2-1.5-6zM34.5 9q-3 3-1.5 6q3-2 1.5-6z"/><circle cx="30" cy="20" r="4.6"/><path d="M21 22a9 9 0 0 0 18 0a9 6.5 0 0 1-18 0z"/><rect x="20" y="31" width="20" height="2.4"/></g>`),
  'h-yugoslavia': svg(`${bands('#003893', '#fff', '#de0000')}${star(30, 20, 11, '#de0000', `stroke="${GOLD}" stroke-width="1.2"`)}`),
  // A red Nordic cross on gold.
  'h-kalmar': svg(`<rect width="60" height="40" fill="#f2b600"/><rect x="17" width="7" height="40" fill="#c8102e"/><rect y="16.5" width="60" height="7" fill="#c8102e"/>`),
};

if (verginaSun?.includes('<svg')) {
  const inner = verginaSun.replace(/<\?xml[^>]*>/, '').replace(/<svg\b/, '<svg x="12" y="2" width="36" height="36"');
  historic['h-macedon'] = svg(`<rect width="60" height="40" fill="#1f3f8f"/>${inner}`);
}

/** Where the picture of a library flag is, or undefined for an id the library does not have. */
export const flagUrl = (id: string): string | undefined =>
  (id === 'h-macedon' ? undefined : wikimedia[`/src/assets/flags/${id}.svg`]) ?? historic[id] ?? modern[`/node_modules/flag-icons/flags/4x3/${id}.svg`];
