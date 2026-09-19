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
    out.push({ header, lang: h.lang ? lang || 'und' : null, source: `layer:${layer.id}` });
  });
  out.push({ header: null, lang: null, source: 'stored' });
  return out;
}

/** The project's mapping when it has one, else the proposal. */
export function resolveIlg(config, layerInfo) {
  return Array.isArray(config) && config.length ? config : proposeIlg(layerInfo);
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
  const morphemesByWord = words.map((w) =>
    (sentence.morphemes || [])
      .filter((m) => m.begin >= w.begin && m.end <= w.end)
      .sort((a, b) => a.begin - b.begin || (a.precedence ?? 0) - (b.precedence ?? 0)),
  );
  const glossLayers = new Map((layerInfo?.glossLayers || []).map((g) => [g.layer.id, g]));
  const produced = new Set();
  const lines = [];
  const stored = sentence.storedIlg || [];

  mapping.forEach((entry) => {
    if (entry.source === 'stored') return;
    const h = headerOf(entry.header);
    if (!h) return;
    const base = { header: h.header, key: h.key, lang: h.lang ? entry.lang || 'und' : null };
    if (entry.source === 'morphemes') {
      const perWord = morphemesByWord.map((ms) => ms.map((m) => m.text || '_'));
      lines.push({ ...base, items: perWord.flat(), perWord });
      produced.add(h.key);
      return;
    }
    const id = String(entry.source).replace(/^layer:/, '');
    const g = glossLayers.get(id);
    if (!g) return;
    const valueOf = valueByToken(g.layer);
    if (g.scope === 'morpheme') {
      const perWord = morphemesByWord.map((ms) => ms.map((m) => valueOf(m.id) ?? '_'));
      lines.push({ ...base, items: perWord.flat(), perWord });
    } else if (g.scope === 'word') {
      const perWord = words.map((w) => [valueOf(w.id) ?? '_']);
      lines.push({ ...base, items: perWord.flat(), perWord });
    } else {
      const text = valueOf(sentence.tokenId) ?? '';
      const items = String(text).split(/\s+/).filter(Boolean);
      if (items.length) lines.push({ ...base, items, perWord: null });
    }
    produced.add(h.key);
  });

  if (mapping.some((e) => e.source === 'stored')) {
    stored.forEach((line) => {
      if (STORED_KEYS.has(line.key) && produced.has(line.key)) return;
      const perWord = line.items.length === words.length ? line.items.map((x) => [x]) : null;
      lines.push({ ...line, perWord });
    });
  }
  return lines;
}

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
