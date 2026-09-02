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
import { isValueAllowed, scanValue, tagsetEnforces, tagsetRecord } from './tagsets.js';

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

export const TAGSET_SOURCE = 'tagset';

// Every value worth offering for a cell, ranked: what precedent says (with
// counts, machine-made included as for the guess), what the linked entry
// says, what the cell's own producer predicted (provDetail.value, plus a top-k
// distribution under provDetail.valueProbs when it has one), and what the
// field's tagset allows. Rows merge by value; `source` is the provenance
// source a pick is written with. Rank: count, then probability, then
// entry-backed, then alphabetical.
//
// An ENFORCING tagset then keeps only what it allows: offering a value that
// commit will reject is offering a dead end.
//
// A tagset with DELIMITERS switches the list from whole-value mode to PART
// mode, because the caret then sits inside one part of a composite value and
// completing it with a whole value ("1SG.NOM" offered while typing the second
// half of "1SG.NO") would be nonsense. In part mode everything whole-valued is
// decomposed and pooled per part. ("Allows" is the validator's answer, not bare
// membership, so a mixed-mode tagset keeps offering the lexical precedent it
// accepts.)
export function listAlternatives({
  precedent,
  kind,
  form,
  field,
  vocabItem = null,
  span = null,
  tagset = null,
}) {
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
  let list = [...rows.values()].map((r) => ({
    ...r,
    source: r.entry
      ? VOCAB_ENTRY_SOURCE
      : r.count
        ? PRECEDENT_SOURCE
        : span?.metadata?.[PROV_SOURCE_KEY] || PRECEDENT_SOURCE,
  }));

  if (tagset?.delimiters) list = decomposeRows(list, tagset.delimiters);

  // The tagset's own values, so a fresh field with no precedent still offers
  // the whole list rather than nothing. An attested value keeps its count and
  // only picks up the description.
  if (tagset) {
    const byValue = new Map(list.map((r) => [r.value, r]));
    for (const rec of tagset.values) {
      const existing = byValue.get(rec.value);
      if (existing) {
        existing.description = rec.description;
        existing.color = rec.color;
        continue;
      }
      const row = {
        value: rec.value,
        count: 0,
        prob: null,
        entry: false,
        model: false,
        source: TAGSET_SOURCE,
        description: rec.description,
        color: rec.color,
      };
      byValue.set(rec.value, row);
      list.push(row);
    }
  }

  if (tagsetEnforces(tagset)) list = list.filter((r) => isValueAllowed(r.value, tagset));

  list.sort(
    (a, b) =>
      b.count - a.count ||
      (b.prob ?? -1) - (a.prob ?? -1) ||
      Number(b.entry) - Number(a.entry) ||
      a.value.localeCompare(b.value),
  );
  return list;
}

// Whole-value rows to part rows: each row's value is split on the tagset's
// delimiters and its count credited to every part it contains. Two rows that
// share a part pool into one ("1SG.NOM" and "1SG.ERG" both feed 1SG), which is
// what makes a frequent part rank first even when no whole value is frequent.
function decomposeRows(rows, delimiters) {
  const byPart = new Map();
  for (const r of rows) {
    for (const seg of scanValue(r.value, delimiters)) {
      const value = seg.text.trim();
      if (!value) continue;
      let p = byPart.get(value);
      if (!p) {
        byPart.set(
          value,
          (p = { value, count: 0, prob: null, entry: false, model: false, source: r.source }),
        );
      }
      p.count += r.count;
      if (r.prob != null) p.prob = Math.max(p.prob ?? 0, r.prob);
      p.entry ||= r.entry;
      p.model ||= r.model;
      // Precedent is the strongest claim to a source; keep it over a model's.
      if (r.count) p.source = r.source;
    }
  }
  return [...byPart.values()];
}

/** The description a tagset gives a value, for the picker row. */
export const describeValue = (tagset, value) => tagsetRecord(tagset, value)?.description ?? null;

/**
 * A guess only survives if the field's tagset would accept it. A closed field
 * whose precedent holds a value the tagset no longer allows must not offer it:
 * the placeholder invites one keystroke to adopt it, and the commit would then
 * reject what the cell just told the user to press Enter on.
 */
export const allowedGuess = (guess, tagset) =>
  guess && isValueAllowed(guess.value, tagset) ? guess : null;
