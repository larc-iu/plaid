import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { TokenColumn } from './TokenColumn.jsx';
import { EditorSessionContext } from './editorSession.js';
import { testCells } from '../../../test/cells.js';
import { needsReview } from '@larc-iu/plaid-client';

// REV-JOIN20-2: a lemma the assistant's discard emptied, still the machine's,
// holds nothing to review. Its word shows the ✓ only for what else it holds
// (here the parser's head), and the lemma cell carries no mark.

vi.mock('../../../utils/feedback.jsx', () => ({ notifyWarning: vi.fn(), notifyError: vi.fn() }));

const stores = [];
afterEach(() => {
  for (const cells of stores.splice(0)) cells.clear();
});

const entry = (id, form, extra = {}) => ({
  token: { id, begin: 0, end: form.length },
  tokenForm: form,
  form: null,
  lemma: null,
  upos: null,
  xpos: null,
  feats: [],
  word: { id: `w-${id}`, begin: 0, end: form.length },
  wordForm: form,
  spanIds: { form: null, lemma: null, upos: null, xpos: null, features: [] },
  tokenIndex: 1,
  ...extra,
});

const render = (data, relationInferred = false) => {
  const cells = testCells({ read: () => undefined });
  stores.push(cells);
  const session = {
    isReadOnly: false,
    onAnnotationUpdate: vi.fn(),
    onFeatureDelete: vi.fn(),
    onConfirmTokens: vi.fn(),
    onPrecedent: vi.fn(),
    reviewable: needsReview,
    visibleFields: { lemma: true, upos: true, xpos: true, feats: true },
    cells,
    vocab: {},
    validators: {},
    descriptions: {},
    colors: {},
  };
  return renderComponent(
    <EditorSessionContext.Provider value={session}>
      <TokenColumn
        data={data}
        relationInferred={relationInferred}
        index={0}
        columnWidth={80}
        maxFeatures={0}
        getTabIndex={() => 1}
        onNavigate={() => {}}
        tokenRefs={{ current: new Map() }}
      />
    </EditorSessionContext.Provider>,
  );
};

const machine = { prov: 'inferred', provSource: 'service:stanza-parser' };
const emptied = () =>
  entry('m1', 'dog', { lemma: { id: 'lem1', value: null, tokens: ['m1'], metadata: machine } });

describe('a word whose machine lemma the assistant emptied', () => {
  it('shows no ✓ for the empty lemma alone', async () => {
    const view = await render(emptied());
    expect(view.container.querySelector('.word-accept')).toBeNull();
    const cell = view.container.querySelector('#m1-lemma');
    expect(cell.className).not.toMatch(/editable-field--machine/);
    expect(cell.title).toBe('Edit Lemma');
    await view.unmount();
  });

  it("shows the ✓ for the parser's head on it", async () => {
    const view = await render(emptied(), true);
    expect(view.container.querySelector('.word-accept')).not.toBeNull();
    await view.unmount();
  });

  it('shows the ✓ for a machine lemma that has a value', async () => {
    const view = await render(
      entry('m1', 'dog', {
        lemma: { id: 'lem1', value: 'dog', tokens: ['m1'], metadata: machine },
      }),
    );
    expect(view.container.querySelector('.word-accept')).not.toBeNull();
    await view.unmount();
  });
});
