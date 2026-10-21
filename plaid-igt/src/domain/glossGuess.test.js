import { describe, it, expect } from 'vitest';
import {
  glossFollowingLink,
  linkFollowingGloss,
  modelSenses,
  precedentGuessSource,
  vocabEntryGuessSource,
  entryFieldFor,
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
  const ctx = (metadata) => ({ vocabItem: { metadata } });

  it("offers the linked entry's same-named field, matching across case and separators", () => {
    expect(g.guessFor('morpheme', 'perro', 'Gloss', ctx({ gloss: 'dog' }))).toEqual({
      value: 'dog',
      source: 'vocab:entry',
      entryForm: null,
      trusted: true,
    });
    expect(g.guessFor('word', 'perro', 'POS', ctx({ pos: 'N' }))?.value).toBe('N');
    expect(g.guessFor('word', 'x', 'Morph Type', ctx({ morphType: 'stem' }))?.value).toBe('stem');
  });

  it('has no opinion for unlinked tokens, unknown fields, or blank entry values', () => {
    expect(g.guessFor('morpheme', 'perro', 'Gloss', { vocabItem: null })).toBeNull();
    expect(g.guessFor('morpheme', 'perro', 'Gloss', ctx({ pos: 'N' }))).toBeNull();
    expect(g.guessFor('morpheme', 'perro', 'Gloss', ctx({ gloss: '  ' }))).toBeNull();
  });

  // A FieldWorks import in two analysis languages names the annotation fields
  // "Gloss (pmy)" and "Gloss (en)" but keeps the entry's built-in `gloss`,
  // recording its language in the lexicon's field schema.
  it('pairs a tagged field with the entry field in the same language', () => {
    const meta = { gloss: 'rumah', 'gloss (en)': 'house' };
    const entryFields = { gloss: { lang: 'pmy' }, 'gloss (en)': { lang: 'en' } };
    const withSchema = (fieldLang = null) => ({ ...ctx(meta), fieldLang, entryFields });
    expect(g.guessFor('morpheme', 'x', 'Gloss (pmy)', withSchema('pmy'))?.value).toBe('rumah');
    expect(g.guessFor('morpheme', 'x', 'Gloss (en)', withSchema('en'))?.value).toBe('house');
    // A field that records no language is read by its name's tag.
    expect(g.guessFor('morpheme', 'x', 'Gloss (pmy)', withSchema())?.value).toBe('rumah');
    // What a field records wins over its name.
    expect(g.guessFor('morpheme', 'x', 'Gloss (pmy)', withSchema('en'))?.value).toBe('house');
    // No schema, so nothing says the bare `gloss` is in pmy.
    expect(g.guessFor('morpheme', 'x', 'Gloss (pmy)', ctx(meta))).toBeNull();
    // A language nothing on the entry is in.
    expect(g.guessFor('morpheme', 'x', 'Gloss (nl)', withSchema('nl'))).toBeNull();
  });
});

describe('entryFieldFor', () => {
  it('takes the same name before the same language', () => {
    const meta = { gloss: 'a', 'gloss (pmy)': 'b' };
    const entryFields = { gloss: { lang: 'pmy' } };
    expect(entryFieldFor('Gloss (pmy)', meta, { fieldLang: 'pmy', entryFields })).toBe(
      'gloss (pmy)',
    );
    expect(entryFieldFor('Gloss', meta, { fieldLang: 'pmy', entryFields })).toBe('gloss');
  });

  it('never pairs across base names', () => {
    const meta = { definition: 'a' };
    const entryFields = { definition: { lang: 'pmy' } };
    expect(entryFieldFor('Gloss (pmy)', meta, { fieldLang: 'pmy', entryFields })).toBeNull();
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
    expect(g.guessFor('morpheme', 'perro', 'Gloss', { vocabItem: item })?.value).toBe('dog');
    expect(g.guessFor('morpheme', 'perro', 'Gloss', { vocabItem: null })?.value).toBe('hound');
    expect(g.guessFor('morpheme', 's', 'Gloss', { vocabItem: { metadata: {} } })).toEqual({
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
      g.guessFor('morpheme', 'perro', 'Gloss', { vocabItem: { ...entry, prov } });

    // A person made or confirmed the link: the entry is a claim about THIS
    // token and outranks what other tokens spelled the same were given.
    expect(guess('human')?.value).toBe('dog');
    expect(guess('verified')?.value).toBe('dog');
    // The link is itself an unconfirmed machine guess, so precedent wins.
    expect(guess('machine')?.value).toBe('hound');
    expect(guess('contributed')?.value).toBe('hound');
    // ...but the entry is still better than nothing where precedent is silent.
    expect(
      g.guessFor('morpheme', 'gato', 'Gloss', { vocabItem: { ...entry, prov: 'machine' } }),
    ).toMatchObject({ value: 'dog', source: 'vocab:entry', trusted: false });
  });

  it('reports the entry form and the link standing for the cell to show', () => {
    const g = defaultGuessSource({ precedent: createTally() });
    expect(
      g.guessFor('morpheme', 'perro', 'Gloss', {
        vocabItem: { form: 'perro', prov: 'human', metadata: { gloss: 'dog' } },
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

  it('lists the entry value of a tagged field in the same language', () => {
    const list = listAlternatives({
      precedent,
      kind: 'morpheme',
      form: 's',
      field: 'Gloss (pmy)',
      vocabItem: { metadata: { gloss: 'jamak', 'gloss (en)': 'PL' } },
      fieldLang: 'pmy',
      entryFields: { gloss: { lang: 'pmy' }, 'gloss (en)': { lang: 'en' } },
    });
    expect(list.filter((r) => r.entry).map((r) => r.value)).toEqual(['jamak']);
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

describe('linkFollowingGloss', () => {
  const span = {
    metadata: {
      prov: 'inferred',
      provSource: 'service:cwomp-analyzer',
      provDetail: {
        valueProbs: { TOP: 0.6, and: 0.3 },
        valueLinks: { TOP: 'i-top', and: 'i-and' },
      },
    },
  };
  const own = { id: 'i-top', prov: 'machine', provSource: 'service:cwomp-analyzer' };

  it("moves the producer's own unconfirmed link to the picked alternative's entry", () => {
    expect(linkFollowingGloss({ vocabItem: own }, span, 'and')).toEqual({
      itemId: 'i-and',
      source: 'service:cwomp-analyzer',
    });
    expect(linkFollowingGloss({ vocabItem: null }, span, 'and')?.itemId).toBe('i-and');
  });

  it('moves a link an earlier pick of an alternative made, for a verifier or a contributor', () => {
    const picked = { id: 'i-and', prov: 'verified', provSource: 'service:cwomp-analyzer' };
    expect(linkFollowingGloss({ vocabItem: picked }, span, 'TOP')?.itemId).toBe('i-top');
    const contributed = {
      id: 'i-and',
      prov: 'contributed',
      provSource: 'user:ann@x.com',
      provGuess: 'service:cwomp-analyzer',
    };
    expect(linkFollowingGloss({ vocabItem: contributed }, span, 'TOP')?.itemId).toBe('i-top');
  });

  it('takes the producer’s link off when the new gloss has no entry it knew', () => {
    expect(linkFollowingGloss({ vocabItem: own }, span, 'typed')).toEqual({
      itemId: null,
      source: 'service:cwomp-analyzer',
    });
    expect(linkFollowingGloss({ vocabItem: null }, span, 'typed')).toBeNull();
  });

  it('leaves a link that is not the producer’s to move', () => {
    expect(linkFollowingGloss({ vocabItem: own }, span, 'TOP')).toBeNull();
    expect(
      linkFollowingGloss({ vocabItem: { id: 'i-top', prov: 'human' } }, span, 'and'),
    ).toBeNull();
    // A person's verified link to an entry outside the alternatives.
    const elsewhere = { id: 'i-x', prov: 'verified', provSource: 'service:cwomp-analyzer' };
    expect(linkFollowingGloss({ vocabItem: elsewhere }, span, 'and')).toBeNull();
    const other = { ...own, provSource: 'rule:precedent-or-unique' };
    expect(linkFollowingGloss({ vocabItem: other }, span, 'and')).toBeNull();
    expect(linkFollowingGloss({ vocabItem: own }, { metadata: {} }, 'and')).toBeNull();
  });
});

describe('glossFollowingLink', () => {
  const gloss = (value, meta = {}) => ({
    value,
    metadata: {
      prov: 'inferred',
      provSource: 'service:x',
      provDetail: {
        value: 'sell',
        valueProbs: { sell: 0.39, another: 0.3, other: 0.19 },
        valueLinks: { sell: 'i-sell', another: 'i-another' },
      },
      ...meta,
    },
  });
  const morph = (value, meta) => ({
    annotations: { Gloss: gloss(value, meta), POS: { value: 'n' } },
  });

  it('lists the senses weighed, with the field that records them', () => {
    const m = modelSenses(morph('sell'));
    expect(m.field).toBe('Gloss');
    expect(m.senses).toEqual([
      { gloss: 'sell', itemId: 'i-sell', prob: 0.39 },
      { gloss: 'another', itemId: 'i-another', prob: 0.3 },
    ]);
    expect(modelSenses({ annotations: { POS: { value: 'n' } } })).toBeNull();
  });

  it('sets the gloss of the sense a link picks, while the gloss is one the model weighed', () => {
    expect(glossFollowingLink(morph('sell'), 'i-another')).toEqual({
      field: 'Gloss',
      value: 'another',
      source: 'service:x',
    });
    // A gloss a person confirmed or picked, still among the alternatives.
    expect(glossFollowingLink(morph('other', { provConfirmed: true }), 'i-sell')?.value).toBe(
      'sell',
    );
  });

  it('leaves the gloss when it is not one the model weighed, or nothing changes', () => {
    expect(glossFollowingLink(morph('typed by hand'), 'i-another')).toBeNull();
    expect(glossFollowingLink(morph('sell'), 'i-sell')).toBeNull();
    expect(glossFollowingLink(morph('sell'), 'i-unrelated')).toBeNull();
    expect(glossFollowingLink({ annotations: {} }, 'i-sell')).toBeNull();
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

describe('a link that names several of the glosses weighed', () => {
  it('leaves the gloss, since the link does not say which', () => {
    const morph = {
      annotations: {
        Gloss: {
          value: 'sell',
          metadata: {
            prov: 'inferred',
            provSource: 'service:x',
            provDetail: {
              valueProbs: { sell: 0.5, sold: 0.3, another: 0.2 },
              valueLinks: { sell: 'i-sell', sold: 'i-sell', another: 'i-another' },
            },
          },
        },
      },
    };
    expect(glossFollowingLink(morph, 'i-sell')).toBeNull();
    expect(glossFollowingLink(morph, 'i-another')?.value).toBe('another');
  });
});
