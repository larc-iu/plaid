import { describe, it, expect } from 'vitest';
import { joinPhrase, parseFlextext, parseFlextextFiles } from './flextextParser.js';
import { buildDocuments } from './buildDocuments.js';
import { deriveImportConfig } from './importEngine.js';
import { buildFlextextDocument } from '../../export/flextext.js';
import { makeFixtureDoc, FLEXTEXT_OPTIONS } from '../../export/testFixtures.js';

const w = (text) => ({ kind: 'word', text });
const p = (text) => ({ kind: 'punct', text });

describe('joinPhrase (FieldWorks rebuilding a phrase from its words)', () => {
  it('puts a space between words and none before ending punctuation', () => {
    expect(joinPhrase([w('a'), w('b'), p(','), w('c'), p('.')])).toBe('a b, c. ');
  });

  it('spaces brackets and quotes by their Unicode class', () => {
    expect(joinPhrase([w('a'), p('('), w('b'), p(')'), w('c')])).toBe('a (b) c');
    expect(joinPhrase([w('a'), p('«'), w('b'), p('»'), w('c')])).toBe('a «b» c');
  });

  it('puts a lone straight quote after a word in front of a space', () => {
    expect(joinPhrase([w('said'), p('"'), w('go')])).toBe('said "go');
    expect(joinPhrase([p('"'), w('go')])).toBe('"go');
  });

  it('spaces a multi-character piece by its first and last character', () => {
    expect(joinPhrase([w('a'), p('."'), w('b')])).toBe('a." b');
    expect(joinPhrase([w('a'), p(', '), w('b')])).toBe('a, b');
  });

  it('puts a space before an inverted question mark after a word', () => {
    expect(joinPhrase([w('Dijo'), p('¿'), w('qué'), p('?')])).toBe('Dijo ¿qué? ');
  });

  it('writes the first piece as it is', () => {
    expect(joinPhrase([p('('), w('a'), p(')')])).toBe('(a) ');
    expect(joinPhrase([])).toBe('');
  });
});

const TEXT = `\uFEFF<?xml version="1.0" encoding="utf-8"?>
<document version="2">
  <interlinear-text guid="t-1">
    <item type="title" lang="en">A dog</item>
    <item type="title" lang="xx">Kici</item>
    <item type="title-abbreviation" lang="en">AD</item>
    <item type="source" lang="en">Abir</item>
    <item type="comment" lang="en">Told twice</item>
    <item type="genre" lang="en" guid="g-1">Narrative</item>
    <item type="date-created" lang="en">2020-01-01</item>
    <item type="notebook-record" lang="en" guid="n-1"></item>
    <paragraphs>
      <paragraph guid="p-1">
        <phrases>
          <phrase guid="s-1" begin-time-offset="0" end-time-offset="1500" speaker="Ana">
            <item type="segnum" lang="en">1.1</item>
            <words>
              <word guid="w-1">
                <item type="txt" lang="xx">Kici</item>
                <item type="txt" lang="xx-Latn">Kitsi</item>
                <morphemes>
                  <morph type="stem" guid="mt-1">
                    <item type="txt" lang="xx">kic</item>
                    <item type="cf" lang="xx">kic</item>
                    <item type="gls" lang="en">dog</item>
                    <item type="msa" lang="en">n</item>
                  </morph>
                  <morph type="suffix" guid="mt-2">
                    <item type="txt" lang="xx">-i</item>
                    <item type="gls" lang="en">ABS</item>
                  </morph>
                </morphemes>
                <item type="gls" lang="en">dog</item>
                <item type="pos" lang="en">n</item>
              </word>
              <word guid="w-2">
                <item type="txt" lang="xx">
                  <run lang="xx">aw</run>
                  <run lang="xx" style="Emphasis">ai</run>
                </item>
                <item type="gls" lang="en" analysisStatus="guess">was</item>
              </word>
              <word>
                <item type="punct" lang="xx">.</item>
              </word>
            </words>
            <item type="gls" lang="en">There was a dog.</item>
            <item type="gls" lang="ru">Была собака.</item>
            <item type="lit" lang="en">Dog was.</item>
            <item type="note" lang="en" groupid="1">Second-hand</item>
            <item type="note" lang="ru" groupid="1">Со слов</item>
            <item type="note" lang="en">Check</item>
          </phrase>
          <phrase guid="s-2">
            <item type="txt" lang="xx">It  barked.</item>
            <words>
              <word><item type="txt" lang="xx">It</item></word>
              <word><item type="txt" lang="xx">barked</item></word>
              <word><item type="punct" lang="xx">.</item></word>
            </words>
          </phrase>
        </phrases>
      </paragraph>
      <paragraph><phrases></phrases></paragraph>
      <paragraph guid="p-3">
        <phrases>
          <phrase>
            <words><word><item type="gls" lang="en">orphan</item></word></words>
            <item type="gls" lang="en">Nothing here</item>
          </phrase>
          <phrase>
            <words>
              <word>
                <item type="txt" lang="xx">Iti</item>
                <morphemes analysisStatus="guessByStatisticalAnalysis">
                  <morph><item type="txt" lang="xx">it</item></morph>
                  <morph><item type="txt" lang="xx">=i</item></morph>
                </morphemes>
              </word>
            </words>
          </phrase>
        </phrases>
      </paragraph>
    </paragraphs>
    <languages>
      <language lang="xx" font="Charis SIL" vernacular="true" />
      <language lang="xx-Latn" vernacular="true" />
      <language lang="en" font="Times New Roman" />
      <language lang="ru" />
    </languages>
    <media-files offset-type=""><media guid="m-1" location="a.wav" /></media-files>
  </interlinear-text>
</document>`;

describe('a word that is only punctuation', () => {
  it('is spaced as punctuation and still read as a word', () => {
    const xml = `<document><interlinear-text><paragraphs><paragraph><phrases><phrase><words>
      <word><item type="txt" lang="x">Cuomo</item></word>
      <word><item type="txt" lang="x">(</item></word>
      <word><item type="txt" lang="x">born</item></word>
      <word><item type="txt" lang="x">1970</item></word>
      <word><item type="txt" lang="x">)</item></word>
      <word><item type="txt" lang="x">is</item></word>
    </words></phrase></phrases></paragraph></paragraphs></interlinear-text></document>`;
    const [text] = parseFlextext(xml, 'x.flextext').texts;
    const [para] = text.paragraphs;
    expect(para.content).toBe('Cuomo (born 1970) is');
    expect(para.segments[0].analyses.map((a) => a.kind)).toEqual(Array(6).fill('word'));
  });
});

describe('a lone morph that is only the word', () => {
  const read = (morphs) =>
    parseFlextext(
      `<document><interlinear-text><paragraphs><paragraph><phrases><phrase><words>
        <word><item type="txt" lang="x">Cuomo</item><morphemes>${morphs}</morphemes></word>
      </words></phrase></phrases></paragraph></paragraphs></interlinear-text></document>`,
    ).texts[0].paragraphs[0].segments[0].analyses[0].morphemes;

  it('is no segmentation', () => {
    expect(read('<morph><item type="txt" lang="x">Cuomo</item></morph>')).toBeNull();
    expect(read('<morph></morph>')).toBeNull();
  });

  it('is kept when it says anything more', () => {
    expect(read('<morph type="stem"><item type="txt" lang="x">Cuomo</item></morph>')).toHaveLength(
      1,
    );
    expect(
      read(
        '<morph><item type="txt" lang="x">Cuomo</item><item type="gls" lang="en">name</item></morph>',
      ),
    ).toHaveLength(1);
    expect(read('<morph><item type="txt" lang="x">cuomo</item></morph>')).toHaveLength(1);
  });
});

describe('parseFlextext', () => {
  const { texts, languages, census, warnings } = parseFlextext(TEXT, 'dog.flextext');
  const [text] = texts;

  it('reads the text-level items', () => {
    expect(text.guid).toBe('t-1');
    expect(text.names).toEqual({ en: 'A dog', xx: 'Kici' });
    expect(text.abbreviations).toEqual({ en: 'AD' });
    expect(text.source).toEqual({ en: 'Abir' });
    expect(text.description).toEqual({ en: 'Told twice' });
    expect(text.genres).toEqual(['Narrative']);
    expect(languages.map((l) => [l.lang, l.vernacular])).toEqual([
      ['xx', true],
      ['xx-Latn', true],
      ['en', false],
      ['ru', false],
    ]);
  });

  it('rebuilds each paragraph, keeping a phrase text given in the file', () => {
    expect(text.paragraphs.map((p) => p.content)).toEqual(['Kici awai. It  barked.', '', 'Iti']);
    expect(text.paragraphs[0].segments.map((s) => s.beginOffset)).toEqual([0, 11]);
  });

  it('reads words, joining runs and marking what FLEx says it guessed', () => {
    const [kici, awai, stop] = text.paragraphs[0].segments[0].analyses;
    expect(kici).toMatchObject({
      kind: 'word',
      surface: 'Kici',
      forms: { xx: 'Kici', 'xx-Latn': 'Kitsi' },
      gloss: { en: 'dog' },
      pos: { en: 'n' },
      approved: true,
      machineAgents: [],
    });
    expect(kici.morphemes).toEqual([
      {
        forms: { xx: 'kic' },
        gloss: { en: 'dog' },
        pos: { en: 'n' },
        morphType: 'stem',
        senseGuid: null,
        entryGuid: null,
      },
      {
        forms: { xx: 'i' },
        gloss: { en: 'ABS' },
        pos: null,
        morphType: 'suffix',
        senseGuid: null,
        entryGuid: null,
      },
    ]);
    expect(awai).toMatchObject({
      surface: 'awai',
      approved: false,
      machineAgents: ['guess'],
      morphemes: [],
    });
    expect(stop).toEqual({ kind: 'punct', form: '.' });
  });

  it('reads a guessed breakdown and types an untyped morph by its markers', () => {
    const [iti] = text.paragraphs[2].segments[0].analyses;
    expect(iti.machineAgents).toEqual(['guessByStatisticalAnalysis']);
    expect(iti.morphemes.map((m) => [m.forms.xx, m.morphType])).toEqual([
      ['it', null],
      ['i', 'enclitic'],
    ]);
  });

  it('reads translations, and notes grouped by groupid', () => {
    const seg = text.paragraphs[0].segments[0];
    expect(seg.freeTranslation).toEqual({ en: 'There was a dog.', ru: 'Была собака.' });
    expect(seg.literalTranslation).toEqual({ en: 'Dog was.' });
    expect(seg.notes).toEqual([{ en: 'Second-hand', ru: 'Со слов' }, { en: 'Check' }]);
  });

  it('leaves out a phrase with no text, and says so', () => {
    expect(text.paragraphs[2].segments).toHaveLength(1);
    expect(warnings).toEqual([
      'A dog: 1 word with no text left out of sentence 3',
      'A dog: sentence 3 has no text and was left out with its translation',
    ]);
  });

  it('counts what it does not read', () => {
    expect(Object.fromEntries(census.unread)).toEqual({
      'Notebook records': 1,
      'Media files': 1,
      'Time alignment': 1,
      Speakers: 1,
      'Lex. Entries': 1,
    });
  });

  it('refuses a file that is not a .flextext', () => {
    expect(() => parseFlextext('<html></html>')).toThrow(/no <document>/);
    expect(() => parseFlextext('<document><oops></document>')).toThrow(/not readable XML/);
  });
});

describe('parseFlextextFiles', () => {
  const ir = parseFlextextFiles([{ name: 'dog.flextext', xml: TEXT }]);

  it('takes the writing systems from what the words and glosses use', () => {
    expect(ir.writingSystems).toEqual({ vernacular: ['xx', 'xx-Latn'], analysis: ['en', 'ru'] });
    expect(ir.wsUsage.wordForms).toEqual(['xx', 'xx-Latn']);
    expect(ir.wsUsage.freeTranslation).toEqual(['en', 'ru']);
    expect(ir.wsUsage.note).toEqual(['en', 'ru']);
    expect(ir.posWs).toBe('en');
    expect(ir.lexicon).toEqual([]);
  });

  it('builds documents the FLEx engine can write, aligned exactly', () => {
    const build = buildDocuments(ir);
    const [doc] = build.documents;
    expect(build.baselineWs).toBe('xx');
    expect(build.orthographyWss).toEqual(['xx-Latn']);
    expect(doc.body).toBe('Kici awai. It  barked.\n\nIti');
    expect(doc.warnings).toEqual([]);
    expect(doc.words.map((x) => doc.body.slice(x.begin, x.end))).toEqual([
      'Kici',
      'awai',
      'It',
      'barked',
      'Iti',
    ]);
    // The sentence layer partitions the body.
    expect(doc.sentences.map((s) => [s.begin, s.end])).toEqual([
      [0, 11],
      [11, 24],
      [24, 27],
    ]);
    expect(doc.name).toBe('Kici');
  });

  it('derives fields for every language the data is in', () => {
    const cfg = deriveImportConfig(ir, buildDocuments(ir));
    expect(cfg.fields.map((f) => `${f.scope}:${f.name}:${f.ws}`)).toEqual([
      'Word:Gloss (en):en',
      'Word:POS:en',
      'Morpheme:Gloss (en):en',
      'Morpheme:POS:en',
      'Sentence:Translation (en):en',
      'Sentence:Translation (ru):ru',
      'Sentence:Literal Translation (en):en',
      'Sentence:Note (en):en',
      'Sentence:Note (ru):ru',
    ]);
  });

  it('reads a text in two files once, and keys texts with no guid by file', () => {
    const bare = TEXT.replace('guid="t-1"', '').replace(
      /<item type="title"[^>]*>[^<]*<\/item>/g,
      '',
    );
    const many = parseFlextextFiles([
      { name: 'b.flextext', xml: TEXT },
      { name: 'a.flextext', xml: TEXT },
      { name: 'c.flextext', xml: bare },
      { name: 'c.flextext', xml: bare },
    ]);
    expect(many.texts.map((t) => t.guid)).toEqual(['t-1', 'c.flextext#1', 'c.flextext#1 (2)']);
    expect(many.warnings).toContain('“A dog” is in both a.flextext and b.flextext. Read once.');
    const names = buildDocuments(many).documents.map((d) => d.name);
    expect(names).toEqual(['c', 'c', 'Kici']);
  });

  it('keeps two untitled texts of one file apart', () => {
    const two = TEXT.replace(/<item type="title"[^>]*>[^<]*<\/item>/g, '')
      .replace('guid="t-1"', '')
      .replace(/(<interlinear-text[\s\S]*<\/interlinear-text>)/, '$1$1');
    const many = parseFlextextFiles([{ name: 'story.flextext', xml: two }]);
    expect(many.texts.map((t) => [t.guid, t.fallbackName])).toEqual([
      ['story.flextext#1', 'story 1'],
      ['story.flextext#2', 'story 2'],
    ]);
  });
});

describe('a .flextext Plaid wrote, read back', () => {
  const xml = buildFlextextDocument([makeFixtureDoc()], FLEXTEXT_OPTIONS);
  const ir = parseFlextextFiles([{ name: 'out.flextext', xml }]);
  const [doc] = buildDocuments(ir).documents;

  it('comes back with its text, words and morphemes', () => {
    expect(doc.body).toBe('perros corren.');
    expect(doc.name).toBe('Test & Doc');
    expect(doc.words.map((x) => [x.forms.spa, x.pos])).toEqual([
      ['perros', { en: 'NOUN' }],
      ['corren', { en: 'VERB' }],
    ]);
    expect(doc.words[0].forms['spa-x-translit']).toBe('perros-translit');
    expect(doc.words[0].morphemes.map((m) => [m.forms.spa, m.morphType, m.gloss?.en])).toEqual([
      ['perro', 'stem', 'dog'],
      ['s', 'enclitic', 'PL'],
    ]);
    expect(doc.sentences[0].freeTranslation).toEqual({ en: 'The dogs run.' });
    expect(doc.source).toEqual({ en: 'Field notes' });
    expect(doc.warnings).toEqual([]);
  });

  it('counts the lexical entries it leaves behind', () => {
    expect(ir.unread).toEqual([{ label: 'Lex. Entries', count: 1 }]);
  });
});

// A FLEx category is ONE thing with a name in each analysis writing system,
// and an export writes out every one the project has turned on. Both names
// are read so the import can be told which to take, and the one it leaves is
// counted as unread.
describe('a category named in more than one writing system', () => {
  const XML = `<?xml version="1.0" encoding="utf-8"?>
<document version="2">
  <interlinear-text guid="t-1">
    <item type="title" lang="en">Two names</item>
    <paragraphs><paragraph><phrases><phrase>
      <words>
        <word>
          <item type="txt" lang="pmy">makan</item>
          <item type="gls" lang="en">eat</item>
          <item type="pos" lang="en">v</item>
          <item type="pos" lang="id">kt.kerja</item>
          <morphemes>
            <morph type="stem">
              <item type="txt" lang="pmy">makan</item>
              <item type="gls" lang="en">eat</item>
              <item type="msa" lang="en">v</item>
              <item type="msa" lang="id">kt.kerja</item>
            </morph>
          </morphemes>
        </word>
      </words>
      <item type="gls" lang="en">eat</item>
    </phrase></phrases></paragraph></paragraphs>
    <languages>
      <language lang="pmy" vernacular="true" />
      <language lang="en" />
      <language lang="id" />
    </languages>
  </interlinear-text>
</document>`;
  const ir = parseFlextextFiles([{ name: 'two.flextext', xml: XML }]);
  const build = buildDocuments(ir);
  const [word] = build.documents[0].words;

  it('keeps every name, and offers them most used first', () => {
    expect(word.pos).toEqual({ en: 'v', id: 'kt.kerja' });
    expect(word.morphemes[0].pos).toEqual({ en: 'v', id: 'kt.kerja' });
    expect(ir.posWss).toEqual(['en', 'id']);
    expect(ir.posWs).toBe('en');
  });

  it('counts the name it does not read as unread', () => {
    expect(ir.unread).toContainEqual({
      label: 'Parts of speech in another writing system',
      count: 2,
    });
  });

  it('reads the one the import is told to, on words and morphemes alike', () => {
    for (const [ws, value] of [
      ['en', 'v'],
      ['id', 'kt.kerja'],
    ]) {
      const config = deriveImportConfig(ir, build, { posWs: ws });
      expect(config.posWs).toBe(ws);
      expect(config.fields.filter((f) => f.kind.endsWith('Pos')).map((f) => f.ws)).toEqual([
        ws,
        ws,
      ]);
      expect(word.pos[ws]).toBe(value);
      expect(word.morphemes[0].pos[ws]).toBe(value);
    }
  });
});
