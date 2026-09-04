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
import { isValueAllowed, tagsetEnforces } from '../domain/tagsets.js';

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
 * The `normalizeValue` rowsToEntries takes, for a vocabulary whose fields may
 * be governed by tagsets. `tagsetFor(field)` is the tagset governing that
 * field, or null. A value an ENFORCING tagset refuses is rejected (reported
 * on the entry, never stored), the same way an unknown morph type is; a
 * suggesting tagset lets everything through, since that is what it is for.
 */
export const makeValueNormalizer =
  (tagsetFor = () => null) =>
  (field, raw) => {
    if (field === 'morphType') return normalizeMorphType(raw);
    const tagset = tagsetFor(field);
    if (tagsetEnforces(tagset) && !isValueAllowed(raw, tagset)) return '';
    return raw;
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
 * @returns {{cells: string[], line: number}[]} line is 1-based in the source.
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
        if (ch === '\n') line += 1; // a newline inside a quoted cell
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

const normalizeHeader = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

// Header spellings that mean "this is the entry's form".
const FORM_ALIASES = new Set(
  ['form', 'lexeme form', 'lexeme', 'headword', 'head word', 'entry', 'citation form'].map(
    normalizeHeader,
  ),
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

/**
 * Match one header cell to a mapping target: FORM, a field name, or null when
 * nothing recognizes it.
 *
 * @param {string} cell - the header cell
 * @param {string[]} fieldNames - the vocabulary's field names
 * @param {(name: string) => string} humanize - field name → display label
 */
export const matchHeader = (cell, fieldNames, humanize = (n) => n) => {
  const n = normalizeHeader(cell);
  if (!n) return null;
  if (FORM_ALIASES.has(n)) return FORM;
  if (EXPORT_ONLY.has(n)) return IGNORE;
  for (const field of fieldNames) {
    if (n === normalizeHeader(field) || n === normalizeHeader(humanize(field))) return field;
    if ((FIELD_ALIASES[field] || []).some((a) => normalizeHeader(a) === n)) return field;
  }
  return null;
};

/** Column 0 is the form, the rest follow the vocabulary's field order. */
export const positionalMapping = (colCount, fieldNames) =>
  Array.from({ length: colCount }, (_, i) => (i === 0 ? FORM : (fieldNames[i - 1] ?? IGNORE)));

/**
 * Guess whether row 0 is a header and what each column holds. A header is
 * recognized when at least half of its non-blank cells name something we know,
 * so `Form<TAB>Gloss` is a header but `perro<TAB>dog` is data.
 *
 * @returns {{hasHeader: boolean, mapping: string[]}}
 */
export const guessColumns = (rows, fieldNames, humanize = (n) => n) => {
  const first = rows[0]?.cells ?? [];
  const colCount = Math.max(0, ...rows.slice(0, 50).map((r) => r.cells.length));
  if (!colCount) return { hasHeader: false, mapping: [] };

  const matches = first.map((c) => matchHeader(c, fieldNames, humanize));
  const nonBlank = first.filter((c) => String(c).trim() !== '').length;
  const matched = matches.filter((m) => m !== null).length;
  const hasHeader = matched > 0 && matched * 2 >= nonBlank;

  if (!hasHeader) return { hasHeader: false, mapping: positionalMapping(colCount, fieldNames) };

  const mapping = Array.from({ length: colCount }, (_, i) => matches[i] ?? IGNORE);
  // A field claimed twice keeps only its first column. The later one is left
  // out rather than silently overwriting.
  const used = new Set();
  for (let i = 0; i < mapping.length; i++) {
    if (mapping[i] === IGNORE) continue;
    if (used.has(mapping[i])) mapping[i] = IGNORE;
    else used.add(mapping[i]);
  }
  return { hasHeader: true, mapping };
};

// ---------------------------------------------------------------------------
// 3. rows → entries
// ---------------------------------------------------------------------------

/**
 * Apply a column mapping to the parsed rows.
 *
 * `normalizeValue(field, raw)` may clean a value up or reject it by returning
 * ''. The dialog uses it to drop morph types outside the controlled
 * vocabulary, which are reported per entry as `rejected` rather than stored.
 *
 * @returns {{line: number, form: string, values: object, rejected: {field, value}[]}[]}
 */
export const rowsToEntries = (rows, mapping, { hasHeader = false, normalizeValue = null } = {}) => {
  const body = hasHeader ? rows.slice(1) : rows;
  return body.map(({ cells, line }) => {
    let form = '';
    const values = {};
    const rejected = [];
    mapping.forEach((target, i) => {
      if (target === IGNORE) return;
      const raw = String(cells[i] ?? '').trim();
      if (target === FORM) {
        form = raw;
        return;
      }
      if (!raw) return;
      const clean = normalizeValue ? normalizeValue(target, raw) : raw;
      if (clean) values[target] = clean;
      else rejected.push({ field: target, value: raw });
    });
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
}) => {
  const policies = { ...DEFAULT_STRATEGIES, ...strategies };

  // The row's own answer wins over its bucket's, as long as it still makes
  // sense for how the row classified this time round.
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
  const policyFor = (kind, line) => answerFor(kind, line).policy;

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
    push(item?.form ?? '', { id: item.id, form: item.form, values });
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
    values: { ...c.values },
    pending: c.id == null,
    target: !!target,
    canTarget,
  });

  const record = (entry, d) =>
    decisions.push({
      line: entry.line,
      form: entry.form,
      values: { ...entry.values },
      targetId: null,
      targetForm: null,
      candidates: 0,
      matches: [],
      changes: [],
      ...d,
    });

  const createFrom = (entry, fields, kind, detail, extra = {}) => {
    // Stored as typed (trimmed only): NFC is how we COMPARE forms, not a
    // normalization we impose on the user's orthography.
    const metadata = { ...entry.values };
    const pending = { form: String(entry.form).trim(), metadata };
    creates.push(pending);
    push(entry.form, { id: null, form: pending.form, values: metadata, pending });
    record(entry, { kind, action: 'create', detail, changes: additions(entry, fields), ...extra });
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

    if (compatible.length === 1) {
      counts.enrich += 1;
      const target = compatible[0];
      const changes = diffAgainst(target, entry, fields);
      const patch = Object.fromEntries(changes.map((c) => [c.field, c.to]));
      const added = changes.map((c) => c.field).join(', ');
      const base = {
        kind: 'enrich',
        targetId: target.id,
        targetForm: target.form,
        candidates: candidates.length,
        matches: candidates.map((c) => snapshot(c, c === target)),
        changes,
      };
      if (policyFor('enrich', entry.line) !== ENRICH_FILL) {
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
      record(entry, { ...base, action: 'update', detail: `adds ${added}` });
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
        record(entry, {
          kind: 'ambiguous',
          action: 'update',
          targetId: chosen.id,
          targetForm: chosen.form,
          candidates: candidates.length,
          matches: candidates.map((c) => snapshot(c, c === chosen, compatible.includes(c))),
          changes,
          detail: `adds ${changes.map((c) => c.field).join(', ')}`,
        });
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

    // Disagreement with every candidate. Diff against the first, which is the
    // only sensible target when there is exactly one, and the clearest
    // illustration of the clash when there are several.
    counts.conflict += 1;
    const { policy: mode, index: chosenIndex } = answerFor('conflict', entry.line, candidates);
    // Diff against whichever entry the answer names, falling back to the first,
    // which is the only sensible target when there is one and the clearest
    // illustration of the clash when there are several.
    const first = candidates[chosenIndex ?? 0];
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
      record(entry, { ...base, action: 'update', detail: `replaces ${replaced}` });
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

  return {
    decisions,
    counts,
    creates,
    updates: updateOrder.map((id) => ({ id, patch: updates.get(id) })),
  };
};

/** Rows whose values were partly rejected (an unusable morph type, say). */
export const countRejected = (entries) =>
  entries.reduce((n, e) => n + (e.rejected?.length ? 1 : 0), 0);

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
