import { describe, it, expect } from 'vitest';
import { buildFlextextDocument, phraseTimingFor, phraseSpeakerFor } from './flextext.js';
import {
  makeFixtureDoc, makeSentence, makeAlignmentToken, FLEXTEXT_OPTIONS,
} from './testFixtures.js';

const parse = (xml) => {
  const dom = new DOMParser().parseFromString(xml, 'text/xml');
  expect(dom.querySelector('parsererror')).toBeNull();
  return dom;
};

describe('buildFlextextDocument', () => {
  it('produces well-formed XML with the FLEx hierarchy', () => {
    const xml = buildFlextextDocument([makeFixtureDoc()], FLEXTEXT_OPTIONS);
    const dom = parse(xml);
    const doc = dom.querySelector('document');
    expect(doc.getAttribute('version')).toBe('2');
    expect(dom.querySelectorAll('interlinear-text').length).toBe(1);
    expect(dom.querySelectorAll('paragraph').length).toBe(1);
    expect(dom.querySelectorAll('phrase').length).toBe(1);
    expect(dom.querySelectorAll('word').length).toBe(3); // 2 tokens + 1 punct
    expect(dom.querySelectorAll('morph').length).toBe(2);
  });

  it('escapes XML specials in the title', () => {
    const xml = buildFlextextDocument([makeFixtureDoc()], FLEXTEXT_OPTIONS);
    expect(xml).toContain('Test &amp; Doc');
    const title = parse(xml).querySelector('interlinear-text > item[type="title"]');
    expect(title.textContent).toBe('Test & Doc');
    expect(title.getAttribute('lang')).toBe('spa');
  });

  it('emits document metadata as source/comment items', () => {
    const dom = parse(buildFlextextDocument([makeFixtureDoc()], FLEXTEXT_OPTIONS));
    expect(dom.querySelector('item[type="source"]').textContent).toBe('Field notes');
    expect(dom.querySelector('item[type="comment"]').textContent).toBe('Genre: narrative');
  });

  it('emits segnum, mapped phrase items, and omits empty values', () => {
    const dom = parse(buildFlextextDocument([makeFixtureDoc()], FLEXTEXT_OPTIONS));
    const phrase = dom.querySelector('phrase');
    expect(phrase.querySelector('item[type="segnum"]').textContent).toBe('1');
    expect(phrase.querySelector(':scope > item[type="gls"][lang="en"]').textContent).toBe('The dogs run.');
    // Note maps to "note" but its value is empty → omitted.
    expect(phrase.querySelector(':scope > item[type="note"]')).toBeNull();
  });

  it('emits word txt items per writing system plus mapped word fields', () => {
    const dom = parse(buildFlextextDocument([makeFixtureDoc()], FLEXTEXT_OPTIONS));
    const word = dom.querySelector('word');
    const txts = [...word.querySelectorAll(':scope > item[type="txt"]')];
    expect(txts.map((t) => [t.getAttribute('lang'), t.textContent])).toEqual([
      ['spa', 'perros'],
      ['spa-x-translit', 'perros-translit'],
    ]);
    expect(word.querySelector(':scope > item[type="pos"]').textContent).toBe('NOUN');
    // Second word's Translit value is '' → no second txt item.
    const word2 = dom.querySelectorAll('word')[1];
    expect(word2.querySelectorAll(':scope > item[type="txt"]').length).toBe(1);
  });

  it('emits morph type attribute, txt without affix markers, cf, and gloss', () => {
    const dom = parse(buildFlextextDocument([makeFixtureDoc()], FLEXTEXT_OPTIONS));
    const morphs = [...dom.querySelectorAll('morph')];
    expect(morphs[0].getAttribute('type')).toBe('stem');
    expect(morphs[1].getAttribute('type')).toBe('enclitic');
    expect(morphs[0].querySelector('item[type="txt"]').textContent).toBe('perro'); // no "-"/"="
    expect(morphs[0].querySelector('item[type="cf"]').textContent).toBe('perro');
    expect(morphs[1].querySelector('item[type="cf"]')).toBeNull(); // unlinked
    expect(morphs[1].querySelector('item[type="gls"]').textContent).toBe('PL');
  });

  it('omits the morph type attribute for unknown morph types', () => {
    const doc = makeFixtureDoc();
    doc.sortedSentences[0].tokens[0].morphemes[0].metadata.morphType = 'martian';
    doc.sortedSentences[0].pieces[0].morphemes[0].metadata.morphType = 'martian';
    const dom = parse(buildFlextextDocument([doc], FLEXTEXT_OPTIONS));
    expect(dom.querySelector('morph').hasAttribute('type')).toBe(false);
  });

  it('renders punctuation gaps as punct words and skips whitespace gaps', () => {
    const dom = parse(buildFlextextDocument([makeFixtureDoc()], FLEXTEXT_OPTIONS));
    const puncts = [...dom.querySelectorAll('item[type="punct"]')];
    expect(puncts.length).toBe(1);
    expect(puncts[0].textContent).toBe('.');
  });

  it('lists languages with vernacular flags, deduped', () => {
    const dom = parse(buildFlextextDocument([makeFixtureDoc()], FLEXTEXT_OPTIONS));
    const langs = [...dom.querySelectorAll('language')];
    expect(langs.map((l) => [l.getAttribute('lang'), l.getAttribute('vernacular')])).toEqual([
      ['spa', 'true'],
      ['spa-x-translit', 'true'],
      ['en', null],
    ]);
  });

  it('splits paragraphs on baseline newlines', () => {
    const t = (begin, end, content) => ({
      content, begin, end, annotations: {}, morphemes: [], orthographies: {},
    });
    const doc = {
      document: { name: 'P' },
      body: 'one\ntwo',
      sortedSentences: [
        makeSentence({ begin: 0, end: 3, tokens: [t(0, 3, 'one')] }),
        makeSentence({ begin: 4, end: 7, tokens: [t(4, 7, 'two')] }),
      ],
    };
    const dom = parse(buildFlextextDocument([doc], FLEXTEXT_OPTIONS));
    expect(dom.querySelectorAll('paragraph').length).toBe(2);
    const segnums = [...dom.querySelectorAll('item[type="segnum"]')].map((s) => s.textContent);
    expect(segnums).toEqual(['1', '2']);
  });

  it('wraps multiple documents as sibling interlinear-texts', () => {
    const dom = parse(buildFlextextDocument([makeFixtureDoc(), makeFixtureDoc()], FLEXTEXT_OPTIONS));
    expect(dom.querySelectorAll('document > interlinear-text').length).toBe(2);
  });

  it('degrades on minimal options and bare sentences (no pieces)', () => {
    const doc = {
      document: {},
      body: '',
      sortedSentences: [makeSentence({
        begin: 0, end: 1, pieces: undefined,
        tokens: [{ content: 'x', annotations: {}, morphemes: [] }],
      })],
    };
    doc.sortedSentences[0].pieces = undefined;
    const dom = parse(buildFlextextDocument([doc], {}));
    expect(dom.querySelector('word > item[type="txt"]').getAttribute('lang')).toBe('und');
  });
});

describe('phraseTimingFor', () => {
  const sentence = { begin: 0, end: 14 };

  it('uses a unique exact-extent token, rounding seconds to ms', () => {
    const timing = phraseTimingFor(sentence, [makeAlignmentToken('a', 0, 14, 1.2345, 3.5)]);
    expect(timing).toEqual({ beginMs: 1235, endMs: 3500 });
  });

  it('falls back to a unique containing token', () => {
    const timing = phraseTimingFor(sentence, [makeAlignmentToken('a', 0, 30, 0, 9.9)]);
    expect(timing).toEqual({ beginMs: 0, endMs: 9900 });
  });

  it('prefers an exact match over a containing one', () => {
    const timing = phraseTimingFor(sentence, [
      makeAlignmentToken('big', 0, 30, 0, 60),
      makeAlignmentToken('exact', 0, 14, 1, 2),
    ]);
    expect(timing).toEqual({ beginMs: 1000, endMs: 2000 });
  });

  it('skips on ambiguity and on partial overlap', () => {
    expect(phraseTimingFor(sentence, [
      makeAlignmentToken('a', 0, 30, 0, 5),
      makeAlignmentToken('b', 0, 20, 0, 5),
    ])).toBeNull();
    expect(phraseTimingFor(sentence, [makeAlignmentToken('a', 5, 14, 0, 5)])).toBeNull();
    expect(phraseTimingFor(sentence, [])).toBeNull();
  });
});

describe('phraseSpeakerFor', () => {
  const sentence = { begin: 0, end: 14 };
  const tok = (begin, end, speaker) => ({ id: `${begin}-${end}`, begin, end, metadata: { speaker } });

  it('returns the speaker of a unique exact-or-containing alignment', () => {
    expect(phraseSpeakerFor(sentence, [tok(0, 14, 'Ana')])).toBe('Ana');
    expect(phraseSpeakerFor(sentence, [tok(0, 30, 'Ben')])).toBe('Ben'); // containing
  });

  it('trims, and treats blank/absent speakers as none', () => {
    expect(phraseSpeakerFor(sentence, [tok(0, 14, '  Ana  ')])).toBe('Ana');
    expect(phraseSpeakerFor(sentence, [tok(0, 14, '   ')])).toBeNull();
    expect(phraseSpeakerFor(sentence, [{ id: 'a', begin: 0, end: 14, metadata: {} }])).toBeNull();
  });

  it('returns null on ambiguity or partial overlap (never guesses)', () => {
    // Two containing tokens, no exact match → ambiguous.
    expect(phraseSpeakerFor(sentence, [tok(0, 20, 'Ana'), tok(0, 30, 'Ben')])).toBeNull();
    expect(phraseSpeakerFor(sentence, [tok(5, 14, 'Ana')])).toBeNull(); // partial
    expect(phraseSpeakerFor(sentence, [])).toBeNull();
  });
});

describe('flextext speaker (diarization)', () => {
  const withSpeaker = (speaker, metaExtra = {}) => makeFixtureDoc({
    alignmentTokens: [{ id: 'a1', begin: 0, end: 14, metadata: { speaker, ...metaExtra } }],
  });

  it('emits a phrase speaker attribute from the covering alignment', () => {
    const dom = parse(buildFlextextDocument([withSpeaker('Speaker 1', { timeBegin: 1, timeEnd: 3 })], FLEXTEXT_OPTIONS));
    expect(dom.querySelector('phrase').getAttribute('speaker')).toBe('Speaker 1');
  });

  it('omits the attribute when no covering alignment carries a speaker', () => {
    const dom = parse(buildFlextextDocument([makeFixtureDoc()], FLEXTEXT_OPTIONS));
    expect(dom.querySelector('phrase').hasAttribute('speaker')).toBe(false);
  });

  it('escapes XML specials in the speaker', () => {
    const xml = buildFlextextDocument([withSpeaker('A & B')], FLEXTEXT_OPTIONS);
    expect(xml).toContain('speaker="A &amp; B"');
  });

  it('resolves a speaker independently of timing (segment with no valid times)', () => {
    const phrase = parse(buildFlextextDocument([withSpeaker('Ana')], FLEXTEXT_OPTIONS)).querySelector('phrase');
    expect(phrase.getAttribute('speaker')).toBe('Ana');
    expect(phrase.hasAttribute('begin-time-offset')).toBe(false);
  });
});

describe('flextext time alignment', () => {
  const timed = (opts = {}) => makeFixtureDoc({
    alignmentTokens: [makeAlignmentToken('a1', 0, 14, 1.25, 3.5)],
    mediaUrl: '/media/d1/recording.wav',
    ...opts,
  });

  it('emits phrase offsets in ms, media-file, and the media-files element', () => {
    const dom = parse(buildFlextextDocument([timed()], FLEXTEXT_OPTIONS));
    const phrase = dom.querySelector('phrase');
    expect(phrase.getAttribute('begin-time-offset')).toBe('1250');
    expect(phrase.getAttribute('end-time-offset')).toBe('3500');
    expect(phrase.getAttribute('media-file')).toBe('d1');
    const media = dom.querySelector('interlinear-text > media-files > media');
    expect(media.getAttribute('guid')).toBe('d1');
    expect(media.getAttribute('location')).toBe('recording.wav');
  });

  it('strips query strings from the media location and escapes specials', () => {
    const doc = timed({ mediaUrl: '/media/d1/a&b.wav?token=xyz' });
    const xml = buildFlextextDocument([doc], FLEXTEXT_OPTIONS);
    const dom = parse(xml);
    expect(dom.querySelector('media').getAttribute('location')).toBe('a&b.wav');
    expect(xml).toContain('location="a&amp;b.wav"');
  });

  it('falls back to the document name when the mediaUrl has no filename (server endpoint shape)', () => {
    const doc = timed({ mediaUrl: '/api/v1/documents/d1/media' });
    const dom = parse(buildFlextextDocument([doc], FLEXTEXT_OPTIONS));
    expect(dom.querySelector('media').getAttribute('location')).toBe('Test & Doc');
  });

  it('emits offsets without media-file when the document has no media', () => {
    const doc = makeFixtureDoc({ alignmentTokens: [makeAlignmentToken('a1', 0, 14, 1, 2)] });
    const dom = parse(buildFlextextDocument([doc], FLEXTEXT_OPTIONS));
    const phrase = dom.querySelector('phrase');
    expect(phrase.getAttribute('begin-time-offset')).toBe('1000');
    expect(phrase.hasAttribute('media-file')).toBe(false);
    expect(dom.querySelector('media-files')).toBeNull();
  });

  it('ignores alignment tokens with invalid times', () => {
    const doc = makeFixtureDoc({
      alignmentTokens: [{ id: 'a1', begin: 0, end: 14, metadata: { timeBegin: 1 } }],
      mediaUrl: '/media/d1/x.wav',
    });
    const dom = parse(buildFlextextDocument([doc], FLEXTEXT_OPTIONS));
    expect(dom.querySelector('phrase').hasAttribute('begin-time-offset')).toBe(false);
    expect(dom.querySelector('media-files')).toBeNull();
  });

  it('is byte-identical to the untimed output when no alignment exists', () => {
    expect(buildFlextextDocument([makeFixtureDoc()], FLEXTEXT_OPTIONS))
      .toBe(buildFlextextDocument([makeFixtureDoc({ alignmentTokens: undefined })], FLEXTEXT_OPTIONS));
    const dom = parse(buildFlextextDocument([makeFixtureDoc()], FLEXTEXT_OPTIONS));
    expect(dom.querySelector('phrase').hasAttribute('begin-time-offset')).toBe(false);
  });
});
