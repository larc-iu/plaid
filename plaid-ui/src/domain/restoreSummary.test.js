import { describe, it, expect } from 'vitest';
import {
  changeLines,
  historyMessage,
  indexLayers,
  latestState,
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
  const client = (entries) => ({ documents: { audit: async () => entries } });

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
