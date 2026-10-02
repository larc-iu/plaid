// The cross-talk rule on every path that writes a speaker or a new segment:
// two segments may overlap in time only when both are labelled and the labels
// differ. A time box already refused a same-voice overlap. A speaker edit (the
// speaker box, a row edit that changes the speaker with the text) and a new
// segment have to refuse it too, or the next open reports the document broken.
import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from '../IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '../test-helpers.js';
import { overlapProblem } from '../alignmentTimes.js';

function makeDoc(raw) {
  return new IgtDocument({
    raw,
    project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
    vocabularies: {},
    client: makeFakeClient(),
    projectId: 'proj-1',
  });
}

const kinds = (doc) => doc.client.calls.map((c) => c.kind);

// Ben 4.000 to 6.500 and Ana 6.200 to 9.000: legal cross-talk, as the ELAN
// import stored it in the hunter's reproduction.
const crossTalk = () =>
  buildRawDoc({
    body: 'kai pele dunu kata',
    alignmentTokens: [
      {
        id: 'a-1',
        text: 'text-1',
        begin: 0,
        end: 8,
        metadata: { timeBegin: 4, timeEnd: 6.5, speaker: 'Ben' },
      },
      {
        id: 'a-2',
        text: 'text-1',
        begin: 9,
        end: 18,
        metadata: { timeBegin: 6.2, timeEnd: 9, speaker: 'Ana' },
      },
    ],
  });

const speakerOf = (doc, id) => doc.alignmentTokens.find((t) => t.id === id).metadata.speaker;

beforeEach(() => resetIds());

describe('a speaker edit keeps the cross-talk rule', () => {
  it('refuses renaming a segment to the voice it overlaps, naming the other segment', async () => {
    const doc = makeDoc(crossTalk());
    expect(await doc.updateAlignmentSpeaker('a-1', 'Ana')).toBe(false);
    expect(doc.error).toBe(
      'Overlaps the segment from 6.200 s to 9.000 s. Only segments with different speakers may overlap.',
    );
    expect(kinds(doc)).not.toContain('tokens.patchMetadata');
    expect(speakerOf(doc, 'a-1')).toBe('Ben');
  });

  it('refuses clearing the speaker of a segment in cross-talk', async () => {
    const doc = makeDoc(crossTalk());
    expect(await doc.updateAlignmentSpeaker('a-2', '')).toBe(false);
    expect(doc.error).toMatch(/^Overlaps the segment from 4\.000 s to 6\.500 s\./);
    expect(kinds(doc)).not.toContain('tokens.patchMetadata');
    expect(speakerOf(doc, 'a-2')).toBe('Ana');
  });

  it('allows a rename that keeps the voices different', async () => {
    const doc = makeDoc(crossTalk());
    expect(await doc.updateAlignmentSpeaker('a-1', 'Cleo')).toBe(true);
    expect(speakerOf(doc, 'a-1')).toBe('Cleo');
  });

  it('refuses a row edit that changes the text and the speaker into a same-voice overlap', async () => {
    const doc = makeDoc(crossTalk());
    const ok = await doc.editAlignment('a-1', {
      text: 'kai pelo',
      timeBegin: 4,
      timeEnd: 6.5,
      speaker: 'Ana',
    });
    expect(ok).toBe(false);
    expect(doc.error).toMatch(/^Overlaps the segment from 6\.200 s/);
    expect(kinds(doc)).toEqual([]);
    expect(doc.body).toBe('kai pele dunu kata');
  });

  it('does not refuse a speaker edit for an overlap the segment already had', async () => {
    // Two unlabelled segments overlapping (data that got in some other way):
    // labelling one of them is not what made the overlap.
    const doc = makeDoc(
      buildRawDoc({
        body: 'kai pele dunu kata',
        alignmentTokens: [
          { id: 'a-1', text: 'text-1', begin: 0, end: 8, metadata: { timeBegin: 4, timeEnd: 6.5 } },
          {
            id: 'a-2',
            text: 'text-1',
            begin: 9,
            end: 18,
            metadata: { timeBegin: 6.2, timeEnd: 9 },
          },
        ],
      }),
    );
    expect(await doc.updateAlignmentSpeaker('a-1', 'Ana')).toBe(true);
  });
});

describe('a new segment keeps the cross-talk rule', () => {
  it('createAlignment refuses a same-voice overlap and allows cross-talk', async () => {
    const doc = makeDoc(crossTalk());
    const refused = await doc.createAlignment({
      text: 'zzz',
      timeBegin: 8,
      timeEnd: 10,
      speaker: 'Ana',
    });
    expect(refused).toBe(false);
    expect(doc.error).toMatch(/^Overlaps the segment from 6\.200 s to 9\.000 s\./);
    expect(kinds(doc)).toEqual([]);
    const ok = await doc.createAlignment({
      text: 'zzz',
      timeBegin: 8,
      timeEnd: 10,
      speaker: 'Ben',
    });
    expect(ok).toBe(true);
  });

  it('alignBaseline refuses an unlabelled segment over another', async () => {
    const doc = makeDoc(
      buildRawDoc({
        body: 'kai pele dunu kata',
        alignmentTokens: [
          {
            id: 'a-1',
            text: 'text-1',
            begin: 0,
            end: 8,
            metadata: { timeBegin: 4, timeEnd: 6.5, speaker: 'Ben' },
          },
        ],
      }),
    );
    const ok = await doc.alignBaseline({ begin: 9, end: 18, timeBegin: 6, timeEnd: 9 });
    expect(ok).toBe(false);
    expect(doc.error).toMatch(/^Overlaps the segment from 4\.000 s to 6\.500 s\./);
    expect(kinds(doc)).toEqual([]);
  });
});

describe('overlapProblem', () => {
  const seg = (id, timeBegin, timeEnd, speaker) => ({
    id,
    metadata: { timeBegin, timeEnd, ...(speaker ? { speaker } : {}) },
  });
  it('lets segments that only touch sit side by side', () => {
    expect(overlapProblem([seg('a', 0, 2, 'A')], seg('b', 2, 3, 'A'))).toBeNull();
  });
  it('names the earliest segment it may not overlap', () => {
    const tokens = [seg('c', 5, 8, 'A'), seg('a', 0, 2, 'A'), seg('b', 1, 3, 'B')];
    expect(overlapProblem(tokens, seg('x', 1, 6, 'A'))).toMatch(
      /^Overlaps the segment from 0 to 2\./,
    );
  });
});
