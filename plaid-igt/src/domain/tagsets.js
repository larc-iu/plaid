// Tagsets: controlled vocabularies for annotation field VALUES.
//
// Not to be confused with a "vocabulary" in plaid-igt, which is the lexicon
// (src/components/vocabularies, client.projects.linkVocab). A tagset governs
// what may be TYPED into a field; a vocabulary holds lexical entries that
// cells LINK to. A vocabulary's own entry fields (POS, say) can be governed
// too: it carries its own `config.igt.tagsets` in this same shape, because it
// is shared across projects and edited outside any of them, so it cannot
// borrow a project's list (see vocabFields.js).
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
//       values: [{ value: "NOM", description: "nominative" }]
//     }
//   }
//   spanLayer.config.igt.tagset = "Leipzig"
//
// A value record's `value` is the only required key. `description` is reserved
// and rendered (in the picker and the settings table); every other key is
// free-form and display-only, so a project can hang whatever it likes off a
// tag without this module caring. (`color` was reserved once, and a settings
// column saved it, but nothing ever rendered it; a stored one is now just a
// free-form key.)
//
// A CLOSED list is also a rule core holds (igtConstraints.js declares it as a
// value set on each field it governs), so every writer is refused an off-list
// value, the assistant included. Core lets through an unverified machine value
// and an import's, and the Validation view is how those are found.

import { canNameWord, isBoundType } from './affixMarkers.js';
import { IGT_NAMESPACE } from './igtConfig.js';

const str = (v) => (typeof v === 'string' ? v : '');
export const stripSpace = (s) => s.replace(/\s+/gu, '');

/** Value-record keys this app renders. Everything else is free-form. */
export const RESERVED_VALUE_KEYS = Object.freeze(['description']);

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

// The case rule and small caps live in plaid-ui (domain/glossCase.js), since
// plaid-umr reads glosses by them too.
import {
  GLOSS_ABBREVIATIONS,
  lexicalFlags,
  lenientFlags,
  isLexicalPart,
  glossMorphemes,
  lexicalFlagsOf,
  boundByPieces,
  glossSmallCaps,
  capsAreSmallCaps,
} from '@ui/domain/glossCase.js';

export {
  GLOSS_ABBREVIATIONS,
  lexicalFlags,
  lenientFlags,
  isLexicalPart,
  glossMorphemes,
  lexicalFlagsOf,
  boundByPieces,
  glossSmallCaps,
  capsAreSmallCaps,
};

/**
 * One morpheme's gloss cell as the rule reads it: whether the gloss can
 * never name its word (canNameWord), and the glosses of the word's other
 * morphemes that could, which share its unit. `morphemes` is the word's
 * morphemes in order, each { morphType, form, gloss }, and `i` the cell's.
 */
export const morphemeGlossReading = (morphemes, i) => {
  const names = (m) => canNameWord(m.morphType, m.form);
  const self = morphemes[i];
  if (!self || !names(self)) return { bound: true, beside: [] };
  return {
    bound: false,
    beside: morphemes
      .filter((m, j) => j !== i && names(m))
      .map((m) => str(m.gloss))
      .filter((g) => g.trim()),
  };
};

const BOUND_READING = Object.freeze({ bound: true, beside: Object.freeze([]) });

/**
 * The reading of a gloss known only by its own morpheme's morph type and form,
 * with none of its word's other glosses beside it: an aggregate count of a
 * morpheme field's values, or a lexicon entry's field. An affix's, a clitic's
 * or a zero morph's gloss is read as morphemeGlossReading reads it, and any
 * other is read alone, as a one-morpheme word's stem. `form` null means the
 * morpheme states none (it shows its word's text, so it can name the word).
 * Undefined, the reading of a stem's or a word's gloss, when the gloss can
 * name its word.
 */
export const glossReadingOf = (morphType, form = null) =>
  isBoundType(morphType) || (typeof form === 'string' && !canNameWord(morphType, form))
    ? BOUND_READING
    : undefined;

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
    // Whitespace is never a delimiter: a box typed as ". : >" would otherwise
    // split a two-word stem gloss in two, and the space could not be shown.
    delimiters: stripSpace(str(raw?.delimiters)),
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
const WORD_AFFIX_DELIMITERS = Object.freeze(['-', '=']);

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
 * `tagsetFor(scope, fieldName)` resolves the governing tagset, or null. A
 * morpheme's gloss is read as its cell in the grid reads it (readingTagset).
 */
export const analysisViolations = (analysis, tagsetFor) => {
  const out = [];
  const check = (scope, fields, readingOf = () => undefined) => {
    for (const [field, value] of Object.entries(fields || {})) {
      const tagset = tagsetFor(scope, field);
      const violations = validateValue(
        value ?? '',
        tagset && readingTagset(tagset, readingOf(field)),
      );
      if (violations.length) out.push({ scope, field, value, violations });
    }
  };
  check('word', analysis?.word?.fields);
  const morphemes = analysis?.morphemes || [];
  morphemes.forEach((m, i) =>
    check('morpheme', m?.fields, (field) =>
      morphemeGlossReading(
        morphemes.map((x) => ({
          morphType: x?.morphType,
          form: x?.form,
          gloss: x?.fields?.[field],
        })),
        i,
      ),
    ),
  );
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

/**
 * The order a person expects to read a list of abbreviations in: alphabetical
 * without regard to case, and with numbers in numeric order (1SG, 2SG, 3PL,
 * ABL, dog, NOM). Two values that differ only in case still get a fixed order.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const compareValues = (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * A tagset's values in reading order, for DISPLAY: the settings table and the
 * metadata form's dropdown. The stored order is the order values were added,
 * which nothing shows and nothing depends on, so it is left alone. The
 * editor's picker ranks by use instead and never sees this.
 */
/**
 * A tagset's values as a picker lists them: alphabetical, which is the only
 * order a hand-typed inventory of three hundred glosses has.
 *
 * `ordered` keeps the stored order instead, for the few tagsets the app writes
 * itself where the order MEANS something. Status is the one: draft, reviewed,
 * published is a workflow, and alphabetical listed it draft, published,
 * reviewed, which reads as a workflow that goes backwards. Nothing in the
 * tagset editor reorders values, so a tagset a person made has no order worth
 * keeping and does not set this.
 */
export const sortedValues = (tagset) =>
  tagset?.ordered
    ? [...(tagset?.values || [])]
    : [...(tagset?.values || [])].sort((x, y) => compareValues(x.value, y.value));

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
 *
 * A tagset may carry the `reading` of the cell it is asked about (see
 * readingTagset): a morpheme's gloss cell reads an affix's gloss with no
 * fall-back and a stem's with the word's other stems. Without one, the value
 * is one stem's or one word's gloss.
 */
export const validateValue = (value, tagset) => {
  if (!tagset) return [];
  const s = value ?? '';
  if (s.trim() === '') return [];
  const out = [];
  const parts = scanValue(s, tagset.delimiters);
  const lexical = lexicalFlagsOf(s, parts, tagset.reading ?? undefined);
  parts.forEach((p, i) => {
    const text = p.text.trim();
    if (!text) out.push({ part: p.text, begin: p.begin, end: p.end, reason: 'empty' });
    else if (
      tagset.mode !== MODES.SUGGEST &&
      !tagsetHas(tagset, text) &&
      !(tagset.mode === MODES.MIXED && lexical[i])
    )
      out.push({ part: text, begin: p.begin, end: p.end, reason: 'unknown' });
  });
  return out;
};

/**
 * `tagset` as one cell reads it, `reading` being morphemeGlossReading's
 * answer for that cell. Every check that takes the tagset (validateValue,
 * isValueAllowed, the picker's filter) then reads the cell's value by it.
 */
export const readingTagset = (tagset, reading) => (tagset ? { ...tagset, reading } : null);

/**
 * The `tagsetFor(fieldName)` of one lexicon entry's fields, each read as the
 * entry's morph type gives (glossReadingOf): a suffix's, a clitic's or a zero
 * morph's gloss with no fall-back. `morphType` is the one the entry goes by
 * (vocabDictionary morphTypeOf: its own, else its headword's). An entry with
 * none is read as a stem's or a word's, and so is one with no form yet.
 */
export const entryTagsetFor = (tagsetFor, morphType, form) => {
  const reading = glossReadingOf(morphType, form || null);
  return (name) => readingTagset(tagsetFor(name), reading);
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
 * Given the field's attested values (the [value, count, reading] rows a
 * frequency query returns over its span layer, `reading` being how the grid
 * reads the value: glossReadingOf for a morpheme field's, absent for any
 * other), the parts that are NOT in the tagset, most frequent first:
 * [{ part, count, lexical }], `lexical` saying whether the part read as
 * lexical in every value it came from (lexicalFlagsOf, which reads a part with
 * the rest of its value).
 *
 * What "add values used in this project" offers (seedCandidates). Its sibling
 * offTagsetValues answers the other question (which CELLS are wrong) and is
 * what the Validation view lists. Neither loads a document: both read a
 * field's whole value inventory from one aggregate query.
 */
const readOffTagsetParts = (attested, tagset) => {
  if (!tagset) return [];
  const counts = new Map();
  const lexical = new Map();
  for (const [value, n, reading] of attested || []) {
    const parts = scanValue(value ?? '', tagset.delimiters);
    const flags = lexicalFlagsOf(value ?? '', parts, reading ?? undefined);
    parts.forEach((p, i) => {
      const text = p.text.trim();
      if (!text || tagsetHas(tagset, text)) return;
      // A lexical gloss is not a tag. Seeding `dog` into a Leipzig tagset would
      // turn a grammatical inventory into a word list.
      if (tagset.mode === MODES.MIXED && flags[i]) return;
      counts.set(text, (counts.get(text) || 0) + (n || 0));
      lexical.set(text, (lexical.get(text) ?? true) && flags[i]);
    });
  }
  return [...counts.entries()]
    .map(([part, count]) => ({ part, count, lexical: lexical.get(part) }))
    .sort((a, b) => b.count - a.count || a.part.localeCompare(b.part));
};

/**
 * `tagset` read as closing it would read it: an open list's unlisted parts
 * count as off the list. The Validation tab's reading, where a list being
 * built is checked before it is closed.
 */
export const asClosed = (tagset) =>
  tagset?.mode === MODES.SUGGEST ? { ...tagset, mode: MODES.CLOSED } : tagset;

/**
 * The attested VALUES with a part off the list or a stray delimiter, worst
 * first: [{ value, count, violations, flagged, lexical }].
 *
 * The sibling of readOffTagsetParts, answering the other question. That one says
 * which tags are missing from the list, which is what a seed needs; this says
 * which cells are wrong, which is what a person fixing them needs to find and
 * what a bulk replace has to match on.
 *
 * An OPEN tagset's unlisted parts are listed too, read as closing the list
 * would read them: open is the state a list is built in before it is closed,
 * and these are the values a close would refuse. `flagged` says whether the
 * cell itself marks the value (validateValue), which on an open list is only
 * a stray delimiter. `lexical` says that every unlisted part of it reads as
 * lexical (the seed's test, lexicalFlagsOf), so on an open list it is a word
 * rather than a tag the list is missing. Always false on an enforcing list.
 */
export const offTagsetValues = (attested, tagset) => {
  if (!tagset) return [];
  const open = tagset.mode === MODES.SUGGEST;
  const listing = asClosed(tagset);
  // One row per value. A value attested under two readings (a stem's and a
  // suffix's) counts only the occurrences that fail, with every part that
  // fails under any of them.
  const byValue = new Map();
  for (const [raw, n, reading] of attested || []) {
    const value = raw ?? '';
    const violations = validateValue(value, readingTagset(listing, reading));
    if (!violations.length) continue;
    const flagged = !open || violations.some((v) => v.reason === 'empty');
    // Under mixed a lexical part passes, so what mixed still refuses is the
    // value's tags. None means every unlisted part reads as a word.
    const lexical =
      open &&
      !flagged &&
      !validateValue(value, readingTagset({ ...tagset, mode: MODES.MIXED }, reading)).length;
    const row = byValue.get(value);
    if (!row) {
      byValue.set(value, { value, count: n || 0, violations, flagged, lexical });
      continue;
    }
    row.flagged ||= flagged;
    row.lexical &&= lexical;
    row.count += n || 0;
    const seen = new Set(row.violations.map((v) => `${v.begin}:${v.end}:${v.reason}`));
    row.violations = [
      ...row.violations,
      ...violations.filter((v) => !seen.has(`${v.begin}:${v.end}:${v.reason}`)),
    ].sort((a, b) => a.begin - b.begin);
  }
  return [...byValue.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
};

/**
 * What the seed button would add, split by kind:
 *
 *   { tags: [{ value }], lexical: [{ value }] }
 *
 * `lexical` holds the parts that read as lexical glosses wherever they occur
 * (lexicalFlagsOf: a lowercase letter, read with the rest of the value, so
 * the pfv of go.3.pfv is a tag). They are kept apart because seeding a Leipzig
 * tagset from a glossed project would otherwise turn a grammatical inventory
 * into a word list: a project's stems outnumber its tags many times over, and
 * a `suggest` tagset (what a new one starts as) pulled in every one of them
 * without a word said. That is how a tagset came to hold 1,700 values.
 *
 * Under `mixed` the lexical bucket is always empty: those values are accepted
 * without being listed, so listing them adds nothing. Under `closed` and
 * `suggest` the caller decides, because the split is a reading of the Leipzig
 * casing convention and not of meaning: a closed POS inventory (n, v, adj) is
 * entirely "lexical" by this test and wants every one of its values. So the
 * split is offered, never imposed.
 */
export const seedCandidates = (attested, tagset) => {
  const tags = [];
  const lexical = [];
  for (const { part, lexical: isLexical } of readOffTagsetParts(attested, tagset)) {
    (isLexical ? lexical : tags).push({ value: part });
  }
  return { tags, lexical };
};

/**
 * May this edit be saved? Only fields the user actually CHANGED are judged.
 *
 * The grid refuses a value on the way in and leaves what is already stored
 * alone (`next !== orig` in IgtEditor._commitField). A form has to match, or
 * one off-tagset value an import left behind would lock the whole document
 * (or lexicon entry) out of saving — you could not even rename it — and the
 * deliberately preserved "(not in tagset)" option would be visible but
 * unsavable.
 */
export const changedValuesAllowed = (fields, values, tagsetFor, original = {}) =>
  fields.every((f) => {
    const next = values[f.name] ?? '';
    if (next === (original[f.name] ?? '')) return true;
    const t = tagsetFor(f);
    return !tagsetEnforces(t) || isValueAllowed(next, t);
  });
