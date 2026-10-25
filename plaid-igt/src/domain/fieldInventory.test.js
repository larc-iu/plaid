import { describe, it, expect } from 'vitest';
import { existingFields, fieldRolesOf } from './fieldInventory.js';

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

describe('existingFields', () => {
  it('collects the project’s fields by scope', () => {
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

describe('fieldRolesOf', () => {
  it("gives each field the role its Lexicon field holds: a vocabulary's, or a core field's for a key none declares", async () => {
    const span = (name, scope, lexiconField) => ({
      id: name,
      name,
      config: { igt: { scope, ...(lexiconField ? { lexiconField } : {}) } },
    });
    const project = {
      vocabs: [{ config: { igt: { fields: { Meaning: { role: 'gloss' }, gloss: {} } } } }],
      textLayers: [
        {
          config: { plaid: { role: 'baseline' } },
          tokenLayers: [
            {
              config: { plaid: { role: 'morpheme' } },
              spanLayers: [
                span('Sense', 'Morpheme', 'Meaning'),
                span('Gloss', 'Morpheme', 'gloss'),
                span('POS', 'Morpheme', 'pos'),
                span('Note', 'Morpheme', null),
              ],
            },
          ],
        },
      ],
    };
    // The vocabulary declares `gloss` with its role cleared: no gloss, as the
    // exports read it. `pos` it does not declare, so the core field's role holds.
    expect(fieldRolesOf(project)).toEqual({ Morpheme: { Sense: 'gloss', POS: 'pos' } });
    // With no vocabulary every core key holds its core role.
    expect(fieldRolesOf({ ...project, vocabs: [] })).toEqual({
      Morpheme: { Gloss: 'gloss', POS: 'pos' },
    });
  });

  it("gives a sentence field its stored role, never its name's", async () => {
    const span = (name, sentenceRole) => ({
      id: name,
      name,
      config: { igt: { scope: 'Sentence', ...(sentenceRole ? { sentenceRole } : {}) } },
    });
    const project = {
      vocabs: [],
      textLayers: [
        {
          config: { plaid: { role: 'baseline' } },
          tokenLayers: [
            {
              config: { plaid: { role: 'sentence' } },
              spanLayers: [span('Libre', 'translation'), span('Translation'), span('Obs', 'note')],
            },
          ],
        },
      ],
    };
    expect(fieldRolesOf(project)).toEqual({ Sentence: { Libre: 'translation', Obs: 'note' } });
  });
});
