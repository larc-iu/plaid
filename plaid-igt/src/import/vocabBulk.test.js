import { describe, it, expect } from 'vitest';
import {
  FORM,
  IGNORE,
  ENRICH_SKIP,
  CONFLICT_NEW,
  CONFLICT_OVERWRITE,
  AMBIGUOUS_NEW,
  detectDelimiter,
  parseDelimited,
  parseTable,
  matchHeader,
  guessColumns,
  positionalMapping,
  rowsToEntries,
  planVocabImport,
  serializeImportReport,
  describeChange,
  targetedAnswer,
  OVERRIDE_VALUES,
  CONFLICT_SKIP,
  ENRICH_FILL,
  AMBIGUOUS_SKIP,
  makeValueNormalizer,
  normalizeMorphType,
  rejectedFields,
} from './vocabBulk.js';

const FIELDS = ['morphType', 'gloss', 'pos', 'definition'];
const humanize = (n) => ({ morphType: 'Morph Type', pos: 'POS' })[n] ?? n;

describe('detectDelimiter', () => {
  it('prefers a tab wherever one appears', () => {
    expect(detectDelimiter('a\tb,c\nd\te,f')).toBe('\t');
  });

  it('falls back to comma, then semicolon when semicolons dominate', () => {
    expect(detectDelimiter('a,b\nc,d')).toBe(',');
    expect(detectDelimiter('form;gloss;pos\nperro;dog, hound;N')).toBe(';');
  });

  it('treats separator-free text as a single tab-separated column', () => {
    expect(detectDelimiter('perro\ngato')).toBe('\t');
  });
});

describe('parseDelimited', () => {
  it('splits cells and numbers lines from 1', () => {
    expect(parseDelimited('a\tb\nc\td\n', '\t')).toEqual([
      { cells: ['a', 'b'], line: 1 },
      { cells: ['c', 'd'], line: 2 },
    ]);
  });

  it('handles CRLF and a missing trailing newline', () => {
    expect(parseDelimited('a\tb\r\nc\td', '\t').map((r) => r.cells)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('drops all-blank rows but keeps the line numbers of what follows', () => {
    expect(parseDelimited('a\n\n\nb\n', '\t')).toEqual([
      { cells: ['a'], line: 1 },
      { cells: ['b'], line: 4 },
    ]);
  });

  it('reads RFC4180 quoting, including embedded delimiters and newlines', () => {
    const rows = parseDelimited('form,gloss\nperro,"dog, hound"\ngato,"a ""cat"""\n', ',');
    expect(rows.map((r) => r.cells)).toEqual([
      ['form', 'gloss'],
      ['perro', 'dog, hound'],
      ['gato', 'a "cat"'],
    ]);
  });

  it('does not treat a quote inside a cell as an opening quote', () => {
    expect(parseDelimited('ka"m\tgloss', '\t')[0].cells).toEqual(['ka"m', 'gloss']);
  });

  it('strips a UTF-8 BOM', () => {
    expect(parseDelimited('\uFEFFForm\tGloss', '\t')[0].cells).toEqual(['Form', 'Gloss']);
  });
});

describe('column guessing', () => {
  it('recognizes a header row and maps by name', () => {
    const { rows } = parseTable('Form\tGloss\tPOS\nperro\tdog\tN\n');
    expect(guessColumns(rows, FIELDS, humanize)).toEqual({
      hasHeader: true,
      mapping: [FORM, 'gloss', 'pos'],
    });
  });

  it('maps common external spellings onto our fields', () => {
    expect(matchHeader('Headword', FIELDS, humanize)).toBe(FORM);
    expect(matchHeader('Part of Speech', FIELDS, humanize)).toBe('pos');
    expect(matchHeader('Meaning', FIELDS, humanize)).toBe('gloss');
    expect(matchHeader('Morpheme Type', FIELDS, humanize)).toBe('morphType');
    expect(matchHeader('Semantic Domain', FIELDS, humanize)).toBe(null);
  });

  it('ignores the export-only Uses column so our own export round-trips', () => {
    const { rows } = parseTable('Form\tGloss\tUses\nperro\tdog\t3\n');
    expect(guessColumns(rows, FIELDS, humanize).mapping).toEqual([FORM, 'gloss', IGNORE]);
  });

  it('treats a data first row as data and falls back to column order', () => {
    const { rows } = parseTable('perro\tdog\nchat\tcat\n');
    expect(guessColumns(rows, ['gloss', 'pos'], humanize)).toEqual({
      hasHeader: false,
      mapping: [FORM, 'gloss'],
    });
  });

  it('leaves a repeated field on its first column only', () => {
    const { rows } = parseTable('Form\tGloss\tgloss\nx\ta\tb\n');
    expect(guessColumns(rows, FIELDS, humanize).mapping).toEqual([FORM, 'gloss', IGNORE]);
  });

  it('pads the positional mapping with Ignore past the last field', () => {
    expect(positionalMapping(4, ['gloss'])).toEqual([FORM, 'gloss', IGNORE, IGNORE]);
  });
});

describe('rowsToEntries', () => {
  const { rows } = parseTable('Form\tGloss\tPOS\nperro\tdog\tN\n gato \t\tN\n');

  it('applies the mapping, trims, and drops blank values', () => {
    const entries = rowsToEntries(rows, [FORM, 'gloss', 'pos'], { hasHeader: true });
    expect(entries).toEqual([
      { line: 2, form: 'perro', values: { gloss: 'dog', pos: 'N' }, rejected: [] },
      { line: 3, form: 'gato', values: { pos: 'N' }, rejected: [] },
    ]);
  });

  it('reports values the normalizer rejects instead of storing them', () => {
    const normalizeValue = (field, raw) => (field === 'pos' && raw === 'N' ? '' : raw);
    const entries = rowsToEntries(rows, [FORM, 'gloss', 'pos'], {
      hasHeader: true,
      normalizeValue,
    });
    expect(entries[0].values).toEqual({ gloss: 'dog' });
    expect(entries[0].rejected).toEqual([{ field: 'pos', value: 'N' }]);
  });

  it('keeps the first row when it is not a header', () => {
    expect(rowsToEntries(rows, [FORM], { hasHeader: false })).toHaveLength(3);
  });
});

// --- merge planning --------------------------------------------------------

const entry = (line, form, values = {}) => ({ line, form, values, rejected: [] });
const plan = (entries, existingItems, opts = {}) =>
  planVocabImport({ entries, existingItems, fieldNames: FIELDS, ...opts });

describe('planVocabImport', () => {
  const existing = [
    { id: 'i1', form: 'perro', metadata: { gloss: 'dog' } },
    { id: 'i2', form: 'gato', metadata: { gloss: 'cat', pos: 'N' } },
  ];

  it('creates entries whose form is not present', () => {
    const p = plan([entry(1, 'lobo', { gloss: 'wolf' })], existing);
    expect(p.counts.new).toBe(1);
    expect(p.creates).toEqual([{ form: 'lobo', metadata: { gloss: 'wolf' } }]);
    expect(p.updates).toEqual([]);
  });

  it('skips a row an existing entry already covers', () => {
    const p = plan([entry(1, 'gato', { gloss: 'cat' })], existing);
    expect(p.counts.identical).toBe(1);
    expect(p.creates).toEqual([]);
    expect(p.decisions[0]).toMatchObject({ action: 'skip', targetId: 'i2' });
  });

  it('treats a bare repeated form as already present, not a new homonym', () => {
    const p = plan([entry(1, 'perro')], existing);
    expect(p.counts.identical).toBe(1);
    expect(p.creates).toEqual([]);
  });

  it('fills in only the blanks of a compatible entry', () => {
    const p = plan([entry(1, 'perro', { gloss: 'dog', pos: 'N', definition: 'a dog' })], existing);
    expect(p.counts.enrich).toBe(1);
    expect(p.updates).toEqual([{ id: 'i1', patch: { pos: 'N', definition: 'a dog' } }]);
  });

  it('leaves the entry alone when enrichment is turned off', () => {
    const p = plan([entry(1, 'perro', { pos: 'N' })], existing, {
      strategies: { enrich: ENRICH_SKIP },
    });
    expect(p.counts.enrich).toBe(1);
    expect(p.updates).toEqual([]);
    expect(p.decisions[0].action).toBe('skip');
  });

  it('merges several rows touching one entry into a single patch', () => {
    const p = plan(
      [entry(1, 'perro', { pos: 'N' }), entry(2, 'perro', { definition: 'a dog' })],
      existing,
    );
    expect(p.updates).toEqual([{ id: 'i1', patch: { pos: 'N', definition: 'a dog' } }]);
  });

  it('never overwrites a value that disagrees', () => {
    const p = plan([entry(1, 'gato', { gloss: 'wildcat' })], existing);
    expect(p.counts.conflict).toBe(1);
    expect(p.updates).toEqual([]);
    expect(p.creates).toEqual([]);
    expect(p.decisions[0].detail).toContain('gloss');
  });

  it('can add a disagreeing row as a separate sense', () => {
    const p = plan([entry(1, 'gato', { gloss: 'wildcat' })], existing, {
      strategies: { conflict: CONFLICT_NEW },
    });
    expect(p.creates).toEqual([{ form: 'gato', metadata: { gloss: 'wildcat' } }]);
  });

  it('can overwrite a disagreeing value when there is exactly one target', () => {
    const p = plan([entry(1, 'gato', { gloss: 'wildcat', definition: 'felis' })], existing, {
      strategies: { conflict: CONFLICT_OVERWRITE },
    });
    expect(p.updates).toEqual([{ id: 'i2', patch: { gloss: 'wildcat', definition: 'felis' } }]);
  });

  it('replaces onto an entry this same import is adding, rather than doing nothing', () => {
    // The only 'yalu' is the one line 1 creates, so there is no id to patch.
    // The answer still has to land somewhere.
    const p = plan(
      [entry(1, 'yalu', { gloss: 'fire' }), entry(2, 'yalu', { gloss: 'firewood' })],
      [],
      { overrides: { 2: CONFLICT_OVERWRITE } },
    );
    expect(p.creates).toEqual([{ form: 'yalu', metadata: { gloss: 'firewood' } }]);
    expect(p.updates).toEqual([]);
    expect(p.decisions[1]).toMatchObject({ action: 'update' });
    expect(p.decisions[1].detail).toContain('replaces gloss');
  });

  it('says why a replace could not apply instead of looking like a no-op', () => {
    const homonyms = [
      { id: 'a', form: 'kap', metadata: { gloss: 'hand' } },
      { id: 'b', form: 'kap', metadata: { gloss: 'head' } },
    ];
    const p = plan([entry(1, 'kap', { gloss: 'foot' })], homonyms, {
      strategies: { conflict: CONFLICT_OVERWRITE },
    });
    expect(p.decisions[0].action).toBe('skip');
    expect(p.decisions[0].detail).toContain('nothing single to replace');
  });

  it('refuses to overwrite when homonyms make the target ambiguous', () => {
    const homonyms = [
      { id: 'a', form: 'kap', metadata: { gloss: 'hand' } },
      { id: 'b', form: 'kap', metadata: { gloss: 'head' } },
    ];
    const p = plan([entry(1, 'kap', { gloss: 'foot' })], homonyms, {
      strategies: { conflict: CONFLICT_OVERWRITE },
    });
    expect(p.updates).toEqual([]);
    expect(p.decisions[0]).toMatchObject({ action: 'skip', kind: 'conflict' });
  });

  it('flags a row that could enrich several homonyms as ambiguous', () => {
    const homonyms = [
      { id: 'a', form: 'kap', metadata: { gloss: 'hand' } },
      { id: 'b', form: 'kap', metadata: { gloss: 'head' } },
    ];
    const p = plan([entry(1, 'kap', { pos: 'N' })], homonyms);
    expect(p.counts.ambiguous).toBe(1);
    expect(p.updates).toEqual([]);
    const added = plan([entry(1, 'kap', { pos: 'N' })], homonyms, {
      strategies: { ambiguous: AMBIGUOUS_NEW },
    });
    expect(added.creates).toEqual([{ form: 'kap', metadata: { pos: 'N' } }]);
  });

  it('picks the compatible homonym and leaves the disagreeing one alone', () => {
    const homonyms = [
      { id: 'a', form: 'kap', metadata: { gloss: 'hand' } },
      { id: 'b', form: 'kap', metadata: { gloss: 'head' } },
    ];
    const p = plan([entry(1, 'kap', { gloss: 'head', pos: 'N' })], homonyms);
    expect(p.updates).toEqual([{ id: 'b', patch: { pos: 'N' } }]);
  });

  it('does not create the same form twice from one file', () => {
    const p = plan([entry(1, 'lobo', { gloss: 'wolf' }), entry(2, 'lobo', { gloss: 'wolf' })], []);
    expect(p.creates).toHaveLength(1);
    expect(p.counts.identical).toBe(1);
  });

  it('folds a later row into the create it enriches rather than writing twice', () => {
    const p = plan([entry(1, 'lobo', { gloss: 'wolf' }), entry(2, 'lobo', { pos: 'N' })], []);
    expect(p.creates).toEqual([{ form: 'lobo', metadata: { gloss: 'wolf', pos: 'N' } }]);
    expect(p.updates).toEqual([]);
    expect(p.decisions[1].action).toBe('update');
  });

  it('keeps a second sense in the same file distinct from the first', () => {
    const p = plan([entry(1, 'kap', { gloss: 'hand' }), entry(2, 'kap', { gloss: 'head' })], [], {
      strategies: { conflict: CONFLICT_NEW },
    });
    expect(p.creates).toEqual([
      { form: 'kap', metadata: { gloss: 'hand' } },
      { form: 'kap', metadata: { gloss: 'head' } },
    ]);
  });

  it('matches forms across NFC/NFD spellings of the same diacritics', () => {
    const decomposed = 'nan\u0303a'; // n + combining tilde
    const composed = 'na\u00f1a'; // precomposed ñ
    const p = plan(
      [entry(1, decomposed, { pos: 'N' })],
      [{ id: 'x', form: composed, metadata: { gloss: 'thing' } }],
    );
    expect(p.counts.enrich).toBe(1);
    expect(p.updates).toEqual([{ id: 'x', patch: { pos: 'N' } }]);
  });

  it('is case-sensitive by default and case-insensitive on request', () => {
    const items = [{ id: 'x', form: 'Perro', metadata: { gloss: 'dog' } }];
    expect(plan([entry(1, 'perro', { gloss: 'dog' })], items).counts.new).toBe(1);
    expect(
      plan([entry(1, 'perro', { gloss: 'dog' })], items, { caseInsensitive: true }).counts
        .identical,
    ).toBe(1);
  });

  it('stores the form as typed rather than imposing NFC', () => {
    const decomposed = 'nan\u0303a';
    const p = plan([entry(1, ` ${decomposed} `)], []);
    expect(p.creates[0].form).toBe(decomposed);
  });

  it('counts and skips rows with no form', () => {
    const p = plan([entry(1, '', { gloss: 'orphan' }), entry(2, 'lobo')], []);
    expect(p.counts.blank).toBe(1);
    expect(p.creates).toEqual([{ form: 'lobo', metadata: {} }]);
  });
});

describe('decision detail for review', () => {
  const existing = [
    { id: 'i1', form: 'perro', metadata: { gloss: 'dog' } },
    { id: 'i2', form: 'gato', metadata: { gloss: 'cat', pos: 'N' } },
  ];

  it('reports an addition with an empty from side', () => {
    const p = plan([entry(1, 'perro', { pos: 'N' })], existing);
    expect(p.decisions[0].changes).toEqual([{ field: 'pos', from: '', to: 'N' }]);
    expect(describeChange(p.decisions[0].changes[0])).toBe('pos: N');
  });

  it('reports a disagreement with both sides, so a reviewer can judge it', () => {
    const p = plan([entry(1, 'gato', { gloss: 'wildcat', definition: 'felis' })], existing);
    expect(p.decisions[0]).toMatchObject({ kind: 'conflict', targetId: 'i2', targetForm: 'gato' });
    expect(p.decisions[0].changes).toEqual([
      { field: 'gloss', from: 'cat', to: 'wildcat' },
      { field: 'definition', from: '', to: 'felis' },
    ]);
    expect(p.decisions[0].changes.map(describeChange)).toEqual([
      'gloss: cat > wildcat',
      'definition: felis',
    ]);
  });

  it('gives a new row its values as additions and no target', () => {
    const p = plan([entry(1, 'lobo', { gloss: 'wolf' })], existing);
    expect(p.decisions[0]).toMatchObject({ kind: 'new', targetId: null, candidates: 0 });
    expect(p.decisions[0].changes).toEqual([{ field: 'gloss', from: '', to: 'wolf' }]);
  });

  it('counts the candidates sharing the form', () => {
    const homonyms = [
      { id: 'a', form: 'kap', metadata: { gloss: 'hand' } },
      { id: 'b', form: 'kap', metadata: { gloss: 'head' } },
    ];
    const p = plan([entry(1, 'kap', { pos: 'N' })], homonyms);
    expect(p.decisions[0]).toMatchObject({ kind: 'ambiguous', candidates: 2 });
  });

  it('names the matched entry even when case-insensitive matching found it', () => {
    const p = plan(
      [entry(1, 'perro', { pos: 'N' })],
      [{ id: 'x', form: 'Perro', metadata: { gloss: 'dog' } }],
      { caseInsensitive: true },
    );
    expect(p.decisions[0].targetForm).toBe('Perro');
  });

  it('reports nothing to change for an identical row', () => {
    const p = plan([entry(1, 'gato', { gloss: 'cat' })], existing);
    expect(p.decisions[0].changes).toEqual([]);
  });
});

describe('matched entries on a decision', () => {
  const homonyms = [
    { id: 'a', form: 'kan', metadata: { gloss: 'house', pos: 'N' } },
    { id: 'b', form: 'kan', metadata: { gloss: 'mouth', pos: 'N' } },
  ];

  it('carries every entry sharing the form, so a reviewer can see them', () => {
    const p = plan([entry(1, 'kan', { definition: 'an opening' })], homonyms);
    expect(p.decisions[0].kind).toBe('ambiguous');
    expect(p.decisions[0].matches).toEqual([
      {
        form: 'kan',
        values: { gloss: 'house', pos: 'N' },
        pending: false,
        target: false,
        canTarget: true,
      },
      {
        form: 'kan',
        values: { gloss: 'mouth', pos: 'N' },
        pending: false,
        target: false,
        canTarget: true,
      },
    ]);
  });

  it('marks which entry an enrichment would change', () => {
    const p = plan([entry(1, 'kan', { gloss: 'mouth', definition: 'an opening' })], homonyms);
    expect(p.decisions[0].matches.map((m) => m.target)).toEqual([false, true]);
  });

  it('flags a match this same import is creating', () => {
    const p = plan([entry(1, 'yalu', { gloss: 'fire' }), entry(2, 'yalu', { gloss: 'wood' })], []);
    expect(p.decisions[1]).toMatchObject({ kind: 'conflict' });
    expect(p.decisions[1].matches).toEqual([
      { form: 'yalu', values: { gloss: 'fire' }, pending: true, target: true, canTarget: true },
    ]);
  });

  it('freezes match values before later rows fill them in', () => {
    const items = [{ id: 'a', form: 'tuk', metadata: { gloss: 'see' } }];
    const p = plan(
      [entry(1, 'tuk', { pos: 'V' }), entry(2, 'tuk', { definition: 'to see' })],
      items,
    );
    // The first row's snapshot must not show the pos it is itself adding.
    expect(p.decisions[0].matches[0].values).toEqual({ gloss: 'see' });
    expect(p.decisions[1].matches[0].values).toEqual({ gloss: 'see', pos: 'V' });
  });

  it('carries the row own values for display', () => {
    const p = plan([entry(1, 'kan', { definition: 'an opening' })], homonyms);
    expect(p.decisions[0].values).toEqual({ definition: 'an opening' });
  });
});

describe('naming which entry an answer targets', () => {
  const homonyms = [
    { id: 'k1', form: 'kan', metadata: { gloss: 'house', pos: 'N' } },
    { id: 'k2', form: 'kan', metadata: { gloss: 'mouth', pos: 'N' } },
  ];

  it('expands the entry the answer names, out of several sharing the form', () => {
    const row = [entry(1, 'kan', { definition: 'an opening' })];
    expect(plan(row, homonyms).counts.ambiguous).toBe(1);
    expect(plan(row, homonyms, { overrides: { 1: targetedAnswer('fill', 1) } }).updates).toEqual([
      { id: 'k2', patch: { definition: 'an opening' } },
    ]);
    expect(plan(row, homonyms, { overrides: { 1: targetedAnswer('fill', 0) } }).updates).toEqual([
      { id: 'k1', patch: { definition: 'an opening' } },
    ]);
  });

  it('replaces the entry the answer names, out of several sharing the form', () => {
    const p = plan([entry(1, 'kan', { gloss: 'foot' })], homonyms, {
      overrides: { 1: targetedAnswer('overwrite', 1) },
    });
    expect(p.updates).toEqual([{ id: 'k2', patch: { gloss: 'foot' } }]);
    expect(p.decisions[0]).toMatchObject({ kind: 'conflict', action: 'update' });
  });

  it('marks the named entry so the comparison can point at it', () => {
    const p = plan([entry(1, 'kan', { definition: 'an opening' })], homonyms, {
      overrides: { 1: targetedAnswer('fill', 1) },
    });
    expect(p.decisions[0].matches.map((m) => m.target)).toEqual([false, true]);
  });

  it('will not offer an entry the row contradicts as a target', () => {
    const three = [
      { id: 'a', form: 'kan', metadata: { pos: 'N' } },
      { id: 'b', form: 'kan', metadata: { pos: 'N' } },
      { id: 'c', form: 'kan', metadata: { gloss: 'hand', pos: 'N' } },
    ];
    // The row fits the first two, which have no gloss, and contradicts the
    // third, so only the first two can receive it.
    const p = plan([entry(1, 'kan', { gloss: 'foot' })], three);
    expect(p.decisions[0].kind).toBe('ambiguous');
    expect(p.decisions[0].matches.map((m) => m.canTarget)).toEqual([true, true, false]);
    expect(
      plan([entry(1, 'kan', { gloss: 'foot' })], three, {
        overrides: { 1: targetedAnswer('fill', 2) },
      }).updates,
    ).toEqual([]);
  });

  it('ignores a target that is out of range', () => {
    const p = plan([entry(1, 'kan', { definition: 'an opening' })], homonyms, {
      overrides: { 1: targetedAnswer('fill', 9) },
    });
    expect(p.updates).toEqual([]);
    expect(p.decisions[0].action).toBe('skip');
  });

  it('ignores a target naming a policy the classification does not take', () => {
    const p = plan([entry(1, 'kan', { definition: 'an opening' })], homonyms, {
      overrides: { 1: targetedAnswer('overwrite', 1) },
    });
    expect(p.updates).toEqual([]);
  });
});

describe('per-row overrides', () => {
  const existing = [{ id: 'i2', form: 'gato', metadata: { gloss: 'cat', pos: 'N' } }];
  const rows = [entry(1, 'gato', { gloss: 'wildcat' }), entry(2, 'gato', { gloss: 'stray' })];

  it('lets one conflicting row be added while its bucket stays on skip', () => {
    const p = plan(rows, existing, { overrides: { 1: 'new' } });
    expect(p.creates).toEqual([{ form: 'gato', metadata: { gloss: 'wildcat' } }]);
    expect(p.decisions[0].action).toBe('create');
    expect(p.decisions[1].action).toBe('skip');
  });

  it('lets one row be skipped while its bucket adds the rest', () => {
    const p = plan(rows, existing, {
      strategies: { conflict: 'new' },
      overrides: { 2: CONFLICT_SKIP },
    });
    expect(p.creates).toEqual([{ form: 'gato', metadata: { gloss: 'wildcat' } }]);
    expect(p.decisions[1].action).toBe('skip');
  });

  it('overrides one enrichment without touching the others', () => {
    const items = [
      { id: 'a', form: 'perro', metadata: { gloss: 'dog' } },
      { id: 'b', form: 'lobo', metadata: { gloss: 'wolf' } },
    ];
    const p = plan([entry(1, 'perro', { pos: 'N' }), entry(2, 'lobo', { pos: 'N' })], items, {
      overrides: { 1: 'skip' },
    });
    expect(p.updates).toEqual([{ id: 'b', patch: { pos: 'N' } }]);
  });

  it('ignores an override that is meaningless for how the row classified', () => {
    // 'overwrite' is a conflict answer; this row came out as an enrichment.
    const p = plan(
      [entry(1, 'perro', { pos: 'N' })],
      [{ id: 'a', form: 'perro', metadata: { gloss: 'dog' } }],
      { overrides: { 1: 'overwrite' } },
    );
    expect(p.updates).toEqual([{ id: 'a', patch: { pos: 'N' } }]);
  });

  it('exposes the valid answers per classification', () => {
    expect(OVERRIDE_VALUES.enrich).toContain(ENRICH_FILL);
    expect(OVERRIDE_VALUES.ambiguous).toEqual([AMBIGUOUS_SKIP, 'new']);
    expect(OVERRIDE_VALUES.new).toBeUndefined();
  });
});

describe('serializeImportReport', () => {
  it('emits one line per decision with its outcome', () => {
    const p = plan(
      [entry(1, 'lobo', { gloss: 'wolf' }), entry(2, 'perro', { pos: 'N' })],
      [{ id: 'i1', form: 'perro', metadata: { gloss: 'dog' } }],
    );
    expect(serializeImportReport(p.decisions).split('\n')).toEqual([
      'Line\tForm\tOutcome\tWhy\tValues',
      '1\tlobo\tAdded\tnew entry\tgloss: wolf',
      '2\tperro\tExpanded\tadds pos\tpos: N',
      '',
    ]);
  });
});

describe('makeValueNormalizer', () => {
  const closed = { delimiters: '', mode: 'closed', values: [{ value: 'n' }, { value: 'v' }] };
  const tagsetFor = (field) => (field === 'pos' ? closed : null);

  it('maps a morph type to the inventory spelling and rejects an unknown one', () => {
    const normalize = makeValueNormalizer();
    expect(normalize('morphType', 'Suffix')).toBe('suffix');
    expect(normalizeMorphType('MWE')).toBe('phrase');
    expect(normalize('morphType', 'thing')).toBe('');
  });

  it('rejects a value a closed tagset refuses, and leaves ungoverned fields alone', () => {
    const normalize = makeValueNormalizer(tagsetFor);
    expect(normalize('pos', 'n')).toBe('n');
    expect(normalize('pos', 'noun')).toBe('');
    expect(normalize('gloss', 'anything at all')).toBe('anything at all');
  });

  it('lets a suggesting tagset through: that is what suggesting is for', () => {
    const normalize = makeValueNormalizer(() => ({ ...closed, mode: 'suggest' }));
    expect(normalize('pos', 'noun')).toBe('noun');
  });

  it('reports rejections per entry, and rejectedFields names the fields once each', () => {
    const rows = [
      { line: 1, cells: ['perro', 'dog', 'noun'] },
      { line: 2, cells: ['gato', 'cat', 'n'] },
      { line: 3, cells: ['casa', 'house', 'noun'] },
    ];
    const entries = rowsToEntries(rows, [FORM, 'gloss', 'pos'], {
      normalizeValue: makeValueNormalizer(tagsetFor),
    });
    expect(entries[0]).toMatchObject({
      values: { gloss: 'dog' },
      rejected: [{ field: 'pos', value: 'noun' }],
    });
    expect(entries[1].values).toEqual({ gloss: 'cat', pos: 'n' });
    expect(rejectedFields(entries)).toEqual(['pos']);
  });
});
