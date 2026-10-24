import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { TokenColumn } from './TokenColumn.jsx';
import { EditorSessionContext } from './editorSession.js';
import { testCells } from '../../../test/cells.js';

// A word with no UD word yet is shown in the grid as its first write makes it
// (domain/sentenceRows.js), and a writer edits it as any other word: that
// write makes it (R3, 2026-10-24).

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
  it("shows its form, and its cells take input as a stored word's do", async () => {
    const view = await render(entry('virtual:w1', 'dog', { virtual: true }));
    expect(view.container.querySelector('.token-form').textContent).toBe('dog');
    const stand = view.container.querySelectorAll('input').length;
    await view.unmount();
    const stored = await render(entry('m1', 'cat'));
    expect(stand).toBeGreaterThan(0);
    expect(stand).toBe(stored.container.querySelectorAll('input').length);
    await stored.unmount();
  });
});
