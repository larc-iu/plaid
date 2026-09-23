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
vi.mock('./services/TokenizeDialog.jsx', () => ({ TokenizeDialog: () => null }));

const { TextEditor } = await import('./TextEditor.jsx');
const { hasUnsavedDraft } = await import('@ui/hooks/useUnsavedDraft.js');

const setup = (body, { writers = ['u1'] } = {}) => {
  editor.current = {
    projectId: 'p1',
    documentId: 'd1',
    project: { id: 'p1', name: 'P', writers, readers: [], maintainers: [] },
    doc: {
      id: 'd1',
      name: 'D',
      isSaving: false,
      layerInfo: {
        isConfigured: true,
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
});
