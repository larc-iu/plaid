import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// Two people on one document's Text Editor (V3 H3-2, H3-4). A save sent from
// a copy another user has since saved over used to put their passages back.

const client = vi.hoisted(() => ({
  enterStrictMode: vi.fn(),
  exitStrictMode: vi.fn(),
}));
const auth = vi.hoisted(() => ({ getClient: () => client, user: { id: 'u1' } }));
vi.mock('../../contexts/AuthContext.jsx', () => ({ useAuth: () => auth }));
const editor = vi.hoisted(() => ({ current: null }));
vi.mock('@ui/hooks/useDocumentEditor.js', () => ({ useDocumentEditor: () => editor.current }));
const visualized = vi.hoisted(() => ({ props: null }));
vi.mock('./TokenVisualizer.jsx', () => ({
  TokenVisualizer: (props) => {
    visualized.props = props;
    return null;
  },
}));
vi.mock('./services/ParseDialog.jsx', () => ({ ParseDialog: () => null }));
vi.mock('./services/TokenizeDialog.jsx', () => ({ TokenizeDialog: () => null }));

const { TextEditor } = await import('./TextEditor.jsx');

const makeDoc = (body, over = {}) => ({
  id: 'd1',
  name: 'D',
  isSaving: false,
  layerInfo: {
    isConfigured: true,
    textLayer: { id: 't', text: { id: 'x', body, digest: `digest:${body}` } },
    wordTokenLayer: { tokens: over.words ?? [] },
  },
  saveText: vi.fn(async () => true),
  ...over,
});

const setDoc = (doc) => {
  editor.current = {
    projectId: 'p1',
    documentId: 'd1',
    project: { id: 'p1', name: 'P', writers: ['u1'], readers: [], maintainers: [] },
    doc,
    services: {},
    writeLockHeld: null,
  };
};

const tree = () => (
  <MemoryRouter>
    <TextEditor />
  </MemoryRouter>
);

// Type `text` at `at` (UTF-16), with `remove` characters selected after it,
// as a browser does: the selection is known before the change and the caret
// after it.
const typeAt = (el, at, text, remove = 0) => {
  el.setSelectionRange(at, at + remove);
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, el.value.slice(0, at) + text + el.value.slice(at + remove));
  el.setSelectionRange(at + text.length, at + text.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const typeAtEnd = (el, text) => typeAt(el, el.value.length, text);

const button = (root, text) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

describe('the Text Editor with another user saving the same text', () => {
  it('writes in strict mode for its document, and leaves it on the way out', async () => {
    setDoc(makeDoc('The dog ran.'));
    const view = await renderComponent(tree());
    expect(client.enterStrictMode).toHaveBeenCalledWith('d1');
    expect(client.exitStrictMode).not.toHaveBeenCalled();
    await view.unmount();
    expect(client.exitStrictMode).toHaveBeenCalled();
  });

  it('sends the edits typed and the digest of the body they were typed on', async () => {
    const doc = makeDoc('The big dog ran.');
    doc.saveText = vi.fn(async (_sent, { onStored }) => {
      onStored('The dog ran. It slept.', 'digest:The dog ran. It slept.');
      return true;
    });
    setDoc(doc);
    const view = await renderComponent(tree());
    const box = view.container.querySelector('textarea');
    await view.step(() => typeAtEnd(box, ' It slept.'));
    await view.step(() => button(view.container, 'Save').click());
    expect(doc.saveText).toHaveBeenCalledWith(
      {
        base: 'The big dog ran.',
        digest: 'digest:The big dog ran.',
        gaps: [{ start: 16, end: 16, value: ' It slept.' }],
      },
      expect.anything(),
    );
    // What was stored holds another user's change: the box shows it, and
    // there is nothing left to save.
    expect(box.value).toBe('The dog ran. It slept.');
    expect(button(view.container, 'Save').disabled).toBe(true);
    await view.unmount();
  });

  it('moves a draft onto a newer stored body that changed another passage', async () => {
    setDoc(makeDoc('The big dog ran.'));
    const view = await renderComponent(tree());
    const box = view.container.querySelector('textarea');
    await view.step(() => typeAtEnd(box, ' It slept.'));
    setDoc(makeDoc('The dog ran.'));
    await view.rerender(tree());
    expect(box.value).toBe('The dog ran. It slept.');
    expect(view.container.textContent).not.toContain('Changed elsewhere');
    // The draft is now over the new body, with its digest.
    const doc = makeDoc('The dog ran.');
    setDoc(doc);
    await view.rerender(tree());
    await view.step(() => button(view.container, 'Save').click());
    expect(doc.saveText.mock.calls[0][0]).toEqual({
      base: 'The dog ran.',
      digest: 'digest:The dog ran.',
      gaps: [{ start: 12, end: 12, value: ' It slept.' }],
    });
    await view.unmount();
  });

  it('keeps a draft that changed the same passage, says so, and Discard shows the stored text', async () => {
    setDoc(makeDoc('The big dog ran.'));
    const view = await renderComponent(tree());
    const box = view.container.querySelector('textarea');
    await view.step(() => typeAt(box, 4, 'large', 3));
    expect(box.value).toBe('The large dog ran.');
    setDoc(makeDoc('The huge dog ran.'));
    await view.rerender(tree());
    expect(box.value).toBe('The large dog ran.');
    expect(view.container.textContent).toContain('Changed elsewhere in the same passage.');
    await view.step(() => button(view.container, 'Discard changes').click());
    expect(box.value).toBe('The huge dog ran.');
    expect(view.container.textContent).not.toContain('Changed elsewhere');
    await view.unmount();
  });

  it('keeps text typed while a save is on its way, on top of what was stored', async () => {
    let finish = null;
    const doc = makeDoc('The dog ran.');
    doc.saveText = vi.fn(
      (_sent, { onStored }) =>
        new Promise((resolve) => {
          finish = (body) => {
            onStored(body, `digest:${body}`);
            resolve(true);
          };
        }),
    );
    setDoc(doc);
    const view = await renderComponent(tree());
    const box = view.container.querySelector('textarea');
    await view.step(() => typeAtEnd(box, ' It slept.'));
    await view.step(() => button(view.container, 'Save').click());
    await view.step(() => typeAtEnd(box, ' Then it woke.'));
    // The save's answer comes with the stored body, which also holds another
    // user's change at the start.
    setDoc(makeDoc('A dog ran. It slept.', { saveText: doc.saveText }));
    await view.rerender(tree());
    expect(view.container.textContent).not.toContain('Changed elsewhere');
    await view.step(() => finish('A dog ran. It slept.'));
    expect(box.value).toBe('A dog ran. It slept. Then it woke.');
    await view.step(() => button(view.container, 'Save').click());
    expect(doc.saveText.mock.calls[1][0]).toEqual({
      base: 'A dog ran. It slept.',
      digest: 'digest:A dog ran. It slept.',
      gaps: [{ start: 20, end: 20, value: ' Then it woke.' }],
    });
    await view.unmount();
  });

  it('puts the edits of a save that did not land back in the draft', async () => {
    const doc = makeDoc('The dog ran.');
    doc.saveText = vi.fn(async () => false);
    setDoc(doc);
    const view = await renderComponent(tree());
    const box = view.container.querySelector('textarea');
    await view.step(() => typeAtEnd(box, ' It slept.'));
    await view.step(() => button(view.container, 'Save').click());
    expect(box.value).toBe('The dog ran. It slept.');
    expect(button(view.container, 'Save').disabled).toBe(false);
    await view.step(() => button(view.container, 'Save').click());
    expect(doc.saveText.mock.calls[1][0]).toEqual(doc.saveText.mock.calls[0][0]);
    await view.unmount();
  });

  it('hands the token view the body its tokens stand in, in the same render as the tokens', async () => {
    setDoc(makeDoc('The dog ran.', { words: [{ id: 'w1', begin: 0, end: 3 }] }));
    const view = await renderComponent(tree());
    expect(visualized.props.originalText).toBe('The dog ran.');
    // A lengthening save: the refetch brings the longer body and the tokens
    // at their places in it together.
    setDoc(
      makeDoc('The dog ran home.', {
        words: [
          { id: 'w1', begin: 0, end: 3 },
          { id: 'w2', begin: 13, end: 17 },
        ],
      }),
    );
    await view.rerender(tree());
    expect(visualized.props.originalText).toBe('The dog ran home.');
    expect(visualized.props.text).toBe('The dog ran home.');
    await view.unmount();
  });
});
