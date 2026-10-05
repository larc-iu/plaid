import { describe, it, expect } from 'vitest';
import {
  changeGroups,
  changeLines,
  historyMessage,
  indexLayers,
  latestState,
  recordingNote,
  restoreError,
  skippedLines,
} from './restoreSummary.js';

const readRole = (config) => config?.plaid?.role ?? null;

const raw = {
  textLayers: [
    {
      id: 'text',
      tokenLayers: [
        { id: 'sent', name: 'Sentences', config: { plaid: { role: 'sentence' } } },
        {
          id: 'word',
          name: 'Words',
          config: { plaid: { role: 'word' } },
          spanLayers: [
            { id: 'gloss', name: 'Gloss', relationLayers: [{ id: 'dep', name: 'Dependencies' }] },
          ],
        },
        { id: 'other', name: 'Timeline', config: {} },
      ],
    },
  ],
};

describe('indexLayers', () => {
  it('names every layer and reads each token layer role through the client', () => {
    const layers = indexLayers(raw, readRole);
    expect(layers.sent).toEqual({ name: 'Sentences', role: 'sentence' });
    expect(layers.other).toEqual({ name: 'Timeline', role: null });
    expect(layers.gloss).toEqual({ name: 'Gloss' });
    expect(layers.dep).toEqual({ name: 'Dependencies' });
  });

  // UMR's own layers: the node tokens are left out (a node is counted once,
  // by its concept span), the rest named in the app's words.
  it("takes an app's own words for its own layers, null leaving one out", () => {
    const umr = {
      textLayers: [
        {
          id: 'text',
          tokenLayers: [
            {
              id: 'nodes',
              name: 'UMR nodes',
              config: { umr: { nodes: true } },
              spanLayers: [
                {
                  id: 'concepts',
                  name: 'UMR concepts',
                  config: { umr: { concepts: true } },
                  relationLayers: [
                    { id: 'edges', name: 'UMR relations', config: { umr: { relations: true } } },
                  ],
                },
              ],
            },
            { id: 'word', name: 'Words', config: { plaid: { role: 'word' } } },
          ],
        },
      ],
    };
    const layerWords = (config) =>
      config?.umr?.nodes
        ? null
        : config?.umr?.concepts
          ? ['node', 'nodes']
          : config?.umr?.relations
            ? ['edge', 'edges']
            : undefined;
    const layers = indexLayers(umr, readRole, layerWords);
    expect(layers.word).toEqual({ name: 'Words', role: 'word' });
    const summary = {
      tokens: {
        byLayer: [
          { layerId: 'nodes', inserted: 2 },
          { layerId: 'word', updated: 1 },
        ],
      },
      spans: { byLayer: [{ layerId: 'concepts', inserted: 2 }] },
      relations: { byLayer: [{ layerId: 'edges', inserted: 1, deleted: 2 }] },
    };
    expect(changeLines(summary, layers, { word: ['word', 'words'] })).toEqual([
      '1 word',
      '2 nodes',
      '3 edges',
    ]);
  });

  it('reads a document with no layers as an empty index', () => {
    expect(indexLayers(null, readRole)).toEqual({});
  });
});

describe('changeLines', () => {
  const layers = indexLayers(raw, readRole);

  it('calls a token layer what the app calls its role', () => {
    const summary = {
      tokens: {
        byLayer: [
          { layerId: 'sent', inserted: 1 },
          { layerId: 'word', inserted: 2, deleted: 1 },
        ],
      },
    };
    expect(changeLines(summary, layers, { sentence: ['sentence', 'sentences'] })).toEqual([
      '1 sentence',
      '3 tokens in Words',
    ]);
    expect(
      changeLines(summary, layers, {
        sentence: ['sentence', 'sentences'],
        word: ['word', 'words'],
      }),
    ).toEqual(['1 sentence', '3 words']);
  });

  it('names the tokens that read from a restored text', () => {
    expect(changeLines({ texts: { updated: 1 } }, layers, {})).toEqual([
      'The text, and the words read from it',
    ]);
  });

  it('lists nothing for an empty or absent summary', () => {
    expect(changeLines(null, layers, {})).toEqual([]);
    expect(changeLines({}, layers, {})).toEqual([]);
  });
});

describe('changeGroups', () => {
  const layers = indexLayers(raw, readRole);

  it('says what is removed, what is brought back and what is changed back', () => {
    const summary = {
      name: true,
      texts: { updated: 1 },
      tokens: { byLayer: [{ layerId: 'word', inserted: 2, deleted: 24 }] },
      spans: { byLayer: [{ layerId: 'gloss', deleted: 3, updated: 1 }] },
      relations: { byLayer: [{ layerId: 'dep', deleted: 18 }] },
      vocabLinks: { inserted: 1 },
      documentMetadata: true,
    };
    expect(changeGroups(summary, layers, { word: ['word', 'words'] })).toEqual([
      {
        heading: 'Removed',
        lines: ['24 words', '3 annotations in Gloss', '18 relations in Dependencies'],
      },
      { heading: 'Brought back', lines: ['2 words', '1 vocabulary link'] },
      {
        heading: 'Changed back',
        lines: [
          'The document name',
          'The text, and the words read from it',
          '1 annotation in Gloss',
          'Metadata',
        ],
      },
    ]);
  });

  it('leaves out an empty group, and has none for an empty or absent summary', () => {
    expect(
      changeGroups({ relations: { byLayer: [{ layerId: 'dep', deleted: 2 }] } }, layers),
    ).toEqual([{ heading: 'Removed', lines: ['2 relations in Dependencies'] }]);
    expect(changeGroups({}, layers)).toEqual([]);
    expect(changeGroups(null, layers)).toEqual([]);
  });
});

describe('recordingNote', () => {
  const asOf = '2026-09-01T10:00:00.000000000Z';
  const upload = (time) => ({ time, ops: [{ type: 'media/upload', time }] });
  const remove = (time) => ({ time, ops: [{ type: 'media/delete', time }] });

  it('says the recording is not changed when it was added after the moment', () => {
    expect(recordingNote([upload('2026-09-01T11:00:00.000000000Z')], asOf, true)).toEqual({
      note: 'The recording is not changed.',
    });
  });

  it('says a recording deleted after the moment cannot come back', () => {
    expect(recordingNote([remove('2026-09-01T11:00:00.000000000Z')], asOf, false)).toEqual({
      gap: 'The deleted recording cannot come back.',
    });
  });

  it('says nothing when the recording did not change after the moment', () => {
    expect(
      recordingNote([upload(asOf), upload('2026-09-01T09:00:00.000000000Z')], asOf, true),
    ).toBe(null);
    expect(recordingNote([], asOf, true)).toBe(null);
    expect(recordingNote(null, asOf, false)).toBe(null);
    expect(
      recordingNote([{ time: '2026-09-02T00:00:00Z', ops: [{ type: 'span/create' }] }], asOf, true),
    ).toBe(null);
  });
});

describe('skippedLines', () => {
  it('reports each kind, singular and plural', () => {
    expect(
      skippedLines([
        { kind: 'span', count: 1 },
        { kind: 'token', count: 4 },
      ]),
    ).toEqual(['1 annotation cannot come back.', '4 tokens cannot come back.']);
    expect(skippedLines(undefined)).toEqual([]);
  });
});

describe('restoreError', () => {
  it('passes a refusal naming the layer through, without the status or the URL', () => {
    const err = new Error(
      'HTTP 409 The saved state no longer fits layer l1 at http://localhost:8085/api/v1/documents/d1/restore',
    );
    expect(restoreError(err, 'The restore was not applied.')).toBe(
      'The saved state no longer fits layer l1',
    );
  });

  it('describes anything else the way every other screen does', () => {
    expect(restoreError({ status: 403 }, 'The restore was not applied.')).toBe(
      "You don't have permission to do that.",
    );
    expect(restoreError(null, 'The restore was not applied.')).toBe('The restore was not applied.');
  });
});

describe('latestState', () => {
  // The log oldest first, as a page reads it newest first.
  const asked = [];
  const client = (entries) => ({
    documents: {
      auditPage: async (id, opts) => {
        asked.push([id, opts]);
        return { entries: [...entries].reverse().slice(0, opts.limit), nextCursor: null };
      },
    },
  });

  it('reads one entry with one action, not the whole log', async () => {
    asked.length = 0;
    await latestState(client([{ time: '1' }, { time: '2' }]), 'd1');
    expect(asked).toEqual([['d1', { order: 'desc', limit: 1, opsLimit: 1 }]]);
  });

  it('takes the newest entry, preferring the moment it ended', async () => {
    const state = await latestState(
      client([
        { time: '1', endTime: '2', message: 'first' },
        { time: '3', endTime: '4', message: 'last' },
      ]),
      'd1',
    );
    expect(state).toEqual({ time: '4', label: 'last' });
  });

  it("falls back to the lone operation's description, then to no label", async () => {
    expect(
      await latestState(client([{ time: '1', ops: [{ description: 'Tokenize' }] }]), 'd1'),
    ).toEqual({ time: '1', label: 'Tokenize' });
    expect(await latestState(client([{ time: '1' }]), 'd1')).toEqual({ time: '1', label: null });
  });

  it('is null for a document with no history', async () => {
    expect(await latestState(client([]), 'd1')).toBeNull();
  });
});

describe('historyMessage', () => {
  it('names the moment, and the entry it follows', () => {
    const at = '2026-09-14T12:00:00.000Z';
    expect(historyMessage(at, null)).toBe(`Restore to ${new Date(at).toLocaleString()}`);
    expect(historyMessage(at, 'Tokenize')).toBe(
      `Restore to ${new Date(at).toLocaleString()} (after “Tokenize”)`,
    );
  });
});
