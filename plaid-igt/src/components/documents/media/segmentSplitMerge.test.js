// Splitting and merging segments on the Media tab. A segment is a token on
// the alignment layer beside the sentences and the words, so neither changes
// the baseline or anything on it: the words, their glosses and the sentence's
// translation are all still there, and only the segments and their times
// change. The left half of a split keeps the segment, the right half is new
// under an id this page minted, and a merge keeps the earlier segment.
import { describe, it, expect, beforeEach } from 'vitest';
import { buildRawDoc, resetIds, makeIgtDoc, settle } from '../../../domain/test-helpers.js';
import { segmentCuts } from '../../../domain/mutations/alignment.js';
import { isPendingId } from '@ui/domain/pendingIds.js';

//            0         1         2
//            0123456789012345678901234567
const BODY = 'he saw a fish and he laughed';
const wordsOf = (body) =>
  [...body.matchAll(/\S+/g)].map((m, i) => ({
    id: `w-${i + 1}`,
    begin: m.index,
    end: m.index + m[0].length,
  }));

// One segment over the whole text, 3.0 to 6.0 s, Tom's, glosses on every
// morpheme and a translation on the sentence.
const annotated = ({ alignmentTokens } = {}) => {
  const words = wordsOf(BODY);
  const raw = buildRawDoc({
    body: BODY,
    words,
    alignmentTokens: alignmentTokens ?? [
      {
        id: 'seg-1',
        text: 'text-1',
        begin: 0,
        end: BODY.length,
        metadata: { timeBegin: 3, timeEnd: 6, speaker: 'Tom' },
      },
    ],
  });
  const layers = raw.textLayers[0].tokenLayers;
  const morphs = layers.find((l) => l.id === 'morphL');
  morphs.spanLayers[0].spans = morphs.tokens.map((m, i) => ({
    id: `g-${i + 1}`,
    tokens: [m.id],
    value: `GL${i + 1}`,
  }));
  layers.find((l) => l.id === 'sentL').spanLayers[0].spans = [
    { id: 'tr-1', tokens: ['s-1'], value: 'He saw a fish and laughed.' },
  ];
  return raw;
};

// Everything on the text but the segments, as the document shows it.
const annotation = (doc) => {
  const layers = doc.layerInfo.primaryTextLayer.tokenLayers.filter((l) => l.id !== 'alignL');
  return JSON.stringify({
    body: doc.body,
    tokens: layers.map((l) => l.tokens.map((t) => [t.id, t.begin, t.end])),
    spans: layers.map((l) => l.spanLayers.map((sl) => sl.spans)),
  });
};

const segments = (doc) =>
  [...doc.alignmentTokens]
    .sort((a, b) => a.begin - b.begin)
    .map((t) => ({
      text: doc.body.slice(t.begin, t.end),
      timeBegin: t.metadata.timeBegin,
      timeEnd: t.metadata.timeEnd,
      speaker: t.metadata.speaker,
    }));

// The writes sent, without the batch's own bookkeeping.
const writes = (doc) => doc.client.calls.filter((c) => /^(tokens|texts|spans)\./.test(c.kind));
const kinds = (doc) => writes(doc).map((c) => c.kind);

beforeEach(() => resetIds());

describe('splitting a segment', () => {
  it('cuts the text between words at the caret and the time at playback, and keeps every annotation', async () => {
    const doc = makeIgtDoc({ raw: annotated() });
    const before = annotation(doc);
    // The caret just before "and".
    const ok = await doc.splitSegment('seg-1', { time: 4.5, at: 14 });
    expect(ok).not.toBe(false);
    expect(segments(doc)).toEqual([
      { text: 'he saw a fish', timeBegin: 3, timeEnd: 4.5, speaker: 'Tom' },
      { text: 'and he laughed', timeBegin: 4.5, timeEnd: 6, speaker: 'Tom' },
    ]);
    expect(annotation(doc)).toBe(before);
    // One batch: the split under a minted id, the left half trimmed off the
    // space, the halves' times. Nothing deleted, no text written.
    expect(kinds(doc)).toEqual([
      'tokens.split',
      'tokens.update',
      'tokens.patchMetadata',
      'tokens.patchMetadata',
    ]);
    const [split, update] = writes(doc);
    expect(split.args.slice(0, 2)).toEqual(['seg-1', 14]);
    expect(isPendingId(split.args[3].id)).toBe(false);
    expect(split.args[3].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(update.args).toEqual(['seg-1', undefined, 13]);
    // The left half keeps the segment.
    expect(doc.alignmentTokens.find((t) => t.id === 'seg-1').end).toBe(13);
  });

  it('cuts the text in proportion to the time when no caret says where', () => {
    const doc = makeIgtDoc({ raw: annotated() });
    // Two thirds of the way through the time is two thirds of the text, the
    // gap before "he" at 18.
    expect(doc.segmentSplitPlan('seg-1', { time: 5 })).toMatchObject({ at: 18, leftEnd: 17 });
    expect(doc.segmentSplitPlan('seg-1', { time: 3.2 })).toMatchObject({ at: 3, leftEnd: 2 });
  });

  it('never cuts inside a word, and takes the nearest gap to a caret inside one', () => {
    const doc = makeIgtDoc({ raw: annotated() });
    // The caret inside "fish".
    expect(doc.segmentSplitPlan('seg-1', { time: 4, at: 11 })).toMatchObject({ at: 9 });
    expect(
      segmentCuts(BODY, { begin: 0, end: BODY.length }, wordsOf(BODY)).map((c) => c.at),
    ).toEqual([3, 7, 9, 14, 18, 21]);
  });

  it('cuts between words written without spaces', () => {
    const body = '我们走了';
    const words = [
      { id: 'w-1', begin: 0, end: 2 },
      { id: 'w-2', begin: 2, end: 4 },
    ];
    expect(segmentCuts(body, { begin: 0, end: 4 }, words)).toEqual([{ at: 2, leftEnd: 2 }]);
  });

  it('refuses a split with playback outside the segment, or a segment of one word', async () => {
    const doc = makeIgtDoc({ raw: annotated() });
    expect(doc.segmentSplitPlan('seg-1', { time: 7 })).toEqual({
      error: 'Playback must be inside the segment.',
    });
    expect(await doc.splitSegment('seg-1', { time: 3 })).toBe(false);
    const one = makeIgtDoc({
      raw: annotated({
        alignmentTokens: [
          { id: 'seg-1', text: 'text-1', begin: 3, end: 6, metadata: { timeBegin: 0, timeEnd: 1 } },
        ],
      }),
    });
    expect(one.segmentSplitPlan('seg-1', { time: 0.5 })).toEqual({
      error: 'This segment has one word.',
    });
    expect(kinds(doc)).toEqual([]);
    expect(kinds(one)).toEqual([]);
  });

  it('asks about a relation kept inside one segment that the split would cut, and takes it off', async () => {
    const raw = annotated();
    // Another layer's relation from "he" to "and", kept inside one segment.
    const words = raw.textLayers[0].tokenLayers.find((l) => l.id === 'wordL');
    words.spanLayers.push({
      id: 'sl-dep',
      spans: [
        { id: 'd1', tokens: ['w-1'], value: 'x' },
        { id: 'd5', tokens: ['w-5'], value: 'y' },
      ],
      relationLayers: [
        {
          id: 'rl-dep',
          constraints: { other: [{ type: 'same-ancestor', tokenLayer: 'alignL' }] },
          relations: [{ id: 'r1', source: 'd1', target: 'd5' }],
        },
      ],
    });
    const doc = makeIgtDoc({ raw });
    expect(doc.segmentSplitPlan('seg-1', { time: 5, at: 18 }).loss.annotations).toBe(0);
    expect(doc.segmentSplitPlan('seg-1', { time: 4.5, at: 14 }).loss).toMatchObject({
      annotations: 1,
      relationIds: ['r1'],
    });
    await doc.splitSegment('seg-1', { time: 4.5, at: 14 });
    const relations = doc.layerInfo.primaryTextLayer.tokenLayers
      .find((l) => l.id === 'wordL')
      .spanLayers.find((sl) => sl.id === 'sl-dep').relationLayers[0].relations;
    expect(relations).toEqual([]);
  });
});

describe('merging segments', () => {
  const two = (second = {}) =>
    annotated({
      alignmentTokens: [
        {
          id: 'seg-1',
          text: 'text-1',
          begin: 0,
          end: 13,
          metadata: { timeBegin: 3, timeEnd: 4.5, speaker: 'Tom' },
        },
        {
          id: 'seg-2',
          text: 'text-1',
          begin: 14,
          end: BODY.length,
          metadata: { timeBegin: 4.6, timeEnd: 6, speaker: 'Tom', ...second },
        },
      ],
    });

  it('keeps the earlier segment over both texts and times, and every annotation', async () => {
    const doc = makeIgtDoc({ raw: two() });
    const before = annotation(doc);
    expect(doc.segmentMergePlan('seg-1').loss).toEqual({ speaker: null, keys: [] });
    expect(await doc.mergeSegment('seg-1')).not.toBe(false);
    expect(segments(doc)).toEqual([{ text: BODY, timeBegin: 3, timeEnd: 6, speaker: 'Tom' }]);
    expect(doc.alignmentTokens[0].id).toBe('seg-1');
    expect(annotation(doc)).toBe(before);
    expect(kinds(doc)).toEqual(['tokens.merge', 'tokens.patchMetadata']);
    expect(writes(doc)[0].args.slice(0, 2)).toEqual(['seg-1', 'seg-2']);
  });

  it('a split and the merge back leave the document as it was', async () => {
    const doc = makeIgtDoc({ raw: annotated() });
    const before = annotation(doc);
    await doc.splitSegment('seg-1', { time: 4.5, at: 14 });
    await settle();
    await doc.mergeSegment('seg-1');
    await settle();
    expect(segments(doc)).toEqual([{ text: BODY, timeBegin: 3, timeEnd: 6, speaker: 'Tom' }]);
    expect(annotation(doc)).toBe(before);
  });

  it('says what would go: the next segment speaker, and a value of its own', () => {
    const doc = makeIgtDoc({ raw: two({ speaker: 'Ana', note: 'laughs' }) });
    expect(doc.segmentMergePlan('seg-1')).toMatchObject({
      speaker: 'Tom',
      loss: { speaker: 'Ana', keys: ['note'] },
    });
  });

  it('gives an unlabelled segment the next one speaker without asking', () => {
    const raw = two();
    delete raw.textLayers[0].tokenLayers.find((l) => l.id === 'alignL').tokens[0].metadata.speaker;
    const doc = makeIgtDoc({ raw });
    expect(doc.segmentMergePlan('seg-1')).toMatchObject({
      speaker: 'Tom',
      loss: { speaker: null },
    });
  });

  it('refuses the last segment, and a next segment that is cross-talk', async () => {
    const doc = makeIgtDoc({ raw: two({ speaker: 'Ana', timeBegin: 4 }) });
    expect(doc.segmentMergePlan('seg-2')).toEqual({ error: 'This is the last segment.' });
    expect(doc.segmentMergePlan('seg-1')).toEqual({
      error: 'The next segment overlaps this one.',
    });
    expect(await doc.mergeSegment('seg-1')).toBe(false);
    expect(kinds(doc)).toEqual([]);
  });

  it('refuses two segments in different sentences', async () => {
    const raw = buildRawDoc({
      body: BODY,
      words: wordsOf(BODY),
      sentences: [
        { id: 's-1', begin: 0, end: 14 },
        { id: 's-2', begin: 14, end: BODY.length },
      ],
      alignmentTokens: two().textLayers[0].tokenLayers.find((l) => l.id === 'alignL').tokens,
    });
    const doc = makeIgtDoc({ raw });
    expect(doc.segmentMergePlan('seg-1')).toEqual({
      error: 'The two segments are in different sentences.',
    });
    expect(await doc.mergeSegment('seg-1')).toBe(false);
    expect(kinds(doc)).toEqual([]);
  });
});
