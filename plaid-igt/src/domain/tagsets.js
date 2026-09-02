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
//       closed: true,            // false = nudge toward the list, allow new
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

/** Value-record keys this app renders. Everything else is free-form. */
export const RESERVED_VALUE_KEYS = Object.freeze(['description', 'color']);

/** A tagset with nothing configured: whole-cell, open, empty. */
export const EMPTY_TAGSET = Object.freeze({ delimiters: '', closed: false, values: [] });

// --- reading config --------------------------------------------------------

const str = (v) => (typeof v === 'string' ? v : '');

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
  return { delimiters: str(raw?.delimiters), closed: raw?.closed === true, values };
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

/** Which fields reference `name`, as [{scope, name}] — for delete warnings. */
export const fieldsUsingTagset = (layerInfo, name) => {
  const out = [];
  for (const [scope, layers] of Object.entries(layerInfo?.spanLayers || {})) {
    for (const sl of layers || []) {
      if (readTagsetName(sl.config) === name) out.push({ scope, name: sl.name, id: sl.id });
    }
  }
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
 * The segment the caret sits in, or null for an empty value. A caret exactly on
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
  if (!p) return { value: replacement, caret: replacement.length };
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
 */
export const validateValue = (value, tagset) => {
  if (!tagset) return [];
  const s = value ?? '';
  if (s.trim() === '') return [];
  const out = [];
  for (const p of scanValue(s, tagset.delimiters)) {
    const text = p.text.trim();
    if (!text) out.push({ part: p.text, begin: p.begin, end: p.end, reason: 'empty' });
    else if (tagset.closed && !tagsetHas(tagset, text))
      out.push({ part: text, begin: p.begin, end: p.end, reason: 'unknown' });
  }
  return out;
};

/** May this value be written to a cell governed by `tagset`? */
export const isValueAllowed = (value, tagset) => validateValue(value, tagset).length === 0;

// --- inventory: seeding and violations -------------------------------------

/**
 * Given the field's attested values (the [value, count] rows a frequency query
 * returns over its span layer), the parts that are NOT in the tagset, most
 * frequent first: [{ part, count }].
 *
 * This is the one computation behind three features. The violations view lists
 * it, the Fields settings badge counts it, and "seed from attested" turns it
 * into value records when a field goes open to closed — so all three agree on
 * what counts as off-tagset, and none of them has to load a document to say so.
 */
export const offTagsetParts = (attested, tagset) => {
  if (!tagset) return [];
  const counts = new Map();
  for (const [value, n] of attested || []) {
    for (const p of scanValue(value ?? '', tagset.delimiters)) {
      const text = p.text.trim();
      if (!text || tagsetHas(tagset, text)) continue;
      counts.set(text, (counts.get(text) || 0) + (n || 0));
    }
  }
  return [...counts.entries()]
    .map(([part, count]) => ({ part, count }))
    .sort((a, b) => b.count - a.count || a.part.localeCompare(b.part));
};

/** Those parts as value records, ready to append to a tagset's `values`. */
export const seedValueRecords = (attested, tagset) =>
  offTagsetParts(attested, tagset).map(({ part }) => ({ value: part }));
