import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { EditableCell } from './EditableCell.jsx';
import { SentenceRow } from './SentenceRow.jsx';
import { EditorSessionContext } from './editorSession.js';

// Which way the grid lays out, and what that does and does not reach.
//
// The rule: LAYOUT takes the document's direction, a VALUE takes its own. So
// the sentence block flips as one unit and every cell in it is on `auto`,
// which is what lets an English lemma read left to right in a column standing
// under an Arabic word.
//
// The arcs are deliberately not tested here. They are drawn from positions
// measured off the DOM, so they mirror with the flex container and there is
// nothing of our own to check. The one tree that has to mirror itself is the
// assistant's citation card, in assistant/depTree.test.js.

vi.mock('../../../utils/feedback.jsx', () => ({ notifyWarning: vi.fn() }));

const SESSION = {
  isReadOnly: false,
  onAnnotationUpdate: vi.fn(() => Promise.resolve()),
  onToggleField: vi.fn(),
  visibleFields: { lemma: true, xpos: true, upos: true, feats: true },
  vocab: {},
  validators: {},
  descriptions: {},
  colors: {},
  // A predicate over a span's metadata, as AnnotationEditor builds it.
  reviewable: () => false,
};

const token = (id, form, begin, end, tokenIndex) => ({
  token: { id, begin, end, metadata: {} },
  tokenForm: form,
  wordForm: form,
  word: null,
  form: { id: `${id}-f`, metadata: {} },
  lemma: { id: `${id}-l`, value: form, metadata: {} },
  xpos: { id: `${id}-x`, value: '', metadata: {} },
  upos: { id: `${id}-u`, value: 'NOUN', metadata: {} },
  feats: [],
  spanIds: {
    form: `${id}-f`,
    lemma: `${id}-l`,
    upos: `${id}-u`,
    xpos: `${id}-x`,
    features: [],
  },
  tokenIndex,
});

const sentence = {
  // "قرأ الولد": read.PST the.boy.
  tokens: [token('t1', 'قرأ', 0, 3, 0), token('t2', 'الولد', 4, 9, 1)],
  relations: [],
  lemmaSpans: [],
};

const mountRow = (session) =>
  renderComponent(
    <EditorSessionContext.Provider value={{ ...SESSION, ...session }}>
      <SentenceRow sentenceData={sentence} totalTokensBefore={0} sentenceIndex={0} />
    </EditorSessionContext.Provider>,
  );

describe('the annotation grid takes its direction from the document', () => {
  it('lays an RTL document out right to left', async () => {
    const { container, unmount } = await mountRow({ textDirection: 'rtl' });
    expect(container.querySelector('.sentence-container').getAttribute('dir')).toBe('rtl');
    await unmount();
  });

  it('leaves an LTR document alone', async () => {
    const { container, unmount } = await mountRow({ textDirection: 'ltr' });
    expect(container.querySelector('.sentence-container').getAttribute('dir')).toBe('ltr');
    await unmount();
  });

  it('marks each token form auto, whichever way the grid runs', async () => {
    const { container, unmount } = await mountRow({ textDirection: 'rtl' });
    const forms = all(container, '.token-form');
    expect(forms.length).toBe(2);
    for (const f of forms) expect(f.getAttribute('dir')).toBe('auto');
    await unmount();
  });
});

describe('a cell decides for itself', () => {
  const mountCell = (props) =>
    renderComponent(
      <EditorSessionContext.Provider value={SESSION}>
        <EditableCell
          value=""
          tokenId="t1"
          tokenIndex={0}
          field="lemma"
          tokenForm="الولد"
          tabIndex={1}
          columnWidth={80}
          {...props}
        />
      </EditorSessionContext.Provider>,
    );

  it('is on auto', async () => {
    const { container, unmount } = await mountCell();
    expect(all(container, 'input')[0].getAttribute('dir')).toBe('auto');
    await unmount();
  });

  it('is still on auto when the field is a picker', async () => {
    const { container, unmount } = await mountCell({
      field: 'upos',
      value: 'NOUN',
    });
    expect(all(container, 'input')[0].getAttribute('dir')).toBe('auto');
    await unmount();
  });
});
