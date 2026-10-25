import { describe, it, expect } from 'vitest';
import { similarField, missingFields } from './fieldTargets.js';
import { existingFields } from '../../domain/fieldInventory.js';
import { createFields, missingOrthographies, addOrthographies } from '../project.js';

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
            { id: 'f4', name: 'POS', config: scoped('Word') },
          ],
        },
        { id: 'morph', config: role('morpheme'), spanLayers: [] },
        { id: 'align', config: role('time-alignment'), spanLayers: [] },
      ],
    },
  ],
};

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
  // Writes are queued on a batch and recorded when it is sent, so a test sees
  // which batch each went in.
  const fakeClient = () => {
    const calls = [];
    let batch = 0;
    const bundle = (sink) => ({
      spanLayers: {
        create: (parentId, name, _audit, { id } = {}) =>
          sink({ kind: 'create', parentId, name, id }),
        setConfig: (id, ns, key, value) => sink({ kind: 'setConfig', id, ns, key, value }),
        setConstraints: (id, ns, constraints, _audit, options) =>
          sink({ kind: 'setConstraints', id, ns, constraints, options }),
      },
    });
    return {
      calls,
      batched: async (fn) => {
        batch += 1;
        const ops = [];
        await fn(bundle((c) => ops.push({ ...c, batch })));
        calls.push(...ops);
        return [];
      },
    };
  };
  const strip = ({ batch: _batch, ...c }) => c;

  // Nothing declares a field's rules on open any more (2026-10-06): the
  // field an import adds holds them from the start, as one Settings adds does.
  it("declares each new field's rules", async () => {
    const client = fakeClient();
    const [made] = await createFields(client, PROJECT, [{ name: 'Gloss', scope: 'Morpheme' }]);
    expect(client.calls.filter((c) => c.kind === 'setConstraints').map(strip)).toEqual([
      {
        kind: 'setConstraints',
        id: made.id,
        ns: 'igt',
        constraints: [{ type: 'single-span' }],
        options: { expected: null },
      },
    ]);
    // In the batch that makes the layer, so no failure leaves it without them.
    expect(new Set(client.calls.map((c) => c.batch))).toEqual(new Set([1]));
  });

  it('creates each field under the token layer its scope belongs to', async () => {
    const client = fakeClient();
    const created = await createFields(client, PROJECT, [
      { name: 'Speaker', scope: 'Sentence' },
      { name: 'Gloss', scope: 'Morpheme' },
    ]);
    const [speaker, gloss] = created.map((f) => f.id);
    expect(client.calls.filter((c) => c.kind === 'create').map(strip)).toEqual([
      { kind: 'create', parentId: 'sent', name: 'Speaker', id: speaker },
      { kind: 'create', parentId: 'morph', name: 'Gloss', id: gloss },
    ]);
    expect(client.calls.filter((c) => c.kind === 'setConfig').map(strip)).toEqual([
      { kind: 'setConfig', id: speaker, ns: 'igt', key: 'scope', value: 'Sentence' },
      { kind: 'setConfig', id: gloss, ns: 'igt', key: 'scope', value: 'Morpheme' },
      // The name proposes its Lexicon field.
      { kind: 'setConfig', id: gloss, ns: 'igt', key: 'lexiconField', value: 'gloss' },
    ]);
  });

  it('gives a sentence field the role its name proposes, or the one it states', async () => {
    const client = fakeClient();
    const [translation, free, note] = await createFields(client, PROJECT, [
      { name: 'Translation (nl)', scope: 'Sentence' },
      { name: 'Libre', scope: 'Sentence', sentenceRole: 'translation' },
      { name: 'Note', scope: 'Sentence', sentenceRole: null },
    ]);
    const roles = client.calls
      .filter((c) => c.kind === 'setConfig' && c.key === 'sentenceRole')
      .map((c) => [c.id, c.value]);
    expect(roles).toEqual([
      [translation.id, 'translation'],
      [free.id, 'translation'],
    ]);
    expect(note.sentenceRole).toBeNull();
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
