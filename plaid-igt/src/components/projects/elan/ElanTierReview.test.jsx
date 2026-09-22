import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { ElanTierReview } from './ElanTierReview.jsx';
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
