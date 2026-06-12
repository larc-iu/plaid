import { describe, it, expect } from 'vitest';
import {
  isUnanalyzedWord, extractAnalysis, analysisSignature, tallyAnalyses,
  mergeTallies, buildAnalysisTable, resolveAnalysisForForm, filterAnalysis,
  computeAnalysisCopyProposals, rankSourceDocs,
} from './analysisMemory.js';

const MACHINE = { prov: 'inferred', provSource: 'rule:test' };
const VERIFIED = { ...MACHINE, provConfirmed: true };

// Derived-token builders mirroring derive.js output shapes.
const morph = ({ id = 'm', form, content = '', morphType = null, vocabItem = null, annotations = {}, prov = null } = {}) => ({
  id,
  content,
  metadata: {
    ...(form != null ? { form } : {}),
    ...(morphType != null ? { morphType } : {}),
    ...(prov || {}),
  },
  annotations,
  vocabItem,
});
const word = ({ id = 'w', content, vocabItem = null, annotations = {}, morphemes = null } = {}) => ({
  id,
  content,
  vocabItem,
  annotations,
  morphemes: morphemes ?? [morph({ content })],
});
const span = (value, metadata = null) => ({ id: `s-${value}`, value, ...(metadata ? { metadata } : {}) });
const link = (id, prov = 'human') => ({ id, linkId: `l-${id}`, prov });
const sentences = (...tokens) => [{ tokens }];

describe('isUnanalyzedWord', () => {
  it('accepts the healed default state and rejects any sign of work', () => {
    expect(isUnanalyzedWord(word({ content: 'perro' }))).toBe(true);
    // form equal to the surface is still "default"
    expect(isUnanalyzedWord(word({ content: 'perro', morphemes: [morph({ form: 'perro', content: 'perro' })] }))).toBe(true);

    expect(isUnanalyzedWord(word({ content: 'perro', vocabItem: link('i1') }))).toBe(false);
    expect(isUnanalyzedWord(word({ content: 'perro', annotations: { Gloss: span('dog') } }))).toBe(false);
    expect(isUnanalyzedWord(word({ content: 'perro', morphemes: [morph({ form: 'perr' }), morph({ form: 'o' })] }))).toBe(false);
    expect(isUnanalyzedWord(word({ content: 'perro', morphemes: [morph({ form: 'perr', content: 'perro' })] }))).toBe(false);
    expect(isUnanalyzedWord(word({ content: 'perro', morphemes: [morph({ content: 'perro', morphType: 'stem' })] }))).toBe(false);
    expect(isUnanalyzedWord(word({ content: 'perro', morphemes: [morph({ content: 'perro', annotations: { Gloss: span('dog') } })] }))).toBe(false);
    // empty-value spans don't count as work
    expect(isUnanalyzedWord(word({ content: 'perro', annotations: { Gloss: span('') } }))).toBe(true);
  });

  it('never targets ignored tokens', () => {
    const cfg = { type: 'unicodePunctuation', whitelist: [] };
    expect(isUnanalyzedWord(word({ content: '…' }), cfg)).toBe(false);
  });
});

describe('extractAnalysis', () => {
  const analyzed = () => word({
    content: 'perros',
    morphemes: [
      morph({ id: 'm1', form: 'perr', morphType: 'stem', vocabItem: link('i-perro'), annotations: { Gloss: span('dog') } }),
      morph({ id: 'm2', form: 'os', morphType: 'suffix', annotations: { Gloss: span('PL') } }),
    ],
  });

  it('captures segmentation, links, and values', () => {
    const a = extractAnalysis(analyzed());
    expect(a.morphemes).toHaveLength(2);
    expect(a.morphemes[0]).toEqual({ form: 'perr', morphType: 'stem', vocabItemId: 'i-perro', fields: { Gloss: 'dog' } });
    expect(a.morphemes[1]).toEqual({ form: 'os', morphType: 'suffix', vocabItemId: null, fields: { Gloss: 'PL' } });
  });

  it('returns null for unanalyzed words', () => {
    expect(extractAnalysis(word({ content: 'perro' }))).toBe(null);
  });

  it('excludes pure machine-unverified sources but keeps any human/verified touch', () => {
    const pureMachine = word({
      content: 'perros',
      morphemes: [
        morph({ id: 'm1', form: 'perr', prov: MACHINE, vocabItem: link('i-perro', 'machine'), annotations: { Gloss: span('dog', MACHINE) } }),
        morph({ id: 'm2', form: 'os', prov: MACHINE, annotations: { Gloss: span('PL', MACHINE) } }),
      ],
    });
    expect(extractAnalysis(pureMachine)).toBe(null);

    const oneVerified = word({
      content: 'perros',
      morphemes: [
        morph({ id: 'm1', form: 'perr', prov: MACHINE, vocabItem: link('i-perro', 'machine'), annotations: { Gloss: span('dog', VERIFIED) } }),
        morph({ id: 'm2', form: 'os', prov: MACHINE, annotations: { Gloss: span('PL', MACHINE) } }),
      ],
    });
    expect(extractAnalysis(oneVerified)).not.toBe(null);
  });

  it('segmentation-only human work counts via the morpheme tokens', () => {
    const handSegmented = word({
      content: 'perros',
      morphemes: [morph({ id: 'm1', form: 'perr' }), morph({ id: 'm2', form: 'os' })],
    });
    expect(extractAnalysis(handSegmented)).not.toBe(null);

    const machineSegmented = word({
      content: 'perros',
      morphemes: [morph({ id: 'm1', form: 'perr', prov: MACHINE }), morph({ id: 'm2', form: 'os', prov: MACHINE })],
    });
    expect(extractAnalysis(machineSegmented)).toBe(null);
  });
});

describe('tally + majority + resolution', () => {
  const seg = (g1, g2) => word({
    content: 'perros',
    morphemes: [
      morph({ id: 'm1', form: 'perr', annotations: { Gloss: span(g1) } }),
      morph({ id: 'm2', form: 'os', annotations: { Gloss: span(g2) } }),
    ],
  });

  it('strict majority wins; ties are contested and resolve to null', () => {
    const tally = tallyAnalyses(new Map(), sentences(seg('dog', 'PL'), seg('dog', 'PL'), seg('hound', 'PL')));
    const table = buildAnalysisTable(tally);
    expect(resolveAnalysisForForm('perros', table).morphemes[0].fields.Gloss).toBe('dog');

    const tied = tallyAnalyses(new Map(), sentences(seg('dog', 'PL'), seg('hound', 'PL')));
    expect(resolveAnalysisForForm('perros', buildAnalysisTable(tied))).toBe(null);
  });

  it('a single occurrence is a strict majority', () => {
    const table = buildAnalysisTable(tallyAnalyses(new Map(), sentences(seg('dog', 'PL'))));
    expect(resolveAnalysisForForm('perros', table)).not.toBe(null);
  });

  it('merges per-document tallies and falls back to casefold', () => {
    const a = tallyAnalyses(new Map(), sentences(seg('dog', 'PL')));
    const b = tallyAnalyses(new Map(), sentences(seg('dog', 'PL'), seg('hound', 'PL')));
    const table = buildAnalysisTable(mergeTallies(a, b));
    expect(resolveAnalysisForForm('perros', table).morphemes[0].fields.Gloss).toBe('dog'); // 2 > 1
    expect(resolveAnalysisForForm('Perros', table)).not.toBe(null); // casefold tier
    expect(resolveAnalysisForForm('gatos', table)).toBe(null);
  });

  it('signatures are key-order independent', () => {
    const a1 = { word: { vocabItemId: null, fields: { A: '1', B: '2' } }, morphemes: [] };
    const a2 = { word: { vocabItemId: null, fields: { B: '2', A: '1' } }, morphemes: [] };
    expect(analysisSignature(a1)).toBe(analysisSignature(a2));
  });
});

describe('filterAnalysis', () => {
  const full = {
    word: { vocabItemId: 'i-w', fields: { Note: 'n' } },
    morphemes: [
      { form: 'perr', morphType: 'stem', vocabItemId: 'i-perro', fields: { Gloss: 'dog' } },
      { form: 'os', morphType: 'suffix', vocabItemId: null, fields: { Gloss: 'PL' } },
    ],
  };

  it('passes everything through by default', () => {
    expect(filterAnalysis(full)).toEqual(full);
  });

  it('strips links and fields independently', () => {
    const noLinks = filterAnalysis(full, { links: false });
    expect(noLinks.word.vocabItemId).toBe(null);
    expect(noLinks.morphemes[0].vocabItemId).toBe(null);
    expect(noLinks.morphemes[0].fields.Gloss).toBe('dog');

    const noFields = filterAnalysis(full, { fields: false });
    expect(noFields.morphemes[0].fields).toEqual({});
    expect(noFields.morphemes[0].vocabItemId).toBe('i-perro');
  });

  it('without segmentation, multi-morpheme analyses keep only word-level parts', () => {
    const f = filterAnalysis(full, { segmentation: false });
    expect(f.morphemes).toEqual([]);
    expect(f.word.vocabItemId).toBe('i-w');

    const nothingLeft = filterAnalysis(
      { word: { vocabItemId: null, fields: {} }, morphemes: full.morphemes },
      { segmentation: false },
    );
    expect(nothingLeft).toBe(null);
  });

  it('without segmentation, a single morpheme survives as a carrier without form/type', () => {
    const single = {
      word: { vocabItemId: null, fields: {} },
      morphemes: [{ form: 'perro', morphType: 'stem', vocabItemId: 'i-perro', fields: { Gloss: 'dog' } }],
    };
    const f = filterAnalysis(single, { segmentation: false });
    expect(f.morphemes[0]).toEqual({ form: null, morphType: null, vocabItemId: 'i-perro', fields: { Gloss: 'dog' } });
  });
});

describe('computeAnalysisCopyProposals', () => {
  it('proposes only for unanalyzed words with an uncontested analysis', () => {
    const source = word({
      id: 'w-src',
      content: 'perros',
      morphemes: [
        morph({ id: 'm1', form: 'perr', annotations: { Gloss: span('dog') } }),
        morph({ id: 'm2', form: 'os', annotations: { Gloss: span('PL') } }),
      ],
    });
    const table = buildAnalysisTable(tallyAnalyses(new Map(), sentences(source)));
    const targets = sentences(
      word({ id: 'w1', content: 'perros' }),               // eligible
      word({ id: 'w2', content: 'Perros' }),               // casefold eligible
      word({ id: 'w3', content: 'perros', vocabItem: link('x') }), // already worked on
      word({ id: 'w4', content: 'gatos' }),                // no precedent
    );
    const proposals = computeAnalysisCopyProposals({ sentences: targets, table });
    expect(proposals.map((p) => p.wordTokenId)).toEqual(['w1', 'w2']);
    expect(proposals[0].analysis.morphemes).toHaveLength(2);
  });
});

describe('rankSourceDocs', () => {
  it('filters to matching forms (casefolded too), excludes the open doc, ranks and caps', () => {
    const result = { results: [
      ['d1', 'perros', 5],
      ['d1', 'gatos', 9],     // not a target form
      ['d2', 'Perros', 2],    // casefold match
      ['d3', 'perros', 3],
      ['d-self', 'perros', 99],
    ] };
    const { docIds, truncated } = rankSourceDocs(result, new Set(['perros']), { excludeDocId: 'd-self', maxDocs: 2 });
    expect(docIds).toEqual(['d1', 'd3']);
    expect(truncated).toBe(true);
  });
});
