// A create or a row edit refused because the document changed elsewhere is
// planned again on the document as stored and sent. The cross-talk rule
// (alignmentTimes.js) has to hold on THAT document too: the change elsewhere
// may be what makes the overlap a same-voice one (REV-MEDIA-3).
import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, resetIds } from './test-helpers.js';
import { segmentServer } from '../test/segmentServer.js';

const seg = (id, begin, end, timeBegin, timeEnd, speaker) => ({
  id,
  text: 'text-1',
  begin,
  end,
  metadata: { timeBegin, timeEnd, ...(speaker ? { speaker } : {}) },
});

const serverWith = (segments, body = 'one two three') =>
  segmentServer(buildRawDoc({ body, words: [], morphemes: [], alignmentTokens: segments }));

const open = (server) => {
  const doc = new IgtDocument({
    raw: structuredClone(server.stored),
    project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
    vocabularies: {},
    client: server.client,
    projectId: 'proj-1',
    user: { id: 'a' },
  });
  doc._writes._retryDelay = () => 2;
  doc.onError = () => {};
  return doc;
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const idle = async (doc) => {
  while (doc.isSaving) await settle();
};
const alignLayer = (server) =>
  server.stored.textLayers[0].tokenLayers.find((l) => l.id === 'alignL');
const stored = (server, id) => alignLayer(server).tokens.find((t) => t.id === id);

beforeEach(() => resetIds());

describe('the cross-talk rule on a write planned again', () => {
  it('a row edit giving its segment the voice the other segment was given elsewhere is refused', async () => {
    // A and B talk over each other from 1 to 2.
    const server = serverWith([
      seg('a-1', 0, 3, 0, 1),
      seg('a-2', 4, 7, 1, 2, 'A'),
      seg('a-3', 8, 13, 1, 2, 'B'),
    ]);
    const doc = open(server);
    // Elsewhere: B's segment relabelled Cid, and the text changed, so this
    // page's text write is refused and planned again.
    server.otherRelabels('a-3', { speaker: 'Cid' });
    server.otherSaves([{ type: 'insert', index: 13, value: ' later' }]);

    const outcome = await doc.cellWrite(() =>
      doc.editAlignment('a-2', { text: 'dos', timeBegin: 1, timeEnd: 2, speaker: 'Cid' }),
    );
    await idle(doc);
    expect(outcome.landed).toBe(false);
    expect(stored(server, 'a-2').metadata.speaker).toBe('A');
    expect(server.answers()).toEqual([409]);
  });

  it('a new unlabelled segment over one made elsewhere meanwhile is refused', async () => {
    const server = serverWith([
      seg('a-1', 0, 3, 0, 1),
      seg('a-2', 4, 7, 1, 2),
      seg('a-3', 8, 13, 2, 3),
    ]);
    const doc = open(server);
    server.otherSaves([{ type: 'insert', index: 13, value: ' quatro' }]);
    alignLayer(server).tokens.push(seg('b-new', 14, 20, 3, 4));

    const ok = await doc.createAlignment({ text: 'cinco', timeBegin: 3.5, timeEnd: 4.5 });
    expect(ok).toBe(false);
    await idle(doc);
    expect(server.segments().map((t) => t.id)).toEqual(['a-1', 'a-2', 'a-3', 'b-new']);
    expect(server.body).toBe('one two three quatro');
    expect(server.answers()).toEqual([409]);
  });
});
