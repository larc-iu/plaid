import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { ElanTierReview, SchemaMismatch } from './ElanTierReview.jsx';
import { ROLES } from '@/import/elan/schema';

// A resume locks the tier mapping, since it redoes the unfinished documents
// against the answers the first run was given. Two pairs of tier names that
// read alike are the exception: Import waits until every pair is decided, and
// an import whose record has no answer for one (a record written before the
// answers were kept, or a pair that only appears once an .eaf is taken out of
// the batch) had nothing left to click, Import greyed out for good.

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

describe('ElanTierReview with the mapping locked', () => {
  it('lets a pair nobody has answered be decided, and keeps the roles locked', async () => {
    view = await renderComponent(
      <ElanTierReview batch={batchWith()} editable mappingEditable={false} />,
    );
    expect(decideBox(view.container).disabled).toBe(false);
    expect(roleBox(view.container).disabled).toBe(true);
  });

  it('locks the pair again once the record has answered it', async () => {
    view = await renderComponent(
      <ElanTierReview
        batch={batchWith({ nearMissChoices: { phrase: 'Phrase' }, undecidedNearMisses: [] })}
        editable
        mappingEditable={false}
      />,
    );
    // Answered, so it reads as the decision rather than as a question.
    expect(decideBox(view.container)).toBeUndefined();
    const answered = buttons(view.container).find((b) => b.textContent.includes('Same tier'));
    expect(answered.disabled).toBe(true);
  });

  it('decides nothing while the run is going', async () => {
    view = await renderComponent(
      <ElanTierReview batch={batchWith()} editable={false} mappingEditable={false} />,
    );
    expect(decideBox(view.container).disabled).toBe(true);
  });

  it('leaves everything editable for an import that is not a resume', async () => {
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
