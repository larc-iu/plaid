import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// Text typed into the Text Editor and not saved is lost by any way out of the
// tab, so it registers with the shared unsaved-draft guard like every other
// editor. The screen said "Unsaved changes" and then let the reader walk away.

const auth = vi.hoisted(() => ({ getClient: () => null, user: { id: 'u1' } }));
vi.mock('../../contexts/AuthContext.jsx', () => ({ useAuth: () => auth }));
const editor = vi.hoisted(() => ({ current: null }));
vi.mock('@ui/hooks/useDocumentEditor.js', () => ({ useDocumentEditor: () => editor.current }));
vi.mock('./TokenVisualizer.jsx', () => ({ TokenVisualizer: () => null }));
vi.mock('./services/ParseDialog.jsx', () => ({ ParseDialog: () => null }));
const tokenizeProps = vi.hoisted(() => ({ current: null }));
vi.mock('./services/TokenizeDialog.jsx', () => ({
  TokenizeDialog: (props) => {
    tokenizeProps.current = props;
    return null;
  },
}));

const { TextEditor } = await import('./TextEditor.jsx');
const { hasUnsavedDraft } = await import('@ui/hooks/useUnsavedDraft.js');

const setup = (body, { writers = ['u1'], maintainers = [], isConfigured = true } = {}) => {
  editor.current = {
    projectId: 'p1',
    documentId: 'd1',
    project: { id: 'p1', name: 'P', writers, readers: [], maintainers },
    doc: {
      id: 'd1',
      name: 'D',
      isSaving: false,
      layerInfo: {
        isConfigured,
        textLayer: { id: 't', text: body ? { id: 'x', body } : null },
      },
    },
    services: {},
    writeLockHeld: null,
  };
};

const mount = () =>
  renderComponent(
    <MemoryRouter>
      <TextEditor />
    </MemoryRouter>,
  );

const typeInto = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('the Text Editor', () => {
  it('opens a document with no text with the caret in the text box', async () => {
    setup('');
    const view = await mount();
    expect(document.activeElement).toBe(view.container.querySelector('textarea'));
    await view.unmount();
  });

  it('leaves focus alone on a document that has text', async () => {
    setup('The saved text.');
    const view = await mount();
    expect(document.activeElement).not.toBe(view.container.querySelector('textarea'));
    await view.unmount();
  });

  it('registers typed text as unsaved, and the saved text as nothing to lose', async () => {
    setup('The saved text.');
    const view = await mount();
    const box = view.container.querySelector('textarea');
    expect(box.value).toBe('The saved text.');
    expect(hasUnsavedDraft()).toBe(null);

    await view.step(() => typeInto(box, 'The saved text. And more.'));
    expect(hasUnsavedDraft()).toBe('The text you have typed');

    await view.step(() => typeInto(box, 'The saved text.'));
    expect(hasUnsavedDraft()).toBe(null);
    await view.unmount();
  });

  it('registers nothing while the saved text is copied in on load', async () => {
    // For one render the box is still empty beside the loaded body. A draft
    // registered there puts a history entry in and takes it out again under
    // the router, which walked a freshly opened tab off the page.
    setup('The saved text.');
    const push = vi.spyOn(window.history, 'pushState');
    const view = await mount();
    expect(push).not.toHaveBeenCalled();
    push.mockRestore();
    await view.unmount();
  });

  it('counts text typed into a document that has none saved yet', async () => {
    setup('');
    const view = await mount();
    await view.step(() => typeInto(view.container.querySelector('textarea'), 'Hello.'));
    expect(hasUnsavedDraft()).toBe('The text you have typed');
    await view.unmount();
  });

  // H31-TEXT polish: the status said "Unsaved changes" only on a tokenized
  // document, though Save and the leave guard counted typed text on any.
  it('says Unsaved changes on a document with no tokens, and asks for a save before Tokenize', async () => {
    setup('The saved text.');
    const view = await mount();
    const box = view.container.querySelector('textarea');
    expect(view.container.textContent).not.toContain('Unsaved changes');
    expect(tokenizeProps.current.blockedHint).toBe(null);
    await view.step(() => typeInto(box, 'The saved text. And more.'));
    expect(view.container.textContent).toContain('Unsaved changes');
    expect(tokenizeProps.current.blockedHint).toBe('Save the text first.');
    await view.step(() => typeInto(box, 'The saved text.'));
    expect(view.container.textContent).not.toContain('Unsaved changes');
    expect(tokenizeProps.current.blockedHint).toBe(null);
    await view.unmount();
  });

  it('says Unsaved changes on a document with no text saved yet', async () => {
    setup('');
    const view = await mount();
    await view.step(() => typeInto(view.container.querySelector('textarea'), 'Hello.'));
    expect(view.container.textContent).toContain('Unsaved changes');
    await view.unmount();
  });
});

// One rule for Save in every app: the default button, disabled until there is
// something to save. Clear tokens is a labelled destructive button at rest, so
// it is outline with red text, shown whether or not there is anything to clear.
describe('the Text Editor buttons', () => {
  const button = (root, text) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

  it('keeps Save disabled until the text differs from the saved text', async () => {
    setup('The saved text.');
    const view = await mount();
    const save = button(view.container, 'Save');
    expect(save.disabled).toBe(true);
    expect(save.className).toContain('bg-primary');
    expect(save.className).not.toContain('emerald');
    const box = view.container.querySelector('textarea');
    await view.step(() => typeInto(box, 'The saved text. And more.'));
    expect(save.disabled).toBe(false);
    await view.step(() => typeInto(box, 'The saved text.'));
    expect(save.disabled).toBe(true);
    await view.unmount();
  });

  it('shows Clear tokens as an outline red button, disabled with no tokens', async () => {
    setup('The saved text.');
    const view = await mount();
    const clear = button(view.container, 'Clear tokens');
    expect(clear).toBeTruthy();
    expect(clear.disabled).toBe(true);
    const classes = clear.className.split(/\s+/);
    expect(classes).toContain('text-destructive');
    expect(classes).not.toContain('bg-destructive');
    await view.unmount();
  });
});

// H33-UD-2: in a project UD has not adopted the tab is read-only, as Annotate
// is. Its sentences and words may be another app's, and Clear tokens took that
// app's annotation with them.
describe('the Text Editor in a project not set up for UD', () => {
  const buttons = (root) => [...root.querySelectorAll('button')].map((b) => b.textContent.trim());

  it('locks the text and offers no write, to a writer', async () => {
    setup('The saved text.', { isConfigured: false });
    const view = await mount();
    expect(view.container.querySelector('textarea').readOnly).toBe(true);
    expect(buttons(view.container)).not.toContain('Save');
    expect(buttons(view.container)).not.toContain('Clear tokens');
    expect(view.container.textContent).toContain(
      'This project is not set up for UD. A project maintainer can set it up.',
    );
    await view.unmount();
  });

  it('links a maintainer to the set-up page', async () => {
    setup('The saved text.', { isConfigured: false, writers: [], maintainers: ['u1'] });
    const view = await mount();
    expect(view.container.querySelector('textarea').readOnly).toBe(true);
    const link = [...view.container.querySelectorAll('a')].find(
      (a) => a.textContent === 'Set it up',
    );
    expect(link.getAttribute('href')).toBe('/projects/p1/configuration');
    await view.unmount();
  });
});
