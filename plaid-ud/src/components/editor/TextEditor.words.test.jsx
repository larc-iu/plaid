import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider';

// Changing or deleting a token's words from the Text Editor (V3 S3, D12). The
// question names only this editor's own annotations (Luke's ruling Q3: an app
// speaks of its own data).

const auth = vi.hoisted(() => ({ getClient: () => null, user: { id: 'u1' } }));
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

const home = { id: 'w1', begin: 0, end: 4 };
const setup = (loss) => {
  const doc = {
    id: 'd1',
    name: 'D',
    isSaving: false,
    layerInfo: {
      isConfigured: true,
      textLayer: { id: 't', text: { id: 'x', body: 'home' } },
      sentenceTokenLayer: { tokens: [{ id: 's1', begin: 0, end: 4 }] },
      wordTokenLayer: { tokens: [home] },
      morphemeTokenLayer: { tokens: [{ id: 'm1', begin: 0, end: 4 }] },
    },
    annotationLossForWord: vi.fn(() => loss),
    setWordMorphemes: vi.fn(async () => true),
    deleteWord: vi.fn(async () => true),
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

const dialog = () => document.querySelector('[role="alertdialog"]');
const press = async (label) => {
  const b = [...dialog().querySelectorAll('button')].find((x) => x.textContent.trim() === label);
  await act(async () => b.click());
};

describe('the Text Editor asking before words go', () => {
  it('respells as many words as before without asking', async () => {
    const doc = setup({ annotations: 2, relations: 1 });
    const view = await mount();
    await act(async () => visualized.props.onSetWordMorphemes(home, ['house']));
    expect(dialog()).toBeNull();
    expect(doc.setWordMorphemes).toHaveBeenCalledWith(home, ['house']);
    await view.unmount();
  });

  it('asks before another number of words replaces annotated ones, naming what goes', async () => {
    const doc = setup({ annotations: 2, relations: 1 });
    const view = await mount();
    let done;
    await act(async () => {
      done = visualized.props.onSetWordMorphemes(home, ['ho', 'me']);
    });
    expect(dialog().textContent).toContain('Deletes 2 annotations and 1 relation on “home”.');
    expect(dialog().textContent).not.toMatch(/glossing|another app/);
    await press('Cancel');
    await act(async () => done);
    expect(doc.setWordMorphemes).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('deletes a token with nothing on it at once, and asks for one with annotations', async () => {
    const bare = setup({ annotations: 0, relations: 0 });
    let view = await mount();
    await act(async () => visualized.props.onWordDelete('w1'));
    expect(dialog()).toBeNull();
    expect(bare.deleteWord).toHaveBeenCalledWith('w1');
    await view.unmount();

    const doc = setup({ annotations: 1, relations: 0 });
    view = await mount();
    let done;
    await act(async () => {
      done = visualized.props.onWordDelete('w1');
    });
    expect(dialog().textContent).toContain('Deletes 1 annotation on “home”.');
    await press('Delete');
    await act(async () => done);
    expect(doc.deleteWord).toHaveBeenCalledWith('w1');
    await view.unmount();
  });
});
