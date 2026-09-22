import { describe, it, expect } from 'vitest';
import { createDocumentShell, resolveIgtTargets, setupDataFor } from './project.js';
import { defaultIgnoredTokensSetup } from '../domain/igtConfig.js';

const role = (r) => ({ plaid: { role: r } });
const scoped = (name, scope) => ({ id: `sl-${name}`, name, config: { igt: { scope } } });

const PROJECT = {
  id: 'p1',
  textLayers: [
    {
      id: 'tl',
      config: role('baseline'),
      tokenLayers: [
        { id: 'wl', config: role('word'), spanLayers: [scoped('POS', 'Word')] },
        { id: 'sl', config: role('sentence'), spanLayers: [scoped('Translation', 'Sentence')] },
        { id: 'ml', config: role('morpheme'), spanLayers: [scoped('Gloss', 'Morpheme')] },
        { id: 'al', config: role('time-alignment'), spanLayers: [] },
      ],
    },
  ],
};

const stubClient = () => {
  const calls = [];
  let n = 0;
  const next = (p) => `${p}${++n}`;
  return {
    calls,
    documents: {
      create: (...args) => {
        calls.push(['documents.create', ...args]);
        return { id: 'doc1' };
      },
    },
    texts: {
      create: (...args) => {
        calls.push(['texts.create', ...args]);
        return { id: 'text1' };
      },
    },
    tokens: {
      bulkCreate: (specs) => {
        calls.push(['tokens.bulkCreate', specs]);
        return { ids: specs.map(() => next('t')) };
      },
    },
  };
};

describe('setupDataFor', () => {
  it('builds the wizard input, Baseline first and the default ignore rule', () => {
    const setup = setupDataFor({
      projectName: 'My Corpus',
      orthographies: ['IPA'],
      fields: [{ name: 'Gloss', scope: 'Morpheme', lang: 'en' }],
      vocabularies: [{ id: 'new-lexicon', name: 'Lexicon' }],
      documentMetadata: ['Source'],
    });
    expect(setup.basicInfo).toEqual({ projectName: 'My Corpus' });
    expect(setup.orthographies.orthographies).toEqual([
      { name: 'Baseline', isBaseline: true },
      { name: 'IPA' },
    ]);
    expect(setup.fields.fields).toEqual([
      { name: 'Gloss', scope: 'Morpheme', lang: 'en', isCustom: true },
    ]);
    expect(setup.fields.ignoredTokens).toEqual(defaultIgnoredTokensSetup());
    expect(setup.vocabulary.vocabularies).toEqual([
      { id: 'new-lexicon', name: 'Lexicon', enabled: true, isCustom: true },
    ]);
    expect(setup.documentMetadata.enabledFields).toEqual([
      { name: 'Source', enabled: true, isCustom: true },
    ]);
  });

  it('writes no ignore rule at all when the caller passes null', () => {
    const setup = setupDataFor({ projectName: 'x', ignoredTokens: null });
    expect(setup.fields.ignoredTokens).toBeUndefined();
  });

  it('keeps a vocabulary the caller says is not new', () => {
    const setup = setupDataFor({
      projectName: 'x',
      vocabularies: [{ id: 'v1', name: 'Shared', isCustom: false }],
    });
    expect(setup.vocabulary.vocabularies).toEqual([
      { id: 'v1', name: 'Shared', enabled: true, isCustom: false },
    ]);
  });
});

describe('resolveIgtTargets', () => {
  it('finds the substrate and maps every field layer by scope and name', () => {
    const targets = resolveIgtTargets(PROJECT, [{ name: 'Gloss', scope: 'Morpheme' }]);
    expect(targets).toMatchObject({
      textLayerId: 'tl',
      sentenceLayerId: 'sl',
      wordLayerId: 'wl',
      morphemeLayerId: 'ml',
      alignmentLayerId: 'al',
    });
    expect(targets.spanLayerByScopeName.get('Word:POS')).toBe('sl-POS');
  });

  it('carries no alignment layer rather than refusing when there is none', () => {
    const noAlign = {
      textLayers: [
        {
          ...PROJECT.textLayers[0],
          tokenLayers: PROJECT.textLayers[0].tokenLayers.filter((t) => t.id !== 'al'),
        },
      ],
    };
    expect(resolveIgtTargets(noAlign, []).alignmentLayerId).toBeNull();
  });

  // One sentence for all four importers: they said "Project setup incomplete"
  // three times and "Run project setup first" once.
  it('says the same thing about every missing piece', () => {
    expect(() => resolveIgtTargets({ textLayers: [] }, [])).toThrow(
      /No baseline text layer\. Project setup incomplete/,
    );
    const noSubstrate = {
      textLayers: [{ id: 'tl', config: role('baseline'), tokenLayers: [] }],
    };
    expect(() => resolveIgtTargets(noSubstrate, [])).toThrow(
      /Substrate token layers missing\. Project setup incomplete/,
    );
    expect(() => resolveIgtTargets(PROJECT, [{ name: 'Nope', scope: 'Word' }])).toThrow(
      /Annotation field "Nope" \(Word\) missing\. Project setup incomplete/,
    );
  });
});

describe('createDocumentShell', () => {
  const targets = resolveIgtTargets(PROJECT, []);

  it('writes the document, its text and the sentence partition in one bulk call', async () => {
    const client = stubClient();
    const shell = await createDocumentShell({
      client,
      projectId: 'p1',
      targets,
      name: 'Story',
      metadata: { source: 'a.eaf' },
      body: 'los perros',
      sentences: [{ begin: 0, end: 10 }],
    });
    expect(client.calls.map(([m]) => m)).toEqual([
      'documents.create',
      'texts.create',
      'tokens.bulkCreate',
    ]);
    expect(client.calls[0].slice(1)).toEqual(['p1', 'Story', { source: 'a.eaf' }]);
    expect(client.calls[1].slice(1)).toEqual(['tl', 'doc1', 'los perros', undefined]);
    expect(client.calls[2][1]).toEqual([{ tokenLayerId: 'sl', text: 'text1', begin: 0, end: 10 }]);
    expect(shell).toEqual({ documentId: 'doc1', textId: 'text1', sentenceIds: ['t1'] });
  });

  it('gives an empty document no text and no sentences', async () => {
    const client = stubClient();
    const shell = await createDocumentShell({
      client,
      projectId: 'p1',
      targets,
      name: 'Empty',
      metadata: {},
      body: '',
      sentences: [],
    });
    expect(client.calls.map(([m]) => m)).toEqual(['documents.create']);
    expect(shell).toEqual({ documentId: 'doc1', textId: null, sentenceIds: [] });
  });

  it('carries a sentence metadata map only when it holds something', async () => {
    const client = stubClient();
    await createDocumentShell({
      client,
      projectId: 'p1',
      targets,
      name: 'Story',
      metadata: {},
      body: 'ab',
      sentences: [
        { begin: 0, end: 1, metadata: {} },
        { begin: 1, end: 2, metadata: { speaker: 'Ana' } },
      ],
    });
    expect(client.calls[2][1]).toEqual([
      { tokenLayerId: 'sl', text: 'text1', begin: 0, end: 1 },
      { tokenLayerId: 'sl', text: 'text1', begin: 1, end: 2, metadata: { speaker: 'Ana' } },
    ]);
  });

  it('tells the caller the new id before anything is written under it', async () => {
    const client = stubClient();
    const seen = [];
    await createDocumentShell({
      client,
      projectId: 'p1',
      targets,
      name: 'Story',
      metadata: {},
      body: 'ab',
      sentences: [{ begin: 0, end: 2 }],
      onDocument: (id) => seen.push(['onDocument', id, client.calls.length]),
      textMetadata: () => {
        seen.push(['textMetadata', client.calls.length]);
        return { note: 'x' };
      },
    });
    expect(seen).toEqual([
      ['onDocument', 'doc1', 1],
      ['textMetadata', 1],
    ]);
    expect(client.calls[1][4]).toEqual({ note: 'x' });
  });

  it('routes the partition through the engine own writer when it has one', async () => {
    const client = stubClient();
    const shell = await createDocumentShell({
      client,
      projectId: 'p1',
      targets,
      name: 'Story',
      metadata: {},
      body: 'ab',
      sentences: [{ begin: 0, end: 2 }],
      createTokens: async (specs) => specs.map((_, i) => `own${i}`),
    });
    expect(client.calls.map(([m]) => m)).toEqual(['documents.create', 'texts.create']);
    expect(shell.sentenceIds).toEqual(['own0']);
  });
});
