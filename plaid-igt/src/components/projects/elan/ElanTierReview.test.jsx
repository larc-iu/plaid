import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { ElanTierReview, SchemaMismatch } from './ElanTierReview.jsx';
import { ROLES } from '@/import/elan/schema';

const NODE = {
  key: 'Phrase:u',
  baseName: 'Phrase',
  tierIds: ['Phrase'],
  typeRef: 'u',
  stereotype: null,
  depth: 0,
  annotationCount: 3,
  participants: ['Ana'],
};

const PAIR = { fold: 'phrase', names: ['Phrase', 'phrase'], differsBy: 'case', mergeable: true };

const batchWith = (over = {}) => ({
  files: [{ fileName: 'corpus.eaf' }],
  nodes: [NODE],
  roles: { [NODE.key]: ROLES.UTTERANCE },
  fieldNames: {},
  nearMissGroups: [PAIR],
  nearMissChoices: {},
  undecidedNearMisses: [PAIR],
  chooseNearMiss: vi.fn(),
  setRole: vi.fn(),
  setName: vi.fn(),
  ...over,
});

const buttons = (container) => [...container.querySelectorAll('button')];
const decideBox = (container) => buttons(container).find((b) => b.textContent.includes('Decide'));
const roleBox = (container) => buttons(container).find((b) => b.textContent.includes('Sentences'));

let view;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('ElanTierReview while a run goes', () => {
  it('decides nothing while the run is going', async () => {
    view = await renderComponent(<ElanTierReview batch={batchWith()} editable={false} />);
    expect(decideBox(view.container).disabled).toBe(true);
  });

  it('leaves everything editable otherwise', async () => {
    view = await renderComponent(<ElanTierReview batch={batchWith()} editable />);
    expect(decideBox(view.container).disabled).toBe(false);
    expect(roleBox(view.container).disabled).toBe(false);
  });
});

describe('a batch whose files fall into several tier trees', () => {
  it('names the other spellings of a row and the files it is in', async () => {
    const sentences = { ...NODE, aliases: ['A_phrase-segnum-en'], fileCount: 3 };
    const only = {
      ...NODE,
      key: 'gls',
      baseName: 'A_phrase-gls-qaa-x-dim',
      aliases: [],
      fileCount: 1,
      depth: 1,
    };
    view = await renderComponent(
      <ElanTierReview
        batch={batchWith({
          files: [{ fileName: 'a.eaf' }, { fileName: 'b.eaf' }, { fileName: 'c.eaf' }],
          nodes: [sentences, only],
          roles: { [NODE.key]: ROLES.UTTERANCE, gls: ROLES.SENTENCE_FIELD },
          nearMissGroups: [],
          undecidedNearMisses: [],
        })}
        editable
      />,
    );
    const text = view.container.textContent;
    expect(text).toContain('3 files, 2 tiers. Not every file has every tier.');
    expect(text).toContain('Phrase / A_phrase-segnum-en');
    expect(text).toContain('in 1 of 3 files');
    expect(text).not.toContain('in 3 of 3 files');
  });

  it('refuses with the tier the files disagree about, and offers the merge of a typo', async () => {
    view = await renderComponent(
      <SchemaMismatch
        batch={batchWith({
          comparison: {
            differences: [
              {
                tier: 'gloss',
                variants: [
                  { role: ROLES.WORD_FIELD, files: ['a.eaf', 'b.eaf'] },
                  { role: ROLES.MORPH_FIELD, files: ['c.eaf'] },
                ],
              },
              {
                role: ROLES.UTTERANCE,
                variants: [
                  { name: 'Phrase', files: ['a.eaf'] },
                  { name: 'phrase', files: ['b.eaf'] },
                ],
                nearMiss: true,
              },
            ],
          },
        })}
        onReset={() => {}}
      />,
    );
    const text = view.container.textContent;
    expect(text).toContain('gloss: Word field in a.eaf, b.eaf · Morpheme field in c.eaf');
    expect(text).toContain(
      'Sentences: “Phrase” in a.eaf · “phrase” in b.eaf. The names differ only in spelling.',
    );
    expect(decideBox(view.container).disabled).toBe(false);
  });
});
