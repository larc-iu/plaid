// The gloss lines under a sentence and in the file's token block, and where
// each one comes from: a project's own layers (IGT's morphemes and its
// Word-, Morpheme- and Sentence-scoped fields), or lines an imported file
// carried that no layer holds.
//
// `config.umr.ilg` is an ordered list of `{ header, lang, source }`:
//   header  one of HEADERS' keys ('morpheme-gloss', 'word-gloss', ...)
//   lang    an ISO code for the headers that carry one, else null
//   source  'morphemes' (the morpheme token layer), 'layer:<spanLayerId>', or
//           'stored' (every imported line no other entry covers)
// Index and Words are always written and never configured.

// By its real path rather than through `@ui`: the node suite, which runs
// this file, has no alias (see sentenceGraph.js).
import { morphemeJoiner } from '../../../plaid-ui/src/domain/morphemes.js';

export const HEADERS = [
  { key: 'morphemes', header: 'Morphemes', scope: 'morpheme', lang: false },
  { key: 'morpheme-gloss', header: 'Morpheme Gloss', scope: 'morpheme', lang: true },
  { key: 'morpheme-category', header: 'Morpheme Category', scope: 'morpheme', lang: false },
  { key: 'word-gloss', header: 'Word Gloss', scope: 'word', lang: true },
  { key: 'pos', header: 'Part of Speech', scope: 'word', lang: false },
  { key: 'sentence-gloss', header: 'Sentence Gloss', scope: 'sentence', lang: true },
  { key: 'sentence', header: 'Sentence', scope: 'sentence', lang: false },
];

const headerOf = (key) => HEADERS.find((h) => h.key === key) || null;

// Word lines, then morpheme lines, then sentence lines, whatever order a
// mapping was written in. That is the order an interlinear text is read in,
// and it is what lets a word's morpheme lines share their columns: the canvas
// lays them out as one grid, which wants them together.
//
// STABLE within a scope, so the Settings screen's arrows still order the lines
// of one scope against each other. The `stored` entry names no header and
// keeps its place at the end.
const SCOPE_RANK = { word: 0, morpheme: 1, sentence: 2 };
const scopeRank = (entry) => {
  const h = headerOf(entry?.header);
  if (!h) return 4;
  return SCOPE_RANK[h.scope] ?? 3;
};

export const sortIlg = (mapping) =>
  (mapping || [])
    .map((entry, i) => [entry, i])
    .sort(([a, ai], [b, bi]) => scopeRank(a) - scopeRank(b) || ai - bi)
    .map(([entry]) => entry);

// A layer's name says what it holds, often enough to propose a mapping.
const looksLike = (name, re) => re.test(String(name || ''));

/**
 * A mapping proposed from the project's layers: the morpheme layer as
 * Morphemes, a morpheme-scoped field named like a gloss as Morpheme Gloss,
 * a word-scoped one as Word Gloss, a sentence-scoped translation as Sentence
 * Gloss, and whatever an import stored after those.
 */
export function proposeIlg(layerInfo) {
  const out = [];
  if (layerInfo?.morphemeTokenLayer)
    out.push({ header: 'morphemes', lang: null, source: 'morphemes' });
  (layerInfo?.glossLayers || []).forEach(({ layer, scope, lang }) => {
    const name = layer.name;
    let header = null;
    if (scope === 'morpheme') {
      if (looksLike(name, /gloss|meaning/i)) header = 'morpheme-gloss';
      else if (looksLike(name, /cat|pos|part|type|class/i)) header = 'morpheme-category';
    } else if (scope === 'word') {
      if (looksLike(name, /gloss|meaning/i)) header = 'word-gloss';
      else if (looksLike(name, /pos|part|tag|class/i)) header = 'pos';
    } else if (scope === 'sentence') {
      if (looksLike(name, /trans|gloss|free|meaning/i)) header = 'sentence-gloss';
    }
    if (!header) return;
    const h = headerOf(header);
    out.push({ header, lang: h.lang ? languageCode(lang) : null, source: `layer:${layer.id}` });
  });
  out.push({ header: null, lang: null, source: 'stored' });
  return sortIlg(out);
}

/**
 * The project's mapping when it has one, else the proposal. A line whose
 * layer is gone takes the layer the proposal names for the same line: an
 * archive import, a project copy and a restore all give a layer a new id, and
 * the mapping, which names layers by id, then drew and wrote nothing for that
 * line, with nothing said about why.
 */
export function resolveIlg(config, layerInfo) {
  if (!Array.isArray(config) || !config.length) return proposeIlg(layerInfo);
  const live = new Set((layerInfo?.glossLayers || []).map((g) => g.layer.id));
  const isLayer = (source) => String(source ?? '').startsWith('layer:');
  const slot = (entry) => `${entry.header}|${entry.lang || ''}`;
  const proposed = new Map(
    proposeIlg(layerInfo)
      .filter((e) => isLayer(e.source))
      .map((e) => [slot(e), e.source]),
  );
  return sortIlg(
    config.map((entry) => {
      if (!isLayer(entry.source) || live.has(String(entry.source).replace(/^layer:/, ''))) {
        return entry;
      }
      const source = proposed.get(slot(entry));
      return source ? { ...entry, source } : entry;
    }),
  );
}

// The stored key of a line an import kept, as umrFile.js normalizes headers.
const STORED_KEYS = new Set(HEADERS.map((h) => h.key));

/**
 * The lines of one sentence, in the mapping's order. Each line is
 * `{ header, key, lang, items, perWord }`: `items` is what the file writes
 * (whitespace-joined), `perWord` groups the items under the words for the
 * canvas (null for a sentence-level line).
 *
 * @param {object} sentence from buildDocumentGraph, with words, morphemes and
 *   the stored lines in `storedIlg`
 * @param {object} layerInfo
 * @param {Array} mapping the resolved config
 */
export function ilgLinesFor(sentence, layerInfo, mapping) {
  const words = sentence.words;
  const morphemesByWord = morphemesPerWord(sentence);
  const glossLayers = new Map((layerInfo?.glossLayers || []).map((g) => [g.layer.id, g]));
  // What the layers produced, by header and language, so a stored line the
  // layers cover is not written twice while one they do not is kept.
  const produced = new Set();
  const lines = [];
  const stored = sentence.storedIlg || [];
  const slot = (key, lang) => `${key}|${lang || ''}`;
  // A line is a line only with something in it: an empty layer (a document
  // imported into a glossed project, not yet glossed) must not push out the
  // stored line and must not be written as `_ _ _`.
  const push = (line) => {
    if (!line.items.length || line.items.every((x) => x === '_')) return;
    lines.push(line);
    produced.add(slot(line.key, line.lang));
  };

  mapping.forEach((entry) => {
    if (entry.source === 'stored') return;
    const h = headerOf(entry.header);
    if (!h) return;
    const base = { header: h.header, key: h.key, lang: h.lang ? languageCode(entry.lang) : null };
    if (entry.source === 'morphemes') {
      // A word with no morphemes (IGT's unanalyzed word) keeps its place.
      const perWord = morphemesByWord.map((ms) =>
        ms.length ? ms.map((m) => item(m.text)) : ['_'],
      );
      push({ ...base, items: perWord.flat(), perWord });
      return;
    }
    const id = String(entry.source).replace(/^layer:/, '');
    const g = glossLayers.get(id);
    if (!g) return;
    const valueOf = valueByToken(g.layer);
    if (g.scope === 'morpheme') {
      const perWord = morphemesByWord.map((ms) =>
        ms.length ? ms.map((m) => item(valueOf(m.id))) : ['_'],
      );
      push({ ...base, items: perWord.flat(), perWord });
    } else if (g.scope === 'word') {
      const perWord = words.map((w) => [item(valueOf(w.id))]);
      push({ ...base, items: perWord.flat(), perWord });
    } else {
      const text = valueOf(sentence.tokenId) ?? '';
      const items = String(text).split(/\s+/).filter(Boolean);
      push({ ...base, items, perWord: null });
    }
  });

  if (mapping.some((e) => e.source === 'stored')) {
    perWordStored(stored, words.length).forEach((line) => {
      if (STORED_KEYS.has(line.key) && produced.has(slot(line.key, line.lang))) return;
      lines.push(line);
    });
  }
  // Sorted here as well as in the mapping, so a line an IMPORT carried obeys
  // the reading order too: a stored word gloss belongs beside the other word
  // lines, not under the sentence. Stable, so a stored line still follows the
  // produced line of its own scope.
  return sortLines(lines);
}

// The rendered lines in reading order. Keyed on the line rather than a mapping
// entry, since a stored line has no entry.
const sortLines = (lines) =>
  lines
    .map((line, i) => [line, i])
    .sort(
      ([a, ai], [b, bi]) => scopeRank({ header: a.key }) - scopeRank({ header: b.key }) || ai - bi,
    )
    .map(([line]) => line);

// Whether an item of a line joins the one after it (a prefix or proclitic,
// `neseihiin-`, `ma=`) or the one before it (a suffix or enclitic, `-3i'`,
// `=go`): the Leipzig convention that writes the morphemes of one word
// joined by hyphens, and a clitic by an equals sign.
const joinsNext = (item) => item.length > 1 && /[-=]$/.test(item);
const joinsPrevious = (item) => item.length > 1 && /^[-=]/.test(item);

/** A line's item indexes grouped into words by those joiners. */
export const wordGroups = (items) => {
  const groups = [];
  items.forEach((item, i) => {
    if (i > 0 && (joinsPrevious(item) || joinsNext(items[i - 1]))) {
      groups[groups.length - 1].push(i);
    } else groups.push([i]);
  });
  return groups;
};

const SENTENCE_KEYS = new Set(['sentence-gloss', 'sentence']);

/**
 * The lines an imported file carried, laid under the words wherever the
 * file lets that be told: a line with one item per word; a line whose own
 * joiners group it into as many words as there are (`’a- ní- dz- oo- d- záa
 * =go` is one word); or a line paired item for item with the Morphemes line
 * when that one groups into the words (its glosses). Whitespace alone cannot
 * say which word a morpheme belongs to, and a file's column alignment is not
 * a reliable guide (Sanapaná's corpus aligns its lines item by item). Any
 * other line, and a translation always, runs as a row of its own.
 */
export function perWordStored(lines, wordCount) {
  const morphemes = lines.find((l) => l.key === 'morphemes');
  const morphemeGroups = morphemes ? wordGroups(morphemes.items) : null;
  const fits = (groups) => !!groups && groups.length === wordCount;
  return lines.map((line) => {
    const { items } = line;
    let groups = null;
    if (wordCount && items.length && !SENTENCE_KEYS.has(line.key)) {
      const own = wordGroups(items);
      if (items.length === wordCount) groups = items.map((_, i) => [i]);
      else if (fits(own)) groups = own;
      else if (fits(morphemeGroups) && items.length === morphemes.items.length) {
        groups = morphemeGroups;
      }
    }
    return { ...line, perWord: groups ? groups.map((g) => g.map((i) => items[i])) : null };
  });
}

// One item of a gloss line: the file has no quoting, so a value with a
// space in it (`give birth`) is one item with the spaces made visible.
// The morphemes of each word, in their order within it.
const morphemesPerWord = (sentence) =>
  (sentence.words || []).map((w) =>
    (sentence.morphemes || [])
      .filter((m) => m.begin >= w.begin && m.end <= w.end)
      .sort((a, b) => a.begin - b.begin || (a.precedence ?? 0) - (b.precedence ?? 0)),
  );

/**
 * The joint to draw BEFORE each morpheme of each word, '' for the first of a
 * word: `[['', '-'], ['', '=', '-']]`. A display concern only, which is why
 * it is not on the lines themselves: an exported file writes the forms bare.
 */
export const morphemeJoinersFor = (sentence) =>
  morphemesPerWord(sentence).map((ms) =>
    ms.map((m, i) => (i === 0 ? '' : morphemeJoiner(ms[i - 1]?.morphType, m.morphType))),
  );

const item = (value) => {
  const v = value == null ? '' : String(value).trim().replace(/\s+/g, '_');
  return v || '_';
};

// The two- or three-letter code a gloss header takes, from whatever a
// layer or a person wrote (`en`, `pt-BR`, `qaa-x-eng`): `und` when there is
// none to be had.
export const languageCode = (lang) => {
  const base = String(lang || '')
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(base) ? base : 'und';
};

// A span layer's value by the first token of each span.
function valueByToken(layer) {
  const map = new Map();
  (layer.spans || []).forEach((span) => {
    const first = span.tokens?.[0];
    if (first != null && span.value != null && span.value !== '')
      map.set(first, String(span.value));
  });
  return (tokenId) => map.get(tokenId) ?? null;
}
