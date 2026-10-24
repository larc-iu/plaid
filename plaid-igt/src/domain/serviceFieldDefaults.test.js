import { describe, it, expect } from 'vitest';
import { proposeServiceFieldDefaults } from './serviceFieldDefaults.js';

// Each field is stored by its span layer id, proposed by its stored role.
describe('proposeServiceFieldDefaults', () => {
  const f = (name, scope, more = {}) => ({ name, scope, id: `id-${name}`, ...more });
  const ROLES = { gloss: 'gloss', pos: 'pos', 'gloss (pt)': 'gloss' };

  it('takes the morpheme field paired with a gloss and the sentence field holding the translation', () => {
    expect(
      proposeServiceFieldDefaults(
        [
          f('Glosa', 'Morpheme', { lexiconField: 'gloss' }),
          f('POS', 'Morpheme', { lexiconField: 'pos' }),
          f('Libre', 'Sentence', { sentenceRole: 'translation' }),
          f('Notes', 'Sentence', { sentenceRole: 'note' }),
        ],
        ROLES,
      ),
    ).toEqual({
      analyze: { fieldParams: { gloss_field: 'id-Glosa', translation_field: 'id-Libre' } },
      translate: { fieldParams: { translation_field: 'id-Libre', gloss_field: 'id-Glosa' } },
    });
  });

  it('never reads a name', () => {
    expect(
      proposeServiceFieldDefaults(
        [f('Gloss', 'Morpheme'), f('Translation', 'Sentence', { sentenceRole: null })],
        ROLES,
      ),
    ).toEqual({});
  });

  it('proposes nothing where two fields could be meant, or there is none', () => {
    expect(
      proposeServiceFieldDefaults(
        [
          f('Gloss (en)', 'Morpheme', { lexiconField: 'gloss' }),
          f('Gloss (pt)', 'Morpheme', { lexiconField: 'gloss (pt)' }),
          f('Free (en)', 'Sentence', { sentenceRole: 'translation' }),
          f('Free (pt)', 'Sentence', { sentenceRole: 'translation' }),
        ],
        ROLES,
      ),
    ).toEqual({});
    expect(proposeServiceFieldDefaults([])).toEqual({});
  });
});
