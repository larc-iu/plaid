import { describe, it, expect } from 'vitest';
import {
  existingFields,
  similarField,
  missingFields,
  createFields,
  missingOrthographies,
  addOrthographies,
} from './fieldTargets.js';

const role = (r) => ({ plaid: { role: r } });
const scoped = (s) => ({ igt: { scope: s } });

// A project shaped like one the FLEx importer made: the substrate layers plus
// the fields that import names.
const PROJECT = {
  id: 'p1',
  textLayers: [
    {
      id: 'tl1',
      config: role('baseline'),
      tokenLayers: [
        {
          id: 'sent',
          config: role('sentence'),
          spanLayers: [
            { id: 'f1', name: 'Translation', config: scoped('Sentence') },
            { id: 'f2', name: 'Translation (nl)', config: scoped('Sentence') },
          ],
        },
        {
          id: 'word',
          config: { ...role('word'), igt: { orthographies: [{ name: 'IPA' }] } },
          spanLayers: [
            { id: 'f3', name: 'Gloss', config: scoped('Word') },
            { id: 'f4', name: 'POS', config: scoped('Token') }, // the older spelling
          ],
        },
        { id: 'morph', config: role('morpheme'), spanLayers: [] },
        { id: 'align', config: role('time-alignment'), spanLayers: [] },
      ],
    },
  ],
};

describe('existingFields', () => {
  it('collects the project’s fields by scope, counting Token as Word', () => {
    expect(existingFields(PROJECT)).toEqual({
      Sentence: [
        { name: 'Translation', id: 'f1' },
        { name: 'Translation (nl)', id: 'f2' },
      ],
      Word: [
        { name: 'Gloss', id: 'f3' },
        { name: 'POS', id: 'f4' },
      ],
      Morpheme: [],
    });
  });

  it('gives every scope for a project with no layers at all', () => {
    expect(existingFields({})).toEqual({ Sentence: [], Word: [], Morpheme: [] });
  });
});

describe('similarField', () => {
  const existing = existingFields(PROJECT);

  it('matches through case, spacing and punctuation', () => {
    expect(similarField(existing, 'Sentence', 'translation')).toBe('Translation');
    expect(similarField(existing, 'Sentence', 'Trans-lation')).toBe('Translation');
    expect(similarField(existing, 'Word', 'gloss')).toBe('Gloss');
  });

  it('ignores the writing-system tag, which is the naming convention', () => {
    // "Translation (pmy)" is a sibling of "Translation", not a duplicate name,
    // but it still reads alike and is worth pointing at.
    expect(similarField(existing, 'Sentence', 'Translation (pmy)')).toBe('Translation');
  });

  it('is null for an exact match and for a genuinely new name', () => {
    expect(similarField(existing, 'Sentence', 'Translation')).toBeNull();
    expect(similarField(existing, 'Sentence', 'Speaker')).toBeNull();
    expect(similarField(existing, 'Morpheme', 'Gloss')).toBeNull(); // other scope
  });
});

describe('missingFields', () => {
  it('lists only what the project lacks, with a near-name when there is one', () => {
    expect(
      missingFields(PROJECT, [
        { name: 'Translation', scope: 'Sentence' },
        { name: 'Translation (pmy)', scope: 'Sentence' },
        { name: 'Gloss', scope: 'Morpheme' },
        { name: 'Speaker', scope: 'Sentence' },
      ]),
    ).toEqual([
      { name: 'Translation (pmy)', scope: 'Sentence', lang: null, similarTo: 'Translation' },
      { name: 'Gloss', scope: 'Morpheme', lang: null, similarTo: null },
      { name: 'Speaker', scope: 'Sentence', lang: null, similarTo: null },
    ]);
  });

  it('reports one entry per field however many tiers ask for it', () => {
    const out = missingFields(PROJECT, [
      { name: 'Speaker', scope: 'Sentence' },
      { name: 'Speaker', scope: 'Sentence' },
    ]);
    expect(out).toHaveLength(1);
  });
});

describe('createFields', () => {
  const fakeClient = () => {
    const calls = [];
    return {
      calls,
      spanLayers: {
        create: async (parentId, name) => {
          calls.push({ kind: 'create', parentId, name });
          return { id: `new-${name}` };
        },
        setConfig: async (id, ns, key, value) => {
          calls.push({ kind: 'setConfig', id, ns, key, value });
        },
      },
    };
  };

  it('creates each field under the token layer its scope belongs to', async () => {
    const client = fakeClient();
    const created = await createFields(client, PROJECT, [
      { name: 'Speaker', scope: 'Sentence' },
      { name: 'Gloss', scope: 'Morpheme' },
    ]);
    expect(client.calls.filter((c) => c.kind === 'create')).toEqual([
      { kind: 'create', parentId: 'sent', name: 'Speaker' },
      { kind: 'create', parentId: 'morph', name: 'Gloss' },
    ]);
    expect(client.calls.filter((c) => c.kind === 'setConfig')).toEqual([
      { kind: 'setConfig', id: 'new-Speaker', ns: 'igt', key: 'scope', value: 'Sentence' },
      { kind: 'setConfig', id: 'new-Gloss', ns: 'igt', key: 'scope', value: 'Morpheme' },
    ]);
    expect(created.map((f) => f.id)).toEqual(['new-Speaker', 'new-Gloss']);
  });

  it('refuses rather than guessing when the scope has no layer', async () => {
    const client = fakeClient();
    await expect(
      createFields(client, { textLayers: [] }, [{ name: 'Speaker', scope: 'Sentence' }]),
    ).rejects.toThrow(/no sentence layer/i);
  });
});

describe('orthographies', () => {
  it('lists only the names the word layer does not carry', () => {
    expect(missingOrthographies(PROJECT, ['IPA', 'Practical', 'Practical'])).toEqual(['Practical']);
    expect(missingOrthographies(PROJECT, ['IPA'])).toEqual([]);
  });

  it('appends to the word layer rather than replacing its list', async () => {
    const calls = [];
    const client = {
      tokenLayers: { setConfig: async (...args) => calls.push(args) },
    };
    const added = await addOrthographies(client, PROJECT, ['IPA', 'Practical']);
    expect(added).toEqual(['Practical']);
    expect(calls).toEqual([
      ['word', 'igt', 'orthographies', [{ name: 'IPA' }, { name: 'Practical' }]],
    ]);
  });

  it('writes nothing when the project already has them all', async () => {
    const calls = [];
    const client = { tokenLayers: { setConfig: async (...args) => calls.push(args) } };
    expect(await addOrthographies(client, PROJECT, ['IPA'])).toEqual([]);
    expect(calls).toEqual([]);
  });
});
