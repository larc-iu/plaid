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
  ar: { name: 'Arabic', rolesets: 10041 },
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
  const base = baseTag(languageTag);
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

// The lemma of a roleset id: `leave-02` is `leave`, `have-org-role-92` is
// `have-org-role`.
const lemmaOf = (roleset) => String(roleset).replace(/-\d+$/, '');

// The forms of alif an Arabic text writes with a hamza (and the wasla), all
// read as plain alif: the bundled Arabic file keys `اعلن-01` without the
// hamza a text writes in أعلنت, and `ٱنكشف-01` with a wasla nobody types.
// The tatweel (ـ), a stretch between letters that spells nothing, goes too,
// so قـال reads as قال. Folded on both sides, the typed or written form and
// the file's keys.
const ALIF_FORMS = /[\u0622\u0623\u0625\u0671]/g;
const TATWEEL = /\u0640/g;
export const foldAlif = (text) =>
  String(text ?? '')
    .replace(TATWEEL, '')
    .replace(ALIF_FORMS, '\u0627');

const ARABIC = /\p{Script=Arabic}/u;

// One proclitic at most (and, but, with, for, like, the), then common
// suffixes of person, number and gender and the object pronouns: وقالت is
// و + قال + ت. Longest first, so ها is tried before ا. Not the future's س:
// it goes on an imperfect verb (سيقول), and the file's lemmas are perfect
// forms, so its stem never matched and it only offered خرت-01 for سخرت.
const ARABIC_PROCLITICS = ['\u0627\u0644', '\u0648', '\u0641', '\u0628', '\u0644', '\u0643'];
const ARABIC_SUFFIXES = [
  '\u0647\u0645\u0627', // هما
  '\u0648\u0627', // وا
  '\u0648\u0646', // ون
  '\u064a\u0646', // ين
  '\u0627\u0646', // ان
  '\u0627\u062a', // ات
  '\u062a\u0645', // تم
  '\u062a\u0646', // تن
  '\u0647\u0627', // ها
  '\u0647\u0645', // هم
  '\u0647\u0646', // هن
  '\u0643\u0645', // كم
  '\u0646\u0627', // نا
  '\u0646\u064a', // ني
  '\u062a', // ت
  '\u0629', // ة
  '\u0627', // ا
  '\u0647', // ه
  '\u0643', // ك
  '\u064a', // ي
];

// A stem is left at two letters or more: a guess shorter than that lists
// half the file.
const MIN_STEM = 2;

// The word, then the word less each proclitic it starts with.
function arabicStems(form) {
  const stems = [form];
  ARABIC_PROCLITICS.forEach((clitic) => {
    if (form.startsWith(clitic) && [...form].length - [...clitic].length >= MIN_STEM) {
      stems.push(form.slice(clitic.length));
    }
  });
  return stems;
}

function arabicCandidates(form) {
  const out = new Set([form]);
  const stems = arabicStems(form);
  stems.forEach((stem) => out.add(stem));
  stems.forEach((stem) => {
    ARABIC_SUFFIXES.forEach((suffix) => {
      if (stem.endsWith(suffix) && [...stem].length - [...suffix].length >= MIN_STEM) {
        out.add(stem.slice(0, -suffix.length));
      }
    });
  });
  return [...out];
}

// What a surface form might be the lemma of, best first: the form itself,
// lowercased, and the form less the common inflections, English's, or for a
// word in Arabic script its alif folded and tatweel dropped, less one
// proclitic and a suffix (ruled 2026-09-28). The word itself comes first,
// then what one strip leaves, then two. Other languages find their lemma by
// typing it. A wrong guess costs nothing but a listing, a missing one costs
// the annotator a search.
export function lemmaCandidates(form) {
  const f = String(form || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'-]/gu, '');
  if (!f) return [];
  if (ARABIC.test(f)) return arabicCandidates(foldAlif(f));
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

// `lemmaCandidates` on the word as it was written, the tatweel dropped but
// every hamza kept: الأم gives أم, where the folded guesses give ام and so
// also match ألام. Elsewhere the two are the same.
function writtenCandidates(form) {
  const f = String(form || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'-]/gu, '');
  if (!f || !ARABIC.test(f)) return lemmaCandidates(form);
  return arabicCandidates(f.replace(TATWEEL, ''));
}

// A defective verb, whose last root letter is weak, drops its final letter
// before a subject suffix: alif (دعا) and alif maqsura (رمى) before the ت of
// she (دعت, رمت), and those and the ya of a kasra verb (نسي) before the وا of
// they (دعوا, رموا, نسوا). A kasra verb keeps its ya before ت (نسيت), so ت
// puts back only alif or alif maqsura. These are the only drops restored.
const DEFECTIVE_DROPS = [
  ['\u062a', ['\u0627', '\u0649']], // ت: ا ى
  ['\u0648\u0627', ['\u0627', '\u0649', '\u064a']], // وا: ا ى ي
];
const WEAK_FINAL = /[\u0627\u0649\u064a]$/u;

// The lemmas a defective verb's suffixed form leaves once its dropped letter
// is back, for one prepared form (folded, or as written): نمت gives نما and
// نمى, ورموا gives رما, رمى and رمي.
function defectiveCandidates(form) {
  const out = new Set();
  arabicStems(form).forEach((stem) => {
    DEFECTIVE_DROPS.forEach(([suffix, finals]) => {
      if (stem.endsWith(suffix) && [...stem].length - [...suffix].length >= MIN_STEM) {
        finals.forEach((final) => out.add(stem.slice(0, -suffix.length) + final));
      }
    });
  });
  return [...out];
}

// A word's defective guesses, folded and as written, less any its ordinary
// guesses already make. None outside Arabic script.
function restoredCandidates(form, ordinary, written) {
  const f = String(form || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'-]/gu, '');
  if (!f || !ARABIC.test(f)) return { folded: [], written: [] };
  return {
    folded: defectiveCandidates(foldAlif(f)).filter((c) => !ordinary.includes(c)),
    written: defectiveCandidates(f.replace(TATWEEL, '')).filter((c) => !written.includes(c)),
  };
}

// A roleset's lemma less the second hyphen of a lost vowel class: upstream's
// Arabic keeps `أثر--01` beside a different `أثر-01`, and it is a sense of أثر.
const DOUBLED = /-$/;

/**
 * The rolesets of a frame file whose lemma is one of the candidates, best
 * first: every lemma the word gives as it is before one found only by putting
 * back a defective verb's dropped letter (نمت lists نمت-01 and نم-01 before
 * نما-01), then a lemma guessed from the word as written before one only its
 * alif fold finds (الأم lists أم-01 before ألام-01), then an exact lemma
 * before a stripped one, a lemma's plain senses before its `lemma--NN` ones,
 * lower sense numbers first.
 * @returns {Array<{ id: string, lemma: string, args: object }>}
 */
export function sensesFor(frames, form) {
  if (!frames) return [];
  const candidates = lemmaCandidates(form);
  const written = writtenCandidates(form);
  const restored = restoredCandidates(form, candidates, written);
  const out = [];
  const seen = new Set();
  const collect = (lemmas, writtenLemmas, isRestored) =>
    lemmas.forEach((lemma, rank) => {
      rolesetsStartingWith(frames, `${lemma}-`, 200).forEach(({ id, args }) => {
        const full = lemmaOf(id);
        const doubled = DOUBLED.test(full);
        const own = doubled ? full.slice(0, -1) : full;
        if (foldAlif(own) !== lemma || seen.has(id)) return;
        // A letter put back is a weak one, never a hamza: أنبأ keeps its
        // hamza before ت (أنبأت), so أنبت is not أنبأ.
        if (isRestored && !WEAK_FINAL.test(own)) return;
        seen.add(id);
        // Guessed from the word as written, it ranks among those guesses.
        const asWritten = writtenLemmas.indexOf(own);
        const folded = asWritten < 0;
        const at = folded ? rank : asWritten;
        out.push({ id, lemma: own, args, rank: at, folded, doubled, restored: isRestored });
      });
    });
  collect(candidates, written, false);
  collect(restored.folded, restored.written, true);
  return out
    .sort(
      (a, b) =>
        a.restored - b.restored ||
        a.folded - b.folded ||
        a.rank - b.rank ||
        a.doubled - b.doubled ||
        a.id.localeCompare(b.id, undefined, { numeric: true }),
    )
    .map(({ id, lemma, args }) => ({ id, lemma, args }));
}

// A frame file's ids, each with its alif folded, sorted by that, once per
// file: the picker asks on every keystroke and a file has tens of thousands
// of entries.
const keyLists = new WeakMap();
const keysOf = (frames) => {
  let keys = keyLists.get(frames);
  if (!keys) {
    keys = Object.keys(frames)
      .map((id) => [foldAlif(id), id])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    keyLists.set(frames, keys);
  }
  return keys;
};

// The rolesets whose id starts with what was typed, alif folded on both
// sides (أعلن finds `اعلن-01`). Capped: a frame file has thousands.
export function rolesetsStartingWith(frames, prefix, limit = 40) {
  if (!frames) return [];
  const p = foldAlif(String(prefix || '').toLowerCase());
  if (!p) return [];
  const out = [];
  for (const [key, id] of keysOf(frames)) {
    if (key < p && !key.startsWith(p)) continue;
    if (key > p && !key.startsWith(p)) break;
    if (key.startsWith(p)) {
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

// An argument's number for ordering, the numbered ones first: a stored
// roleset's keys come back in any order (core keeps none).
const argNumber = (key) => (/^ARG\d+$/i.test(key) ? Number(key.slice(3)) : Infinity);

// One line summarizing a roleset for a list: `ARG0 giver, ARG1 thing given`,
// in number order, anything else (`ARGM-LOC`) after in the order given.
export const argSummary = (args) =>
  Object.entries(args || {})
    .map((entry, i) => [entry, i])
    .sort(([[a], i], [[b], j]) => argNumber(a) - argNumber(b) || i - j)
    .map(([[k, v]]) => `${k} ${v}`)
    .join(', ');
