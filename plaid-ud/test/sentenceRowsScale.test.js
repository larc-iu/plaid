// The annotation grid's rows are built in one sweep of the document, not one
// filter of every layer per sentence and per word. The sweep must give exactly
// what the filters gave, on any extents (overlaps, gaps, empty tokens, astral
// text), and a 20,000-word document must build in well under two seconds. The
// filters took 68 s on a real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSentenceRows } from '../src/domain/sentenceRows.js';

// The builder as it was before the sweep, kept as the oracle.
const cpSlice = (s, b, e) => [...s].slice(b, e).join('');
const containsToken = (parent, child) =>
  parent.begin <= child.begin && child.end <= parent.end && child.begin < parent.end;
const byPosition = (a, b) =>
  a.begin - b.begin || a.end - b.end || (a.precedence ?? 0) - (b.precedence ?? 0);
const spanIndex = (layer) => {
  const index = new Map();
  (layer?.spans || []).forEach((span) => {
    (span.tokens || []).forEach((id) => {
      if (!index.has(id)) index.set(id, []);
      index.get(id).push(span);
    });
  });
  return index;
};
function referenceRows(body, info) {
  if (!body) return [];
  const sentences = [...(info.sentenceTokenLayer?.tokens || [])].sort(byPosition);
  const words = [...(info.wordTokenLayer?.tokens || [])].sort(byPosition);
  const morphemes = [...(info.morphemeTokenLayer?.tokens || [])].sort(byPosition);
  if (!info.morphemeTokenLayer) return [];
  const idx = {
    form: spanIndex(info.formLayer),
    lemma: spanIndex(info.lemmaLayer),
    upos: spanIndex(info.uposLayer),
    xpos: spanIndex(info.xposLayer),
    feats: spanIndex(info.featuresLayer),
  };
  const entry = (m, tokenIndex, word) => {
    const formSpan = (idx.form.get(m.id) || [])[0] || null;
    const lemma = (idx.lemma.get(m.id) || [])[0] || null;
    const upos = (idx.upos.get(m.id) || [])[0] || null;
    const xpos = (idx.xpos.get(m.id) || [])[0] || null;
    const feats = (idx.feats.get(m.id) || []).filter((s) => s.value);
    const sub = cpSlice(body, m.begin, m.end);
    const tokenForm = formSpan?.value != null && formSpan.value !== '' ? formSpan.value : sub;
    return {
      token: m,
      tokenForm,
      form: formSpan,
      lemma,
      upos,
      xpos,
      feats,
      word: word || null,
      wordForm: word ? cpSlice(body, word.begin, word.end) : tokenForm,
      spanIds: {
        form: formSpan?.id || null,
        lemma: lemma?.id || null,
        upos: upos?.id || null,
        xpos: xpos?.id || null,
        features: feats.map((s) => ({ value: s.value, spanId: s.id })),
      },
      tokenIndex,
    };
  };
  const effective = sentences.length
    ? sentences
    : [{ id: '__all__', begin: 0, end: [...body].length }];
  const rows = [];
  effective.forEach((sentence, si) => {
    const inSentence = words.filter((w) => containsToken(sentence, w));
    const entries = [];
    let n = 0;
    if (inSentence.length) {
      inSentence.forEach((w) => {
        const stored = morphemes.filter((m) => containsToken(w, m));
        // A word with no UD word yet stands in for the one the seed makes.
        const ms = stored.length
          ? stored
          : [{ id: `virtual:${w.id}`, begin: w.begin, end: w.end, precedence: 0 }];
        ms.forEach((m, i) => {
          const e = entry(m, n + 1, w);
          if (!stored.length) e.virtual = true;
          e.isFirstMorphemeOfWord = i === 0;
          e.wordHasMultipleMorphemes = ms.length > 1;
          entries.push(e);
          n += 1;
        });
      });
    } else {
      morphemes
        .filter((m) => containsToken(sentence, m))
        .forEach((m) => {
          const e = entry(m, n + 1, null);
          e.isFirstMorphemeOfWord = true;
          e.wordHasMultipleMorphemes = false;
          entries.push(e);
          n += 1;
        });
    }
    if (!entries.length) return;
    const ids = new Set(entries.map((e) => e.token.id));
    const lemmaSpans = (info.lemmaLayer?.spans || []).filter((s) =>
      (s.tokens || []).some((t) => ids.has(t)),
    );
    const lemmaIds = new Set(lemmaSpans.map((s) => s.id));
    rows.push({
      id: sentence.id ?? si,
      text: cpSlice(body, sentence.begin, sentence.end),
      sentenceToken: sentences.length ? sentence : null,
      tokens: entries,
      relations: (info.relationLayer?.relations || []).filter((r) => lemmaIds.has(r.source)),
      enhancedRelations: (info.enhancedRelationLayer?.relations || []).filter((r) =>
        lemmaIds.has(r.source),
      ),
      lemmaSpans,
    });
  });
  return rows;
}

// A small seeded generator, so a failure names a seed that reproduces it.
const rng = (seed) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

function randomDoc(seed) {
  const r = rng(seed);
  const int = (n) => Math.floor(r() * n);
  const alphabet = ['a', 'b', ' ', 'ö', '😀', '𐌰', 'ب', '.'];
  const len = 5 + int(40);
  const body = Array.from({ length: len }, () => alphabet[int(alphabet.length)]).join('');
  let next = 0;
  const id = (p) => `${p}${next++}`;
  const extent = (wide) => {
    const begin = int(len + 1);
    const end = Math.min(len, begin + int(wide));
    return { begin, end };
  };
  const tokens = (p, count, wide) =>
    Array.from({ length: count }, () => ({ id: id(p), ...extent(wide), precedence: int(3) }));
  const sentenceTokens = r() < 0.2 ? [] : tokens('s', int(5), 20);
  const wordTokens = tokens('w', int(12), 6);
  const morphemeTokens = [
    ...tokens('m', int(10), 6),
    // Words of a multi-word token: the full width of a word, by precedence.
    ...wordTokens.flatMap((w) =>
      Array.from({ length: int(3) }, (_, i) => ({
        id: id('m'),
        begin: w.begin,
        end: w.end,
        precedence: i,
      })),
    ),
  ];
  const spans = (p, values) =>
    morphemeTokens
      .filter(() => r() < 0.7)
      .map((m) => ({
        id: id(p),
        tokens: r() < 0.1 ? [m.id, morphemeTokens[int(morphemeTokens.length)].id] : [m.id],
        value: values[int(values.length)],
      }));
  const lemmaLayer = { spans: spans('l', ['go', 'be', null, '']) };
  const relations = (p) =>
    Array.from({ length: int(10) }, () => ({
      id: id(p),
      source: lemmaLayer.spans[int(lemmaLayer.spans.length)]?.id ?? 'none',
      target: lemmaLayer.spans[int(lemmaLayer.spans.length)]?.id ?? 'none',
      value: 'dep',
    }));
  return {
    body,
    info: {
      sentenceTokenLayer: { tokens: sentenceTokens },
      wordTokenLayer: { tokens: wordTokens },
      morphemeTokenLayer: { tokens: morphemeTokens },
      formLayer: { spans: spans('f', ['x', '', null]) },
      lemmaLayer,
      uposLayer: { spans: spans('u', ['NOUN', 'VERB']) },
      xposLayer: null,
      featuresLayer: { spans: spans('t', ['Number=Sing', 'Case=Acc', '']) },
      relationLayer: { relations: relations('r') },
      enhancedRelationLayer: { relations: relations('e') },
    },
  };
}

test('the sweep builds the same rows as a filter per sentence and per word', () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const { body, info } = randomDoc(seed);
    assert.deepStrictEqual(
      buildSentenceRows(body, info),
      referenceRows(body, info),
      `seed ${seed}`,
    );
  }
});

test('a 20,000-word document builds in under two seconds', () => {
  const words = 20000;
  const parts = [];
  const sentenceTokens = [];
  const wordTokens = [];
  const morphemeTokens = [];
  const lemmaSpans = [];
  const relations = [];
  let at = 0;
  let sentenceBegin = 0;
  for (let i = 0; i < words; i++) {
    // An astral letter in every word, so a slice that counts UTF-16 would show.
    const form = `w${i}𐌰`;
    const len = [...form].length;
    wordTokens.push({ id: `w${i}`, begin: at, end: at + len });
    morphemeTokens.push({ id: `m${i}`, begin: at, end: at + len, precedence: 0 });
    lemmaSpans.push({ id: `l${i}`, tokens: [`m${i}`], value: form });
    relations.push({ id: `r${i}`, source: `l${i}`, target: `l${i}`, value: 'root' });
    parts.push(form);
    at += len;
    if (i % 25 === 24) {
      sentenceTokens.push({ id: `s${i}`, begin: sentenceBegin, end: at });
      sentenceBegin = at + 1;
    }
    parts.push(' ');
    at += 1;
  }
  const body = parts.join('');
  const info = {
    sentenceTokenLayer: { tokens: sentenceTokens },
    wordTokenLayer: { tokens: wordTokens },
    morphemeTokenLayer: { tokens: morphemeTokens },
    lemmaLayer: { spans: lemmaSpans },
    relationLayer: { relations },
    enhancedRelationLayer: { relations: [] },
  };
  const t = performance.now();
  const rows = buildSentenceRows(body, info);
  const ms = performance.now() - t;
  assert.equal(rows.length, 800);
  assert.equal(rows[799].tokens[24].tokenForm, 'w19999𐌰');
  assert.equal(rows[799].relations.length, 25);
  assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
});
