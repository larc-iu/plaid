import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { TokenColumn } from './TokenColumn.jsx';
import { EditorSessionContext } from './editorSession.js';
import { testCells } from '../../../test/cells.js';

// H33-UD-1: a word with no UD word yet is shown in the grid as the seed on a
// writer's open would make it (domain/sentenceRows.js). Its id is no token's,
// so even a writer gets its cells read-only, beside words that are editable.

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

const render = (data) => {
  const cells = testCells({ read: () => undefined });
  stores.push(cells);
  const session = {
    isReadOnly: false,
    onAnnotationUpdate: vi.fn(),
    onFeatureDelete: vi.fn(),
    onConfirmTokens: vi.fn(),
    onPrecedent: vi.fn(),
    reviewable: () => false,
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

describe('a word with no UD word yet', () => {
  it('shows its form, and its cells take no input', async () => {
    const view = await render(entry('virtual:w1', 'dog', { virtual: true }));
    expect(view.container.querySelector('.token-form').textContent).toBe('dog');
    expect(view.container.querySelectorAll('input')).toHaveLength(0);
    await view.unmount();
  });

  it('beside a stored word, whose cells do', async () => {
    const view = await render(entry('m1', 'cat'));
    expect(view.container.querySelectorAll('input').length).toBeGreaterThan(0);
    await view.unmount();
  });
});
