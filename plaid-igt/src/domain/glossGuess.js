// Pluggable gloss-guess sources for the interlinear editor. A guess source
// answers guessFor(kind, form, field, ctx) with { value, source } or null;
// `form` is the token's precedent form (precedent.js: a word trimmed by the
// ignore rule, a morpheme's form verbatim) and `ctx` carries the token's
// derived `vocabItem` (null when unlinked). The editor renders guesses as
// placeholder-style suggestions; a guess is only ever WRITTEN when the user
// confirms it, and the written span carries born-verified provenance metadata
// (the editor stamps confirmedInferred(source) from the shared provenance
// helpers).
//
// The built-in default (defaultGuessSource) asks the linked lexicon entry
// first, then project precedent. To plug in a different algorithm (or a
// service-backed one), assign a factory with the same shape to
// IgtEditor.guessSourceFactory:
//   ({ precedent, sentences, wordFields, morphFields }) => ({ id, guessFor })
// where `precedent` is the precedent.js tally the editor maintains.

import { PROV } from '@larc-iu/plaid-client';
import { precedentCounts, pickMajority } from './precedent.js';

const PROV_DETAIL_KEY = PROV.detailKey;
const PROV_SOURCE_KEY = PROV.sourceKey;

export const PRECEDENT_SOURCE = 'gloss:precedent';

// Built-in provider: the value this form was given before for this field,
// project-wide, when one value holds a strict majority. Ties produce NO
// guess (ambiguous forms stay blank rather than guessing wrong half the
// time). Machine-unverified values DO count (ruling A1-11): a guess is only
// a placeholder, and adopting it is a human act, so there is no cascade to
// guard against (see the policy note in precedent.js).
export function precedentGuessSource(precedent) {
  return {
    id: PRECEDENT_SOURCE,
    guessFor(kind, form, field) {
      const counts = precedentCounts(precedent, kind, form, field);
      const value = pickMajority(counts);
      return value ? { value, source: PRECEDENT_SOURCE } : null;
    },
  };
}

export const VOCAB_ENTRY_SOURCE = 'vocab:entry';

// An annotation field and an entry field name the same thing when they match
// after case and separators are dropped: the project's morpheme-scope "Gloss"
// layer pairs with the vocab's `gloss` field, "POS" with `pos`, "Morph Type"
// with `morphType`.
const fieldKey = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

// The linked entry's own value for the same-named field. An entry's fields
// are what it says about itself in the lexicon (form aside); a token linked to
// it inherits them as guesses, never as writes, since an instance may
// legitimately differ from its entry (context-specific glossing).
export function vocabEntryGuessSource() {
  return {
    id: VOCAB_ENTRY_SOURCE,
    guessFor(kind, form, field, ctx = null) {
      const meta = ctx?.vocabItem?.metadata;
      if (!meta || typeof meta !== 'object') return null;
      const want = fieldKey(field);
      if (!want) return null;
      for (const [name, value] of Object.entries(meta)) {
        if (fieldKey(name) !== want) continue;
        if (value == null) return null;
        const s = String(value).trim();
        return s ? { value: s, source: VOCAB_ENTRY_SOURCE } : null;
      }
      return null;
    },
  };
}

// First source with an opinion wins.
export function composeGuessSources(sources) {
  return {
    id: sources.map((s) => s.id).join('+'),
    guessFor(kind, form, field, ctx = null) {
      for (const s of sources) {
        const g = s.guessFor(kind, form, field, ctx);
        if (g) return g;
      }
      return null;
    },
  };
}

// The editor's default: the linked entry, then project precedent.
export function defaultGuessSource({ precedent }) {
  return composeGuessSources([vocabEntryGuessSource(), precedentGuessSource(precedent)]);
}

// Every value worth offering for a cell, ranked: what precedent says (with
// counts, machine-made included as for the guess), what the linked entry
// says, and what the cell's own producer predicted (provDetail.value, plus
// a top-k distribution under provDetail.valueProbs when it has one). Rows
// merge by value; `source` is the provenance source a pick is written with.
// Rank: count, then probability, then entry-backed, then alphabetical.
export function listAlternatives({ precedent, kind, form, field, vocabItem = null, span = null }) {
  const rows = new Map();
  const row = (value) => {
    const v = String(value);
    let r = rows.get(v);
    if (!r) rows.set(v, (r = { value: v, count: 0, prob: null, entry: false, model: false }));
    return r;
  };
  const counts = precedentCounts(precedent, kind, form, field);
  if (counts) for (const [v, n] of counts) row(v).count += n;
  const e = vocabEntryGuessSource().guessFor(kind, form, field, { vocabItem });
  if (e) row(e.value).entry = true;
  const d = span?.metadata?.[PROV_DETAIL_KEY];
  if (d && typeof d === 'object') {
    if (d.value != null && d.value !== '') row(d.value).model = true;
    if (d.valueProbs && typeof d.valueProbs === 'object') {
      for (const [v, p] of Object.entries(d.valueProbs)) {
        if (typeof p !== 'number' || v === '') continue;
        const r = row(v);
        r.model = true;
        r.prob = Math.max(r.prob ?? 0, p);
      }
    }
  }
  const list = [...rows.values()].map((r) => ({
    ...r,
    source: r.entry
      ? VOCAB_ENTRY_SOURCE
      : r.count
        ? PRECEDENT_SOURCE
        : span?.metadata?.[PROV_SOURCE_KEY] || PRECEDENT_SOURCE,
  }));
  list.sort(
    (a, b) =>
      b.count - a.count ||
      (b.prob ?? -1) - (a.prob ?? -1) ||
      Number(b.entry) - Number(a.entry) ||
      a.value.localeCompare(b.value),
  );
  return list;
}
