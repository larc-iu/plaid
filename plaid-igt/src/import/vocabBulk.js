// Bulk vocabulary import: parse a pasted or uploaded table, map its columns
// onto the vocabulary's fields, and plan the merge against the entries that
// are already there.
//
// The merge planner exists because the realistic import is not "an empty
// vocabulary gets N rows". It is "a vocabulary built up from texts meets a
// dictionary the same person kept elsewhere", with heavy overlap. Blindly
// creating every row would bury the curated entries under near-duplicates, and
// blindly skipping every form collision would throw away the dictionary's
// extra columns. So each row is classified against what exists and the caller
// picks a policy per class:
//
//   new        no entry has this form                      → create
//   identical  an entry already has every value in the row → skip (a no-op)
//   enrich     one entry has this form, agrees everywhere  → fill its blanks
//              it has a value, and the row fills a blank
//   conflict   entries with this form all disagree with    → skip / new sense /
//              the row on some value                          overwrite
//   ambiguous  several entries could be enriched and     → skip / new sense
//              there is no safe single target
//
// Homonyms are legitimate here (the same form can be a separate entry), which
// is exactly why "same form" alone cannot mean "duplicate". The field values
// are what separate a duplicate from a second sense.
//
// Everything in this module is pure and synchronous. The dialog owns the I/O.

import { FLEX_MORPH_TYPES } from '../domain/affixMarkers.js';
import { entryTagsetFor, isValueAllowed, tagsetEnforces } from '../domain/tagsets.js';
import { buildItemNumbers, buildSenseTree, morphTypeOf } from '../domain/vocabDictionary.js';

/** Mapping sentinels: a column becomes the item's form, or is left out. */
export const FORM = '__form__';
export const IGNORE = '__ignore__';

// ---------------------------------------------------------------------------
// 0. value normalization
// ---------------------------------------------------------------------------

// Morph types are a controlled vocabulary. Accept any casing an external
// dictionary uses, and drop what isn't in the inventory rather than storing a
// value the interlinear renderer can't interpret.
const MORPH_BY_KEY = new Map([
  ...FLEX_MORPH_TYPES.map((t) => [t.toLowerCase().replace(/[\s_-]+/g, ''), t]),
  // The name the app shows for FieldWorks' phrase type.
  ['multiwordexpression', 'phrase'],
  ['mwe', 'phrase'],
]);

/** The inventory's own spelling of a morph type, or '' when it is not one. */
export const normalizeMorphType = (raw) =>
  MORPH_BY_KEY.get(
    String(raw ?? '')
      .toLowerCase()
      .replace(/[\s_-]+/g, ''),
  ) ?? '';

/**
 * Does an ENFORCING tagset refuse `value` in `field` of an entry with this
 * morph type and form? Read as the entry's morph type gives (entryTagsetFor).
 * A suggesting tagset refuses nothing, since that is what it is for.
 */
export const makeRefusal =
  (tagsetFor = () => null) =>
  (field, value, { morphType = null, form = null } = {}) => {
    const tagset = tagsetFor(field);
    if (!tagsetEnforces(tagset)) return false;
    return !isValueAllowed(value, entryTagsetFor(tagsetFor, morphType, form)(field));
  };

/**
 * The `normalizeValue` rowsToEntries takes, for a vocabulary whose fields may
 * be governed by tagsets. `tagsetFor(field)` is the tagset governing that
 * field, or null. A value an enforcing tagset refuses (makeRefusal, read as
 * the row's own morph type gives) is rejected, reported on the entry and never
 * stored, the same way an unknown morph type is.
 */
export const makeValueNormalizer = (tagsetFor = () => null) => {
  const refuses = makeRefusal(tagsetFor);
  return (field, raw, entry = {}) => {
    if (field === 'morphType') return normalizeMorphType(raw);
    return refuses(field, raw, entry) ? '' : raw;
  };
};

/** What to do with rows that can fill in blanks on an existing entry. */
export const ENRICH_FILL = 'fill';
export const ENRICH_SKIP = 'skip';

/** What to do with rows that disagree with an existing entry. */
export const CONFLICT_SKIP = 'skip';
export const CONFLICT_NEW = 'new';
export const CONFLICT_OVERWRITE = 'overwrite';

/** What to do with rows that match several existing entries. */
export const AMBIGUOUS_SKIP = 'skip';
export const AMBIGUOUS_NEW = 'new';

export const DEFAULT_STRATEGIES = {
  enrich: ENRICH_FILL,
  conflict: CONFLICT_SKIP,
  ambiguous: AMBIGUOUS_SKIP,
};

// ---------------------------------------------------------------------------
// 1. parsing
// ---------------------------------------------------------------------------

/**
 * Pick the delimiter from the text itself. A tab anywhere wins, because
 * spreadsheets paste as TSV and a TSV cell may well contain a comma. Then
 * semicolon (the separator Excel uses in comma-decimal locales), then comma.
 * Text with no separator at all parses as a single Form column.
 */
export const detectDelimiter = (text) => {
  const sample = String(text ?? '').slice(0, 64 * 1024);
  if (sample.includes('\t')) return '\t';
  const semis = (sample.match(/;/g) || []).length;
  const commas = (sample.match(/,/g) || []).length;
  if (semis > commas) return ';';
  if (commas > 0) return ',';
  return '\t';
};

/**
 * Split delimited text into rows of cells. Quoting follows RFC 4180 (a quote
 * only opens at the start of a cell, "" is a literal quote), which our own TSV
 * export never needs but Excel's "tab delimited" save does. Rows whose cells
 * are all blank are dropped, so a trailing newline or a blank separator line
 * doesn't show up as an empty entry.
 *
 * @returns {{cells: string[], line: number}[]} line is the row's 1-based number
 *   as a spreadsheet shows it: blank lines count, and a line break inside a
 *   quoted cell does not start a row.
 */
export const parseDelimited = (text, delimiter) => {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let cells = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;

  const endRow = () => {
    cells.push(cell);
    cell = '';
    if (cells.some((c) => c.trim() !== '')) rows.push({ cells, line: rowLine });
    cells = [];
    line += 1;
    rowLine = line;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n') {
      endRow();
    } else if (ch === '\r') {
      if (src[i + 1] === '\n') i++; // CRLF
      endRow();
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || cells.length) endRow();
  return rows;
};

/** Detect the delimiter and parse in one step. */
export const parseTable = (text) => {
  const delimiter = detectDelimiter(text);
  return { delimiter, rows: parseDelimited(text, delimiter) };
};

/** How the delimiter reads in the UI. */
export const delimiterName = (d) =>
  d === '\t' ? 'tab-separated' : d === ';' ? 'semicolon-separated' : 'comma-separated';

// ---------------------------------------------------------------------------
// 2. column mapping
// ---------------------------------------------------------------------------

// Letters and digits in any script: a field named in Cyrillic, Arabic or a
// CJK script normalized to the empty string when only ASCII was kept, so it
// never matched its own column, and a header row of such names was read as an
// entry.
// Combining marks are kept, since in Devanagari or Arabic they tell words
// apart, and the header is composed first, so a decomposed "categoría" is the
// same name as a composed one.
const normalizeHeader = (s) =>
  String(s ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '');

// Header spellings that mean "this is the entry's form".
const FORM_ALIASES = new Set(
  [
    'form',
    'lexeme form',
    'lexeme',
    'headword',
    'head word',
    'entry',
    'citation form',
    'word',
    'lemma',
  ].map(normalizeHeader),
);

// Header spellings for the core fields, beyond the field's own name and label.
// Only consulted when the vocabulary actually has that field.
const FIELD_ALIASES = {
  gloss: ['gloss', 'glosses', 'meaning', 'translation', 'english'],
  pos: [
    'pos',
    'part of speech',
    'grammatical category',
    'category',
    'grammatical info',
    'word class',
  ],
  definition: ['definition', 'def', 'description', 'sense'],
  morphType: ['morph type', 'morpheme type', 'type'],
};

// Columns our own export emits that must never be read back in as data.
const EXPORT_ONLY = new Set(['uses', 'id'].map(normalizeHeader));

// A header's words: split at anything that is not a letter or digit, and at a
// camelCase boundary, so "en_gloss", "English Gloss" and "phoneticTranscription"
// all come apart into words.
const headerWords = (s) =>
  String(s ?? '')
    .normalize('NFC')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean);

const containsRun = (words, run) =>
  run.length > 0 && words.some((_, at) => run.every((w, k) => words[at + k] === w));

// How good a match is, best first. A column that matches a field better takes
// it from one that matches it worse, wherever the two stand in the row.
const EXACT = 0;
const ALIAS = 1;
const PLURAL = 2;
const CONTAINS = 3;

/**
 * Match one header cell to a mapping target, and say how good the match is:
 * `{target, rank}` with target FORM, IGNORE or a field name, or null when
 * nothing recognizes it.
 *
 * @param {string} cell - the header cell
 * @param {string[]} fieldNames - the vocabulary's field names
 * @param {(name: string) => string} humanize - field name → display label
 */
export const rankHeader = (cell, fieldNames, humanize = (n) => n) => {
  const n = normalizeHeader(cell);
  if (!n) return null;
  // A field the vocabulary actually declares comes first: "lexemeForm" is a
  // field here AND a spelling of "this column holds the entry's form", and the
  // column our own export writes under that name is the field's. Before the
  // columns our export adds, too: a vocabulary whose own field is called ID
  // or Uses had that column thrown away.
  for (const field of fieldNames) {
    if (n === normalizeHeader(field) || n === normalizeHeader(humanize(field)))
      return { target: field, rank: EXACT };
  }
  if (EXPORT_ONLY.has(n)) return { target: IGNORE, rank: ALIAS };
  if (FORM_ALIASES.has(n)) return { target: FORM, rank: ALIAS };
  for (const field of fieldNames) {
    if ((FIELD_ALIASES[field] || []).some((a) => normalizeHeader(a) === n))
      return { target: field, rank: ALIAS };
  }
  // Looser readings, only where they name ONE field. A plural ("sources" for
  // Source), or a header whose words include a field's name as whole words
  // ("English gloss" and "en_gloss" for Gloss, but not "Glossary"). The
  // aliases take part in the plural only: "english" for Gloss is fine as a
  // whole header, but "Example sentence in English" is not a gloss. A name
  // shorter than five letters is never looked for inside a header, since
  // "pos" and "type" turn up in too much.
  const unique = (test) => {
    const hits = fieldNames.filter(test);
    return hits.length === 1 ? hits[0] : null;
  };
  const singular = n.endsWith('s') ? n.slice(0, -1) : null;
  const plural =
    singular &&
    unique((f) =>
      [f, humanize(f), ...(FIELD_ALIASES[f] || [])].some((sp) => normalizeHeader(sp) === singular),
    );
  if (plural) return { target: plural, rank: PLURAL };
  if (singular && FORM_ALIASES.has(singular)) return { target: FORM, rank: PLURAL };
  const words = headerWords(cell);
  const contained = unique((f) =>
    [f, humanize(f)].some((name) => {
      const run = headerWords(name);
      return run.join('').length >= MIN_CONTAINED && containsRun(words, run);
    }),
  );
  return contained ? { target: contained, rank: CONTAINS } : null;
};

// The shortest field name looked for inside a header.
const MIN_CONTAINED = 5;

/** Column 0 is the form, the rest follow the vocabulary's field order. */
export const positionalMapping = (colCount, fieldNames) =>
  Array.from({ length: colCount }, (_, i) => (i === 0 ? FORM : (fieldNames[i - 1] ?? IGNORE)));

// How far down a file the header row is looked for. Exports put a title, a
// date or a second header line above the real one, but not pages of them.
const HEADER_SCAN = 10;

const nonBlankCells = (cells) => cells.filter((c) => String(c ?? '').trim() !== '');

/**
 * Does a row read as a header? At least half of its non-blank cells name
 * something we know. A lone cell is a header only in a one-column table, and
 * only when it names the form: anything else is a title or a word. A row of
 * two or more cells names the form or two columns (`ka<TAB>meaning` is data).
 * `strict`, for a row the scan finds below the first, asks for both, since a
 * word list whose glosses happen to include "type" or "meaning" has a row
 * that reads as a header, and taking it would drop the rows above it.
 */
const readsAsHeader = (ranked, cells, colCount, strict) => {
  const nonBlank = nonBlankCells(cells).length;
  const matched = ranked.filter(Boolean).length;
  const hasForm = ranked.some((m) => m?.target === FORM);
  if (!matched || matched * 2 < nonBlank) return false;
  if (nonBlank === 1) return colCount === 1 && hasForm;
  return strict ? hasForm && matched >= 2 : hasForm || matched >= 2;
};

// A line of machine keys, as some exports put under the human header
// ("parts_of_speech", "en_gloss", "lexemeForm"): every cell is one ASCII
// identifier, at least half of them are snake_case or camelCase, and one names
// a column. Glosses like "eat.PFV" or "go-out" are never keys.
const KEY = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/;
const COMPOUND_KEY = /_|[a-z][A-Z]/;
const isKeyLine = (cells, ranked) => {
  const keys = nonBlankCells(cells).map((c) => String(c).trim());
  return (
    keys.length >= 2 &&
    keys.every((k) => KEY.test(k)) &&
    keys.filter((k) => COMPOUND_KEY.test(k)).length * 2 >= keys.length &&
    ranked.some(Boolean)
  );
};

/**
 * What each column holds when row `skip` is the header (`hasHeader`), or when
 * the rows from `skip` on are all data. A column empty in every row below is
 * not imported, whatever its name.
 *
 * Whether row `skip` is the header is read from it (readsAsHeader), by the bar
 * for the first row when it is the first or the user picked it (`picked`),
 * and by the stricter bar when the scan found it lower down. `header` true or
 * false says so outright, as the "That row names the columns" box does.
 *
 * Under a header, a second header line (the same names again, or a line of
 * machine keys) is left out too (`subHeader`).
 *
 * @returns {{hasHeader: boolean, subHeader: boolean, mapping: string[]}}
 */
export const columnsAt = (
  rows,
  skip,
  fieldNames,
  humanize = (n) => n,
  { picked = false, header = null } = {},
) => {
  const colCount = Math.max(0, ...rows.slice(skip, skip + 50).map((r) => r.cells.length));
  if (!colCount) return { hasHeader: false, subHeader: false, mapping: [] };

  const rank = (cells) => cells.map((c) => rankHeader(c, fieldNames, humanize));
  const first = rows[skip]?.cells ?? [];
  const ranked = rank(first);
  const hasHeader = header ?? readsAsHeader(ranked, first, colCount, skip > 0 && !picked);
  const next = rows[skip + 1]?.cells;
  const nextRanked = hasHeader && next ? rank(next) : null;
  const subHeader =
    !!nextRanked &&
    (readsAsHeader(nextRanked, next, colCount, true) || isKeyLine(next, nextRanked));

  const mapping = hasHeader
    ? Array.from({ length: colCount }, (_, i) => ranked[i]?.target ?? IGNORE)
    : positionalMapping(colCount, fieldNames);
  // A column empty in every row is not imported, whatever its name. Before a
  // field claimed twice is settled, so an empty column never keeps a field
  // from a full one.
  const body = rows.slice(bodyStart({ skip, hasHeader, subHeader }));
  if (body.length) {
    for (let i = 0; i < mapping.length; i++) {
      if (mapping[i] === FORM) continue;
      if (body.every((r) => String(r.cells[i] ?? '').trim() === '')) mapping[i] = IGNORE;
    }
  }
  // A field claimed twice keeps the column that matches it best, and of
  // those the first. The other is left out rather than silently overwriting.
  const rankOf = (i) => (hasHeader ? (ranked[i]?.rank ?? CONTAINS) : 0);
  const keeper = new Map();
  for (let i = 0; i < mapping.length; i++) {
    const t = mapping[i];
    if (t === IGNORE) continue;
    if (!keeper.has(t) || rankOf(i) < rankOf(keeper.get(t))) keeper.set(t, i);
  }
  for (let i = 0; i < mapping.length; i++) {
    if (mapping[i] !== IGNORE && keeper.get(mapping[i]) !== i) mapping[i] = IGNORE;
  }
  return { hasHeader, subHeader, mapping };
};

/** The index of the first data row: below the rows skipped and the header lines. */
export const bodyStart = ({ skip = 0, hasHeader = false, subHeader = false }) =>
  skip + (hasHeader ? 1 + (subHeader ? 1 : 0) : 0);

/**
 * Guess where the table starts and what each column holds. Of the top rows
 * that read as a header, the one that maps the most columns wins, the
 * earliest on a tie, so a group line above the real header ("Lexeme, Sense,
 * Sense") loses to the header under it. What is above it is skipped. With no
 * header, all of it is data.
 *
 * @returns {{skip: number, hasHeader: boolean, subHeader: boolean, mapping: string[]}}
 */
export const guessColumns = (rows, fieldNames, humanize = (n) => n) => {
  let best = null;
  let bestScore = 0;
  for (let skip = 0; skip < Math.min(HEADER_SCAN, rows.length); skip++) {
    const at = columnsAt(rows, skip, fieldNames, humanize);
    if (!at.hasHeader) continue;
    const score = at.mapping.filter((t) => t !== IGNORE).length;
    if (!best || score > bestScore) {
      best = { skip, ...at };
      bestScore = score;
    }
  }
  return best ?? { skip: 0, ...columnsAt(rows, 0, fieldNames, humanize) };
};

// ---------------------------------------------------------------------------
// 3. rows → entries
// ---------------------------------------------------------------------------

/**
 * Apply a column mapping to the parsed rows.
 *
 * `normalizeValue(field, raw, { morphType, form })` may clean a value up or
 * reject it by returning ''. The dialog uses it to drop morph types outside
 * the controlled vocabulary and values a tagset refuses, which are reported
 * per entry as `rejected` rather than stored. It is told the row's form and
 * its morph type once cleaned, whichever column holds them.
 *
 * `skip` rows above the table are left out, and then the header when there is
 * one, and a second header line under it (`subHeader`). `constants` gives a
 * field the same value on every row.
 *
 * A line break inside a cell is read as a space, as the review shows it.
 *
 * @returns {{line: number, form: string, values: object, rejected: {field, value}[]}[]}
 */
export const rowsToEntries = (
  rows,
  mapping,
  { skip = 0, hasHeader = false, subHeader = false, normalizeValue = null, constants = {} } = {},
) => {
  const body = rows.slice(bodyStart({ skip, hasHeader, subHeader }));
  // A value given for every row, as if the file had a column of it. A field a
  // column already supplies is the column's.
  const given = Object.entries(constants).filter(
    ([field, value]) => String(value ?? '').trim() !== '' && !mapping.includes(field),
  );
  const clean = (target, raw, entry) => (normalizeValue ? normalizeValue(target, raw, entry) : raw);
  return body.map(({ cells, line }) => {
    const cellOf = (i) =>
      String(cells[i] ?? '')
        .replace(/[^\S\r\n]*(?:\r\n|\r|\n)\s*/g, ' ')
        .trim();
    const formAt = mapping.lastIndexOf(FORM);
    const form = formAt < 0 ? '' : cellOf(formAt);
    // The morph type the row ends up with: the last column that gives a usable one.
    let morphType = null;
    for (const [field, raw] of given) {
      if (field === 'morphType') morphType = clean(field, String(raw).trim(), {}) || null;
    }
    mapping.forEach((target, i) => {
      if (target === 'morphType' && cellOf(i))
        morphType = clean(target, cellOf(i), {}) || morphType;
    });
    const values = {};
    const rejected = [];
    mapping.forEach((target, i) => {
      if (target === IGNORE || target === FORM) return;
      const raw = cellOf(i);
      if (!raw) return;
      const value = clean(target, raw, { morphType, form });
      if (value) values[target] = value;
      else rejected.push({ field: target, value: raw });
    });
    for (const [field, raw] of given) {
      const value = clean(field, String(raw).trim(), { morphType, form });
      if (value) values[field] = value;
      else rejected.push({ field, value: String(raw).trim() });
    }
    return { line, form, values, rejected };
  });
};

// ---------------------------------------------------------------------------
// 4. merge planning
// ---------------------------------------------------------------------------

// Forms and values are compared NFC-normalized: a dictionary kept in one tool
// and text typed in another routinely disagree on composed vs. decomposed
// diacritics, and those are the same string to every human involved.
const norm = (v) =>
  String(v ?? '')
    .trim()
    .normalize('NFC');

const formKey = (form, caseInsensitive) => {
  const n = norm(form);
  return caseInsensitive ? n.toLowerCase() : n;
};

const blank = (v) => norm(v) === '';

/**
 * Which policies each classification accepts. Used to validate a per-row
 * override before applying it, so an override left over from an earlier
 * classification of that line cannot pick something meaningless.
 */
export const OVERRIDE_VALUES = {
  enrich: [ENRICH_FILL, ENRICH_SKIP],
  conflict: [CONFLICT_SKIP, CONFLICT_NEW, CONFLICT_OVERWRITE],
  ambiguous: [AMBIGUOUS_SKIP, AMBIGUOUS_NEW],
};

/**
 * When several entries share the form there is no single "the entry", so the
 * answer has to name one: `overwrite:2` replaces the second, `fill:2` fills its
 * blanks. The number is a 1-based position in the decision's `matches`, which
 * is what the reviewer sees listed. The policy alone still means "the only
 * candidate", which is all a single-match row ever needs.
 */
export const targetedAnswer = (policy, index) => `${policy}:${index + 1}`;

/** The policy each kind targets at one entry out of several. */
export const TARGETED_POLICY = {
  conflict: CONFLICT_OVERWRITE,
  ambiguous: ENRICH_FILL,
  // A row naming a headword that has senses fills the headword by default,
  // and a reviewer who means one of the senses picks it here.
  enrich: ENRICH_FILL,
};

const parseAnswer = (raw) => {
  const [policy, position] = String(raw ?? '').split(':');
  const index = position ? Number(position) - 1 : null;
  return { policy, index: Number.isInteger(index) && index >= 0 ? index : null };
};

/**
 * Plan a bulk import against the vocabulary's current contents.
 *
 * Every decision carries what a reviewer needs to second-guess it: the row's
 * own `values`, the `matches` it was weighed against (frozen at decision time),
 * and the value-level `changes` between them. A count of "74 rows disagree" is
 * not something a person can act on, and neither is a diff against an entry
 * they cannot see. A change with an empty `from` is a value the row adds, one
 * with both sides filled is a disagreement, and telling a correction from a
 * second sense is exactly that distinction.
 *
 * @param {object} opts
 * @param {Array} opts.entries - from rowsToEntries
 * @param {Array} opts.existingItems - [{id, form, metadata}]
 * @param {string[]} opts.fieldNames - the vocabulary's fields
 * @param {boolean} [opts.caseInsensitive] - match forms ignoring capitalization
 * @param {object} [opts.strategies] - the per-classification policy, see DEFAULT_STRATEGIES
 * @param {object} [opts.overrides] - `{[line]: policy}`, one row's answer overriding its bucket
 * @param {Function} [opts.refuses] - makeRefusal's: a value it refuses is left out of the write
 *   and listed on the decision's `rejected`, judged by the morph type its entry ends up with
 * A headword and its senses share a form, so a row names the ENTRY, and its
 * senses can still be picked by hand.
 *
 * @returns {{
 *   decisions: {
 *     line, form, values, kind, detail,
 *     action: 'create' | 'update' | 'skip',
 *     targetId, targetForm, candidates,
 *     matches: {form, values, pending, target}[],
 *     changes: {field, from, to}[],
 *   }[],
 *   counts: object,
 *   creates: {form, metadata}[],
 *   updates: {id, patch}[],
 * }}
 */
export const planVocabImport = ({
  entries = [],
  existingItems = [],
  fieldNames = [],
  caseInsensitive = false,
  strategies = DEFAULT_STRATEGIES,
  overrides = {},
  refuses = null,
}) => {
  const policies = { ...DEFAULT_STRATEGIES, ...strategies };
  // A headword and every sense under it carry the same form, so all of them
  // answer to a row. The numbers tell them apart on the comparison, and the
  // headword is what a bare form means (see `heads` below).
  const numbers = buildItemNumbers(existingItems);

  // The row's own answer wins over its bucket's, as long as it still makes
  // sense for how the row classified this time round. A targeted answer also
  // has to still point at a candidate that exists.
  const answerFor = (kind, line, candidates = []) => {
    const { policy, index } = parseAnswer(overrides?.[line]);
    const targeted = index != null && TARGETED_POLICY[kind] === policy;
    if (targeted && index < candidates.length) return { policy, index };
    if (!index && OVERRIDE_VALUES[kind]?.includes(policy)) return { policy, index: null };
    return { policy: policies[kind], index: null };
  };

  // Candidate pool, keyed by form. Entries created by earlier rows of this same
  // import join the pool, so a repeated row lands as `identical` instead of
  // creating the form twice, and a later row can fill in a blank the first row
  // left. A pool entry with no id is one of this run's own creates.
  const pool = new Map();
  const push = (form, entry) => {
    const k = formKey(form, caseInsensitive);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(entry);
  };
  for (const item of existingItems) {
    const values = {};
    for (const f of fieldNames) {
      const v = item?.metadata?.[f];
      if (!blank(v)) values[f] = String(v);
    }
    push(item?.form ?? '', {
      id: item.id,
      form: item.form,
      values,
      root: !item?.metadata?.parent,
      number: numbers.get(item.id) ?? '',
    });
  }

  const decisions = [];
  const creates = [];
  const updateOrder = [];
  const updates = new Map();
  const counts = { blank: 0, new: 0, identical: 0, enrich: 0, conflict: 0, ambiguous: 0 };

  const addUpdate = (id, patch) => {
    if (!updates.has(id)) {
      updates.set(id, {});
      updateOrder.push(id);
    }
    Object.assign(updates.get(id), patch);
  };

  // Every value the row carries, as something it would add from nothing.
  const additions = (entry, fields) =>
    fields.map((f) => ({ field: f, from: '', to: entry.values[f] }));

  // The row against one candidate, field by field: a blank `from` is an
  // addition, a filled one is a disagreement.
  const diffAgainst = (candidate, entry, fields) =>
    fields
      .filter((f) => norm(candidate.values[f]) !== norm(entry.values[f]))
      .map((f) => ({ field: f, from: candidate.values[f] ?? '', to: entry.values[f] }));

  // A candidate frozen at decision time. Pool values are mutated as later rows
  // fill blanks in, so a live reference would show a reviewer the wrong thing.
  // `canTarget` is false for a candidate that cannot receive this row: an
  // ambiguous row can only expand an entry it agrees with.
  const snapshot = (c, target, canTarget = true) => ({
    form: c.form,
    number: c.number ?? '',
    values: { ...c.values },
    pending: c.id == null,
    target: !!target,
    canTarget,
  });

  // Each decision that writes, with the candidate it writes to, for the
  // tagset check once every row has landed (below).
  const wrote = [];
  const record = (entry, d) => {
    const decision = {
      line: entry.line,
      form: entry.form,
      values: { ...entry.values },
      targetId: null,
      targetForm: null,
      candidates: 0,
      matches: [],
      changes: [],
      ...d,
    };
    decisions.push(decision);
    return decision;
  };

  const createFrom = (entry, fields, kind, detail, extra = {}) => {
    // Stored as typed (trimmed only): NFC is how we COMPARE forms, not a
    // normalization we impose on the user's orthography.
    const metadata = { ...entry.values };
    const pending = { form: String(entry.form).trim(), metadata };
    creates.push(pending);
    // What this run creates is an entry of its own, never a sense.
    const created = {
      id: null,
      form: pending.form,
      values: metadata,
      pending,
      root: true,
      number: '',
    };
    push(entry.form, created);
    wrote.push([
      record(entry, {
        kind,
        action: 'create',
        detail,
        changes: additions(entry, fields),
        ...extra,
      }),
      created,
    ]);
  };

  for (const entry of entries) {
    const fields = Object.keys(entry.values);

    if (!norm(entry.form)) {
      counts.blank += 1;
      record(entry, { form: '', kind: 'blank', action: 'skip', detail: 'no form' });
      continue;
    }

    const candidates = pool.get(formKey(entry.form, caseInsensitive)) ?? [];

    if (!candidates.length) {
      counts.new += 1;
      createFrom(entry, fields, 'new', 'new entry');
      continue;
    }

    // Already covered: some entry with this form holds every value in the row
    // (vacuously true for a form-only row, which is then nothing new to say).
    const same = candidates.find((c) => !diffAgainst(c, entry, fields).length);
    if (same) {
      counts.identical += 1;
      record(entry, {
        kind: 'identical',
        action: 'skip',
        targetId: same.id,
        targetForm: same.form,
        candidates: candidates.length,
        matches: candidates.map((c) => snapshot(c, c === same)),
        detail: 'already present',
      });
      continue;
    }

    // Compatible: disagrees nowhere, so the row only adds. Anything else is a
    // real disagreement, very often a second sense rather than a correction.
    const compatible = candidates.filter((c) =>
      fields.every((f) => blank(c.values[f]) || norm(c.values[f]) === norm(entry.values[f])),
    );

    // A form shared by a headword and its senses is one entry: a row names
    // the ENTRY, so a headword that contradicts the row is a disagreement
    // even when a blank sense under it would take the row's values. Left to
    // enrich, the row would land on that sense, which nothing on the
    // comparison lets the reviewer redirect.
    const onlySenseWhileHeadwordDisagrees =
      compatible.length === 1 &&
      !compatible[0].root &&
      candidates.some((c) => c.root && !compatible.includes(c));
    if (compatible.length === 1 && !onlySenseWhileHeadwordDisagrees) {
      counts.enrich += 1;
      const { policy: onePolicy, index: oneIndex } = answerFor('enrich', entry.line, candidates);
      // Only a candidate the row does not contradict can take it: filling a
      // blank is what enrich means, and the other candidates are here for the
      // reader to see, not to be written over.
      const onePick = oneIndex != null ? candidates[oneIndex] : null;
      const oneRefused = onePick != null && !compatible.includes(onePick);
      const target = oneRefused || !onePick ? compatible[0] : onePick;
      const changes = diffAgainst(target, entry, fields);
      const patch = Object.fromEntries(changes.map((c) => [c.field, c.to]));
      const added = changes.map((c) => c.field).join(', ');
      const base = {
        kind: 'enrich',
        targetId: target.id,
        targetForm: target.form,
        candidates: candidates.length,
        matches: candidates.map((c) => snapshot(c, c === target, compatible.includes(c))),
        changes,
      };
      // A pick the row contradicts is not quietly rerouted to another entry:
      // the reviewer named one, and writing to a different one is worse than
      // writing to none.
      if (oneRefused) {
        record(entry, {
          ...base,
          action: 'skip',
          detail: 'the entry chosen disagrees with this row',
        });
        continue;
      }
      if (onePolicy !== ENRICH_FILL) {
        record(entry, { ...base, action: 'skip', detail: `could add ${added}` });
        continue;
      }
      Object.assign(target.values, patch);
      if (target.id == null) {
        // Filling in an entry this same import is about to create, so fold the
        // values into that pending create instead of writing twice. Same
        // outcome as patching a stored entry, so it reports the same way: the
        // difference is which call we make, which is no business of the reader.
        Object.assign(target.pending.metadata, patch);
      } else {
        addUpdate(target.id, patch);
      }
      wrote.push([record(entry, { ...base, action: 'update', detail: `adds ${added}` }), target]);
      continue;
    }

    // A form shared by a headword and its senses is not really a question: the
    // row names the ENTRY, as a bare form does everywhere else. The senses stay
    // on the comparison, and a reviewer can still target one. Two headwords
    // sharing a form are a real question, and stay one.
    const heads = compatible.filter((c) => c.root);
    if (compatible.length > 1 && heads.length === 1) {
      counts.enrich += 1;
      const { policy: enrichPolicy, index: enrichIndex } = answerFor(
        'enrich',
        entry.line,
        candidates,
      );
      // The row names the ENTRY unless a reviewer has picked one of its senses,
      // and only a candidate the row does not contradict can be picked.
      const enrichPick = enrichIndex != null ? candidates[enrichIndex] : null;
      const enrichRefused = enrichPick != null && !compatible.includes(enrichPick);
      const target = enrichRefused || !enrichPick ? heads[0] : enrichPick;
      const changes = diffAgainst(target, entry, fields);
      const patch = Object.fromEntries(changes.map((c) => [c.field, c.to]));
      const added = changes.map((c) => c.field).join(', ');
      const base = {
        kind: 'enrich',
        targetId: target.id,
        targetForm: target.form,
        candidates: candidates.length,
        matches: candidates.map((c) => snapshot(c, c === target, compatible.includes(c))),
        changes,
      };
      if (enrichRefused) {
        record(entry, {
          ...base,
          action: 'skip',
          detail: 'the entry chosen disagrees with this row',
        });
        continue;
      }
      if (enrichPolicy !== ENRICH_FILL) {
        record(entry, { ...base, action: 'skip', detail: `could add ${added}` });
        continue;
      }
      Object.assign(target.values, patch);
      if (target.id == null) Object.assign(target.pending.metadata, patch);
      else addUpdate(target.id, patch);
      wrote.push([record(entry, { ...base, action: 'update', detail: `adds ${added}` }), target]);
      continue;
    }

    if (compatible.length > 1) {
      counts.ambiguous += 1;
      const detail = `${compatible.length} entries share this form`;
      const { policy, index } = answerFor('ambiguous', entry.line, candidates);
      // A reviewer looking at the entries can often tell which one the row
      // describes, so a targeted answer names it. Only a compatible candidate
      // can be expanded: the others contradict the row somewhere.
      const chosen = index != null ? candidates[index] : null;
      if (chosen && compatible.includes(chosen)) {
        const changes = diffAgainst(chosen, entry, fields);
        const patch = Object.fromEntries(changes.map((c) => [c.field, c.to]));
        Object.assign(chosen.values, patch);
        if (chosen.id == null) Object.assign(chosen.pending.metadata, patch);
        else addUpdate(chosen.id, patch);
        const decision = record(entry, {
          kind: 'ambiguous',
          action: 'update',
          targetId: chosen.id,
          targetForm: chosen.form,
          candidates: candidates.length,
          matches: candidates.map((c) => snapshot(c, c === chosen, compatible.includes(c))),
          changes,
          detail: `adds ${changes.map((c) => c.field).join(', ')}`,
        });
        wrote.push([decision, chosen]);
        continue;
      }
      const extra = {
        candidates: candidates.length,
        matches: candidates.map((c) => snapshot(c, false, compatible.includes(c))),
      };
      if (policy === AMBIGUOUS_NEW) {
        createFrom(entry, fields, 'ambiguous', `${detail}, so added separately`, extra);
      } else {
        record(entry, {
          ...extra,
          kind: 'ambiguous',
          action: 'skip',
          changes: additions(entry, fields),
          detail,
        });
      }
      continue;
    }

    // Disagreement with every candidate.
    counts.conflict += 1;
    const { policy: mode, index: chosenIndex } = answerFor('conflict', entry.line, candidates);
    // Diff against whichever entry the answer names, falling back to the
    // headword when there is one among them (a row names the entry), else the
    // first, which is the only sensible target when there is one and the
    // clearest illustration of the clash when there are several.
    const first =
      candidates[
        chosenIndex ??
          Math.max(
            0,
            candidates.findIndex((c) => c.root),
          )
      ];
    const changes = diffAgainst(first, entry, fields);
    const clashed = changes
      .filter((c) => c.from !== '')
      .map((c) => c.field)
      .join(', ');
    const base = {
      kind: 'conflict',
      targetId: first.id,
      targetForm: first.form,
      candidates: candidates.length,
      matches: candidates.map((c) =>
        snapshot(c, c === first && (candidates.length === 1 || chosenIndex != null)),
      ),
      changes,
    };

    if (mode === CONFLICT_NEW) {
      createFrom(entry, fields, 'conflict', `differs on ${clashed}, so added separately`, {
        targetId: first.id,
        targetForm: first.form,
        candidates: candidates.length,
        matches: candidates.map((c) => snapshot(c, false)),
      });
      continue;
    }
    if (mode === CONFLICT_OVERWRITE && (candidates.length === 1 || chosenIndex != null)) {
      const patch = Object.fromEntries(changes.map((c) => [c.field, c.to]));
      const replaced = Object.keys(patch).join(', ');
      Object.assign(first.values, patch);
      if (first.id == null) {
        // The only entry with this form is one this import is adding a few rows
        // up, so the replacement lands on that pending entry. Dropping it here
        // (there is no id to patch) would ignore the answer without saying so.
        Object.assign(first.pending.metadata, patch);
      } else {
        addUpdate(first.id, patch);
      }
      wrote.push([
        record(entry, { ...base, action: 'update', detail: `replaces ${replaced}` }),
        first,
      ]);
      continue;
    }
    // Overwrite is the one answer that can fail to apply, and only for want of
    // a single target. Say so rather than looking like nothing happened.
    record(entry, {
      ...base,
      action: 'skip',
      detail:
        mode === CONFLICT_OVERWRITE
          ? `${candidates.length} entries share this form, so there is nothing single to replace`
          : `differs on ${clashed}`,
    });
  }

  // A value is judged by the morph type its entry ends up with, and a later
  // row of this same import can change that: a row with no morph type fills a
  // suffix's gloss, a later row types the entry an earlier row glossed. So the
  // check waits until every row has landed. What an entry already stores is
  // not judged, only what this import writes.
  if (refuses) {
    const tree = buildSenseTree(existingItems);
    for (const [d, t] of wrote) {
      const out = t.id == null ? t.pending.metadata : updates.get(t.id);
      const morphType = t.values.morphType || (t.id != null ? morphTypeOf(tree, t.id) : null);
      const bad = d.changes.filter(
        (c) =>
          c.field !== 'morphType' &&
          norm(out?.[c.field]) === norm(c.to) &&
          refuses(c.field, c.to, { morphType, form: t.form }),
      );
      if (!bad.length) continue;
      for (const c of bad) delete out[c.field];
      d.rejected = bad.map((c) => ({ field: c.field, value: c.to }));
      d.changes = d.changes.filter((c) => !bad.includes(c));
      if (d.action !== 'update') continue;
      const left = d.changes.map((c) => c.field).join(', ');
      if (!left) {
        d.action = 'skip';
        d.detail = `${bad.map((c) => c.field).join(', ')} not accepted`;
      } else d.detail = `${d.detail.startsWith('replaces ') ? 'replaces' : 'adds'} ${left}`;
    }
  }

  return {
    decisions,
    counts,
    creates,
    updates: updateOrder
      .filter((id) => Object.keys(updates.get(id)).length)
      .map((id) => ({ id, patch: updates.get(id) })),
  };
};

/**
 * Rows whose values were partly rejected (an unusable morph type, say), from
 * rowsToEntries' entries and planVocabImport's decisions, a row counted once.
 */
export const countRejected = (entries) =>
  new Set(entries.filter((e) => e.rejected?.length).map((e) => e.line)).size;

/** The fields that had a value rejected, in first-seen order. */
export const rejectedFields = (entries) => {
  const out = [];
  for (const e of entries) {
    for (const r of e.rejected || []) if (!out.includes(r.field)) out.push(r.field);
  }
  return out;
};

/** One change as a phrase: `pos: N` for an addition, `gloss: cat > wildcat` for a clash. */
export const describeChange = (c) =>
  c.from === '' ? `${c.field}: ${c.to}` : `${c.field}: ${c.from} > ${c.to}`;

/**
 * The whole plan as a TSV the user can open in a spreadsheet, still the way to
 * check a few thousand rows away from the dialog or to keep a record of what a
 * run did.
 */
export const serializeImportReport = (decisions) => {
  const cell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
  const outcome = (d) => {
    if (d.action === 'create') return 'Added';
    if (d.action === 'update') return d.kind === 'conflict' ? 'Replaced' : 'Expanded';
    return 'Skipped';
  };
  const lines = ['Line\tForm\tOutcome\tWhy\tValues'];
  for (const d of decisions) {
    lines.push(
      [d.line, d.form, outcome(d), d.detail, (d.changes || []).map(describeChange).join(' · ')]
        .map(cell)
        .join('\t'),
    );
  }
  return `${lines.join('\n')}\n`;
};
