import { describe, it, expect } from 'vitest';
import {
  precedentGuessSource,
  vocabEntryGuessSource,
  defaultGuessSource,
  listAlternatives,
  allowedGuess,
  PRECEDENT_SOURCE,
  TAGSET_SOURCE,
} from './glossGuess.js';
import { addPrecedent, createTally, foldDocumentValues } from './precedent.js';

const sent = (tokens) => [{ tokens }];
const word = (content, annotations = {}, morphemes = []) => ({
  content,
  annotations: Object.fromEntries(Object.entries(annotations).map(([k, v]) => [k, { value: v }])),
  morphemes,
});
const morph = (form, annotations = {}, metadata = null) => ({
  metadata: { form },
  annotations: Object.fromEntries(
    Object.entries(annotations).map(([k, v]) => [k, { value: v, metadata }]),
  ),
});
// The editor's tally for a document with these fields.
const tallyOf = (sentences, fields) => foldDocumentValues(createTally(), sentences, fields);

describe('precedentGuessSource', () => {
  it('guesses the value used by same-form morphemes', () => {
    const g = precedentGuessSource(
      tallyOf(
        sent([word('perros', {}, [morph('perro', { Gloss: 'dog' }), morph('s', { Gloss: 'PL' })])]),
        { morphFields: ['Gloss'] },
      ),
    );
    expect(g.guessFor('morpheme', 's', 'Gloss')).toEqual({
      value: 'PL',
      source: PRECEDENT_SOURCE,
      count: 1,
    });
    expect(g.guessFor('morpheme', 'perro', 'Gloss')).toEqual({
      value: 'dog',
      source: PRECEDENT_SOURCE,
      count: 1,
    });
    expect(g.guessFor('morpheme', 'gato', 'Gloss')).toBeNull();
  });

  it('picks the most frequent value and refuses ties', () => {
    const g = precedentGuessSource(
      tallyOf(
        sent([
          word('a', {}, [
            morph('s', { Gloss: 'PL' }),
            morph('s', { Gloss: 'PL' }),
            morph('s', { Gloss: '3SG' }),
          ]),
          word('b', {}, [morph('la', { Gloss: 'DEF' }), morph('la', { Gloss: '3SG.F' })]),
        ]),
        { morphFields: ['Gloss'] },
      ),
    );
    expect(g.guessFor('morpheme', 's', 'Gloss')?.value).toBe('PL'); // 2 vs 1
    expect(g.guessFor('morpheme', 'la', 'Gloss')).toBeNull(); // 1 vs 1 tie
  });

  it('keeps word and morpheme namespaces separate and skips empty values', () => {
    const g = precedentGuessSource(
      tallyOf(
        sent([
          word('se', { POS: 'PRON' }, [morph('se', { Gloss: '' })]),
          word('se', { POS: 'PRON' }),
        ]),
        { wordFields: ['POS'], morphFields: ['Gloss'] },
      ),
    );
    expect(g.guessFor('word', 'se', 'POS')?.value).toBe('PRON');
    expect(g.guessFor('morpheme', 'se', 'Gloss')).toBeNull(); // empty value never counted
    expect(g.guessFor('morpheme', 'se', 'POS')).toBeNull(); // kind-scoped
  });

  it('guesses from unverified machine-made values too (adopting is a human act, ruling A1-11)', () => {
    const machine = { prov: 'inferred', provSource: 'service:x' };
    const verified = { ...machine, provConfirmed: true };
    const g = precedentGuessSource(
      tallyOf(
        sent([
          word('a', {}, [
            morph('s', { Gloss: 'PL' }, machine),
            morph('s', { Gloss: 'PL' }, machine),
          ]),
          word('b', {}, [morph('la', { Gloss: 'DEF' }, verified)]),
        ]),
        { morphFields: ['Gloss'] },
      ),
    );
    expect(g.guessFor('morpheme', 's', 'Gloss')?.value).toBe('PL');
    expect(g.guessFor('morpheme', 'la', 'Gloss')?.value).toBe('DEF');
  });
});

describe('vocabEntryGuessSource', () => {
  const g = vocabEntryGuessSource();
  const ctx = (metadata, lexiconField = 'gloss') => ({ vocabItem: { metadata }, lexiconField });

  it("offers the linked entry's value for the field's Lexicon field", () => {
    expect(g.guessFor('morpheme', 'perro', 'Gloss', ctx({ gloss: 'dog' }))).toEqual({
      value: 'dog',
      source: 'vocab:entry',
      entryForm: null,
      trusted: true,
    });
    expect(g.guessFor('word', 'perro', 'POS', ctx({ pos: 'N' }, 'pos'))?.value).toBe('N');
  });

  it('reads the record and never the name', () => {
    // A field paired with an entry field of another name.
    const meta = { gloss: 'rumah', 'gloss (en)': 'house', meaning: 'home' };
    expect(g.guessFor('morpheme', 'x', 'Glosa', ctx(meta, 'meaning'))?.value).toBe('home');
    expect(g.guessFor('morpheme', 'x', 'Gloss (pmy)', ctx(meta, 'gloss (en)'))?.value).toBe(
      'house',
    );
    // A field named Gloss with no Lexicon field takes nothing from the entry.
    expect(g.guessFor('morpheme', 'x', 'Gloss', ctx(meta, null))).toBeNull();
  });

  it('has no opinion for unlinked tokens, an entry without the field, or blank values', () => {
    const unlinked = { vocabItem: null, lexiconField: 'gloss' };
    expect(g.guessFor('morpheme', 'perro', 'Gloss', unlinked)).toBeNull();
    expect(g.guessFor('morpheme', 'perro', 'Gloss', ctx({ pos: 'N' }))).toBeNull();
    expect(g.guessFor('morpheme', 'perro', 'Gloss', ctx({ gloss: '  ' }))).toBeNull();
  });
});

describe('defaultGuessSource', () => {
  it('prefers the linked entry over precedent, and falls back to it', () => {
    const g = defaultGuessSource({
      precedent: tallyOf(
        sent([
          word('perros', {}, [morph('perro', { Gloss: 'hound' }), morph('s', { Gloss: 'PL' })]),
        ]),
        { morphFields: ['Gloss'] },
      ),
    });
    const item = { metadata: { gloss: 'dog' } };
    const at = (vocabItem) => ({ vocabItem, lexiconField: 'gloss' });
    expect(g.guessFor('morpheme', 'perro', 'Gloss', at(item))?.value).toBe('dog');
    expect(g.guessFor('morpheme', 'perro', 'Gloss', at(null))?.value).toBe('hound');
    expect(g.guessFor('morpheme', 's', 'Gloss', at({ metadata: {} }))).toEqual({
      value: 'PL',
      source: PRECEDENT_SOURCE,
      count: 1,
    });
  });

  it("sits precedent between a person's link and an unconfirmed auto-link", () => {
    const g = defaultGuessSource({
      precedent: tallyOf(
        sent([
          word('perros', {}, [morph('perro', { Gloss: 'hound' }), morph('s', { Gloss: 'PL' })]),
        ]),
        { morphFields: ['Gloss'] },
      ),
    });
    const entry = { form: 'perro', metadata: { gloss: 'dog' } };
    const guess = (prov) =>
      g.guessFor('morpheme', 'perro', 'Gloss', {
        vocabItem: { ...entry, prov },
        lexiconField: 'gloss',
      });

    // A person made or confirmed the link: the entry is a claim about THIS
    // token and outranks what other tokens spelled the same were given.
    expect(guess('human')?.value).toBe('dog');
    expect(guess('verified')?.value).toBe('dog');
    // The link is itself an unconfirmed machine guess, so precedent wins.
    expect(guess('machine')?.value).toBe('hound');
    expect(guess('contributed')?.value).toBe('hound');
    // ...but the entry is still better than nothing where precedent is silent.
    expect(
      g.guessFor('morpheme', 'gato', 'Gloss', {
        vocabItem: { ...entry, prov: 'machine' },
        lexiconField: 'gloss',
      }),
    ).toMatchObject({ value: 'dog', source: 'vocab:entry', trusted: false });
  });

  it('reports the entry form and the link standing for the cell to show', () => {
    const g = defaultGuessSource({ precedent: createTally() });
    expect(
      g.guessFor('morpheme', 'perro', 'Gloss', {
        vocabItem: { form: 'perro', prov: 'human', metadata: { gloss: 'dog' } },
        lexiconField: 'gloss',
      }),
    ).toEqual({ value: 'dog', source: 'vocab:entry', entryForm: 'perro', trusted: true });
  });
});

describe('listAlternatives', () => {
  const precedent = tallyOf(
    sent([
      word('a', {}, [
        morph('s', { Gloss: 'PL' }),
        morph('s', { Gloss: 'PL' }),
        morph('s', { Gloss: '3SG' }, { prov: 'inferred', provSource: 'service:x' }),
      ]),
    ]),
    { morphFields: ['Gloss'] },
  );

  it('merges precedent counts, the linked entry and the producer distribution, ranked', () => {
    const list = listAlternatives({
      precedent,
      kind: 'morpheme',
      form: 's',
      field: 'Gloss',
      vocabItem: { metadata: { gloss: '3SG' } },
      lexiconField: 'gloss',
      span: {
        metadata: {
          prov: 'inferred',
          provSource: 'service:x',
          provDetail: { value: 'PL', valueProbs: { PL: 0.7, GEN: 0.2, '3SG': 0.1 } },
        },
      },
    });
    // The entry's link is a person's (no prov on the item), so it leads —
    // the same order defaultGuessSource picks the placeholder in.
    expect(list.map((r) => [r.value, r.count, r.prob, r.entry, r.model, r.source])).toEqual([
      ['3SG', 1, 0.1, true, true, 'vocab:entry'],
      ['PL', 2, 0.7, false, true, PRECEDENT_SOURCE],
      ['GEN', 0, 0.2, false, true, 'service:x'],
    ]);
  });

  it('ranks an entry behind precedent when its link is an unconfirmed auto-link', () => {
    const rank = (prov) =>
      listAlternatives({
        precedent,
        kind: 'morpheme',
        form: 's',
        field: 'Gloss',
        vocabItem: { form: 's', prov, metadata: { gloss: 'GEN' } },
        lexiconField: 'gloss',
      }).map((r) => [r.value, r.entry, r.entryTrusted]);

    expect(rank('human')).toEqual([
      ['GEN', true, true],
      ['PL', false, false],
      ['3SG', false, false],
    ]);
    expect(rank('machine')).toEqual([
      ['PL', false, false],
      ['3SG', false, false],
      ['GEN', true, false],
    ]);
  });

  it("lists the entry value of the field's Lexicon field, and none without one", () => {
    const args = {
      precedent,
      kind: 'morpheme',
      form: 's',
      field: 'Gloss (pmy)',
      vocabItem: { metadata: { gloss: 'jamak', 'gloss (en)': 'PL' } },
    };
    const entryRows = (lexiconField) =>
      listAlternatives({ ...args, lexiconField })
        .filter((r) => r.entry)
        .map((r) => r.value);
    expect(entryRows('gloss')).toEqual(['jamak']);
    expect(entryRows('gloss (en)')).toEqual(['PL']);
    expect(entryRows(null)).toEqual([]);
  });

  it('is empty when nothing is known, and precedent alone ranks by count then name', () => {
    expect(listAlternatives({ precedent, kind: 'morpheme', form: 'zzz', field: 'Gloss' })).toEqual(
      [],
    );
    const t = tallyOf(
      sent([word('a', {}, [morph('la', { Gloss: 'DEF' }), morph('la', { Gloss: '3SG.F' })])]),
      { morphFields: ['Gloss'] },
    );
    expect(
      listAlternatives({ precedent: t, kind: 'morpheme', form: 'la', field: 'Gloss' }).map(
        (r) => r.value,
      ),
    ).toEqual(['3SG.F', 'DEF']);
  });
});

describe('listAlternatives with a tagset', () => {
  const tagset = (over = {}) => ({
    delimiters: '',
    mode: 'suggest',
    values: [{ value: 'PL', description: 'plural' }, { value: 'SG' }],
    ...over,
  });

  // "s" has been glossed PL twice and GEN once in this document.
  const precedent = tallyOf(
    sent([
      word('a', {}, [morph('s', { Gloss: 'PL' })]),
      word('b', {}, [morph('s', { Gloss: 'PL' })]),
      word('c', {}, [morph('s', { Gloss: 'GEN' })]),
    ]),
    { morphFields: ['Gloss'] },
  );
  const list = (over = {}) =>
    listAlternatives({ precedent, kind: 'morpheme', form: 's', field: 'Gloss', ...over });

  it('offers the tagset even where there is no precedent at all', () => {
    const rows = list({ form: 'zzz', tagset: tagset() });
    expect(rows.map((r) => [r.value, r.count, r.source])).toEqual([
      ['PL', 0, TAGSET_SOURCE],
      ['SG', 0, TAGSET_SOURCE],
    ]);
  });

  it('an attested tagset value keeps its count and picks up the description', () => {
    const rows = list({ tagset: tagset() });
    const pl = rows.find((r) => r.value === 'PL');
    expect([pl.count, pl.source, pl.description]).toEqual([2, PRECEDENT_SOURCE, 'plural']);
  });

  it('a SUGGESTED tagset still offers off-tagset precedent', () => {
    expect(list({ tagset: tagset() }).map((r) => r.value)).toEqual(['PL', 'GEN', 'SG']);
  });

  it('a CLOSED tagset drops off-tagset precedent, since committing it would fail', () => {
    expect(list({ tagset: tagset({ mode: 'closed' }) }).map((r) => r.value)).toEqual(['PL', 'SG']);
  });

  it('delimiters switch the list to parts, pooling counts across whole values', () => {
    // 1SG.NOM twice and 1SG.ERG once: 1SG outranks either whole value.
    const t = tallyOf(
      sent([
        word('a', {}, [morph('m', { Gloss: '1SG.NOM' })]),
        word('b', {}, [morph('m', { Gloss: '1SG.NOM' })]),
        word('c', {}, [morph('m', { Gloss: '1SG.ERG' })]),
      ]),
      { morphFields: ['Gloss'] },
    );
    const rows = listAlternatives({
      precedent: t,
      kind: 'morpheme',
      form: 'm',
      field: 'Gloss',
      tagset: { delimiters: '.', mode: 'suggest', values: [] },
    });
    expect(rows.map((r) => [r.value, r.count])).toEqual([
      ['1SG', 3],
      ['NOM', 2],
      ['ERG', 1],
    ]);
  });

  it('a closed part-mode tagset keeps only its own parts', () => {
    const t = tallyOf(sent([word('a', {}, [morph('m', { Gloss: '1SG.ABL' })])]), {
      morphFields: ['Gloss'],
    });
    const rows = listAlternatives({
      precedent: t,
      kind: 'morpheme',
      form: 'm',
      field: 'Gloss',
      tagset: { delimiters: '.', mode: 'closed', values: [{ value: '1SG' }, { value: 'NOM' }] },
    });
    expect(rows.map((r) => [r.value, r.count])).toEqual([
      ['1SG', 1],
      ['NOM', 0],
    ]);
  });

  it('behaves exactly as before when there is no tagset', () => {
    expect(list().map((r) => [r.value, r.count])).toEqual([
      ['PL', 2],
      ['GEN', 1],
    ]);
  });
});

describe('allowedGuess', () => {
  const closed = { delimiters: '.', mode: 'closed', values: [{ value: 'PL' }] };

  it('passes a guess the tagset allows', () => {
    const g = { value: 'PL', source: PRECEDENT_SOURCE };
    expect(allowedGuess(g, closed)).toBe(g);
  });

  it('drops one it does not, so Enter never adopts what commit would reject', () => {
    expect(allowedGuess({ value: 'GEN', source: PRECEDENT_SOURCE }, closed)).toBeNull();
  });

  it('passes everything when the field has no tagset', () => {
    const g = { value: 'anything', source: PRECEDENT_SOURCE };
    expect(allowedGuess(g, null)).toBe(g);
  });
});

describe('decomposeRows counting', () => {
  it('counts a part once per occurrence, so PL.PL from 5 words is 10', () => {
    // Deliberate, not a rounding slip: the list ranks how often a part is
    // USED, and a value that uses it twice used it twice.
    const t = tallyOf(sent([word('a', {}, [morph('m', { Gloss: 'PL.PL' })])]), {
      morphFields: ['Gloss'],
    });
    const rows = listAlternatives({
      precedent: t,
      kind: 'morpheme',
      form: 'm',
      field: 'Gloss',
      tagset: { delimiters: '.', mode: 'suggest', values: [] },
    });
    expect(rows).toEqual([expect.objectContaining({ value: 'PL', count: 2 })]);
  });
});

describe('what a mixed tagset offers', () => {
  const mixed = { delimiters: '.', mode: 'mixed', values: [{ value: 'PRT' }, { value: 'RES' }] };
  const tallyWith = (pairs) => {
    const t = createTally();
    for (const [v, n] of pairs) addPrecedent(t, 'morpheme', 'f', 'Gloss', v, n);
    return t;
  };
  const offers = (pairs) =>
    listAlternatives({
      precedent: tallyWith(pairs),
      kind: 'morpheme',
      form: 'f',
      field: 'Gloss',
      tagset: mixed,
    }).map((r) => r.value);

  it('drops a one-off lexical value, which is nearly always a typo', () => {
    // RxES has a lowercase x, so mixed ACCEPTS it on commit. Offering it beside
    // RES forever is what makes the picker worse than useless.
    expect(
      offers([
        ['RES', 502],
        ['RxES', 1],
      ]),
    ).toEqual(['RES', 'PRT']);
  });

  it('offers a lexical value once it is established', () => {
    expect(offers([['dog', 12]])).toContain('dog');
  });

  it('never drops the tagset’s own values, whatever their count', () => {
    expect(offers([])).toEqual(['PRT', 'RES']);
  });

  it('keeps a model’s alternative it allows, used or not', () => {
    const span = {
      metadata: {
        prov: 'inferred',
        provSource: 'service:x',
        provDetail: { value: 'sell', valueProbs: { sell: 0.39, another: 0.3 } },
      },
    };
    const values = listAlternatives({
      precedent: tallyWith([]),
      kind: 'morpheme',
      form: 'f',
      field: 'Gloss',
      span,
      tagset: { mode: 'mixed', values: [{ value: 'PRT' }] },
    }).map((r) => r.value);
    expect(values).toEqual(expect.arrayContaining(['sell', 'another', 'PRT']));
  });
});

describe('the order of a model-glossed cell', () => {
  it('ranks the model’s alternatives by probability above project counts', () => {
    const t = createTally();
    addPrecedent(t, 'morpheme', 'xa', 'Gloss', 'be', 97);
    addPrecedent(t, 'morpheme', 'xa', 'Gloss', 'happened', 89);
    addPrecedent(t, 'morpheme', 'xa', 'Gloss', 'stray', 40);
    const span = {
      value: 'happened',
      metadata: {
        prov: 'inferred',
        provSource: 'service:x',
        provDetail: { value: 'happened', valueProbs: { happened: 0.57, be: 0.23 } },
      },
    };
    const values = listAlternatives({
      precedent: t,
      kind: 'morpheme',
      form: 'xa',
      field: 'Gloss',
      span,
    }).map((r) => r.value);
    expect(values).toEqual(['happened', 'be', 'stray']);
  });
});
