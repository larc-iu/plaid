import { describe, it, expect } from 'vitest';
import {
  buildLatexBook,
  chapterFileName,
  defaultLatexOptions,
  formatAbbreviations,
  formatChapter,
  formatExample,
  entryNumbers,
  exampleNumbersOf,
  formatVocabulary,
  latexLayout,
  latexSelection,
  latexVocabulary,
  linkedEntryIds,
  storedLatexVocabulary,
  notoFamilyFor,
  scriptCollector,
  smallCapsIn,
} from './latexBook.js';
import { makeFixtureDoc, makeSentence } from './testFixtures.js';

const span = (v) => ({ value: v });
const LAYERS = {
  orthographies: ['Translit'],
  wordFields: ['POS'],
  morphFields: ['Gloss'],
  sentFields: ['Translation', 'Note'],
  hasMorphemes: true,
  fieldLangs: {},
};
const SEL = latexSelection(defaultLatexOptions(LAYERS), LAYERS);
const NO_ORTHOGRAPHY = { ...SEL, rows: SEL.rows.filter((r) => r.kind !== 'orthography') };

const word = (content, morphemes = [], annotations = {}) => ({
  content,
  annotations,
  orthographies: {},
  morphemes: morphemes.map(([form, gloss, morphType = null]) => ({
    content: form,
    metadata: { form, ...(morphType ? { morphType } : {}) },
    morphType,
    annotations: gloss == null ? {} : { Gloss: span(gloss) },
  })),
});
const sentenceOf = (tokens, annotations = {}, pieces = null) =>
  makeSentence({ begin: 0, end: 1, tokens, annotations, pieces });
const lineOf = (tex, cmd) =>
  tex
    .split('\n')
    .filter((l) => l.startsWith(`\\${cmd} `))
    .map((l) => l.slice(cmd.length + 2, -3));

// The braces of LaTeX source, balanced once escaped braces are set aside.
const balanced = (tex) => {
  let depth = 0;
  for (const ch of tex.replace(/\\[{}]/g, '')) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
};

describe('latexLayout', () => {
  const W = { kind: 'words', on: true };
  const M = { kind: 'morphemes', on: true };
  const orth = (name, on = true) => ({ kind: 'orthography', name, on });
  const wf = (name, on = true) => ({ kind: 'wordField', name, on });
  const mf = (name, on = true) => ({ kind: 'morphemeField', name, on });
  const L2 = {
    ...LAYERS,
    orthographies: ['Latin', 'IPA'],
    wordFields: ['Gloss', 'POS'],
    morphFields: ['Gloss', 'Type'],
  };

  it("starts a new preset with every line on, in the Analyze tab's order", () => {
    expect(defaultLatexOptions(L2)).toEqual({
      rows: [W, orth('Latin'), orth('IPA'), wf('Gloss'), wf('POS'), M, mf('Gloss'), mf('Type')],
      sentenceFields: [
        { name: 'Translation', on: true },
        { name: 'Note', on: true },
      ],
      includeHeader: true,
    });
  });

  it("keeps the preset's order and switches", () => {
    const rows = [
      M,
      mf('Gloss'),
      W,
      wf('POS', false),
      orth('IPA'),
      orth('Latin'),
      wf('Gloss'),
      mf('Type'),
    ];
    expect(latexLayout({ rows }, L2).rows).toEqual(rows);
  });

  it('puts a line the preset does not name right after its neighbour in the default order, and drops lines the project lost', () => {
    const rows = [M, W, mf('Type'), wf('Gone'), W];
    expect(latexLayout({ rows }, L2).rows).toEqual([
      M,
      mf('Gloss'),
      W,
      orth('Latin'),
      orth('IPA'),
      wf('Gloss'),
      wf('POS'),
      mf('Type'),
    ]);
  });

  it('orders the sentence fields too', () => {
    const sentenceFields = [{ name: 'Note', on: true }];
    // Translation comes first in the default order, so it goes back in first.
    expect(latexSelection({ sentenceFields }, L2).sentFields).toEqual(['Translation', 'Note']);
    const both = [
      { name: 'Note', on: true },
      { name: 'Translation', on: true },
    ];
    expect(latexSelection({ sentenceFields: both }, L2).sentFields).toEqual([
      'Note',
      'Translation',
    ]);
  });

  it('prints only the lines that are on, in order', () => {
    const rows = [M, W, wf('POS', false)];
    expect(latexSelection({ rows }, L2).rows).toEqual([
      { kind: 'morphemes' },
      { kind: 'morphemeField', name: 'Gloss' },
      { kind: 'morphemeField', name: 'Type' },
      { kind: 'words' },
      { kind: 'orthography', name: 'Latin' },
      { kind: 'orthography', name: 'IPA' },
      { kind: 'wordField', name: 'Gloss' },
    ]);
  });
});

describe('formatExample', () => {
  it('mirrors the Analyze tab: words, orthography, word field, morphemes, morpheme field, translation', () => {
    const tex = formatExample(makeFixtureDoc().sortedSentences[0], SEL);
    expect(tex.split('\n')).toEqual([
      '\\ex',
      '\\begingl',
      '\\gla \\PlaidWord{perros} \\PlaidWord{corren} \\PlaidWord{.} //',
      '\\glb \\PlaidOrthography{perros-translit} {} {} //',
      '\\glb \\PlaidWordField{\\textsc{noun}} \\PlaidWordField{\\textsc{verb}} {} //',
      // corren has no morphemes in this fixture, as punctuation the project skips has none.
      '\\glb \\PlaidMorphemes{perro=s} {} {} //',
      '\\glb \\PlaidMorphemeField{dog=\\textsc{pl}} {} {} //',
      '\\glft {\\PlaidTranslation{The dogs run.}} //',
      '\\endgl',
      '\\xe',
    ]);
  });

  it('prints the lines in any order: morphemes above the words, glosses around a word field', () => {
    const rows = [
      { kind: 'morphemes' },
      { kind: 'words' },
      { kind: 'morphemeField', name: 'Gloss' },
      { kind: 'wordField', name: 'POS' },
      { kind: 'orthography', name: 'Translit' },
    ];
    const tex = formatExample(makeFixtureDoc().sortedSentences[0], { ...SEL, rows });
    expect(lineOf(tex, 'gla')).toEqual(['\\PlaidMorphemes{perro=s} {} {}']);
    expect(lineOf(tex, 'glb')).toEqual([
      '\\PlaidWord{perros} \\PlaidWord{corren} \\PlaidWord{.}',
      '\\PlaidMorphemeField{dog=\\textsc{pl}} {} {}',
      '\\PlaidWordField{\\textsc{noun}} \\PlaidWordField{\\textsc{verb}} {}',
      '\\PlaidOrthography{perros-translit} {} {}',
    ]);
  });

  it('prints two fields of one scope each on its own line, in the order given', () => {
    const s = sentenceOf([
      word(
        'ab',
        [
          ['a', 'x'],
          ['b', 'y'],
        ],
        { POS: span('N'), Gloss: span('g') },
      ),
    ]);
    const rows = [
      { kind: 'wordField', name: 'Gloss' },
      { kind: 'morphemeField', name: 'Gloss' },
      { kind: 'wordField', name: 'POS' },
    ];
    expect(lineOf(formatExample(s, { ...SEL, rows }), 'glb')).toEqual([
      '\\PlaidMorphemeField{x-y}',
      '\\PlaidWordField{\\textsc{n}}',
    ]);
    expect(lineOf(formatExample(s, { ...SEL, rows }), 'gla')).toEqual(['\\PlaidWordField{g}']);
  });

  it('sets every other sentence field under its name', () => {
    const s = sentenceOf([word('a')], { Translation: span('A.'), Note: span('said twice') });
    expect(lineOf(formatExample(s, SEL), 'glft')).toEqual([
      '{\\PlaidTranslation{A.} \\PlaidSentenceField{Note}{said twice}}',
    ]);
  });

  it('takes the first sentence field with a value as the translation', () => {
    const s = sentenceOf([word('a')], { Note: span('only a note') });
    expect(lineOf(formatExample(s, SEL), 'glft')).toEqual(['{\\PlaidTranslation{only a note}}']);
  });

  it('leaves out a line with nothing in it, and the morphemes when nothing is segmented', () => {
    const s = sentenceOf([word('a', [['a', null]]), word('b', [['b', null]])]);
    const tex = formatExample(s, SEL);
    expect(lineOf(tex, 'gla')).toEqual(['\\PlaidWord{a} \\PlaidWord{b}']);
    expect(lineOf(tex, 'glb')).toEqual([]);
    expect(tex).not.toContain('\\glft');
  });

  it('keeps an unglossed word in its column with an empty cell', () => {
    const s = sentenceOf([
      word('ab', [
        ['a', 'x'],
        ['b', 'PL'],
      ]),
      word('c', [['c', null]]),
    ]);
    expect(lineOf(formatExample(s, SEL), 'glb')).toEqual([
      '\\PlaidMorphemes{a-b} \\PlaidMorphemes{c}',
      '\\PlaidMorphemeField{x-\\textsc{pl}} {}',
    ]);
  });

  it('writes a zero morph as the character itself', () => {
    const s = sentenceOf([
      word('kai', [
        ['kai', 'go'],
        ['∅', 'PST', 'suffix'],
      ]),
    ]);
    const tex = formatExample(s, SEL);
    expect(tex).toContain('\\PlaidMorphemes{kai-∅}');
    expect(tex).toContain('\\PlaidMorphemeField{go-\\textsc{pst}}');
  });

  it('braces a word with a space in it, so it stays one column', () => {
    const s = sentenceOf([word('look after', [['look after', 'tend']]), word('it')]);
    expect(lineOf(formatExample(s, SEL), 'gla')).toEqual([
      '\\PlaidWord{{look after}} \\PlaidWord{it}',
    ]);
  });

  it('splits text no token covers into a column per run, so it can break across lines', () => {
    const s = sentenceOf([], { Translation: span('Nobody tokenized this.') }, [
      { type: 'gap', content: 'kuna  ha\nmi.' },
    ]);
    expect(lineOf(formatExample(s, SEL), 'gla')).toEqual([
      '\\PlaidWord{kuna} \\PlaidWord{ha} \\PlaidWord{mi.}',
    ]);
  });

  it('gives an empty sentence its number', () => {
    const s = sentenceOf([], {}, [{ type: 'gap', content: '  ' }]);
    expect(lineOf(formatExample(s, SEL), 'gla')).toEqual(['{}']);
  });

  it('names the speaker above the lines', () => {
    const tex = formatExample(sentenceOf([word('a')]), SEL, { speaker: 'Ana_B' });
    expect(tex).toContain('\\glpreamble \\PlaidSpeaker{Ana\\_B} //');
  });

  it('escapes every data string, wherever it lands', () => {
    const nasty = [
      '50% & #1 $x$',
      'a_b^c~d',
      '{open',
      'close}',
      'back\\slash',
      'a // b',
      '\u0000x\u0007',
    ];
    for (const n of nasty) {
      const s = sentenceOf([word(n, [[n, n]], { POS: span(n) })], {
        Translation: span(n),
        Note: span(n),
      });
      const tex = formatExample(s, NO_ORTHOGRAPHY, { speaker: n });
      expect(balanced(tex), n).toBe(true);
      // Every special left in the output is escaped or part of a macro we wrote.
      const bare = tex
        .replace(/\\(textbackslash|textasciitilde|textasciicircum)\{\}/g, '')
        .replace(/\\[&%$#_{}]/g, '');
      expect(bare, n).not.toMatch(/[&%$#_^~]/);
      // eslint-disable-next-line no-control-regex
      expect(tex, n).not.toMatch(/[\u0000-\u0008]/);
    }
  });

  it('lays a right-to-left text out right to left, with a Latin gloss in its own direction', () => {
    const s = sentenceOf([word('كتب', [['كتب', 'write.PST']])], { Translation: span('He wrote.') });
    const tex = formatExample(s, SEL, { docDir: 'rtl' });
    expect(tex).toContain('\\gla \\PlaidWord{\\PlaidScript{Arabic}{كتب}} //');
    expect(tex).toContain('\\glb \\PlaidLTR{\\PlaidMorphemeField{write.\\textsc{pst}}} //');
    // The quotation marks go with the translation's own direction.
    expect(tex).toContain('\\glft {\\PlaidLTR{\\PlaidTranslation{He wrote.}}} //');
  });

  it('sets a right-to-left value in a left-to-right text right to left', () => {
    const s = sentenceOf([word('kitab')], { Translation: span('كتاب') });
    expect(formatExample(s, SEL)).toContain(
      '\\PlaidRTL{\\PlaidTranslation{\\PlaidScript{Arabic}{كتاب}}}',
    );
  });

  it('boxes a right-to-left run inside left-to-right text, and sets only its letters in its font', () => {
    const s = sentenceOf(
      [
        word('abcd-كتب', [
          ['abcd', 'x'],
          ['كتب', 'y'],
        ]),
      ],
      {
        Translation: span('He said كتب الولد twice.'),
      },
    );
    const tex = formatExample(s, SEL);
    expect(tex).toContain('\\PlaidWord{abcd-\\PlaidRTL{\\PlaidScript{Arabic}{كتب}}}');
    expect(tex).toContain(
      '\\PlaidTranslation{He said \\PlaidRTL{\\PlaidScript{Arabic}{كتب الولد}} twice.}',
    );
  });

  it('sets every number read right to left in its own order, left to right', () => {
    // LuaTeX lays out the digits of a right-to-left run right to left, so
    // 1584 printed as 4851.
    const s = sentenceOf([word('كتب'), word('23'), word('سنة ١٤٤٥ هـ')], {
      Translation: span('He wrote 2 books.'),
      Note: span('1584'),
    });
    const tex = formatExample(s, SEL, { docDir: 'rtl' });
    expect(tex).toContain('\\PlaidWord{\\PlaidLTR{23}}');
    expect(tex).toContain('\\PlaidWord{{\\PlaidScript{Arabic}{سنة \\PlaidLTR{١٤٤٥} هـ}}}');
    expect(tex).toContain('{\\PlaidLTR{1584}}');
    // A value read left to right needs nothing.
    expect(tex).toContain('\\PlaidLTR{\\PlaidTranslation{He wrote 2 books.}}');
    // In a left-to-right text, a number inside a right-to-left value too.
    const ltr = formatExample(sentenceOf([word('x')], { Translation: span('عام 1999 م') }), SEL);
    expect(ltr).toContain(
      '\\PlaidRTL{\\PlaidTranslation{\\PlaidScript{Arabic}{عام} \\PlaidLTR{1999} \\PlaidScript{Arabic}{م}}}',
    );
    expect(balanced(tex) && balanced(ltr)).toBe(true);
  });

  it('keeps a range of numbers and a percentage together, left to right', () => {
    const s = sentenceOf([
      word('1990-2000'),
      word('1990–2000'),
      word('50%'),
      word('٥٠٪'),
      word('3‰'),
    ]);
    const tex = formatExample(s, SEL, { docDir: 'rtl' });
    expect(tex).toContain('\\PlaidWord{\\PlaidLTR{1990-2000}}');
    expect(tex).toContain('\\PlaidWord{\\PlaidLTR{1990–2000}}');
    expect(tex).toContain('\\PlaidWord{\\PlaidLTR{50\\%}}');
    expect(tex).toContain('\\PlaidWord{\\PlaidScript{Arabic}{\\PlaidLTR{٥٠٪}}}');
    expect(tex).toContain('\\PlaidWord{\\PlaidLTR{3‰}}');
    // In an Arabic value too.
    const value = formatExample(
      sentenceOf([word('x')], { Translation: span('من 1990-2000') }),
      SEL,
    );
    expect(value).toContain('\\PlaidLTR{1990-2000}');
  });

  it('sets the Arabic comma, question mark, semicolon and tatweel in the Arabic font', () => {
    const s = sentenceOf([word('كتب'), word('،'), word('هل؟'), word('ـ'), word('\u0654')]);
    const tex = formatExample(s, SEL, { docDir: 'rtl' });
    // A hamza above written as a word of its own.
    expect(tex).toContain('\\PlaidWord{\\PlaidScript{Arabic}{\u0654}}');
    expect(tex).toContain('\\PlaidWord{\\PlaidScript{Arabic}{،}}');
    expect(tex).toContain('\\PlaidWord{\\PlaidScript{Arabic}{هل؟}}');
    expect(tex).toContain('\\PlaidWord{\\PlaidScript{Arabic}{ـ}}');
    const ltr = formatExample(sentenceOf([word('x'), word('؛')]), SEL);
    expect(ltr).toContain('\\PlaidWord{\\PlaidRTL{\\PlaidScript{Arabic}{؛}}}');
    // A mark or a dot that Latin text uses too stays with the text.
    const latin = formatExample(sentenceOf([word('ã·b')]), SEL);
    expect(latin).toContain('\\PlaidWord{ã·b}');
    expect(formatExample(sentenceOf([word('n\u0303o\u0323')]), SEL)).toContain(
      '\\PlaidWord{n\u0303o\u0323}',
    );
  });
});

describe('formatChapter', () => {
  it('opens a chapter with the metadata, and numbers its examples from 1', () => {
    const doc = makeFixtureDoc();
    doc.document.metadata = { ...doc.document.metadata, plaid: { textDirection: 'ltr' } };
    const tex = formatChapter(doc, SEL);
    expect(tex.startsWith('\\chapter{Test \\& Doc}\n\\excnt=1\n')).toBe(true);
    expect(tex).toContain('\\PlaidMetadata{Source}{Field notes}');
    expect(tex).toContain('\\PlaidMetadata{Genre}{narrative}');
    expect(tex).not.toContain('object Object');
    expect(tex.match(/\\ex\n/g)).toHaveLength(1);
  });

  it('cuts a long name short in the running head only', () => {
    const doc = makeFixtureDoc();
    doc.document.name = 'A very long name for a text that would never fit on one running head line';
    const tex = formatChapter(doc, SEL);
    expect(tex).toContain(`\\chapter{${doc.document.name}}`);
    expect(tex).toContain('\\chaptermark{A very long name for a text that would never…}');
  });

  it('leaves the metadata out when asked', () => {
    expect(formatChapter(makeFixtureDoc(), { ...SEL, includeHeader: false })).not.toContain(
      'PlaidMetadata',
    );
  });

  it('wraps a right-to-left document in the right-to-left environment', () => {
    const doc = makeFixtureDoc();
    doc.textDirection = 'rtl';
    const tex = formatChapter(doc, SEL);
    expect(tex).toContain('\\begin{PlaidRightToLeft}');
    expect(tex.trim().endsWith('\\end{PlaidRightToLeft}')).toBe(true);
  });
});

describe('fonts', () => {
  it('finds the scripts beyond the main font', () => {
    const c = scriptCollector();
    c.add('ʔaŋ ɓà Ωμέγα жизнь ∅ 1SG');
    expect(c.scripts()).toEqual([]);
    c.add('ꯃꯅꯤꯄꯨꯔ মণিপুরী كتاب 漢字 ꯃ');
    expect(c.scripts()).toEqual(['Meetei_Mayek', 'Bengali', 'Arabic', 'Han']);
  });

  it('finds the Arabic script from its punctuation alone', () => {
    const c = scriptCollector();
    c.add('a ، b');
    expect(c.scripts()).toEqual(['Arabic']);
  });

  it('names a Noto font for each', () => {
    expect(notoFamilyFor('Bengali')).toBe('Noto Serif Bengali');
    expect(notoFamilyFor('Meetei_Mayek')).toBe('Noto Sans Meetei Mayek');
    expect(notoFamilyFor('Arabic')).toBe('Noto Naskh Arabic');
    expect(notoFamilyFor('Han')).toBe('Noto Serif CJK SC');
  });
});

describe('abbreviations', () => {
  it('lists each small-caps abbreviation once, described by the tagset, else by Leipzig', () => {
    const tags = smallCapsIn(
      'x.\\textsc{pl} \\textsc{1sg}.\\textsc{nom} \\textsc{pl} \\textsc{evid}',
    );
    const config = {
      igt: { tagsets: { L: { values: [{ value: 'NOM', description: 'nominative case' }] } } },
    };
    const tex = formatAbbreviations(tags, config);
    expect(tex.match(/PlaidAbbreviation\{/g)).toHaveLength(4);
    expect(tex).toContain('\\PlaidAbbreviation{\\textsc{nom}}{nominative case}');
    expect(tex).toContain('\\PlaidAbbreviation{\\textsc{pl}}{plural}');
    expect(tex).toContain('\\PlaidAbbreviation{\\textsc{evid}}{}');
    // In order, digits first.
    expect(tex.indexOf('{1sg}')).toBeLessThan(tex.indexOf('{evid}'));
  });
});

describe('buildLatexBook', () => {
  it('writes main.tex, the abbreviations, one file per text, latexmkrc and a README', () => {
    const files = buildLatexBook({
      title: 'Kukama texts',
      texts: [
        { name: 'The Fox & the Crow', tex: '\\chapter{x}\n\\textsc{pl} মণিপুরী' },
        { name: 'Ñandú', tex: '\\chapter{y}\n' },
        { name: '日本', tex: '\\chapter{z}\n' },
      ],
      projectConfig: {},
    });
    expect(files.map((f) => f.path)).toEqual([
      'main.tex',
      'abbreviations.tex',
      'texts/001-the-fox-the-crow.tex',
      'texts/002-nandu.tex',
      'texts/003.tex',
      'latexmkrc',
      'README.txt',
    ]);
    const main = files[0].data;
    expect(main).toContain(
      '\\include{texts/001-the-fox-the-crow}\n\\include{texts/002-nandu}\n\\include{texts/003}',
    );
    expect(main).toContain('\\tableofcontents');
    expect(main).toContain('\\PlaidFallbackFont{Noto Serif Bengali}');
    expect(main).toContain('\\include{abbreviations}');
    expect(balanced(main)).toBe(true);
    // An example's number reads left to right in a right-to-left text too.
    expect(main).toContain(
      '\\lingset{exnoformat=\\begingroup\\textdir TLT\\PlaidExampleNumber X\\endgroup}',
    );
    expect(files[1].data).toContain('\\textsc{pl}}{plural}');
    expect(files.find((f) => f.path === 'latexmkrc').data).toContain('$pdf_mode = 4;');
  });

  it('says on the contents page and in the log when the table of contents is not filled in yet', () => {
    const files = buildLatexBook({
      title: 'Kukama texts',
      texts: [{ name: 'One', tex: '\\chapter{One}\n' }],
      projectConfig: {},
    });
    const main = files[0].data;
    // A first run has no .toc to read: the note and a rerun warning stand in.
    expect(main).toContain('\\IfFileExists{\\jobname.toc}{}{\\renewcommand{\\PlaidContentsNote}{%');
    expect(main).toContain('Rerun to get cross-references right');
    // Checked in the preamble, before \tableofcontents opens the .toc for writing.
    expect(main.indexOf('\\IfFileExists{\\jobname.toc}')).toBeLessThan(
      main.indexOf('\\begin{document}'),
    );
    expect(main).toContain('\\tableofcontents\n\\PlaidContentsNote\n');
    const readme = files.find((f) => f.path === 'README.txt').data;
    expect(readme).toContain('latexmk -lualatex main.tex');
    expect(readme).toContain('LuaLaTeX has to run twice');
    for (const f of files) expect(f.data).not.toMatch(/overleaf/i);
  });

  it('numbers files wide enough for the whole book', () => {
    expect(chapterFileName(4, 1200, 'A b')).toBe('0005-a-b');
    expect(chapterFileName(0, 3, '')).toBe('001');
  });
});

describe('entry numbers in the texts', () => {
  // kai is spelled by two headwords (kai 1, kai 2), the second with a sense.
  const ITEMS = [
    { id: 'k1', form: 'kai', metadata: { gloss: 'go' } },
    { id: 'k2', form: 'kai', metadata: { gloss: 'eat' } },
    { id: 'k2a', form: 'kai', metadata: { gloss: 'devour', parent: 'k2' } },
    { id: 'na', form: 'na', metadata: { gloss: 'PST' } },
    { id: 'ar', form: 'كتب', metadata: { gloss: 'write' } },
    { id: 'ar2', form: 'كتب', metadata: { gloss: 'book' } },
  ];
  const NUMBERS = entryNumbers([{ id: 'v', items: ITEMS }]);
  // A link as derive gives it: the entry's id and form.
  const entry = (id) => (id ? { id, form: ITEMS.find((it) => it.id === id).form } : null);
  const linked = (w, item, morphemes = []) => ({
    ...word(
      w,
      morphemes.map(([form, gloss, morphType]) => [form, gloss, morphType]),
    ),
    vocabItem: entry(item),
  });
  const linkMorphemes = (token, ids) => ({
    ...token,
    morphemes: token.morphemes.map((m, i) => ({ ...m, vocabItem: entry(ids[i]) })),
  });

  it('numbers an entry as the vocabulary does, and an entry with no homograph not at all', () => {
    expect(NUMBERS.get('k1')).toBe('1');
    expect(NUMBERS.get('k2')).toBe('2');
    expect(NUMBERS.get('k2a')).toBe('2.1');
    expect(NUMBERS.get('na')).toBe('');
  });

  it("writes a linked morpheme's number after it on the morpheme line, and leaves the columns aligned", () => {
    const token = linkMorphemes(
      word('kaina', [
        ['kai', 'go'],
        ['na', 'PST', 'suffix'],
      ]),
      ['k2a', 'na'],
    );
    const tex = formatExample(sentenceOf([token, word('mo')]), NO_ORTHOGRAPHY, {
      numbers: NUMBERS,
    });
    expect(lineOf(tex, 'glb')[0]).toBe('\\PlaidMorphemes{kai\\PlaidHomonym{2.1}-na} {}');
    // The gloss line is untouched, and its abbreviations still small caps.
    expect(lineOf(tex, 'glb')[1]).toBe('\\PlaidMorphemeField{go-\\textsc{pst}} {}');
    expect(smallCapsIn(tex)).toEqual(['pst']);
    expect(balanced(tex)).toBe(true);
  });

  it('writes no number after a form spelled unlike its entry, whatever the case', () => {
    const token = linkMorphemes(
      word('kena', [
        ['ke', 'go'],
        ['na', 'PST', 'suffix'],
      ]),
      ['k1', 'na'],
    );
    const tex = formatExample(sentenceOf([token, linked('Kai', 'k2')]), NO_ORTHOGRAPHY, {
      numbers: NUMBERS,
    });
    expect(lineOf(tex, 'gla')[0]).toBe('\\PlaidWord{kena} \\PlaidWord{Kai\\PlaidHomonym{2}}');
    expect(lineOf(tex, 'glb')[0]).toBe('\\PlaidMorphemes{ke-na} {}');
  });

  it("writes a linked word's number on the word line", () => {
    const tex = formatExample(
      sentenceOf([linked('kai', 'k1'), linked('na', 'na')]),
      NO_ORTHOGRAPHY,
      {
        numbers: NUMBERS,
      },
    );
    expect(lineOf(tex, 'gla')[0]).toBe('\\PlaidWord{kai\\PlaidHomonym{1}} \\PlaidWord{na}');
  });

  it('puts the number of a word that is its one morpheme on the word line when the morpheme line is not printed', () => {
    const token = linkMorphemes(word('kai', [['kai', 'go']]), ['k1']);
    const tex = formatExample(sentenceOf([token]), NO_ORTHOGRAPHY, { numbers: NUMBERS });
    expect(lineOf(tex, 'gla')[0]).toBe('\\PlaidWord{kai\\PlaidHomonym{1}}');
    expect(tex).not.toContain('PlaidMorphemes');
  });

  it('writes no number without the option', () => {
    const tex = formatExample(sentenceOf([linked('kai', 'k1')]), NO_ORTHOGRAPHY);
    expect(tex).not.toContain('PlaidHomonym');
  });

  it('keeps the number in reading order, left to right, in a right-to-left text', () => {
    const tex = formatExample(sentenceOf([linked('كتب', 'ar2')]), NO_ORTHOGRAPHY, {
      docDir: 'rtl',
      numbers: NUMBERS,
    });
    expect(lineOf(tex, 'gla')[0]).toBe(
      '\\PlaidWord{\\PlaidScript{Arabic}{كتب}\\PlaidHomonym{\\PlaidLTR{2}}}',
    );
  });

  it('braces a numbered word with a space in it, so it stays one column', () => {
    const token = { ...linked('kai kai', 'k1'), vocabItem: { id: 'k1', form: 'kai kai' } };
    const tex = formatExample(sentenceOf([token]), NO_ORTHOGRAPHY, {
      numbers: NUMBERS,
    });
    expect(lineOf(tex, 'gla')[0]).toBe('\\PlaidWord{{kai kai\\PlaidHomonym{1}}}');
  });
});

describe('the vocabulary chapter', () => {
  const VOCAB = {
    id: 'v1',
    name: 'Kukama & co',
    config: {
      igt: {
        fields: {
          gloss: { inline: true },
          pos: { inline: true },
          seeAlso: { type: 'item', many: true },
        },
      },
    },
    items: [
      { id: 'z', form: 'zapa', metadata: { gloss: 'shoe', pos: 'n' } },
      { id: 'a1', form: 'ana', metadata: { gloss: 'go_out', pos: 'v', seeAlso: ['z'] } },
      {
        id: 'a2',
        form: 'ana',
        metadata: { gloss: 'here', examples: [{ document: 'd1', token: 't3' }] },
      },
      { id: 'a2s', form: 'ana', metadata: { gloss: 'now', parent: 'a2' } },
      { id: 'a2t', form: 'anaka', metadata: { gloss: 'just now', parent: 'a2' } },
      { id: 'b', form: 'Äbu', metadata: { gloss: 'father' } },
    ],
  };
  const choiceFor = (options = {}, vocabs = [VOCAB]) => latexVocabulary(options, vocabs);

  it('defaults to a chapter of the entries the texts use, every vocabulary and field on, no numbers in the texts', () => {
    expect(choiceFor()).toEqual({
      include: true,
      scope: 'used',
      numbersInTexts: false,
      vocabularies: [
        {
          id: 'v1',
          name: 'Kukama & co',
          on: true,
          fields: [
            { name: 'gloss', label: 'Gloss', on: true },
            { name: 'pos', label: 'POS', on: true },
            { name: 'seeAlso', label: 'See Also', on: true },
            { name: 'morphType', label: 'Morph Type', on: true },
          ],
        },
      ],
    });
    expect(latexVocabulary({}, []).include).toBe(false);
  });

  it('round-trips through what a preset stores, and drops a vocabulary the project no longer has', () => {
    const choice = choiceFor();
    choice.scope = 'all';
    choice.numbersInTexts = true;
    choice.vocabularies[0].fields[0].on = false;
    const stored = JSON.parse(
      JSON.stringify({
        ...storedLatexVocabulary(choice),
        vocabularies: [
          ...storedLatexVocabulary(choice).vocabularies,
          { id: 'gone', on: true, fields: [] },
        ],
      }),
    );
    expect(choiceFor({ vocabulary: stored })).toEqual(choice);
    expect(choiceFor({ vocabulary: { include: false } }).include).toBe(false);
  });

  it('lists the headwords the texts use, by form, each with its senses, number, fields and examples', () => {
    const tex = formatVocabulary({
      vocabularies: [VOCAB],
      choice: choiceFor(),
      used: new Set(['a2s', 'a1']),
      exampleNumbers: new Map([['d1/t3', [3, 12]]]),
    });
    expect(tex).toContain('\\chapter*{Vocabulary}\n\\addcontentsline{toc}{chapter}{Vocabulary}');
    const entries = tex.split('\n').filter((l) => l.startsWith('\\PlaidEntry{'));
    expect(entries).toEqual([
      '\\PlaidEntry{\\PlaidEntryForm{ana}\\PlaidHomonym{1}}{\\PlaidEntryGloss{go\\_out} \\PlaidEntryField{POS}{v} \\PlaidEntryField{See Also}{zapa}}',
      '\\PlaidEntry{\\PlaidEntryForm{ana}\\PlaidHomonym{2}}{\\PlaidEntryGloss{here} \\PlaidEntryExamples{\\PlaidExampleRef{3}{12}} \\PlaidSense{2.1}{\\PlaidEntryGloss{now}} \\PlaidSense{2.2}{\\PlaidEntryForm{anaka} \\PlaidEntryGloss{just now}}}',
    ]);
    expect(balanced(tex)).toBe(true);
  });

  it("sorts every entry by the language's collation, and the homographs by their number", () => {
    const forms = (lang) =>
      formatVocabulary({
        vocabularies: [VOCAB],
        choice: choiceFor({ vocabulary: { scope: 'all' } }),
        lang,
      })
        .split('\n')
        .filter((l) => l.startsWith('\\PlaidEntry{'))
        .map((l) =>
          l
            .match(/PlaidEntryForm\{([^}]*)\}(\\PlaidHomonym\{(\d)\})?/)
            .slice(1, 4)
            .filter((x, i) => i !== 1)
            .join(''),
        );
    expect(forms(null)).toEqual(['Äbu', 'ana1', 'ana2', 'zapa']);
    // Swedish puts Ä after z.
    expect(forms('sv')).toEqual(['ana1', 'ana2', 'zapa', 'Äbu']);
    // A tag Intl cannot read falls back to the root collation.
    expect(forms('not a tag!')).toEqual(['Äbu', 'ana1', 'ana2', 'zapa']);
  });

  it('files an affix under its letters, and puts the gloss first', () => {
    const affixes = {
      id: 'v4',
      name: 'Affixes',
      config: { igt: { fields: { pos: {}, gloss: {} } } },
      items: [
        { id: 's', form: '-s', metadata: { gloss: 'PL', pos: 'sfx' } },
        { id: 'r', form: 'ra', metadata: { gloss: 'go' } },
        { id: 'a', form: 'a=', metadata: { gloss: 'DEF' } },
      ],
    };
    const tex = formatVocabulary({
      vocabularies: [affixes],
      choice: choiceFor({ vocabulary: { scope: 'all' } }, [affixes]),
    });
    expect(tex.split('\n').filter((l) => l.startsWith('\\PlaidEntry{'))).toEqual([
      '\\PlaidEntry{\\PlaidEntryForm{a=}}{\\PlaidEntryGloss{\\textsc{def}}}',
      '\\PlaidEntry{\\PlaidEntryForm{ra}}{\\PlaidEntryGloss{go}}',
      '\\PlaidEntry{\\PlaidEntryForm{-s}}{\\PlaidEntryGloss{\\textsc{pl}} \\PlaidEntryField{POS}{sfx}}',
    ]);
  });

  it('names a morph type as the screen does', () => {
    const vocab = {
      id: 'v6',
      name: 'Phrases',
      config: {},
      items: [
        { id: 'p', form: 'dar vuelta', metadata: { gloss: 'turn', morphType: 'phrase' } },
        { id: 'q', form: 'dar la vuelta', metadata: { morphType: 'discontiguous phrase' } },
      ],
    };
    const tex = formatVocabulary({
      vocabularies: [vocab],
      choice: choiceFor({ vocabulary: { scope: 'all' } }, [vocab]),
    });
    expect(tex.match(/Morph Type\}\{multi-word expression\}/g)).toHaveLength(2);
    expect(tex).not.toContain('phrase');
  });

  it("sets a gloss's abbreviations in small caps as the texts do, and lists them", () => {
    const vocab = {
      id: 'v5',
      name: 'Glosses',
      config: { igt: { fields: { gloss: {} } } },
      items: [
        { id: 'g', form: 'gi', metadata: { gloss: 'go.PST' } },
        { id: 'k', form: 'ka', metadata: { gloss: 'NOM', morphType: 'suffix' } },
        { id: 'k1', form: 'ka', metadata: { gloss: '1SG', parent: 'k' } },
      ],
    };
    const tex = formatVocabulary({
      vocabularies: [vocab],
      choice: choiceFor({ vocabulary: { scope: 'all' } }, [vocab]),
    });
    expect(tex).toContain('\\PlaidEntryGloss{go.\\textsc{pst}}');
    expect(tex).toContain('\\PlaidEntryGloss{\\textsc{nom}}');
    // A sense goes by its headword's morph type.
    expect(tex).toContain('\\PlaidSense{1.1}{\\PlaidEntryGloss{\\textsc{1sg}}}');
    const files = buildLatexBook({ title: 'T', texts: [], projectConfig: {}, vocabulary: tex });
    const abbreviations = files.find((f) => f.path === 'abbreviations.tex').data;
    expect(abbreviations).toContain('\\textsc{nom}');
    expect(abbreviations).toContain('\\textsc{1sg}');
  });

  it('shows only the fields that are on', () => {
    const choice = choiceFor();
    choice.vocabularies[0].fields = choice.vocabularies[0].fields.map((f) => ({
      ...f,
      on: f.name === 'pos',
    }));
    const tex = formatVocabulary({ vocabularies: [VOCAB], choice, used: new Set(['z']) });
    expect(tex).toContain('\\PlaidEntry{\\PlaidEntryForm{zapa}}{\\PlaidEntryField{POS}{n}}');
  });

  it('sets a right-to-left headword in its script, its number after it in reading order', () => {
    const rtl = {
      id: 'v2',
      name: 'Arabic',
      config: {},
      items: [
        { id: 'r1', form: 'كتب', metadata: { gloss: 'write' } },
        { id: 'r2', form: 'كتب', metadata: { gloss: 'books' } },
      ],
    };
    const tex = formatVocabulary({
      vocabularies: [rtl],
      choice: choiceFor({}, [rtl]),
      used: new Set(['r2']),
      lang: 'ar',
    });
    expect(tex).toContain(
      '\\PlaidEntry{\\PlaidRTL{\\PlaidEntryForm{\\PlaidScript{Arabic}{كتب}}\\PlaidHomonym{\\PlaidLTR{2}}}}{\\PlaidEntryGloss{books}}',
    );
  });

  it('heads each of several vocabularies by its name, and leaves out one with nothing to list', () => {
    const other = { id: 'v2', name: 'Loans', config: {}, items: [{ id: 'l', form: 'kafe' }] };
    const empty = { id: 'v3', name: 'Empty', config: {}, items: [] };
    const tex = formatVocabulary({
      vocabularies: [VOCAB, other, empty],
      choice: choiceFor({ vocabulary: { scope: 'all' } }, [VOCAB, other, empty]),
    });
    expect(tex).toContain('\\chapter*{Kukama \\& co}');
    expect(tex).toContain('\\chapter*{Loans}');
    expect(tex).not.toContain('Empty');
    expect(formatVocabulary({ vocabularies: [empty], choice: choiceFor({}, [empty]) })).toBeNull();
  });

  it('leaves out a vocabulary that is off', () => {
    const choice = choiceFor({
      vocabulary: { scope: 'all', vocabularies: [{ id: 'v1', on: false }] },
    });
    expect(formatVocabulary({ vocabularies: [VOCAB], choice })).toBeNull();
  });

  it("finds the entries a document links to, and each example's chapter and number", () => {
    const doc = {
      vocabularies: {
        v1: { vocabLinks: [{ vocabItem: { id: 'a1' } }, { vocabItem: 'z' }] },
      },
      sortedSentences: [
        { id: 's1', tokens: [{ id: 't1', morphemes: [] }] },
        { id: 's2', tokens: [{ id: 't2', morphemes: [{ id: 'm1' }] }] },
      ],
    };
    expect([...linkedEntryIds(doc)]).toEqual(['a1', 'z']);
    expect([...exampleNumbersOf(doc, 'd1', 4, new Set(['d1/m1', 'd1/t9', 'd1/s1']))]).toEqual([
      ['d1/s1', [4, 1]],
      ['d1/m1', [4, 2]],
    ]);
  });

  it('puts the chapter at the back of the book, and the example anchors it links to', () => {
    const files = buildLatexBook({
      title: 'T',
      texts: [{ name: 'One', tex: '\\chapter{One}\n' }],
      projectConfig: {},
      vocabulary:
        '\\chapter*{Vocabulary}\n\\PlaidEntry{\\PlaidRTL{\\PlaidEntryForm{\\PlaidScript{Arabic}{كتب}}}}{}\n',
    });
    const main = files.find((f) => f.path === 'main.tex').data;
    expect(main).toContain('\\backmatter\n\\include{vocabulary}\n\\end{document}');
    expect(main).toContain('\\hypertarget{plaidex.\\thechapter.#1}');
    expect(main).toContain('\\newcommand{\\PlaidHomonym}');
    // The vocabulary's scripts get their fonts.
    expect(main).toContain('\\PlaidScriptFont{Arabic}{Noto Naskh Arabic}');
    expect(files.map((f) => f.path)).toContain('vocabulary.tex');
    expect(files.find((f) => f.path === 'README.txt').data).toContain('vocabulary.tex');
    const without = buildLatexBook({
      title: 'T',
      texts: [{ name: 'One', tex: '' }],
      projectConfig: {},
    });
    expect(without.map((f) => f.path)).not.toContain('vocabulary.tex');
    expect(without.find((f) => f.path === 'main.tex').data).not.toContain('\\include{vocabulary}');
  });
});
