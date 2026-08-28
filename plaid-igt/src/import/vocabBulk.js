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

/** Mapping sentinels: a column becomes the item's form, or is left out. */
export const FORM = '__form__';
export const IGNORE = '__ignore__';

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
 * Plan a bulk import against the vocabulary's current contents.
 *
 * @param {object} opts
 * @param {Array} opts.entries - from rowsToEntries
 * @param {Array} opts.existingItems - [{id, form, metadata}]
 * @param {string[]} opts.fieldNames - the vocabulary's fields
 * @param {boolean} [opts.caseInsensitive] - match forms ignoring capitalization
 * @param {object} [opts.strategies] - see DEFAULT_STRATEGIES
 * @returns {{
 *   decisions: {line, form, kind, action, targetId, detail}[],
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
}) => {
  const { enrich, conflict, ambiguous } = { ...DEFAULT_STRATEGIES, ...strategies };

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

  const createFrom = (entry, kind, detail) => {
    // Stored as typed (trimmed only): NFC is how we COMPARE forms, not a
    // normalization we impose on the user's orthography.
    const metadata = { ...entry.values };
    const pending = { form: String(entry.form).trim(), metadata };
    creates.push(pending);
    push(entry.form, { id: null, form: pending.form, values: metadata, pending });
    decisions.push({
      line: entry.line,
      form: entry.form,
      kind,
      action: 'create',
      targetId: null,
      detail,
    });
  };

  for (const entry of entries) {
    const fields = Object.keys(entry.values);

    if (!norm(entry.form)) {
      counts.blank += 1;
      decisions.push({
        line: entry.line,
        form: '',
        kind: 'blank',
        action: 'skip',
        targetId: null,
        detail: 'no form',
      });
      continue;
    }

    const candidates = pool.get(formKey(entry.form, caseInsensitive)) ?? [];

    if (!candidates.length) {
      counts.new += 1;
      createFrom(entry, 'new', 'new entry');
      continue;
    }

    // Already covered: some entry with this form holds every value in the row
    // (vacuously true for a form-only row, which is then nothing new to say).
    const same = candidates.find((c) =>
      fields.every((f) => norm(c.values[f]) === norm(entry.values[f])),
    );
    if (same) {
      counts.identical += 1;
      decisions.push({
        line: entry.line,
        form: entry.form,
        kind: 'identical',
        action: 'skip',
        targetId: same.id,
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
      const patch = {};
      for (const f of fields) if (blank(target.values[f])) patch[f] = entry.values[f];
      const added = Object.keys(patch).join(', ');
      if (enrich !== ENRICH_FILL) {
        decisions.push({
          line: entry.line,
          form: entry.form,
          kind: 'enrich',
          action: 'skip',
          targetId: target.id,
          detail: `could fill in ${added}`,
        });
        continue;
      }
      Object.assign(target.values, patch);
      if (target.id == null) {
        // Filling in an entry this same import is about to create, so fold
        // the values into that pending create instead of writing twice.
        Object.assign(target.pending.metadata, patch);
        decisions.push({
          line: entry.line,
          form: entry.form,
          kind: 'enrich',
          action: 'merge',
          targetId: null,
          detail: `added ${added} to a new entry above`,
        });
      } else {
        addUpdate(target.id, patch);
        decisions.push({
          line: entry.line,
          form: entry.form,
          kind: 'enrich',
          action: 'update',
          targetId: target.id,
          detail: `fills in ${added}`,
        });
      }
      continue;
    }

    if (compatible.length > 1) {
      counts.ambiguous += 1;
      const detail = `${compatible.length} entries share this form`;
      if (ambiguous === AMBIGUOUS_NEW)
        createFrom(entry, 'ambiguous', `${detail}; added separately`);
      else
        decisions.push({
          line: entry.line,
          form: entry.form,
          kind: 'ambiguous',
          action: 'skip',
          targetId: null,
          detail,
        });
      continue;
    }

    // Disagreement with every candidate.
    counts.conflict += 1;
    const clashes = (c) =>
      fields.filter((f) => !blank(c.values[f]) && norm(c.values[f]) !== norm(entry.values[f]));
    if (conflict === CONFLICT_NEW) {
      createFrom(
        entry,
        'conflict',
        `differs on ${clashes(candidates[0]).join(', ')}; added separately`,
      );
      continue;
    }
    if (conflict === CONFLICT_OVERWRITE && candidates.length === 1 && candidates[0].id != null) {
      const target = candidates[0];
      const patch = {};
      for (const f of fields)
        if (norm(target.values[f]) !== norm(entry.values[f])) patch[f] = entry.values[f];
      Object.assign(target.values, patch);
      addUpdate(target.id, patch);
      decisions.push({
        line: entry.line,
        form: entry.form,
        kind: 'conflict',
        action: 'update',
        targetId: target.id,
        detail: `replaces ${Object.keys(patch).join(', ')}`,
      });
      continue;
    }
    decisions.push({
      line: entry.line,
      form: entry.form,
      kind: 'conflict',
      action: 'skip',
      targetId: candidates[0]?.id ?? null,
      detail:
        conflict === CONFLICT_OVERWRITE && candidates.length > 1
          ? `${candidates.length} entries share this form, so there is nothing single to replace`
          : `differs on ${clashes(candidates[0]).join(', ')}`,
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

/**
 * The whole plan as a TSV the user can open in a spreadsheet, the only
 * practical way to check a few thousand rows before or after committing them.
 */
export const serializeImportReport = (decisions) => {
  const cell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
  const OUTCOME = {
    create: 'Added',
    update: 'Updated',
    merge: 'Merged into a new entry',
    skip: 'Skipped',
  };
  const lines = ['Line\tForm\tOutcome\tWhy'];
  for (const d of decisions) {
    lines.push([d.line, d.form, OUTCOME[d.action] ?? d.action, d.detail].map(cell).join('\t'));
  }
  return `${lines.join('\n')}\n`;
};
