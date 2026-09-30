import { describe, it, expect } from 'vitest';
import {
  buildLatexBook,
  chapterFileName,
  formatAbbreviations,
  formatChapter,
  formatExample,
  notoFamilyFor,
  scriptCollector,
  smallCapsIn,
} from './latexBook.js';
import { makeFixtureDoc, makeSentence } from './testFixtures.js';

const span = (v) => ({ value: v });
const SEL = {
  orthographies: ['Translit'],
  wordFields: ['POS'],
  morphFields: ['Gloss'],
  sentFields: ['Translation', 'Note'],
  includeHeader: true,
};

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
      const tex = formatExample(s, { ...SEL, orthographies: [] }, { speaker: n });
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
    expect(files[1].data).toContain('\\textsc{pl}}{plural}');
    expect(files.find((f) => f.path === 'latexmkrc').data).toContain('$pdf_mode = 4;');
  });

  it('numbers files wide enough for the whole book', () => {
    expect(chapterFileName(4, 1200, 'A b')).toBe('0005-a-b');
    expect(chapterFileName(0, 3, '')).toBe('001');
  });
});
