import { describe, it, expect, vi, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// Arriving in the Text Editor with `?sent=` outlines that sentence's block for
// a moment. The app renders under StrictMode, which runs each effect, cleans
// it up and runs it again on mount: the outline must still fade.

const client = vi.hoisted(() => ({ enterStrictMode: vi.fn(), exitStrictMode: vi.fn() }));
const auth = vi.hoisted(() => ({ getClient: () => client, user: { id: 'u1' } }));
vi.mock('../../contexts/AuthContext.jsx', () => ({ useAuth: () => auth }));
const editor = vi.hoisted(() => ({ current: null }));
vi.mock('@ui/hooks/useDocumentEditor.js', () => ({ useDocumentEditor: () => editor.current }));
vi.mock('./TokenVisualizer.jsx', () => ({
  TokenVisualizer: ({ flashSentenceId }) => (
    <>
      <div data-sentence-block="s1" data-flash={flashSentenceId === 's1' ? 'true' : undefined} />
      <div data-sentence-block="s2" data-flash={flashSentenceId === 's2' ? 'true' : undefined} />
    </>
  ),
}));
vi.mock('./services/ParseDialog.jsx', () => ({ ParseDialog: () => null }));
vi.mock('./services/TokenizeDialog.jsx', () => ({ TokenizeDialog: () => null }));

const { TextEditor } = await import('./TextEditor.jsx');

const doc = {
  id: 'd1',
  name: 'D',
  isSaving: false,
  layerInfo: {
    isConfigured: true,
    textLayer: { id: 't', text: { id: 'x', body: 'The dog ran. The cat sat.' } },
    wordTokenLayer: { tokens: [] },
  },
  saveText: vi.fn(async () => true),
};
editor.current = {
  projectId: 'p1',
  documentId: 'd1',
  project: { id: 'p1', name: 'P', writers: ['u1'], readers: [], maintainers: [] },
  doc,
  services: {},
  writeLockHeld: null,
};

afterEach(() => vi.useRealTimers());

describe('the outline on the sentence a link lands on', () => {
  it('shows, then fades under StrictMode', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    Element.prototype.scrollIntoView ??= () => {};
    const view = await renderComponent(
      <StrictMode>
        <MemoryRouter initialEntries={['/projects/p1/documents/d1/edit?sent=s2']}>
          <TextEditor />
        </MemoryRouter>
      </StrictMode>,
    );
    const block = () => view.container.querySelector('[data-sentence-block="s2"]');
    expect(block().getAttribute('data-flash')).toBe('true');
    await view.step(() => vi.advanceTimersByTime(2100));
    expect(block().hasAttribute('data-flash')).toBe(false);
    await view.unmount();
  });
});
