// Test helpers for the IgtDocument domain layer: an in-memory fake plaid-client
// and a builder for the raw document shape that `client.documents.get(id, true)`
// returns (camelCased layers; substrate bound by config.plaid.role, private
// config under config.igt.*), plus the document, the waits and the island
// mount most tests repeat. Not imported by app code.

import { ROLES } from '@larc-iu/plaid-client';
import { fakeClient } from '../../../plaid-client-js/src/testing.js';
import { IgtDocument } from './IgtDocument.js';
import { lexiconFieldChoices, proposeLexiconField } from './lexiconField.js';
import { proposeSentenceRole } from './sentenceRole.js';
import { IgtEditor } from '@/components/documents/analyze/island/IgtEditor.js';

let idCounter = 0;
export const resetIds = () => {
  idCounter = 0;
};
const nextId = (p = 'new') => `${p}-${++idCounter}`;

// ---- raw document builder -----------------------------------------------
// Produces the nested layer shape getIgtLayerInfo() expects. Defaults give a
// single sentence covering the whole body, two word tokens, and (optionally)
// morphemes + span layers at each scope.

// A field's config as setup makes it: its scope, and the Lexicon field its
// name proposes against a new vocabulary's fields, unless the test states one
// (`opts.lexiconFields`, "<scope>:<name>" -> key or null).
const fieldConfig = (opts, scope, name) => {
  const stated = opts.lexiconFields?.[`${scope}:${name}`];
  const lexiconField =
    stated !== undefined ? stated : proposeLexiconField({ name, scope }, lexiconFieldChoices([]));
  return { igt: { scope, ...(lexiconField ? { lexiconField } : {}) } };
};

export function buildRawDoc(opts = {}) {
  const body = opts.body ?? 'the cat';
  const textId = 'text-1';

  const wordSpanLayers = (opts.wordFields ?? ['POS']).map((name, i) => ({
    id: `wsl-${i}`,
    name,
    config: fieldConfig(opts, 'Word', name),
    spans: [],
  }));
  const morphSpanLayers = (opts.morphFields ?? ['Gloss']).map((name, i) => ({
    id: `msl-${i}`,
    name,
    config: fieldConfig(opts, 'Morpheme', name),
    spans: [],
  }));
  const sentSpanLayers = (opts.sentFields ?? ['Translation']).map((name, i) => ({
    id: `ssl-${i}`,
    name,
    // The role its name proposes, as setup gives it.
    config: {
      igt: {
        scope: 'Sentence',
        ...(proposeSentenceRole(name) ? { sentenceRole: proposeSentenceRole(name) } : {}),
      },
    },
    spans: [],
  }));

  const words = opts.words ?? [
    { id: 'w-1', begin: 0, end: 3 },
    { id: 'w-2', begin: 4, end: 7 },
  ];
  const wordTokens = words.map((w) => ({
    id: w.id,
    text: textId,
    begin: w.begin,
    end: w.end,
    metadata: w.metadata ?? {},
  }));

  // Morphemes: by default one per word, same extent, precedence 1.
  const morphemes =
    opts.morphemes ??
    words.map((w, i) => ({
      id: `m-${i + 1}`,
      text: textId,
      begin: w.begin,
      end: w.end,
      precedence: 1,
      metadata: {},
    }));

  // Code-point length (offsets are code points) so astral-text fixtures get a
  // correct default sentence covering the whole body.
  const sentences = opts.sentences ?? [{ id: 's-1', begin: 0, end: [...body].length }];
  const sentenceTokens = sentences.map((s) => ({
    id: s.id,
    text: textId,
    begin: s.begin,
    end: s.end,
  }));

  return {
    id: 'doc-1',
    name: 'Test Doc',
    project: 'proj-1',
    metadata: opts.metadata ?? {},
    textLayers: [
      {
        id: 'tl-1',
        name: 'Main Text',
        config: { plaid: { role: ROLES.BASELINE } },
        text: { id: textId, body },
        tokenLayers: [
          {
            id: 'sentL',
            name: 'Sentences',
            overlapMode: 'partitioning',
            config: { plaid: { role: ROLES.SENTENCE } },
            tokens: sentenceTokens,
            spanLayers: sentSpanLayers,
            vocabs: [],
          },
          {
            id: 'wordL',
            name: 'Words',
            overlapMode: 'non-overlapping',
            config: {
              plaid: { role: ROLES.WORD },
              igt: { orthographies: opts.orthographies ?? [{ name: 'IPA' }] },
            },
            tokens: wordTokens,
            spanLayers: wordSpanLayers,
            vocabs: opts.wordVocabs ?? [],
          },
          {
            id: 'morphL',
            name: 'Morphemes',
            overlapMode: 'any',
            config: { plaid: { role: ROLES.MORPHEME } },
            tokens: morphemes,
            spanLayers: morphSpanLayers,
            vocabs: opts.morphVocabs ?? [],
          },
          {
            id: 'alignL',
            name: 'Alignment',
            overlapMode: 'non-overlapping',
            config: { plaid: { role: ROLES.TIME_ALIGNMENT } },
            tokens: opts.alignmentTokens ?? [],
            spanLayers: [],
            vocabs: [],
          },
        ],
      },
    ],
  };
}

// ---- fake plaid client --------------------------------------------------
// plaid-client's own test client (`fakeClient` in plaid-client-js testing.js):
// the real client, batch and operations on a transport that records each call
// in `.calls` as `{ kind, args }` and answers it here. A create answers a
// fresh id, a check finds nothing and a repair changes nothing, as on a
// project whose data keeps every rule, unless `opts.broken` (or
// `opts.repaired`) names the bundle. Mutations only read ids and batch order
// back from these answers: the optimistic patch is what updates the
// document, so nothing here keeps server state.

const LAYER_BUNDLES = ['tokenLayers', 'spanLayers', 'relationLayers'];

const writeAnswers = (opts) => ({
  'tokens.create': () => ({ id: nextId('tok') }),
  'tokens.split': () => ({ id: nextId('tok') }),
  'tokens.bulkCreate': (body) => ({ ids: (body || []).map(() => nextId('tok')) }),
  'tokens.bulkUpdate': (body) => ({ count: (body || []).length }),
  'spans.create': () => ({ id: nextId('span') }),
  'spans.bulkCreate': (body) => ({ ids: (body || []).map(() => nextId('span')) }),
  'spans.bulkUpdate': (body) => ({ count: (body || []).length }),
  'vocabLinks.create': () => ({ id: nextId('link') }),
  'vocabLinks.bulkCreate': (body) => ({ ids: (body || []).map(() => nextId('link')) }),
  'vocabItems.create': () => ({ id: nextId('vitem') }),
  'vocabItems.bulkUpdate': (body) => ({ count: (body || []).length }),
  'texts.create': () => ({ id: nextId('text') }),
  'texts.edit': (id) => ({
    id,
    reshape: { tokens: [], spans: [], vocabLinks: [], deleted: {} },
  }),
  'documents.copy': () => ({ id: nextId('doc') }),
  ...Object.fromEntries(
    LAYER_BUNDLES.flatMap((bundle) => [
      [`${bundle}.setConstraints`, () => ({ constraints: {} })],
      [
        `${bundle}.checkConstraints`,
        (id, constraints) =>
          opts.broken?.[bundle]
            ? { violations: [{ constraint: constraints[0]?.type }], violationCount: 1 }
            : { violations: [], violationCount: 0 },
      ],
      [
        `${bundle}.repairConstraints`,
        () => ({ repaired: opts.repaired?.[bundle] ?? [], violations: [], violationCount: 0 }),
      ],
    ]),
  ),
});

export function makeFakeClient(opts = {}) {
  const writes = writeAnswers(opts);
  const project = () => opts.project ?? { id: 'proj-1', vocabs: [] };
  const reads = {
    'documents.get': () => opts.reloadDoc ?? buildRawDoc(),
    'projects.get': project,
    'projects.list': () => ({ entries: opts.projects ?? [project()], nextCursor: null }),
    // Mirrors the real endpoint: returns the layer + items but NOT vocab-links
    // (those are embedded in the document GET under tokenLayer.vocabs[] and
    // folded in by mergeRawVocabLinks). Tests pass `opts.vocabularies` to
    // pre-seed links on the loaded table directly.
    'vocabLayers.get': (id) => opts.vocabularies?.[id] ?? { id, items: [] },
    // A query answers what `opts.query(body)` gives, else no rows.
    query: async (body) => (await opts.query?.(body)) ?? { results: [] },
  };
  return fakeClient({
    answer: ({ kind, args, method }) => {
      const answer = reads[kind] ?? writes[kind];
      if (answer) return answer(...args);
      return method === 'GET' ? undefined : {};
    },
  });
}

// ---- a document, the waits, an island ----------------------------------

// An IgtDocument on `raw` in project proj-1, with no vocabularies and a fake
// client unless the test passes its own. Anything else the constructor takes
// (user, asOf) passes through.
export function makeIgtDoc({
  raw = buildRawDoc(),
  project = { id: 'proj-1', vocabs: [], config: { plaid: {} } },
  vocabularies = {},
  client = makeFakeClient(),
  projectId = 'proj-1',
  ...rest
} = {}) {
  return new IgtDocument({ raw, project, vocabularies, client, projectId, ...rest });
}

// Wait out `n` macrotask turns, so the promises a write or a render chains up
// settle before the test looks.
export const settle = async (n = 1) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

// The Analyze island on `doc`, mounted in a fresh div on the page. `destroy`
// takes the island down and removes the div.
export function mountIsland(doc, opts = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editor = new IgtEditor(host, doc, opts);
  return {
    editor,
    host,
    destroy: () => {
      editor.destroy();
      host.remove();
    },
  };
}
