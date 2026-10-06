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

// Every answer here has the shape core gives it, and no more: a create
// answers with the new id alone, a project read names a token layer's id,
// name, config and span layers, and only a read of the token layer itself
// says its overlap mode and parent. A stub that said more let a resume match
// on fields the real project read never carries.
const stub = (project, tokenLayerShapes = {}) => {
  const calls = { created: [], config: [], linked: [], shifted: [] };
  let n = 0;
  const id = (kind) => `${kind}-${++n}`;
  const make =
    (kind) =>
    async (...args) => {
      const name = args[kind === 'project' ? 0 : 1];
      // `under` is what it was created on: the project for a text layer, the
      // text layer for a token layer, the token layer for a span layer.
      calls.created.push({ kind, name, under: kind === 'project' ? null : args[0] });
      return { id: id(kind) };
    };
  const setConfig = (kind) => async (layerId, ns, key, value) => {
    calls.config.push({ kind, id: layerId, ns, key, value });
  };
  const setConstraints = (kind) => async (layerId, ns, constraints, _audit, options) => {
    (calls.constraints ??= []).push({ kind, id: layerId, ns, constraints, options });
    return { constraints: { [ns]: constraints } };
  };
  // The stored data a check finds breaking each layer's rules, by layer id
  // (none unless a test says).
  const broken = (calls.broken ??= {});
  const checkConstraints = async (layerId) => ({
    violations: [],
    violationCount: broken[layerId] ?? 0,
  });
  const repairConstraints = async (layerId, constraints) => {
    (calls.repaired ??= []).push({ id: layerId, constraints });
    return { repaired: broken[layerId] ? [layerId] : [] };
  };
  const client = {
    withOperation: (_label, fn) => fn(),
    batched: async (fn) => {
      await fn(client);
      return [];
    },
    projects: {
      get: async () => project,
      create: make('project'),
      setConfig: setConfig('project'),
      linkVocab: async (projectId, vocabId) => calls.linked.push(vocabId),
    },
    textLayers: { create: make('text'), setConfig: setConfig('text') },
    tokenLayers: {
      create: make('token'),
      setConfig: setConfig('token'),
      setConstraints: setConstraints('token'),
      checkConstraints,
      repairConstraints,
      get: async (layerId) => tokenLayerShapes[layerId],
    },
    spanLayers: {
      create: make('span'),
      setConfig: setConfig('span'),
      setConstraints: setConstraints('span'),
      checkConstraints,
      repairConstraints,
      shift: async (layerId, direction) => calls.shifted.push({ id: layerId, direction }),
    },
    vocabLayers: {
      create: async (name) => {
        calls.created.push({ kind: 'vocab', name });
        return { id: id('vocab') };
      },
      setConfig: setConfig('vocab'),
      list: async () => calls.vocabList ?? [],
    },
  };
  return { client, calls };
};

// The import record an interrupted run leaves on the project. It names the
// vocabularies that run made, which is the only thing that says one belongs
// to this project rather than to somebody else's of the same name.
const importRecord = (vocabsMade) => ({
  [IGT_NAMESPACE]: {
    import: { kind: 'FLEx', source: null, vocabId: null, choices: null, vocabsMade },
  },
});

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
      config: importRecord({ 'Lezgi Lexicon': 'v-half' }),
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
      config: importRecord({ 'Lezgi Lexicon': 'v-half' }),
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

  it('leaves another project\u2019s vocabulary of the same name alone', async () => {
    // `GET /vocab-layers` answers with every vocabulary the user can read, in
    // any project, and says nothing about which project owns one. Two runs of
    // the same import name their lexicon the same, so a name match linked a
    // colleague's dictionary into this project and wrote this import's
    // entries into it.
    const project = {
      id: 'p1',
      config: importRecord(null),
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
        id: 'v-other-project',
        name: 'Lezgi Lexicon',
        config: { [IGT_NAMESPACE]: { fields: [{ name: 'Sense' }], tagsets: {} } },
      },
    ];
    const result = await run(client, 'p1');
    expect(result.failures).toEqual([]);
    expect(madeOf(calls, 'vocab')).toEqual([{ kind: 'vocab', name: 'Lezgi Lexicon' }]);
    expect(calls.linked).toHaveLength(1);
    expect(calls.linked[0]).not.toBe('v-other-project');
    expect(calls.linked[0]).toMatch(/^vocab-/);
  });

  it('says which vocabulary it made before it links it', async () => {
    // The record is what a later run reads to tell this project's half-made
    // lexicon from anyone else's, so it is written between the two requests
    // rather than after both.
    const { client, calls } = stub(null);
    const said = [];
    await executeProjectSetup({
      client,
      isNewProject: true,
      resumeProjectId: null,
      setupData: SETUP_DATA,
      onProgress: () => {},
      onVocabCreated: (id, made) => said.push({ said: id, made, linkedSoFar: [...calls.linked] }),
    });
    expect(said).toEqual([
      { said: calls.linked[0], made: { 'Lezgi Lexicon': calls.linked[0] }, linkedSoFar: [] },
    ]);
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

// A project an interrupted run left with its text layer tagged. `tokenLayers`
// is what the project read carries for them.
const withText = (tokenLayers, config = {}) => ({
  id: 'p1',
  config,
  textLayers: [
    {
      id: 'tl',
      name: 'Main Text',
      config: { [PLAID_NAMESPACE]: { [ROLE_KEY]: ROLES.BASELINE } },
      tokenLayers,
    },
  ],
  vocabs: [],
});
const tagged = (role) => ({ [PLAID_NAMESPACE]: { [ROLE_KEY]: role } });

describe('a resumed setup, token layers', () => {
  it('tags a token layer made but not tagged, asking the layer for its shape', async () => {
    const project = withText([
      { id: 'tk-sent', name: 'Sentences', config: tagged(ROLES.SENTENCE), spanLayers: [] },
      { id: 'tk-half', name: 'Main Tokens', config: {}, spanLayers: [] },
    ]);
    const { client, calls } = stub(project, {
      'tk-half': {
        id: 'tk-half',
        name: 'Main Tokens',
        overlapMode: 'non-overlapping',
        parentTokenLayer: 'tk-sent',
        config: {},
      },
    });
    const result = await run(client, 'p1');
    expect(result.failures).toEqual([]);
    expect(madeOf(calls, 'token').map((c) => c.name)).toEqual(['Main Morphemes', 'Time Alignment']);
    expect(calls.config).toContainEqual({
      kind: 'token',
      id: 'tk-half',
      ns: PLAID_NAMESPACE,
      key: ROLE_KEY,
      value: ROLES.WORD,
    });
  });

  it('leaves an untagged layer of that name but another shape alone', async () => {
    const project = withText([
      { id: 'tk-sent', name: 'Sentences', config: tagged(ROLES.SENTENCE), spanLayers: [] },
      { id: 'tk-other', name: 'Main Tokens', config: {}, spanLayers: [] },
    ]);
    const { client, calls } = stub(project, {
      'tk-other': {
        id: 'tk-other',
        name: 'Main Tokens',
        overlapMode: 'any',
        parentTokenLayer: null,
        config: {},
      },
    });
    await run(client, 'p1');
    expect(madeOf(calls, 'token').map((c) => c.name)).toContain('Main Tokens');
    expect(calls.config.some((c) => c.id === 'tk-other')).toBe(false);
  });
});

describe('a resumed setup, vocabularies', () => {
  const TWO = {
    ...SETUP_DATA,
    vocabulary: {
      vocabularies: [
        { id: 'new-a', name: 'Lezgi Lexicon', enabled: true, isCustom: true },
        { id: 'new-b', name: 'Lezgi Glosses', enabled: true, isCustom: true },
      ],
    },
  };

  it('finishes every vocabulary the record names, not only the last', async () => {
    const project = withText([], importRecord({ 'Lezgi Lexicon': 'v-a', 'Lezgi Glosses': 'v-b' }));
    const { client, calls } = stub(project);
    calls.vocabList = [
      { id: 'v-a', name: 'Lezgi Lexicon', config: {} },
      { id: 'v-b', name: 'Lezgi Glosses', config: {} },
    ];
    const result = await executeProjectSetup({
      client,
      isNewProject: true,
      resumeProjectId: 'p1',
      setupData: TWO,
      onProgress: () => {},
    });
    expect(result.failures).toEqual([]);
    expect(madeOf(calls, 'vocab')).toEqual([]);
    expect(calls.linked).toEqual(['v-a', 'v-b']);
  });

  it('names every vocabulary made so far each time it makes one', async () => {
    // The first run made the lexicon and died; this one makes the second and
    // must still name the first, or a later resume makes it again.
    const project = withText([], importRecord({ 'Lezgi Lexicon': 'v-a' }));
    const { client, calls } = stub(project);
    calls.vocabList = [{ id: 'v-a', name: 'Lezgi Lexicon', config: {} }];
    const said = [];
    await executeProjectSetup({
      client,
      isNewProject: true,
      resumeProjectId: 'p1',
      setupData: TWO,
      onProgress: () => {},
      onVocabCreated: (id, made) => said.push(made),
    });
    expect(said).toEqual([{ 'Lezgi Lexicon': 'v-a', 'Lezgi Glosses': calls.linked[1] }]);
  });
});

describe('a resumed setup, field order', () => {
  const FIELDS = {
    ...SETUP_DATA,
    vocabulary: { vocabularies: [] },
    fields: {
      fields: [
        { name: 'Gloss', scope: 'Word' },
        { name: 'POS', scope: 'Word' },
        { name: 'Note', scope: 'Word' },
      ],
    },
  };
  const project = (spanLayers) =>
    withText([
      { id: 'tk-sent', name: 'Sentences', config: tagged(ROLES.SENTENCE), spanLayers: [] },
      { id: 'tk-word', name: 'Main Tokens', config: tagged(ROLES.WORD), spanLayers },
      { id: 'tk-morph', name: 'Main Morphemes', config: tagged(ROLES.MORPHEME), spanLayers: [] },
      {
        id: 'tk-align',
        name: 'Time Alignment',
        config: tagged(ROLES.TIME_ALIGNMENT),
        spanLayers: [],
      },
    ]);
  const setUp = (client) =>
    executeProjectSetup({
      client,
      isNewProject: true,
      resumeProjectId: 'p1',
      setupData: FIELDS,
      onProgress: () => {},
    });

  it('moves a field made late up to where an uninterrupted import puts it', async () => {
    const { client, calls } = stub(
      project([
        { id: 'sl-pos', name: 'POS' },
        { id: 'sl-note', name: 'Note' },
      ]),
    );
    const result = await setUp(client);
    expect(result.failures).toEqual([]);
    const gloss = madeOf(calls, 'span');
    expect(gloss.map((c) => c.name)).toEqual(['Gloss']);
    const glossId = calls.config.find((c) => c.kind === 'span' && c.value === 'Word').id;
    expect(calls.shifted).toEqual([
      { id: glossId, direction: 'up' },
      { id: glossId, direction: 'up' },
    ]);
  });

  it('declares the annotation rules on the layers it set up, each over nothing declared', async () => {
    const { client, calls } = stub(
      project([{ id: 'sl-gloss', name: 'Gloss', config: { [IGT_NAMESPACE]: { scope: 'Word' } } }]),
    );
    const result = await setUp(client);
    expect(result.failures).toEqual([]);
    // POS and Note, made here, hold theirs from the batch that made them.
    const made = madeOf(calls, 'span').map((c) => c.name);
    expect(made).toEqual(['POS', 'Note']);
    expect(calls.constraints.slice(0, 2).map((c) => [c.constraints, c.options])).toEqual([
      [[{ type: 'single-span' }], { expected: null }],
      [[{ type: 'single-span' }], { expected: null }],
    ]);
    // Then the layers it found.
    expect(calls.constraints.slice(2)).toEqual([
      {
        kind: 'token',
        id: 'tk-morph',
        ns: 'igt',
        constraints: [{ type: 'coextensive' }, { type: 'single-link' }],
        options: { expected: null },
      },
      {
        kind: 'token',
        id: 'tk-word',
        ns: 'igt',
        constraints: [{ type: 'single-link' }],
        options: { expected: null },
      },
      {
        kind: 'span',
        id: 'sl-gloss',
        ns: 'igt',
        constraints: [{ type: 'single-span' }],
        options: { expected: null },
      },
    ]);
  });

  // Nothing declares IGT's rules on open any more (2026-10-06), so a setup
  // over layers that already hold annotations repairs what the rules forbid
  // and declares then, itself.
  it('repairs an adopted layer whose annotations a rule forbids, then declares its rules', async () => {
    const { client, calls } = stub(
      project([{ id: 'sl-gloss', name: 'Gloss', config: { [IGT_NAMESPACE]: { scope: 'Word' } } }]),
    );
    calls.broken['sl-gloss'] = 2;
    const result = await setUp(client);
    expect(result.failures).toEqual([]);
    expect(calls.repaired).toEqual([{ id: 'sl-gloss', constraints: [{ type: 'single-span' }] }]);
    expect(calls.constraints.map((c) => c.id)).toContain('sl-gloss');
  });

  it('moves nothing when the fields are already in order', async () => {
    const { client, calls } = stub(
      project([
        { id: 'sl-gloss', name: 'Gloss' },
        { id: 'sl-pos', name: 'POS' },
        { id: 'sl-note', name: 'Note' },
      ]),
    );
    await setUp(client);
    expect(calls.shifted).toEqual([]);
  });
});

// Nothing declares IGT's rules on open any more (2026-10-06). A setup whose
// rules step failed after the layers were made left them bare for good.
describe('a setup whose rules step fails', () => {
  const FIELDS = {
    ...SETUP_DATA,
    vocabulary: { vocabularies: [] },
    fields: { fields: [{ name: 'Gloss', scope: 'Word', lang: 'en' }] },
  };

  it('leaves every layer it made holding its rules, from the batch that made it', async () => {
    const { client, calls } = stub(null);
    // Which batch each create and each declaration went in.
    let batchNo = 0;
    let open = null;
    const inBatch = [];
    client.batched = async (fn) => {
      open = ++batchNo;
      try {
        await fn(client);
      } finally {
        open = null;
      }
      return [];
    };
    for (const kind of ['tokenLayers', 'spanLayers']) {
      const create = client[kind].create;
      client[kind].create = async (...args) => {
        const opts = args[kind === 'tokenLayers' ? 5 : 3];
        inBatch.push({ what: 'create', id: opts?.id, batch: open });
        return create(...args);
      };
      const declare = client[kind].setConstraints;
      client[kind].setConstraints = async (...args) => {
        inBatch.push({ what: 'declare', id: args[0], batch: open });
        return declare(...args);
      };
    }
    // The project read the rules step makes is lost.
    client.projects.get = async () => {
      throw Object.assign(new Error('Network error'), { status: 0 });
    };
    const result = await executeProjectSetup({
      client,
      isNewProject: true,
      resumeProjectId: null,
      setupData: FIELDS,
      onProgress: () => {},
    });
    expect(result.failures).toEqual(['The annotation rules could not be set up: Network error']);
    const declared = new Map((calls.constraints || []).map((c) => [c.id, c]));
    const roleOf = (role) =>
      calls.config.find((c) => c.kind === 'token' && c.key === ROLE_KEY && c.value === role)?.id;
    const word = roleOf(ROLES.WORD);
    const morph = roleOf(ROLES.MORPHEME);
    const gloss = calls.config.find((c) => c.kind === 'span' && c.key === 'scope')?.id;
    expect(declared.get(word)?.constraints).toEqual([{ type: 'single-link' }]);
    expect(declared.get(morph)?.constraints).toEqual([
      { type: 'coextensive' },
      { type: 'single-link' },
    ]);
    expect(declared.get(gloss)?.constraints).toEqual([{ type: 'single-span' }]);
    for (const id of [word, morph, gloss]) {
      expect(declared.get(id).options).toEqual({ expected: null });
      const create = inBatch.find((c) => c.what === 'create' && c.id === id);
      const declare = inBatch.find((c) => c.what === 'declare' && c.id === id);
      expect(create?.batch).toBeTruthy();
      expect(declare?.batch).toBe(create.batch);
    }
    // The field's scope and language went in that batch too.
    expect(calls.config.filter((c) => c.id === gloss).map((c) => c.key)).toEqual(['scope', 'lang']);
  });
});
