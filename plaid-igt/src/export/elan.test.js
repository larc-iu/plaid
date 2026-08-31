import { describe, it, expect } from 'vitest';
import {
  buildEafDocument,
  containedAlignments,
  sentenceTiming,
  sentenceSpeaker,
  elanLossSummary,
  defaultElanOptions,
} from './elan.js';
import { makeFixtureDoc, makeSentence, makeAlignmentToken } from './testFixtures.js';

const CONTEXT = { exportedAt: '2026-08-31T12:00:00.000Z' };

const OPTIONS = {
  orthographies: ['Translit'],
  wordFields: ['POS'],
  morphFields: ['Gloss'],
  sentFields: ['Translation', 'Note'],
  segmentMorphemes: true,
  affixMarkers: true,
  perSpeaker: true,
};

const parse = (xml) => {
  const dom = new DOMParser().parseFromString(xml, 'text/xml');
  expect(dom.querySelector('parsererror')).toBeNull();
  return dom;
};

const build = (doc, options = OPTIONS, context = CONTEXT) =>
  parse(buildEafDocument(doc, options, context));

// happy-dom's CSS selector parser rejects underscores in tag names, and every
// EAF element name has one, so the tree is addressed by tag rather than query.
const all = (node, tag) => [...node.getElementsByTagName(tag)];
const one = (node, tag) => node.getElementsByTagName(tag)[0] ?? null;
const withAttr = (node, tag, name, value) =>
  all(node, tag).find((n) => n.getAttribute(name) === value) ?? null;

const tierNamed = (dom, id) => withAttr(dom, 'TIER', 'TIER_ID', id);
const valuesOf = (tier) => all(tier, 'ANNOTATION_VALUE').map((n) => n.textContent);
const annotationIds = (dom) =>
  [...all(dom, 'ALIGNABLE_ANNOTATION'), ...all(dom, 'REF_ANNOTATION')].map((n) =>
    n.getAttribute('ANNOTATION_ID'),
  );

// A two-sentence document sharing one body, for the timing/speaker cases.
// "uno dos" [0,7) and "tres" [8,12).
const twoSentenceDoc = (alignmentTokens = []) => {
  const tok = (id, begin, end, content) => ({
    id,
    begin,
    end,
    content,
    metadata: {},
    orthographies: {},
    annotations: {},
    vocabItem: null,
    morphemes: [],
  });
  return {
    document: { id: 'd2', name: 'Two', mediaUrl: null, metadata: {} },
    body: 'uno dos tres',
    sortedSentences: [
      makeSentence({ begin: 0, end: 7, tokens: [tok('t1', 0, 3, 'uno'), tok('t2', 4, 7, 'dos')] }),
      makeSentence({ begin: 8, end: 12, tokens: [tok('t3', 8, 12, 'tres')] }),
    ],
    alignmentTokens,
  };
};

describe('buildEafDocument', () => {
  it('produces a well-formed EAF 2.8 document', () => {
    const dom = build(makeFixtureDoc());
    const root = dom.documentElement;
    expect(root.tagName).toBe('ANNOTATION_DOCUMENT');
    expect(root.getAttribute('VERSION')).toBe('2.8');
    expect(root.getAttribute('FORMAT')).toBe('2.8');
    expect(root.getAttribute('DATE')).toBe(CONTEXT.exportedAt);
    expect(root.getAttribute('AUTHOR')).toBe('plaid-igt');
    expect(root.getAttribute('xsi:noNamespaceSchemaLocation')).toBe(
      'http://www.mpi.nl/tools/elan/EAFv2.8.xsd',
    );
    expect(one(dom, 'HEADER').getAttribute('TIME_UNITS')).toBe('milliseconds');
  });

  it('writes all four stereotypes and the linguistic types, as ELAN does', () => {
    const dom = build(makeFixtureDoc());
    expect(all(dom, 'CONSTRAINT').map((c) => c.getAttribute('STEREOTYPE'))).toEqual([
      'Time_Subdivision',
      'Symbolic_Subdivision',
      'Symbolic_Association',
      'Included_In',
    ]);
    const types = all(dom, 'LINGUISTIC_TYPE');
    const byId = Object.fromEntries(types.map((t) => [t.getAttribute('LINGUISTIC_TYPE_ID'), t]));
    expect(byId.Sentence.getAttribute('TIME_ALIGNABLE')).toBe('true');
    expect(byId.Sentence.getAttribute('CONSTRAINTS')).toBeNull();
    expect(byId.Segment.getAttribute('CONSTRAINTS')).toBe('Included_In');
    expect(byId.Word.getAttribute('CONSTRAINTS')).toBe('Symbolic_Subdivision');
    expect(byId.Word.getAttribute('TIME_ALIGNABLE')).toBe('false');
    expect(byId.Annotation.getAttribute('CONSTRAINTS')).toBe('Symbolic_Association');
  });

  it('builds the sentence > word > morph tier tree with the right parents', () => {
    const dom = build(makeFixtureDoc());
    expect(tierNamed(dom, 'Sentence').getAttribute('PARENT_REF')).toBeNull();
    expect(tierNamed(dom, 'Word').getAttribute('PARENT_REF')).toBe('Sentence');
    expect(tierNamed(dom, 'Word').getAttribute('LINGUISTIC_TYPE_REF')).toBe('Word');
    expect(tierNamed(dom, 'Morph').getAttribute('PARENT_REF')).toBe('Word');
    expect(tierNamed(dom, 'POS').getAttribute('PARENT_REF')).toBe('Word');
    expect(tierNamed(dom, 'Translit').getAttribute('PARENT_REF')).toBe('Word');
    expect(tierNamed(dom, 'Gloss').getAttribute('PARENT_REF')).toBe('Morph');
    expect(tierNamed(dom, 'Translation').getAttribute('PARENT_REF')).toBe('Sentence');
  });

  it('carries the sentence text, the words, and the morphemes with affix markers', () => {
    const dom = build(makeFixtureDoc());
    expect(valuesOf(tierNamed(dom, 'Sentence'))).toEqual(['perros corren.']);
    // Punctuation is not a word: ELAN has no equivalent of FLEx's punct item.
    expect(valuesOf(tierNamed(dom, 'Word'))).toEqual(['perros', 'corren']);
    // "s" is an enclitic, so the joint is "=" rather than "-".
    expect(valuesOf(tierNamed(dom, 'Morph'))).toEqual(['perro', '=s']);
    expect(valuesOf(tierNamed(dom, 'Gloss'))).toEqual(['dog', 'PL']);
    expect(valuesOf(tierNamed(dom, 'POS'))).toEqual(['NOUN', 'VERB']);
  });

  it('omits affix markers when asked, for exact-form searching', () => {
    const dom = build(makeFixtureDoc(), { ...OPTIONS, affixMarkers: false });
    expect(valuesOf(tierNamed(dom, 'Morph'))).toEqual(['perro', 's']);
  });

  it('drops the Morph tier and its fields when segmentation is off', () => {
    const dom = build(makeFixtureDoc(), { ...OPTIONS, segmentMorphemes: false });
    expect(tierNamed(dom, 'Morph')).toBeNull();
    expect(tierNamed(dom, 'Gloss')).toBeNull();
    expect(tierNamed(dom, 'Word')).not.toBeNull();
  });

  it('chains symbolic subdivisions with PREVIOUS_ANNOTATION', () => {
    const dom = build(makeFixtureDoc());
    const refs = all(tierNamed(dom, 'Word'), 'REF_ANNOTATION');
    expect(refs[0].getAttribute('PREVIOUS_ANNOTATION')).toBeNull();
    expect(refs[1].getAttribute('PREVIOUS_ANNOTATION')).toBe(refs[0].getAttribute('ANNOTATION_ID'));
    // Both words hang off the one sentence annotation.
    const sentenceId = one(dom, 'ALIGNABLE_ANNOTATION').getAttribute('ANNOTATION_ID');
    expect(refs.map((r) => r.getAttribute('ANNOTATION_REF'))).toEqual([sentenceId, sentenceId]);
  });

  it('omits an association annotation where the value is empty', () => {
    const dom = build(makeFixtureDoc());
    // "corren" has an empty Translit and the sentence has an empty Note.
    expect(valuesOf(tierNamed(dom, 'Translit'))).toEqual(['perros-translit']);
    expect(tierNamed(dom, 'Note')).toBeNull();
    expect(valuesOf(tierNamed(dom, 'Translation'))).toEqual(['The dogs run.']);
  });

  it('escapes XML specials', () => {
    const xml = buildEafDocument(makeFixtureDoc(), OPTIONS, CONTEXT);
    expect(xml).toContain('Test &amp; Doc');
    expect(withAttr(parse(xml), 'PROPERTY', 'NAME', 'documentName').textContent).toBe('Test & Doc');
  });

  it('carries document metadata as HEADER properties', () => {
    const dom = build(makeFixtureDoc());
    const props = Object.fromEntries(
      all(dom, 'PROPERTY').map((p) => [p.getAttribute('NAME'), p.textContent]),
    );
    expect(props.Source).toBe('Field notes');
    expect(props.Genre).toBe('narrative');
  });
});

describe('time alignment', () => {
  it('gives a sentence the span of the alignment tokens inside it, in milliseconds', () => {
    const dom = build(
      makeFixtureDoc({ alignmentTokens: [makeAlignmentToken('a1', 0, 14, 1.25, 3.5)] }),
    );
    const ann = one(dom, 'ALIGNABLE_ANNOTATION');
    const slotValue = (id) =>
      withAttr(dom, 'TIME_SLOT', 'TIME_SLOT_ID', id).getAttribute('TIME_VALUE');
    expect(slotValue(ann.getAttribute('TIME_SLOT_REF1'))).toBe('1250');
    expect(slotValue(ann.getAttribute('TIME_SLOT_REF2'))).toBe('3500');
  });

  it('spans several contained alignments and exposes them on an Included_In tier', () => {
    const doc = twoSentenceDoc([
      makeAlignmentToken('a1', 0, 3, 0.5, 1.0),
      makeAlignmentToken('a2', 4, 7, 1.0, 2.0),
      makeAlignmentToken('a3', 8, 12, 3.0, 4.0),
    ]);
    const dom = build(doc);
    const segments = tierNamed(dom, 'Segment');
    expect(segments.getAttribute('PARENT_REF')).toBe('Sentence');
    expect(segments.getAttribute('LINGUISTIC_TYPE_REF')).toBe('Segment');
    expect(valuesOf(segments)).toEqual(['uno', 'dos', 'tres']);

    // Sentence 1 spans a1..a2, sentence 2 is exactly a3.
    const slot = (id) => withAttr(dom, 'TIME_SLOT', 'TIME_SLOT_ID', id).getAttribute('TIME_VALUE');
    const sentenceAnns = all(tierNamed(dom, 'Sentence'), 'ALIGNABLE_ANNOTATION');
    expect(
      sentenceAnns.map((a) => [
        slot(a.getAttribute('TIME_SLOT_REF1')),
        slot(a.getAttribute('TIME_SLOT_REF2')),
      ]),
    ).toEqual([
      ['500', '2000'],
      ['3000', '4000'],
    ]);
  });

  it('omits the Segment tier when it would only duplicate its parent', () => {
    const dom = build(twoSentenceDoc([makeAlignmentToken('a1', 0, 7, 0.5, 2.0)]));
    expect(tierNamed(dom, 'Segment')).toBeNull();
  });

  it('leaves a sentence unaligned rather than inventing a time', () => {
    // One token straddling both sentences belongs to neither.
    const dom = build(twoSentenceDoc([makeAlignmentToken('a1', 0, 12, 0.5, 4.0)]));
    for (const slot of all(dom, 'TIME_SLOT')) {
      expect(slot.getAttribute('TIME_VALUE')).toBeNull();
    }
    // The document is still complete: every sentence and word is there.
    expect(valuesOf(tierNamed(dom, 'Sentence'))).toEqual(['uno dos', 'tres']);
  });

  it('exports an unaligned document with value-less time slots', () => {
    const dom = build(makeFixtureDoc());
    const slots = all(dom, 'TIME_SLOT');
    expect(slots).toHaveLength(2);
    expect(slots.every((s) => s.getAttribute('TIME_VALUE') === null)).toBe(true);
    expect(all(dom, 'ALIGNABLE_ANNOTATION')).toHaveLength(1);
  });

  it('ignores alignment tokens with unusable times', () => {
    const dom = build(
      twoSentenceDoc([
        { id: 'bad', begin: 0, end: 7, metadata: { timeBegin: 2, timeEnd: 1 } },
        { id: 'none', begin: 8, end: 12, metadata: {} },
      ]),
    );
    for (const slot of all(dom, 'TIME_SLOT')) {
      expect(slot.getAttribute('TIME_VALUE')).toBeNull();
    }
  });

  it('emits TIME_ORDER in non-decreasing order', () => {
    const dom = build(
      twoSentenceDoc([
        makeAlignmentToken('a1', 0, 3, 0.5, 1.0),
        makeAlignmentToken('a2', 4, 7, 1.0, 2.0),
        makeAlignmentToken('a3', 8, 12, 3.0, 4.0),
      ]),
    );
    const values = all(dom, 'TIME_SLOT')
      .map((s) => s.getAttribute('TIME_VALUE'))
      .filter((v) => v !== null)
      .map(Number);
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });
});

// The EAF 2.8 spec states two constraints in prose that its schema cannot
// express, so neither xmllint nor a third-party parser catches a violation:
//   - Annotations on the same tier cannot (time-wise) overlap
//   - A mix of alignable and reference annotations on the same tier is not allowed
const expectBaseConstraints = (dom) => {
  for (const tier of all(dom, 'TIER')) {
    const kinds = new Set(
      all(tier, 'ANNOTATION').map((a) =>
        a.getElementsByTagName('ALIGNABLE_ANNOTATION').length ? 'alignable' : 'ref',
      ),
    );
    expect(kinds.size, `tier ${tier.getAttribute('TIER_ID')} mixes annotation kinds`).toBeLessThan(
      2,
    );
    const slot = (id) =>
      Number(withAttr(dom, 'TIME_SLOT', 'TIME_SLOT_ID', id)?.getAttribute('TIME_VALUE'));
    const timed = all(tier, 'ALIGNABLE_ANNOTATION')
      .map((a) => ({
        begin: slot(a.getAttribute('TIME_SLOT_REF1')),
        end: slot(a.getAttribute('TIME_SLOT_REF2')),
      }))
      .filter((x) => Number.isFinite(x.begin) && Number.isFinite(x.end))
      .sort((a, b) => a.begin - b.begin);
    for (let i = 1; i < timed.length; i++) {
      expect(
        timed[i].begin,
        `tier ${tier.getAttribute('TIER_ID')} has time-overlapping annotations`,
      ).toBeGreaterThanOrEqual(timed[i - 1].end);
    }
  }
};

describe("EAF's base constraints", () => {
  // Two people talking over each other. With the tiers not split by speaker
  // their sentences land on the SAME tier, which is where the overlap bites.
  const overlappingSpeech = () =>
    twoSentenceDoc([
      makeAlignmentToken('a1', 0, 7, 1.0, 5.0, 'Ana'),
      makeAlignmentToken('a2', 8, 12, 3.0, 7.0, 'Bo'),
    ]);

  it('holds for an ordinary document', () => {
    expectBaseConstraints(
      build(makeFixtureDoc({ alignmentTokens: [makeAlignmentToken('a1', 0, 14, 1, 3)] })),
    );
    expectBaseConstraints(build(overlappingSpeech()));
  });

  it('writes an overlapping sentence without times rather than an illegal file', () => {
    const warnings = [];
    const dom = parse(
      buildEafDocument(
        overlappingSpeech(),
        { ...OPTIONS, perSpeaker: false },
        {
          ...CONTEXT,
          onWarning: (m) => warnings.push(m),
        },
      ),
    );
    expectBaseConstraints(dom);
    // Both sentences are still there; only the later one's time is given up.
    expect(valuesOf(tierNamed(dom, 'Sentence'))).toEqual(['uno dos', 'tres']);
    const values = all(dom, 'TIME_SLOT').map((t) => t.getAttribute('TIME_VALUE'));
    expect(values.filter((v) => v !== null)).toEqual(['1000', '5000']);
    expect(warnings[0]).toMatch(/overlap in time/);
  });

  it('keeps both alignments when the tiers are split by speaker', () => {
    const warnings = [];
    const dom = parse(
      buildEafDocument(
        overlappingSpeech(),
        { ...OPTIONS, perSpeaker: true },
        {
          ...CONTEXT,
          onWarning: (m) => warnings.push(m),
        },
      ),
    );
    expectBaseConstraints(dom);
    expect(warnings).toEqual([]);
    const slot = (id) => withAttr(dom, 'TIME_SLOT', 'TIME_SLOT_ID', id).getAttribute('TIME_VALUE');
    const ann = (tier) => all(tierNamed(dom, tier), 'ALIGNABLE_ANNOTATION')[0];
    expect(slot(ann('Sentence@Ana').getAttribute('TIME_SLOT_REF1'))).toBe('1000');
    expect(slot(ann('Sentence@Bo').getAttribute('TIME_SLOT_REF1'))).toBe('3000');
  });
});

describe('referential integrity', () => {
  const doc = twoSentenceDoc([
    makeAlignmentToken('a1', 0, 3, 0.5, 1.0),
    makeAlignmentToken('a2', 4, 7, 1.0, 2.0),
    makeAlignmentToken('a3', 8, 12, 3.0, 4.0),
  ]);

  it('mints unique NCName annotation ids and resolves every reference', () => {
    const dom = build(doc);
    const ids = annotationIds(dom);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z_][\w.-]*$/);

    const known = new Set(ids);
    for (const ref of all(dom, 'REF_ANNOTATION')) {
      expect(known.has(ref.getAttribute('ANNOTATION_REF'))).toBe(true);
      const prev = ref.getAttribute('PREVIOUS_ANNOTATION');
      if (prev) expect(known.has(prev)).toBe(true);
    }
    const slots = new Set(all(dom, 'TIME_SLOT').map((s) => s.getAttribute('TIME_SLOT_ID')));
    for (const ann of all(dom, 'ALIGNABLE_ANNOTATION')) {
      expect(slots.has(ann.getAttribute('TIME_SLOT_REF1'))).toBe(true);
      expect(slots.has(ann.getAttribute('TIME_SLOT_REF2'))).toBe(true);
    }
  });

  it('keeps TIER_IDs unique when a field collides with a structural tier', () => {
    // A sentence field literally named "Word" must not claim the Word tier's id.
    const collide = twoSentenceDoc();
    collide.sortedSentences[0].annotations = { Word: { value: 'clash' } };
    const dom = build(collide, { ...OPTIONS, wordFields: [], sentFields: ['Word'] });
    const ids = all(dom, 'TIER').map((t) => t.getAttribute('TIER_ID'));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('Word');
    expect(ids).toContain('Word-2');
    expect(valuesOf(tierNamed(dom, 'Word-2'))).toEqual(['clash']);
    expect(tierNamed(dom, 'Word-2').getAttribute('PARENT_REF')).toBe('Sentence');
    // Every PARENT_REF names a tier that exists.
    const known = new Set(ids);
    for (const t of all(dom, 'TIER').filter((x) => x.getAttribute('PARENT_REF'))) {
      expect(known.has(t.getAttribute('PARENT_REF'))).toBe(true);
    }
  });

  it('references a linguistic type that is declared', () => {
    const dom = build(doc);
    const declared = new Set(
      all(dom, 'LINGUISTIC_TYPE').map((t) => t.getAttribute('LINGUISTIC_TYPE_ID')),
    );
    for (const t of all(dom, 'TIER')) {
      expect(declared.has(t.getAttribute('LINGUISTIC_TYPE_REF'))).toBe(true);
    }
  });
});

describe('speakers', () => {
  const speakerDoc = () =>
    twoSentenceDoc([
      makeAlignmentToken('a1', 0, 7, 0.5, 2.0, 'Ana'),
      makeAlignmentToken('a2', 8, 12, 3.0, 4.0, 'Bo'),
    ]);

  it('splits one tier set per speaker, suffixed and tagged with PARTICIPANT', () => {
    const dom = build(speakerDoc());
    expect(tierNamed(dom, 'Sentence@Ana').getAttribute('PARTICIPANT')).toBe('Ana');
    expect(tierNamed(dom, 'Sentence@Bo').getAttribute('PARTICIPANT')).toBe('Bo');
    expect(valuesOf(tierNamed(dom, 'Sentence@Ana'))).toEqual(['uno dos']);
    expect(valuesOf(tierNamed(dom, 'Sentence@Bo'))).toEqual(['tres']);
    expect(tierNamed(dom, 'Word@Ana').getAttribute('PARENT_REF')).toBe('Sentence@Ana');
    expect(valuesOf(tierNamed(dom, 'Word@Bo'))).toEqual(['tres']);
    // Linguistic types are shared across speakers, not duplicated.
    expect(all(dom, 'LINGUISTIC_TYPE')).toHaveLength(5);
  });

  it('keeps one tier set when the split is switched off', () => {
    const dom = build(speakerDoc(), { ...OPTIONS, perSpeaker: false });
    expect(tierNamed(dom, 'Sentence@Ana')).toBeNull();
    expect(valuesOf(tierNamed(dom, 'Sentence'))).toEqual(['uno dos', 'tres']);
  });

  it('takes the speaker from the segments inside a sentence, not only a covering one', () => {
    // Sentence 1 holds TWO segments by Ana. The covering-token rule the
    // .flextext export uses finds nothing here, but the speaker is unambiguous.
    const dom = build(
      twoSentenceDoc([
        makeAlignmentToken('a1', 0, 3, 0.5, 1.0, 'Ana'),
        makeAlignmentToken('a2', 4, 7, 1.0, 2.0, 'Ana'),
        makeAlignmentToken('a3', 8, 12, 3.0, 4.0, 'Bo'),
      ]),
    );
    expect(valuesOf(tierNamed(dom, 'Sentence@Ana'))).toEqual(['uno dos']);
    expect(valuesOf(tierNamed(dom, 'Sentence@Bo'))).toEqual(['tres']);
    expect(tierNamed(dom, 'Sentence')).toBeNull();
  });

  it('files a sentence under no speaker when its segments disagree', () => {
    const dom = build(
      twoSentenceDoc([
        makeAlignmentToken('a1', 0, 3, 0.5, 1.0, 'Ana'),
        makeAlignmentToken('a2', 4, 7, 1.0, 2.0, 'Bo'),
        makeAlignmentToken('a3', 8, 12, 3.0, 4.0, 'Bo'),
      ]),
    );
    expect(valuesOf(tierNamed(dom, 'Sentence'))).toEqual(['uno dos']);
    expect(valuesOf(tierNamed(dom, 'Sentence@Bo'))).toEqual(['tres']);
  });

  it('keeps one tier set when no segment names a speaker', () => {
    const dom = build(twoSentenceDoc([makeAlignmentToken('a1', 0, 7, 0.5, 2.0)]));
    expect(tierNamed(dom, 'Sentence')).not.toBeNull();
    expect(tierNamed(dom, 'Sentence').getAttribute('PARTICIPANT')).toBeNull();
  });
});

describe('media', () => {
  it('omits the descriptor when the document has no media', () => {
    expect(one(build(makeFixtureDoc()), 'MEDIA_DESCRIPTOR')).toBeNull();
  });

  it('uses the caller-computed relative href and its mime type', () => {
    const dom = build(makeFixtureDoc({ mediaUrl: '/api/v1/documents/d1/media' }), OPTIONS, {
      ...CONTEXT,
      mediaHref: '../media/Test Doc.wav',
      mediaType: 'audio/vnd.wave',
    });
    const media = one(dom, 'MEDIA_DESCRIPTOR');
    expect(media.getAttribute('RELATIVE_MEDIA_URL')).toBe('../media/Test Doc.wav');
    expect(media.getAttribute('MEDIA_URL')).toBe('Test Doc.wav');
    expect(media.getAttribute('MIME_TYPE')).toBe('audio/vnd.wave');
  });

  it('falls back to a name from the document when there is no href', () => {
    const dom = build(makeFixtureDoc({ mediaUrl: '/api/v1/documents/d1/media' }));
    const media = one(dom, 'MEDIA_DESCRIPTOR');
    // The endpoint path carries no filename, so the document name stands in.
    expect(media.getAttribute('MEDIA_URL')).toBe('Test & Doc');
    expect(media.getAttribute('MIME_TYPE')).toBe('audio/x-wav');
  });

  it('guesses a mime type from the extension when none was served', () => {
    const dom = build(makeFixtureDoc({ mediaUrl: '/media/rec.mp4' }), OPTIONS, CONTEXT);
    expect(one(dom, 'MEDIA_DESCRIPTOR').getAttribute('MIME_TYPE')).toBe('video/mp4');
  });
});

describe('helpers', () => {
  it('containedAlignments takes only tokens wholly inside, in text order', () => {
    const sentence = { begin: 5, end: 15 };
    const tokens = [
      makeAlignmentToken('inside2', 10, 15, 2, 3),
      makeAlignmentToken('inside1', 5, 9, 1, 2),
      makeAlignmentToken('straddle', 3, 8, 0, 1),
      makeAlignmentToken('outside', 16, 20, 4, 5),
    ];
    expect(containedAlignments(sentence, tokens).map((t) => t.id)).toEqual(['inside1', 'inside2']);
  });

  it('sentenceSpeaker falls back to a covering token when nothing is inside', () => {
    const sentence = { begin: 4, end: 7 };
    expect(sentenceSpeaker(sentence, [makeAlignmentToken('a', 0, 12, 1, 2, 'Ana')])).toBe('Ana');
    expect(sentenceSpeaker(sentence, [])).toBeNull();
    // A blank speaker on the one contained token is not a speaker.
    expect(sentenceSpeaker(sentence, [makeAlignmentToken('a', 4, 7, 1, 2, '  ')])).toBeNull();
  });

  it('sentenceTiming is null without a contained token', () => {
    expect(sentenceTiming({ begin: 0, end: 5 }, [])).toBeNull();
    expect(sentenceTiming({ begin: 0, end: 5 }, [makeAlignmentToken('a', 0, 9, 1, 2)])).toBeNull();
  });

  it('elanLossSummary names the tiers kept and dropped', () => {
    const layers = {
      orthographies: ['Translit'],
      wordFields: ['POS'],
      morphFields: ['Gloss'],
      sentFields: ['Translation', 'Note'],
      hasMorphemes: true,
    };
    const summary = elanLossSummary(layers, { ...OPTIONS, sentFields: ['Translation'] });
    expect(summary.tiers).toContain('Gloss (morpheme field)');
    expect(summary.dropped).toEqual(['Note (sentence field)']);
    expect(summary.morphemesDropped).toBe(false);

    const off = elanLossSummary(layers, { ...OPTIONS, segmentMorphemes: false });
    expect(off.dropped).toContain('Gloss (morpheme field)');
    expect(off.morphemesDropped).toBe(true);
  });

  it('defaultElanOptions selects everything discovered', () => {
    const options = defaultElanOptions({
      orthographies: ['IPA'],
      wordFields: ['POS'],
      morphFields: ['Gloss'],
      sentFields: ['Translation'],
      hasMorphemes: true,
    });
    expect(options).toMatchObject({
      orthographies: ['IPA'],
      sentFields: ['Translation'],
      segmentMorphemes: true,
      perSpeaker: true,
    });
  });
});

describe('degenerate input', () => {
  it('serializes a document with no sentences', () => {
    const dom = build({
      document: { id: 'e', name: 'Empty', mediaUrl: null, metadata: {} },
      body: '',
      sortedSentences: [],
      alignmentTokens: [],
    });
    expect(all(dom, 'TIER')).toHaveLength(0);
    expect(all(dom, 'TIME_SLOT')).toHaveLength(0);
    expect(all(dom, 'LINGUISTIC_TYPE')).toHaveLength(5);
  });

  it('tolerates a bare document object', () => {
    const dom = build({}, {}, CONTEXT);
    expect(dom.documentElement.tagName).toBe('ANNOTATION_DOCUMENT');
  });
});
