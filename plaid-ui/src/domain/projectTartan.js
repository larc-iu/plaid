// Every project's own cloth: a tartan sett woven from a hash of the project's
// id, so the same project wears the same tartan in every app and nothing is
// stored. It sits beside the project's name (the project list, a breadcrumb,
// the project heading, the browser tab), which is what tells two projects of
// one name apart.
//
// The WHOLE id is hashed, never read as digits: a UUIDv7 starts with the time
// it was made, so projects made close together share a prefix.
//
// A sett is written as a weaver writes it: the half-sett's stripes in thread
// counts, mirrored at its two pivots into one repeat, the same in warp and
// weft. The dyes are muted tartan dyes. None is violet or amber, which mark a
// machine's and a contributor's work on every annotation surface, and none is
// oxblood, which is the product mark's own.

const DARK = ['#2a2d31', '#22364f', '#2e5539', '#4a3526', '#264b47'];
const MID = ['#43678a', '#9a4b2c', '#6b6d34', '#8a6a45', '#85817a', '#4f7a55'];
const LIGHT = ['#c7a042', '#e8dfc6', '#9db6c9', '#b5bf8f'];

// FNV-1a over the id, then mulberry32.
const fnv = (s) => {
  let h = 0x811c9dc5;
  for (const c of s) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
};
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];

// Stripe widths in pairs of threads: extra small, small, medium, large.
const WIDTHS = { XS: [1, 2], S: [2, 4], M: [4, 8], L: [9, 17] };
const width = (r, k) => 2 * (WIDTHS[k][0] + Math.floor(r() * (WIDTHS[k][1] - WIDTHS[k][0] + 1)));

// Half-setts by role: g the ground, d a second dark (or a mid), a the accent,
// o the light overcheck.
const TEMPLATES = [
  ['gL', 'oXS', 'gS', 'aM', 'dL'],
  ['dL', 'aXS', 'gL', 'oXS'],
  ['gL', 'aS', 'gXS', 'aS', 'dM', 'oXS'],
  ['aM', 'gL', 'oXS', 'gS', 'dM'],
  ['gL', 'dM', 'aXS', 'dM', 'oS'],
];

/**
 * The tartan of the project with this id: `stripes`, one repeat's stripes in
 * order as `{ color, n }` (n threads), and `bands`, what is left of it at
 * 16px and below. Bands are the ground, the two broadest other stripes crossing
 * it, and the light overcheck as a hairline, each `{ color, at, w }` as a
 * fraction of the swatch, drawn as the product mark draws its cloth.
 */
const tartanOf = (id) => {
  const r = rng(fnv(String(id ?? '')));
  const g = pick(r, DARK);
  let d = pick(r, DARK);
  while (d === g) d = pick(r, DARK);
  if (r() < 0.4) d = pick(r, MID);
  let a = pick(r, MID);
  while (a === d) a = pick(r, MID);
  const role = { g, d, a, o: pick(r, LIGHT) };
  const half = pick(r, TEMPLATES).map((t) => ({ color: role[t[0]], n: width(r, t.slice(1)) }));
  const stripes = [...half, ...half.slice(1, -1).reverse()];

  const total = new Map();
  for (const s of half) total.set(s.color, (total.get(s.color) || 0) + s.n);
  const ground = [...total].sort((x, y) => y[1] - x[1])[0][0];
  const others = half
    .filter((s) => s.color !== ground && !LIGHT.includes(s.color))
    .sort((x, y) => y.n - x.n);
  const light = half.find((s) => LIGHT.includes(s.color));
  const bands = {
    ground,
    broad: others[0] ? { color: others[0].color, at: 0.08 + r() * 0.1, w: 0.3 } : null,
    narrow: others[1] ? { color: others[1].color, at: 0.6 + r() * 0.12, w: 0.13 } : null,
    check: light ? { color: light.color, at: 0.48 + r() * 0.06, w: 0.05 } : null,
  };
  return { stripes, bands };
};

// The cloth fills 19 units of a 24-unit box, as the product mark's does, cut
// as a swatch card with its lower corner folded: a third silhouette beside the
// product's square and the assistant's circle, which share an app header.
const EDGE = 2.5;
const SPAN = 19;
const FOLD = 5.7;
export const TARTAN_CUT = `M${EDGE} ${EDGE}H${EDGE + SPAN}V${EDGE + SPAN - FOLD}L${EDGE + SPAN - FOLD} ${EDGE + SPAN}H${EDGE}Z`;

/**
 * The rectangles that draw a project's tartan in the 24-unit box, each
 * `{ x, y, w, h, color, opacity }`, under the cut TARTAN_CUT. At `size` 16px
 * and below, the bands (tartanOf). Above, the whole sett, about one and a
 * quarter repeats across: the warp's stripes, then the weft's over them at
 * half strength, which at these sizes is what the twill looks like, since a
 * thread is narrower than a pixel.
 */
export const tartanRects = (id, size) => {
  const { stripes, bands } = tartanOf(id);
  const out = [{ x: EDGE, y: EDGE, w: SPAN, h: SPAN, color: bands.ground, opacity: 1 }];
  const cross = (color, at, w, opacity) =>
    out.push(
      { x: at, y: EDGE, w, h: SPAN, color, opacity },
      { x: EDGE, y: at, w: SPAN, h: w, color, opacity },
    );
  if (size <= 16) {
    const band = (b, opacity) => b && cross(b.color, EDGE + b.at * SPAN, b.w * SPAN, opacity);
    band(bands.broad, 0.75);
    band(bands.narrow, 0.6);
    band(bands.check, 0.9);
    return out;
  }
  const threads = stripes.reduce((n, s) => n + s.n, 0);
  const unit = SPAN / 1.25 / threads;
  const runs = [];
  for (let at = EDGE, i = 0; at < EDGE + SPAN; i++) {
    const s = stripes[i % stripes.length];
    runs.push({ at, w: s.n * unit, color: s.color });
    at += s.n * unit;
  }
  for (const r of runs) out.push({ x: r.at, y: EDGE, w: r.w, h: SPAN, color: r.color, opacity: 1 });
  for (const r of runs)
    out.push({ x: EDGE, y: r.at, w: SPAN, h: r.w, color: r.color, opacity: 0.5 });
  return out;
};
