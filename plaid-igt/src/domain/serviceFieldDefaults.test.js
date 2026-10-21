import { describe, it, expect } from 'vitest';
import { proposeServiceFieldDefaults } from './serviceFieldDefaults.js';

// The rule the one-off backfill applies to existing projects too: the two
// agree on these cases (B/scripts/test_backfill_service_defaults.py).
describe('proposeServiceFieldDefaults', () => {
  const f = (name, scope) => ({ name, scope });

  it("takes the field of the name, else the one named for a language, else the scope's only one", () => {
    expect(
      proposeServiceFieldDefaults([
        f('Gloss', 'Morpheme'),
        f('POS', 'Morpheme'),
        f('Translation (pmy)', 'Sentence'),
        f('Notes', 'Sentence'),
      ]),
    ).toEqual({
      analyze: { fieldParams: { gloss_field: 'Gloss', translation_field: 'Translation (pmy)' } },
      translate: { fieldParams: { translation_field: 'Translation (pmy)', gloss_field: 'Gloss' } },
    });
    expect(proposeServiceFieldDefaults([f('Glosa', 'Morpheme')])).toEqual({
      analyze: { fieldParams: { gloss_field: 'Glosa' } },
      translate: { fieldParams: { gloss_field: 'Glosa' } },
    });
  });

  it('proposes nothing where two fields could be meant, or there is none', () => {
    expect(
      proposeServiceFieldDefaults([
        f('Gloss (en)', 'Morpheme'),
        f('Gloss (pt)', 'Morpheme'),
        f('Free', 'Sentence'),
        f('Literal', 'Sentence'),
      ]),
    ).toEqual({});
    expect(proposeServiceFieldDefaults([])).toEqual({});
  });
});
