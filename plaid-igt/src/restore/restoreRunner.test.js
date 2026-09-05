import { describe, it, expect } from 'vitest';
import { runRestore, previewRestore } from './restoreRunner.js';

// The runner re-reads the document between phases. The stub hands back one
// prepared state per live read, in order, and the target for the as-of read,
// and records every write so the test can check what was sent and when.
const role = (r) => ({ plaid: { role: r } });
function rawDoc({ body, sentences, words, morphemes = [], spans = [], links = [], metadata } = {}) {
  const tok = (rows) =>
    rows.map(([id, begin, end, precedence = null]) => ({ id, begin, end, precedence }));
  const spansOn = (name) =>
    spans.filter((s) => s[1] === name).map(([id, , tokens, value]) => ({ id, tokens, value }));
  return {
    id: 'doc1',
    name: 'Doc',
    ...(metadata ? { metadata } : {}),
    textLayers: [
      {
        id: 'tl',
        config: role('baseline'),
        text: { id: 'text1', body },
        tokenLayers: [
          {
            id: 'L-s',
            config: role('sentence'),
            overlapMode: 'partitioning',
            tokens: tok(sentences),
            spanLayers: [{ id: 'SL-tr', name: 'Translation', spans: spansOn('Translation') }],
          },
          {
            id: 'L-w',
            config: role('word'),
            overlapMode: 'non-overlapping',
            parentTokenLayer: 'L-s',
            tokens: tok(words),
            spanLayers: [{ id: 'SL-pos', name: 'POS', spans: spansOn('POS') }],
            vocabs: [
              {
                id: 'v1',
                vocabLinks: links.map(([id, itemId, tokens]) => ({
                  id,
                  vocabItem: { id: itemId, form: itemId },
                  tokens,
                })),
              },
            ],
          },
          {
            id: 'L-m',
            config: role('morpheme'),
            overlapMode: 'any',
            parentTokenLayer: 'L-w',
            tokens: tok(morphemes),
            spanLayers: [],
          },
        ],
      },
    ],
  };
}

function stubClient({ live, target, failLinkItems = [] }) {
  const calls = [];
  let reads = 0;
  let nextId = 0;
  const fresh = (p) => `${p}-${nextId++}`;
  const rec = (name, ...args) => calls.push([name, ...args]);
  const liveState = () => JSON.parse(JSON.stringify(live[Math.min(reads, live.length - 1)]));
  return {
    calls,
    documents: {
      get: async (id, full, asOf) => {
        if (asOf) return JSON.parse(JSON.stringify(target));
        const state = liveState();
        reads += 1;
        return state;
      },
      setMetadata: async (id, body) => rec('documents.setMetadata', id, body),
      deleteMetadata: async (id) => rec('documents.deleteMetadata', id),
    },
    texts: {
      update: async (id, body) => rec('texts.update', id, body),
      create: async (...a) => rec('texts.create', ...a),
      delete: async (id) => rec('texts.delete', id),
      setMetadata: async (id, body) => rec('texts.setMetadata', id, body),
      deleteMetadata: async (id) => rec('texts.deleteMetadata', id),
    },
    tokens: {
      shift: async (id, begin, end) => rec('tokens.shift', id, begin, end),
      merge: async (a, b) => rec('tokens.merge', a, b),
      split: async (id, position) => {
        rec('tokens.split', id, position);
        return { id: fresh('tok') };
      },
      bulkCreate: async (specs) => {
        rec('tokens.bulkCreate', specs);
        return { ids: specs.map(() => fresh('tok')) };
      },
      bulkDelete: async (ids) => rec('tokens.bulkDelete', ids),
      update: (id, begin, end, precedence) => rec('tokens.update', id, begin, end, precedence),
      setMetadata: (id, body) => rec('tokens.setMetadata', id, body),
      deleteMetadata: (id) => rec('tokens.deleteMetadata', id),
    },
    spans: {
      bulkCreate: async (specs) => {
        rec('spans.bulkCreate', specs);
        return { ids: specs.map(() => fresh('span')) };
      },
      bulkDelete: async (ids) => rec('spans.bulkDelete', ids),
      update: (id, value) => rec('spans.update', id, value),
      setTokens: (id, tokens) => rec('spans.setTokens', id, tokens),
      setMetadata: (id, body) => rec('spans.setMetadata', id, body),
      deleteMetadata: (id) => rec('spans.deleteMetadata', id),
    },
    vocabLinks: {
      bulkCreate: async (specs) => {
        rec('vocabLinks.bulkCreate', specs);
        if (specs.some((s) => failLinkItems.includes(s.vocabItem))) throw new Error('400');
        return { ids: specs.map(() => fresh('link')) };
      },
      create: async (item, tokens, metadata) => {
        rec('vocabLinks.create', item, tokens, metadata);
        if (failLinkItems.includes(item)) throw new Error('400');
        return { id: fresh('link') };
      },
      bulkDelete: async (ids) => rec('vocabLinks.bulkDelete', ids),
      setMetadata: (id, body) => rec('vocabLinks.setMetadata', id, body),
      deleteMetadata: (id) => rec('vocabLinks.deleteMetadata', id),
    },
    withOperation: async (message, fn) => {
      rec('withOperation', message);
      return fn(() => {});
    },
    batched: async (fn) => {
      rec('batched');
      await fn();
    },
  };
}

const names = (client) => client.calls.map((c) => c[0]);

describe('runRestore', () => {
  it('does nothing beyond reading when the states already agree', async () => {
    const state = rawDoc({
      body: 'a b',
      sentences: [['s1', 0, 3]],
      words: [
        ['w1', 0, 1],
        ['w2', 2, 3],
      ],
    });
    const client = stubClient({ live: [state], target: state });
    const res = await runRestore({ client, documentId: 'doc1', asOf: '2026-09-01T00:00:00Z' });
    expect(names(client)).toEqual(['withOperation']);
    expect(res.exact).toBe(true);
    expect(res.summary.total).toBe(0);
  });

  it('applies text, then sentences, then tokens, then annotations and links, re-reading between', async () => {
    // Now: one sentence, two words, a POS on w2. Then (T): "a bc", the
    // sentence split in two, w2 wider, a POS on w2 with another value, and a
    // link on w1.
    const now = rawDoc({
      body: 'a b',
      sentences: [['s1', 0, 3]],
      words: [
        ['w1', 0, 1],
        ['w2', 2, 3],
      ],
      spans: [['sp1', 'POS', ['w2'], 'X']],
    });
    const afterText = rawDoc({
      body: 'a bc',
      sentences: [['s1', 0, 4]],
      words: [
        ['w1', 0, 1],
        ['w2', 2, 3],
      ],
      spans: [['sp1', 'POS', ['w2'], 'X']],
    });
    const afterSentences = rawDoc({
      body: 'a bc',
      sentences: [
        ['s1', 0, 2],
        ['tok-0', 2, 4],
      ],
      words: [
        ['w1', 0, 1],
        ['w2', 2, 3],
      ],
      spans: [['sp1', 'POS', ['w2'], 'X']],
    });
    const afterWords = rawDoc({
      body: 'a bc',
      sentences: [
        ['s1', 0, 2],
        ['tok-0', 2, 4],
      ],
      words: [
        ['w1', 0, 1],
        ['w2', 2, 4],
      ],
      spans: [['sp1', 'POS', ['w2'], 'X']],
    });
    const target = rawDoc({
      body: 'a bc',
      sentences: [
        ['s1', 0, 2],
        ['s2', 2, 4],
      ],
      words: [
        ['w1', 0, 1],
        ['w2', 2, 4],
      ],
      spans: [
        ['sp1', 'POS', ['w2'], 'NOUN'],
        ['sp2', 'Translation', ['s2'], 'bc!'],
      ],
      links: [['l1', 'item1', ['w1']]],
    });
    const final = rawDoc({
      body: 'a bc',
      sentences: [
        ['s1', 0, 2],
        ['tok-0', 2, 4],
      ],
      words: [
        ['w1', 0, 1],
        ['w2', 2, 4],
      ],
      spans: [
        ['sp1', 'POS', ['w2'], 'NOUN'],
        ['span-1', 'Translation', ['tok-0'], 'bc!'],
      ],
      links: [['link-2', 'item1', ['w1']]],
    });
    const client = stubClient({
      live: [now, afterText, afterSentences, afterWords, afterWords, final],
      target,
    });
    const res = await runRestore({ client, documentId: 'doc1', asOf: '2026-09-01T00:00:00Z' });
    const writes = client.calls.filter((c) => c[0] !== 'batched' && c[0] !== 'withOperation');
    expect(writes).toEqual([
      ['texts.update', 'text1', 'a bc'],
      ['tokens.split', 's1', 2],
      ['tokens.update', 'w2', undefined, 4, undefined],
      ['spans.update', 'sp1', 'NOUN'],
      // The translation lands on the sentence that came back under a new id.
      ['spans.bulkCreate', [{ spanLayerId: 'SL-tr', tokens: ['tok-0'], value: 'bc!' }]],
      ['vocabLinks.bulkCreate', [{ vocabItem: 'item1', tokens: ['w1'] }]],
    ]);
    expect(res.exact).toBe(true);
    expect(res.warnings).toEqual([]);
  });

  it('names the link whose entry no longer exists, and keeps the rest', async () => {
    const now = rawDoc({
      body: 'a b',
      sentences: [['s1', 0, 3]],
      words: [
        ['w1', 0, 1],
        ['w2', 2, 3],
      ],
    });
    const target = rawDoc({
      body: 'a b',
      sentences: [['s1', 0, 3]],
      words: [
        ['w1', 0, 1],
        ['w2', 2, 3],
      ],
      links: [
        ['l1', 'gone', ['w1']],
        ['l2', 'item2', ['w2']],
      ],
    });
    const final = rawDoc({
      body: 'a b',
      sentences: [['s1', 0, 3]],
      words: [
        ['w1', 0, 1],
        ['w2', 2, 3],
      ],
      links: [['link-9', 'item2', ['w2']]],
    });
    const client = stubClient({ live: [now, final], target, failLinkItems: ['gone'] });
    const res = await runRestore({ client, documentId: 'doc1', asOf: '2026-09-01T00:00:00Z' });
    expect(client.calls.filter((c) => c[0] === 'vocabLinks.create').map((c) => c[1])).toEqual([
      'gone',
      'item2',
    ]);
    expect(res.warnings).toEqual([
      'The link to “gone” was not restored. The entry no longer exists.',
    ]);
    expect(res.exact).toBe(false);
    expect(res.differences[0]).toContain('links');
  });

  it('previews without writing', async () => {
    const now = rawDoc({
      body: 'a b',
      sentences: [['s1', 0, 3]],
      words: [
        ['w1', 0, 1],
        ['w2', 2, 3],
      ],
    });
    const target = rawDoc({
      body: 'a b',
      sentences: [['s1', 0, 3]],
      words: [['w1', 0, 1]],
      metadata: { k: 1 },
    });
    const client = stubClient({ live: [now], target });
    const { summary, name } = await previewRestore({ client, documentId: 'doc1', asOf: 'T' });
    expect(name).toBe('Doc');
    expect(summary).toMatchObject({ text: false, words: 1, metadata: true, total: 1 });
    expect(client.calls).toEqual([]);
  });
});
