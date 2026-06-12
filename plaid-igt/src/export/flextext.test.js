import { describe, it, expect } from 'vitest';
import { buildFlextextDocument } from './flextext.js';
import { makeFixtureDoc, makeSentence, FLEXTEXT_OPTIONS } from './testFixtures.js';

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
