// The rolesets a concept picker offers: the bundled frame file of the
// project's language (src/data/frames, one flat object of roleset id to its
// argument descriptions), later joined by the project's own rolesets.
//
// Loaded on demand and once, by language: a frame file is a megabyte, and a
// project in Arapaho has none.

const FILES = {
  en: () => import('../data/frames/english.json'),
  zh: () => import('../data/frames/chinese.json'),
  ar: () => import('../data/frames/arabic.json'),
  pt: () => import('../data/frames/portuguese.json'),
};

/**
 * What each bundled file holds, for a screen that wants to SAY so without
 * fetching a megabyte to count. `frames.test.js` reads the files and fails
 * while a count here disagrees, so the shortcut cannot drift.
 */
export const FRAME_LANGUAGES = Object.freeze({
  en: { name: 'English', rolesets: 8733 },
  zh: { name: 'Chinese', rolesets: 16891 },
  ar: { name: 'Arabic', rolesets: 10073 },
  pt: { name: 'Portuguese', rolesets: 1410 },
});

/** The base of a BCP-47 tag: `en-US` and `en_GB` are both `en`. */
export const baseTag = (languageTag) =>
  String(languageTag || '')
    .toLowerCase()
    .split(/[-_]/)[0];

/** What the bundled file for a tag holds, or null when there is none. */
export const framesFor = (languageTag) => FRAME_LANGUAGES[baseTag(languageTag)] || null;

const loaded = new Map();

// The frame file for a BCP-47 tag (`en-US` reads as `en`), or null when the
// language has none.
export function loadFrames(languageTag) {
  const base = String(languageTag || '')
    .toLowerCase()
    .split(/[-_]/)[0];
  const load = FILES[base];
  if (!load) return Promise.resolve(null);
  if (!loaded.has(base)) {
    loaded.set(
      base,
      load()
        .then((m) => m.default || m)
        .catch((err) => {
          console.error(`Could not load the ${base} frame file:`, err);
          loaded.delete(base);
          return null;
        }),
    );
  }
  return loaded.get(base);
}

export const hasFrames = (languageTag) =>
  Boolean(
    FILES[
      String(languageTag || '')
        .toLowerCase()
        .split(/[-_]/)[0]
    ],
  );

// The lemma of a roleset id: `leave-02` is `leave`, `have-org-role-92` is
// `have-org-role`.
const lemmaOf = (roleset) => String(roleset).replace(/-\d+$/, '');

// What a surface form might be the lemma of, in English at least: the form
// itself, lowercased, and the form less the common inflections. A wrong
// guess costs nothing but a listing; a missing one costs the annotator a
// search.
export function lemmaCandidates(form) {
  const f = String(form || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'-]/gu, '');
  if (!f) return [];
  const out = new Set([f]);
  const strip = (suffix, replacement = '') => {
    if (f.endsWith(suffix) && f.length > suffix.length + 1) {
      out.add(f.slice(0, -suffix.length) + replacement);
    }
  };
  strip('ies', 'y');
  strip('es');
  strip('s');
  strip('ied', 'y');
  strip('ed');
  strip('d');
  strip('ing');
  strip('ing', 'e');
  // A doubled consonant before -ing or -ed: running, stopped.
  const doubled = f.match(/^(.*?)([bdfglmnprstz])\2(ing|ed)$/);
  if (doubled) out.add(doubled[1] + doubled[2]);
  return [...out];
}

/**
 * The rolesets of a frame file whose lemma is one of the candidates, best
 * first: an exact lemma before a stripped one, lower sense numbers first.
 * @returns {Array<{ id: string, lemma: string, args: object }>}
 */
export function sensesFor(frames, form) {
  if (!frames) return [];
  const candidates = lemmaCandidates(form);
  const out = [];
  candidates.forEach((lemma, rank) => {
    rolesetsStartingWith(frames, `${lemma}-`, 200).forEach(({ id, args }) => {
      if (lemmaOf(id) === lemma) out.push({ id, lemma, args, rank });
    });
  });
  return out
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id, undefined, { numeric: true }))
    .map(({ id, lemma, args }) => ({ id, lemma, args }));
}

// A frame file's ids, sorted, once per file: the picker asks on every
// keystroke and a file has tens of thousands of entries.
const keyLists = new WeakMap();
const keysOf = (frames) => {
  let keys = keyLists.get(frames);
  if (!keys) {
    keys = Object.keys(frames).sort();
    keyLists.set(frames, keys);
  }
  return keys;
};

// The rolesets whose id starts with what was typed, for a picker with no
// anchored word to go on. Capped: a frame file has thousands.
export function rolesetsStartingWith(frames, prefix, limit = 40) {
  if (!frames) return [];
  const p = String(prefix || '').toLowerCase();
  if (!p) return [];
  const out = [];
  for (const id of keysOf(frames)) {
    if (id < p && !id.startsWith(p)) continue;
    if (id > p && !id.startsWith(p)) break;
    if (id.startsWith(p)) {
      out.push({ id, lemma: lemmaOf(id), args: frames[id] });
      if (out.length >= limit) break;
    }
  }
  return out;
}

// The arguments of a roleset as `[{ role: ':ARG0', description }]`, in
// number order, or [] for a concept the file does not know.
export function argsOf(frames, roleset) {
  const args = frames?.[roleset];
  if (!args) return [];
  return Object.entries(args)
    .filter(([k]) => /^ARG\d+$/i.test(k))
    .sort((a, b) => Number(a[0].slice(3)) - Number(b[0].slice(3)))
    .map(([k, description]) => ({ role: `:${k.toUpperCase()}`, description }));
}

// One line summarizing a roleset for a list: `ARG0 giver, ARG1 thing given`.
export const argSummary = (args) =>
  Object.entries(args || {})
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
