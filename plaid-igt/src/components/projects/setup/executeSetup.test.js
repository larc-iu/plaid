import { describe, it, expect } from 'vitest';
import { PLAID_NAMESPACE, ROLE_KEY, ROLES } from '@larc-iu/plaid-client';
import { executeProjectSetup } from './executeSetup.js';
import { IGT_NAMESPACE } from '../../../domain/igtConfig.js';

// Setup makes each of its three kinds of resource in two requests: a create,
// and the write that says what the thing is. A lost response between them
// leaves something no later look for the finished shape can see. The resume
// used to look twice for a token layer only, so an untagged "Main Text" and
// an unlinked vocabulary were each made a second time, the first left behind
// as an orphan.

const stub = (project) => {
  const calls = { created: [], config: [], linked: [] };
  let n = 0;
  const id = (kind) => `${kind}-${++n}`;
  const make =
    (kind) =>
    async (...args) => {
      const name = args[kind === 'project' ? 0 : 1];
      // `under` is what it was created on: the project for a text layer, the
      // text layer for a token layer, the token layer for a span layer.
      calls.created.push({ kind, name, under: kind === 'project' ? null : args[0] });
      return { id: id(kind), name };
    };
  const setConfig = (kind) => async (layerId, ns, key, value) => {
    calls.config.push({ kind, id: layerId, ns, key, value });
  };
  const client = {
    withOperation: (_label, fn) => fn(),
    projects: {
      get: async () => project,
      create: make('project'),
      setConfig: setConfig('project'),
      linkVocab: async (projectId, vocabId) => calls.linked.push(vocabId),
    },
    textLayers: { create: make('text'), setConfig: setConfig('text') },
    tokenLayers: { create: make('token'), setConfig: setConfig('token') },
    spanLayers: { create: make('span'), setConfig: setConfig('span') },
    vocabLayers: {
      create: async (name) => {
        calls.created.push({ kind: 'vocab', name });
        return { id: id('vocab'), name };
      },
      setConfig: setConfig('vocab'),
      list: async () => calls.vocabList ?? [],
    },
  };
  return { client, calls };
};

const SETUP_DATA = {
  basicInfo: { projectName: 'Lezgi' },
  orthographies: { orthographies: [{ name: 'Baseline', isBaseline: true }] },
  fields: { fields: [] },
  vocabulary: {
    vocabularies: [{ id: 'new-lexicon', name: 'Lezgi Lexicon', enabled: true, isCustom: true }],
  },
  documentMetadata: { enabledFields: [] },
};

const run = (client, resumeProjectId) =>
  executeProjectSetup({
    client,
    isNewProject: true,
    resumeProjectId,
    setupData: SETUP_DATA,
    onProgress: () => {},
  });

const madeOf = (calls, kind) => calls.created.filter((c) => c.kind === kind);

describe('executeProjectSetup finishes what an interrupted run started', () => {
  it('tags an untagged "Main Text" rather than making a second one', async () => {
    const project = {
      id: 'p1',
      config: {},
      textLayers: [{ id: 'tl-half', name: 'Main Text', config: {}, tokenLayers: [] }],
      vocabs: [],
    };
    const { client, calls } = stub(project);
    const result = await run(client, 'p1');
    expect(result.failures).toEqual([]);
    expect(madeOf(calls, 'text')).toEqual([]);
    expect(calls.config).toContainEqual({
      kind: 'text',
      id: 'tl-half',
      ns: PLAID_NAMESPACE,
      key: ROLE_KEY,
      value: ROLES.BASELINE,
    });
    // And its token layers hang off the layer that was there, not a new one.
    expect(calls.config.filter((c) => c.kind === 'token' && c.key === ROLE_KEY)).toHaveLength(4);
  });

  it('links a vocabulary an earlier run made rather than making a second one', async () => {
    const project = {
      id: 'p1',
      config: {},
      textLayers: [
        {
          id: 'tl',
          name: 'Main Text',
          config: { [PLAID_NAMESPACE]: { [ROLE_KEY]: ROLES.BASELINE } },
          tokenLayers: [],
        },
      ],
      vocabs: [],
    };
    const { client, calls } = stub(project);
    calls.vocabList = [
      { id: 'v-other', name: 'Somebody else', config: {} },
      { id: 'v-half', name: 'Lezgi Lexicon', config: {} },
    ];
    const result = await run(client, 'p1');
    expect(result.failures).toEqual([]);
    expect(madeOf(calls, 'vocab')).toEqual([]);
    expect(calls.linked).toEqual(['v-half']);
    // It is seeded like a fresh one, since the earlier run never got that far.
    expect(
      calls.config
        .filter((c) => c.kind === 'vocab')
        .map((c) => c.key)
        .sort(),
    ).toEqual(['fields', 'tagsets']);
  });

  it('leaves the fields an earlier run already wrote on that vocabulary alone', async () => {
    const project = {
      id: 'p1',
      config: {},
      textLayers: [
        {
          id: 'tl',
          name: 'Main Text',
          config: { [PLAID_NAMESPACE]: { [ROLE_KEY]: ROLES.BASELINE } },
          tokenLayers: [],
        },
      ],
      vocabs: [],
    };
    const { client, calls } = stub(project);
    calls.vocabList = [
      {
        id: 'v-half',
        name: 'Lezgi Lexicon',
        config: { [IGT_NAMESPACE]: { fields: [{ name: 'Mine' }], tagsets: {} } },
      },
    ];
    await run(client, 'p1');
    expect(calls.config.filter((c) => c.kind === 'vocab')).toEqual([]);
    expect(calls.linked).toEqual(['v-half']);
  });

  it('builds on the text layer the wizard was answered with, stray "Main Text" or not', async () => {
    // Setting up over a project that already has its text: the wizard asks
    // which text layer to build on. An untagged "Main Text" an earlier
    // attempt left behind must not take that answer's place — everything is
    // built under it, and the documents have no text on it.
    const project = {
      id: 'p1',
      config: {},
      textLayers: [
        { id: 'tl-chosen', name: 'Transcription', config: {}, tokenLayers: [] },
        { id: 'tl-stray', name: 'Main Text', config: {}, tokenLayers: [] },
      ],
      vocabs: [],
    };
    const { client, calls } = stub(project);
    const result = await executeProjectSetup({
      client,
      isNewProject: false,
      resumeProjectId: 'p1',
      setupData: {
        ...SETUP_DATA,
        layerSelection: { textLayerType: 'existing', selectedTextLayerId: 'tl-chosen' },
        vocabulary: { vocabularies: [] },
      },
      onProgress: () => {},
    });
    expect(result.failures).toEqual([]);
    expect(madeOf(calls, 'text')).toEqual([]);
    expect(calls.config.filter((c) => c.kind === 'text')).toEqual([
      {
        kind: 'text',
        id: 'tl-chosen',
        ns: PLAID_NAMESPACE,
        key: ROLE_KEY,
        value: ROLES.BASELINE,
      },
    ]);
    // And the token layers hang off the chosen layer.
    expect(madeOf(calls, 'token')).toHaveLength(4);
    expect([...new Set(madeOf(calls, 'token').map((c) => c.under))]).toEqual(['tl-chosen']);
  });

  it('makes both from scratch when there is nothing to finish', async () => {
    const { client, calls } = stub(null);
    const result = await run(client, null);
    expect(result.failures).toEqual([]);
    expect(madeOf(calls, 'text')).toHaveLength(1);
    expect(madeOf(calls, 'vocab')).toHaveLength(1);
    expect(calls.linked).toHaveLength(1);
  });
});
