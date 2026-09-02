// Tagsets: controlled vocabularies for annotation field VALUES.
//
// Not to be confused with a "vocabulary" in plaid-igt, which is the lexicon
// (src/components/vocabularies, client.projects.linkVocab). A tagset governs
// what may be TYPED into an annotation cell; a vocabulary holds lexical
// entries that cells LINK to. The two never interact.
//
// A tagset is a project-level object, referenced by name from the fields that
// use it, because the same list is almost always wanted at two scopes at once
// (the default field set ships Gloss and POS at both Word and Morpheme scope,
// and maintaining that list twice is the thing this shape exists to avoid):
//
//   project.config.igt.tagsets = {
//     "Leipzig": {
//       delimiters: ".:>",       // "" = the whole cell is one value
//       mode: "mixed",           // suggest | closed | mixed (see TAGSET_MODES)
//       values: [{ value: "NOM", description: "nominative", color: "#a33" }]
//     }
//   }
//   spanLayer.config.igt.tagset = "Leipzig"
//
// A value record's `value` is the only required key. `description` and `color`
// are reserved and rendered (in the picker and the cell tooltip); every other
// key is free-form and display-only, so a project can hang whatever it likes
// off a tag without this module caring.
//
// CLOSED IS A PLAID-IGT RULE, NOT AN INVARIANT. plaid-core knows nothing about
// tagsets, so services, the agent, and direct API writes can all still land
// off-tagset values. That is what the violations view is for: closed means
// "closed to typing here", and the way you find out otherwise is by looking.

import { IGT_NAMESPACE } from './igtConfig.js';

const str = (v) => (typeof v === 'string' ? v : '');

/** Value-record keys this app renders. Everything else is free-form. */
export const RESERVED_VALUE_KEYS = Object.freeze(['description', 'color']);

/**
 * How strictly a tagset governs the fields that use it. ONE axis, because the
 * three answers are points on a line from advice to rule, not independent
 * switches:
 *
 *   suggest  the list is advice. Every value is accepted.
 *   closed   the list is the rule. Nothing else is accepted.
 *   mixed    the list is the rule for grammatical tags, and lexical glosses
 *            (see isLexicalPart) are accepted alongside it.
 *
 * There is no fourth "free" mode: a field with no tagset is free, and a tagset
 * that governs nothing would be a second way to spell the same thing.
 */
export const MODES = Object.freeze({ SUGGEST: 'suggest', CLOSED: 'closed', MIXED: 'mixed' });
export const TAGSET_MODES = Object.freeze([MODES.SUGGEST, MODES.CLOSED, MODES.MIXED]);

/** A tagset with nothing configured: whole-cell, advisory, empty. */
export const EMPTY_TAGSET = Object.freeze({
  delimiters: '',
  mode: MODES.SUGGEST,
  values: [],
});

/**
 * Does this part read as a LEXICAL gloss rather than a grammatical one?
 *
 * The Leipzig rules write grammatical glosses in capitals and digits (NOM, 1SG,
 * PST) and lexical glosses as ordinary lowercase words (dog, run). So "contains
 * a lowercase letter" is not a heuristic about meaning, it is a direct read of
 * the convention the glosses are already written in, and the UI can explain it
 * in one sentence.
 *
 * It is deliberately not clever. `I` for a first-person pronoun has no lowercase
 * and so counts as grammatical, which means listing it in the tagset — exactly
 * what a tagset is for. Guessing whether a pronoun is "really" functional is the
 * part that defies rules, so nothing here tries.
 *
 * Scripts without case (Devanagari, Arabic) have no lowercase letters and so
 * never qualify. That is fine: a gloss is written in the metalanguage, and this
 * only ever ADDS permission to an otherwise closed tagset.
 */
const LOWERCASE_RE = /\p{Ll}/u;
export const isLexicalPart = (part) => LOWERCASE_RE.test(str(part));

// --- reading config --------------------------------------------------------

/**
 * Normalize one raw tagset into { delimiters, closed, values }. Value records
 * keep every key they carry (the free-form ones are the point) but must have a
 * non-empty string `value`; the first record wins a duplicate.
 */
export const normalizeTagset = (raw) => {
  const values = [];
  const seen = new Set();
  for (const rec of Array.isArray(raw?.values) ? raw.values : []) {
    const value = str(rec?.value).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push({ ...rec, value });
  }
  return {
    delimiters: str(raw?.delimiters),
    mode: TAGSET_MODES.includes(raw?.mode) ? raw.mode : MODES.SUGGEST,
    values,
  };
};

/** A project's tagsets by name, normalized: { name: tagset }. Never null. */
export const readTagsets = (projectConfig) => {
  const raw = projectConfig?.[IGT_NAMESPACE]?.tagsets;
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const [name, t] of Object.entries(raw)) {
      const key = str(name).trim();
      if (key) out[key] = normalizeTagset(t);
    }
  }
  return out;
};

/** The tagset name a field references, or null. */
export const readTagsetName = (spanLayerConfig) => {
  const name = str(spanLayerConfig?.[IGT_NAMESPACE]?.tagset).trim();
  return name || null;
};

/**
 * The tagset governing a field, or null when it references none. Also null when
 * it references one the project no longer has: a dangling reference governs
 * nothing (an unresolvable name must never silently behave like "closed and
 * empty", which would reject every value in the field). Callers that need to
 * TELL those two cases apart ask readTagsetName as well.
 */
export const resolveTagset = (spanLayerConfig, projectConfig) => {
  const name = readTagsetName(spanLayerConfig);
  if (!name) return null;
  return readTagsets(projectConfig)[name] ?? null;
};

/**
 * Every field in the project governed by a tagset — annotation fields and
 * document-metadata fields alike — as:
 *
 *   { key, kind, field, scope, layerId, tagsetName, tagset }
 *
 * `kind` is 'span' or 'metadata', and it decides how the field's values are
 * reached: a span field has a layerId and is queried through its layer, a
 * metadata field has none and is queried off the document. `key` is unique
 * across both.
 *
 * ONE answer to "which fields use which tagset", because there are three
 * callers that need it in three shapes (the settings usage line, the seed
 * button's queries, the Validation scan) and they drifted the moment metadata
 * fields existed. Derive, do not recompute.
 */
export const governedFields = (layerInfo, projectConfig) => {
  const tagsets = readTagsets(projectConfig);
  const out = [];
  for (const [scope, layers] of Object.entries(layerInfo?.spanLayers || {})) {
    for (const sl of layers || []) {
      const tagsetName = readTagsetName(sl.config);
      const tagset = tagsetName ? (tagsets[tagsetName] ?? null) : null;
      if (!tagset) continue;
      out.push({
        key: sl.id,
        kind: 'span',
        field: sl.name,
        scope,
        layerId: sl.id,
        tagsetName,
        tagset,
      });
    }
  }
  for (const f of projectConfig?.[IGT_NAMESPACE]?.documentMetadata || []) {
    const tagsetName = str(f?.tagset).trim();
    const tagset = tagsetName ? (tagsets[tagsetName] ?? null) : null;
    if (!tagset || !f?.name) continue;
    out.push({
      key: `meta:${f.name}`,
      kind: 'metadata',
      field: f.name,
      scope: 'document',
      layerId: null,
      tagsetName,
      tagset,
    });
  }
  return out;
};

/**
 * The affix joiners a WORD-scope gloss is written with — the same "-" and "="
 * the morpheme grid splits on (see affixMarkers.js).
 */
export const WORD_AFFIX_DELIMITERS = Object.freeze(['-', '=']);

/**
 * Delimiters a tagset needs but does not have, given that a word-scope field
 * uses it. Empty when there is nothing to warn about.
 *
 * This exists because the gap is SILENT. A word-scope gloss reads `dog-PL`. If
 * "-" is not a delimiter that is ONE part, and under `mixed` a part holding a
 * lowercase letter passes whole — so `dog-PL` is accepted without PL ever being
 * checked against the list. The field looks governed and is not, which is worse
 * than not governing it at all.
 *
 * Only `mixed` is affected. Under `closed` the same value is rejected as one
 * unknown part: annoying, but loudly wrong rather than quietly accepted.
 *
 * A tagset with NO delimiters at all is the worst case, not an exempt one --
 * every composite value is a single part, so nothing is ever checked. It used
 * to be skipped here on the reasoning that a whole-cell tagset "has no parts
 * to miss", which had it exactly backwards.
 */
export const missingAffixDelimiters = (tagset, usedAtWordScope) => {
  if (!usedAtWordScope || tagset?.mode !== MODES.MIXED) return [];
  return WORD_AFFIX_DELIMITERS.filter((d) => !(tagset.delimiters || '').includes(d));
};

/**
 * Values that can never match, because they contain one of the tagset's own
 * delimiters. `1SG.NOM` in a tagset that splits on "." is scanned as two parts,
 * neither of which is `1SG.NOM`, so the list holds a value it will reject.
 * Empty when there are no delimiters.
 */
export const unreachableValues = (tagset) => {
  const delims = tagset?.delimiters || '';
  if (!delims) return [];
  return (tagset.values || []).filter((v) => [...delims].some((d) => v.value.includes(d)));
};

/**
 * The off-tagset values in a whole-word analysis (the extractAnalysis shape:
 * `{ word: { fields }, morphemes: [{ fields }] }`), as
 * [{ scope, field, value, violations }].
 *
 * Re-analyze propagates ONE analysis to every occurrence of a form, so a single
 * off-tagset gloss in the chosen target lands everywhere in one click. Unlike a
 * field-replace, where each row is judged on its own, here every row would
 * carry the same defect — so this asks about the analysis itself, before any of
 * it is written.
 *
 * `tagsetFor(scope, fieldName)` resolves the governing tagset, or null.
 */
export const analysisViolations = (analysis, tagsetFor) => {
  const out = [];
  const check = (scope, fields) => {
    for (const [field, value] of Object.entries(fields || {})) {
      const violations = validateValue(value ?? '', tagsetFor(scope, field));
      if (violations.length) out.push({ scope, field, value, violations });
    }
  };
  check('word', analysis?.word?.fields);
  for (const m of analysis?.morphemes || []) check('morpheme', m?.fields);
  return out;
};

/** `governedFields` grouped by tagset name: { name: [record, ...] }. */
export const byTagsetName = (governed) => {
  const out = {};
  for (const g of governed || []) (out[g.tagsetName] ||= []).push(g);
  return out;
};

// --- splitting a cell value ------------------------------------------------

const delimSet = (delimiters) => new Set([...str(delimiters)]);

/**
 * Scan a cell value into its delimiter-separated segments:
 * [{ text, begin, end, sep }], where `sep` is the delimiter that followed the
 * segment (null on the last) and begin/end are offsets into `value`.
 *
 * THE OFFSETS HERE ARE UTF-16, deliberately, and this is the one place in the
 * app that is not code-point indexed. Their only consumer is an <input>'s
 * selectionStart / setSelectionRange, which speak UTF-16; they are never
 * persisted and never become token offsets, so the code-point convention that
 * governs everything touching the baseline does not apply. Code points are
 * still read whole (codePointAt, not [i]) so an astral delimiter or an emoji
 * inside a tag can't be split down the middle.
 */
export const scanValue = (value, delimiters) => {
  const s = value ?? '';
  const set = delimSet(delimiters);
  if (set.size === 0) return [{ text: s, begin: 0, end: s.length, sep: null }];

  const out = [];
  let begin = 0;
  let i = 0;
  while (i < s.length) {
    const cp = String.fromCodePoint(s.codePointAt(i));
    if (set.has(cp)) {
      out.push({ text: s.slice(begin, i), begin, end: i, sep: cp });
      i += cp.length;
      begin = i;
    } else {
      i += cp.length;
    }
  }
  out.push({ text: s.slice(begin), begin, end: s.length, sep: null });
  return out;
};

/** Just the segment texts, untrimmed. */
export const splitValue = (value, delimiters) => scanValue(value, delimiters).map((p) => p.text);

/**
 * The segment the caret sits in. Never null: scanValue always yields at least
 * one segment, so an empty value gives one empty segment. A caret exactly on
 * a delimiter belongs to the segment it ENDS (typing there continues that
 * segment), which is what makes completing "1SG.NO|" offer NOM rather than
 * restarting.
 */
export const partAtCaret = (value, caret, delimiters) => {
  const parts = scanValue(value, delimiters);
  const at = Math.max(0, Math.min(caret ?? 0, (value ?? '').length));
  for (const p of parts) if (at >= p.begin && at <= p.end) return p;
  return parts[parts.length - 1] ?? null;
};

/**
 * Replace the segment under the caret with `replacement`, returning the new
 * value and where the caret should land (at the end of what was just put in).
 * Used by the picker: choosing NOM in "1SG.no|" yields "1SG.NOM" with the caret
 * after it, ready for the next delimiter.
 */
export const replacePartAtCaret = (value, caret, delimiters, replacement) => {
  const s = value ?? '';
  const p = partAtCaret(s, caret, delimiters);
  const next = s.slice(0, p.begin) + replacement + s.slice(p.end);
  return { value: next, caret: p.begin + replacement.length };
};

// --- membership and validation ---------------------------------------------

/**
 * Is `part` in the tagset? Matching is CASE-SENSITIVE and on the trimmed part:
 * glossing conventions make case meaningful (Leipzig writes grammatical
 * categories in caps and lexical glosses in lowercase, so NOM and nom are not
 * the same tag), but stray spaces around a delimiter are a typo, not a tag.
 */
export const tagsetHas = (tagset, part) => {
  const want = str(part).trim();
  if (!want) return false;
  return (tagset?.values || []).some((v) => v.value === want);
};

/** The value record for a part, or null. */
export const tagsetRecord = (tagset, part) => {
  const want = str(part).trim();
  return (tagset?.values || []).find((v) => v.value === want) ?? null;
};

/**
 * Everything wrong with `value` under `tagset`, as
 * [{ part, begin, end, reason }] with reason 'empty' | 'unknown'.
 *
 * An empty cell is never a violation: clearing a cell is how an annotation is
 * deleted. An empty PART ("1SG..NOM", a trailing ".") is one in either mode,
 * since a stray delimiter is a typo whether or not new tags are allowed. Only
 * a closed tagset reports 'unknown' — an open one exists precisely to let new
 * values through, and flagging them would make the nudge a nag.
 *
 * `mixed` is what makes an enforcing tagset usable on a GLOSS field at all.
 * Every morpheme has its own cell, so a stem's cell holds `dog` — a gloss that
 * is not a grammatical tag and never will be. Under `closed` that rejects every
 * stem in the project. `mixed` is its own mode rather than the default because
 * part of speech tags are frequently lowercase themselves (n, v, adj), and a
 * POS tagset in mixed mode would quietly stop enforcing anything.
 */
export const validateValue = (value, tagset) => {
  if (!tagset) return [];
  const s = value ?? '';
  if (s.trim() === '') return [];
  const out = [];
  for (const p of scanValue(s, tagset.delimiters)) {
    const text = p.text.trim();
    if (!text) out.push({ part: p.text, begin: p.begin, end: p.end, reason: 'empty' });
    else if (
      tagset.mode !== MODES.SUGGEST &&
      !tagsetHas(tagset, text) &&
      !(tagset.mode === MODES.MIXED && isLexicalPart(text))
    )
      out.push({ part: text, begin: p.begin, end: p.end, reason: 'unknown' });
  }
  return out;
};

/** May this value be written to a cell governed by `tagset`? */
export const isValueAllowed = (value, tagset) => validateValue(value, tagset).length === 0;

/**
 * Does this tagset REFUSE a value, or only suggest one? The question every
 * write path asks before rejecting. Distinct from isValueAllowed because a
 * suggesting tagset still reports a stray delimiter — worth flagging in the
 * cell, never worth refusing a save over.
 */
export const tagsetEnforces = (tagset) => !!tagset && tagset.mode !== MODES.SUGGEST;

// --- inventory: seeding and violations -------------------------------------

/**
 * Given the field's attested values (the [value, count] rows a frequency query
 * returns over its span layer), the parts that are NOT in the tagset, most
 * frequent first: [{ part, count }].
 *
 * Used by "add values used in this project", which turns these into value
 * records. Its sibling offTagsetValues answers the other question — which
 * CELLS are wrong — and is what the Validation view lists. Neither loads a
 * document: both read a field's whole value inventory from one aggregate
 * query.
 */
export const offTagsetParts = (attested, tagset) => {
  if (!tagset) return [];
  const counts = new Map();
  for (const [value, n] of attested || []) {
    for (const p of scanValue(value ?? '', tagset.delimiters)) {
      const text = p.text.trim();
      if (!text || tagsetHas(tagset, text)) continue;
      // A lexical gloss is not a tag. Seeding `dog` into a Leipzig tagset would
      // turn a grammatical inventory into a word list.
      if (tagset.mode === MODES.MIXED && isLexicalPart(text)) continue;
      counts.set(text, (counts.get(text) || 0) + (n || 0));
    }
  }
  return [...counts.entries()]
    .map(([part, count]) => ({ part, count }))
    .sort((a, b) => b.count - a.count || a.part.localeCompare(b.part));
};

/**
 * The attested VALUES that fail validation, worst first:
 * [{ value, count, violations }].
 *
 * The sibling of offTagsetParts, answering the other question. That one says
 * which tags are missing from the list, which is what a seed needs; this says
 * which cells are wrong, which is what a person fixing them needs to find and
 * what a bulk replace has to match on.
 */
export const offTagsetValues = (attested, tagset) => {
  if (!tagset) return [];
  const out = [];
  for (const [value, n] of attested || []) {
    const violations = validateValue(value ?? '', tagset);
    if (violations.length) out.push({ value: value ?? '', count: n || 0, violations });
  }
  return out.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
};

/** Those parts as value records, ready to append to a tagset's `values`. */
export const seedValueRecords = (attested, tagset) =>
  offTagsetParts(attested, tagset).map(({ part }) => ({ value: part }));
