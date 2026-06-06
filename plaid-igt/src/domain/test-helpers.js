// Test helpers for the IgtDocument domain layer: an in-memory fake plaid-client
// and a builder for the raw document shape that `client.documents.get(id, true)`
// returns (camelCased layers; substrate bound by config.plaid.role, private
// config under config.igt.*). Not imported by app code.

import { ROLES } from '@larc-iu/plaid-client';

let idCounter = 0;
export const resetIds = () => { idCounter = 0; };
const nextId = (p = 'new') => `${p}-${++idCounter}`;

// ---- raw document builder -----------------------------------------------
// Produces the nested layer shape getIgtLayerInfo() expects. Defaults give a
// single sentence covering the whole body, two word tokens, and (optionally)
// morphemes + span layers at each scope.

export function buildRawDoc(opts = {}) {
  const body = opts.body ?? 'the cat';
  const textId = 'text-1';

  const wordSpanLayers = (opts.wordFields ?? ['POS']).map((name, i) => ({
    id: `wsl-${i}`, name, config: { igt: { scope: 'Word' } }, spans: [],
  }));
  const morphSpanLayers = (opts.morphFields ?? ['Gloss']).map((name, i) => ({
    id: `msl-${i}`, name, config: { igt: { scope: 'Morpheme' } }, spans: [],
  }));
  const sentSpanLayers = (opts.sentFields ?? ['Translation']).map((name, i) => ({
    id: `ssl-${i}`, name, config: { igt: { scope: 'Sentence' } }, spans: [],
  }));

  const words = opts.words ?? [
    { id: 'w-1', begin: 0, end: 3 },
    { id: 'w-2', begin: 4, end: 7 },
  ];
  const wordTokens = words.map(w => ({
    id: w.id, text: textId, begin: w.begin, end: w.end, metadata: w.metadata ?? {},
  }));

  // Morphemes: by default one per word, same extent, precedence 1.
  const morphemes = opts.morphemes ?? words.map((w, i) => ({
    id: `m-${i + 1}`, text: textId, begin: w.begin, end: w.end, precedence: 1, metadata: {},
  }));

  // Code-point length (offsets are code points) so astral-text fixtures get a
  // correct default sentence covering the whole body.
  const sentences = opts.sentences ?? [{ id: 's-1', begin: 0, end: [...body].length }];
  const sentenceTokens = sentences.map(s => ({ id: s.id, text: textId, begin: s.begin, end: s.end }));

  return {
    id: 'doc-1',
    name: 'Test Doc',
    project: 'proj-1',
    metadata: opts.metadata ?? {},
    textLayers: [
      {
        id: 'tl-1', name: 'Main Text', config: { plaid: { role: ROLES.BASELINE } },
        text: { id: textId, body },
        tokenLayers: [
          {
            id: 'sentL', name: 'Sentences', config: { plaid: { role: ROLES.SENTENCE } },
            tokens: sentenceTokens, spanLayers: sentSpanLayers, vocabs: [],
          },
          {
            id: 'wordL', name: 'Words',
            config: { plaid: { role: ROLES.WORD }, igt: { orthographies: opts.orthographies ?? [{ name: 'IPA' }] } },
            tokens: wordTokens, spanLayers: wordSpanLayers, vocabs: opts.wordVocabs ?? [],
          },
          {
            id: 'morphL', name: 'Morphemes', config: { plaid: { role: ROLES.MORPHEME } },
            tokens: morphemes, spanLayers: morphSpanLayers, vocabs: opts.morphVocabs ?? [],
          },
          {
            id: 'alignL', name: 'Alignment', config: { plaid: { role: ROLES.TIME_ALIGNMENT } },
            tokens: opts.alignmentTokens ?? [], spanLayers: [], vocabs: [],
          },
        ],
      },
    ],
  };
}

// ---- fake plaid client --------------------------------------------------
// Records every call in `.calls`, fabricates ids for creates, and emulates
// batch semantics: queued ops accumulate, submitBatch() returns one result per
// op in order as `{ status, body }` (body.id present for creates). Mutations
// only read ids + batch order back from these results; the optimistic patch is
// what updates the document, so the fake need not maintain real server state.

export function makeFakeClient(opts = {}) {
  const calls = [];
  let batching = false;
  let queue = null; // array of { kind, makeResult }

  const record = (kind, args) => calls.push({ kind, args });

  // Each op: synchronous side-effect of recording; returns a "result builder"
  // used when not batching (returns {id}) or collected for submitBatch.
  const op = (kind, makeBody) => (...args) => {
    record(kind, args);
    const body = makeBody(...args);
    if (batching) {
      queue.push({ status: 200, body });
      return undefined; // batched ops don't return a usable value
    }
    return body;
  };

  const client = {
    calls,
    isBatching: false,
    beginBatch() { batching = true; this.isBatching = true; queue = []; },
    async submitBatch() {
      const results = queue;
      batching = false; this.isBatching = false; queue = null;
      record('submitBatch', []);
      return results;
    },
    abortBatch() { batching = false; this.isBatching = false; queue = null; },

    tokens: {
      create: op('tokens.create', () => ({ id: nextId('tok') })),
      delete: op('tokens.delete', () => ({})),
      update: op('tokens.update', () => ({})),
      split: op('tokens.split', () => ({ id: nextId('tok') })),
      merge: op('tokens.merge', () => ({})),
      bulkCreate: op('tokens.bulkCreate', (body) => ({ ids: (body || []).map(() => nextId('tok')) })),
      bulkDelete: op('tokens.bulkDelete', () => ({})),
      setMetadata: op('tokens.setMetadata', () => ({})),
      deleteMetadata: op('tokens.deleteMetadata', () => ({})),
    },
    spans: {
      create: op('spans.create', () => ({ id: nextId('span') })),
      update: op('spans.update', () => ({})),
      delete: op('spans.delete', () => ({})),
    },
    vocabLinks: {
      create: op('vocabLinks.create', () => ({ id: nextId('link') })),
      delete: op('vocabLinks.delete', () => ({})),
    },
    vocabItems: {
      create: op('vocabItems.create', () => ({ id: nextId('vitem') })),
    },
    texts: {
      create: op('texts.create', () => ({ id: nextId('text') })),
      update: op('texts.update', () => ({})),
      delete: op('texts.delete', () => ({})),
    },
    documents: {
      get: async () => opts.reloadDoc ?? buildRawDoc(),
      update: op('documents.update', () => ({})),
      setMetadata: op('documents.setMetadata', () => ({})),
      acquireLock: op('documents.acquireLock', () => ({})),
      releaseLock: op('documents.releaseLock', () => ({})),
      uploadMedia: op('documents.uploadMedia', () => ({})),
      deleteMedia: op('documents.deleteMedia', () => ({})),
    },
    projects: {
      get: async () => opts.project ?? { id: 'proj-1', vocabs: [] },
    },
    vocabLayers: {
      get: async (id) => (opts.vocabularies?.[id] ?? { id, items: [], vocabLinks: [] }),
    },
  };
  return client;
}
