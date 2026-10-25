import { afterEach, describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider';

// A save that deletes tokens asks first, naming what goes on this editor's
// layers (R44). The question comes before anything is sent, and Cancel leaves
// the typed text in the box. A save that deletes no token asks nothing.

const auth = vi.hoisted(() => ({ getClient: () => null, user: { id: 'u1' } }));
vi.mock('../../contexts/AuthContext.jsx', () => ({ useAuth: () => auth }));
const editor = vi.hoisted(() => ({ current: null }));
vi.mock('@ui/hooks/useDocumentEditor.js', () => ({ useDocumentEditor: () => editor.current }));
vi.mock('./TokenVisualizer.jsx', () => ({ TokenVisualizer: () => null }));
vi.mock('./services/ParseDialog.jsx', () => ({ ParseDialog: () => null }));
vi.mock('./services/TokenizeDialog.jsx', () => ({ TokenizeDialog: () => null }));

const { TextEditor } = await import('./TextEditor.jsx');
const { hasUnsavedDraft } = await import('@ui/hooks/useUnsavedDraft.js');

// the 0-3, cat 4-7, sat 8-11. Each token that goes takes one word, two
// annotations and one relation.
const TOKENS = [
  { id: 'w1', begin: 0, end: 3 },
  { id: 'w2', begin: 4, end: 7 },
  { id: 'w3', begin: 8, end: 11 },
];

const setup = () => {
  const doc = {
    id: 'd1',
    name: 'D',
    isSaving: false,
    layerInfo: {
      isConfigured: true,
      textLayer: { id: 't', text: { id: 'x', body: 'the cat sat', digest: 'd0' } },
      wordTokenLayer: { tokens: TOKENS },
    },
    textDeleteLoss: vi.fn((ranges) => {
      const n = TOKENS.filter((t) => ranges.some(([b, e]) => b <= t.begin && t.end <= e)).length;
      return { tokens: n, words: n, annotations: 2 * n, relations: n };
    }),
    saveText: vi.fn(async () => false),
  };
  editor.current = {
    projectId: 'p1',
    documentId: 'd1',
    project: { id: 'p1', name: 'P', writers: ['u1'], readers: [], maintainers: [] },
    doc,
    services: {},
    writeLockHeld: null,
  };
  return doc;
};

const mount = () =>
  renderComponent(
    <ConfirmProvider>
      <MemoryRouter>
        <TextEditor />
      </MemoryRouter>
    </ConfirmProvider>,
  );

const typeInto = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const dialog = () => document.querySelector('[role="alertdialog"]');
const buttonIn = (root, label) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === label);

const typeAndSave = async (value, loss = null) => {
  const doc = setup();
  if (loss) doc.textDeleteLoss.mockReturnValue(loss);
  const view = await mount();
  const box = view.container.querySelector('textarea');
  await view.step(() => typeInto(box, value));
  let done;
  await act(async () => {
    done = buttonIn(view.container, 'Save').click();
  });
  return { doc, view, box, done };
};

describe('the Text Editor asking before a save deletes tokens', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('asks before a token typed over whole goes, and Cancel keeps the typed text', async () => {
    const { doc, view, box } = await typeAndSave('the dog sat');
    expect(doc.textDeleteLoss).toHaveBeenCalledWith([[4, 7, true]]);
    expect(dialog().textContent).toContain('Save text?');
    expect(dialog().textContent).toContain(
      'Deletes 1 token and 1 word, with 2 annotations and 1 relation.',
    );
    expect(doc.saveText).not.toHaveBeenCalled();
    await act(async () => buttonIn(dialog(), 'Cancel').click());
    expect(dialog()).toBeNull();
    expect(doc.saveText).not.toHaveBeenCalled();
    expect(box.value).toBe('the dog sat');
    expect(hasUnsavedDraft()).toBe('The text you have typed');
    await view.unmount();
  });

  it('sends the save once the question is answered yes', async () => {
    const { doc, view } = await typeAndSave('the sat');
    expect(dialog().textContent).toContain('Deletes 1 token and 1 word');
    await act(async () => buttonIn(dialog(), 'Save').click());
    expect(doc.saveText).toHaveBeenCalledTimes(1);
    const [sent] = doc.saveText.mock.calls[0];
    expect(sent.base).toBe('the cat sat');
    await view.unmount();
  });

  it('counts several tokens', async () => {
    const { view } = await typeAndSave('a');
    expect(dialog().textContent).toContain(
      'Deletes 3 tokens and 3 words, with 6 annotations and 3 relations.',
    );
    await view.unmount();
  });

  it('names the sentences it deletes and their fields (R45)', async () => {
    const loss = {
      tokens: 3,
      words: 3,
      annotations: 6,
      relations: 3,
      sentences: 1,
      sentenceFields: 2,
    };
    const { view } = await typeAndSave('a', loss);
    expect(dialog().textContent).toContain(
      'Deletes 1 sentence, 3 tokens and 3 words, with 6 annotations, 3 relations and 2 sentence fields.',
    );
    await view.unmount();
  });

  it('asks before a sentence with fields goes alone', async () => {
    const loss = {
      tokens: 0,
      words: 0,
      annotations: 0,
      relations: 0,
      sentences: 1,
      sentenceFields: 1,
    };
    const { view } = await typeAndSave('the cat sa', loss);
    expect(dialog().textContent).toContain('Deletes 1 sentence, with 1 sentence field.');
    await view.unmount();
  });

  it('asks nothing for a save that only adds text or only cuts a token', async () => {
    let { doc, view } = await typeAndSave('the cat sat down');
    expect(dialog()).toBeNull();
    expect(doc.saveText).toHaveBeenCalledTimes(1);
    await view.unmount();
    ({ doc, view } = await typeAndSave('the ct sat'));
    expect(doc.textDeleteLoss).toHaveBeenCalledWith([[5, 6, false]]);
    expect(dialog()).toBeNull();
    expect(doc.saveText).toHaveBeenCalledTimes(1);
    await view.unmount();
  });
});
