import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider';

// Changing or deleting a token's words from the Text Editor (V3 S3, D12), and
// clearing or splitting what other layers hang on. The question names no app:
// what other layers lose is counted by layer, with this editor's own
// annotations (N1-CASCADE-2 to -4).

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
const setup = (loss, { other = { annotations: 0, links: 0 }, clear, split } = {}) => {
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
    otherLossForWord: vi.fn(() => other),
    clearLoss: vi.fn(() => clear),
    otherLossForSentenceSplit: vi.fn(() => split || { annotations: 0, links: 0 }),
    clearTokens: vi.fn(async () => true),
    toggleSentenceBoundary: vi.fn(async () => true),
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
    const doc = setup({ annotations: 2, relations: 1, forms: 0 });
    const view = await mount();
    await act(async () => visualized.props.onSetWordMorphemes(home, ['house']));
    expect(dialog()).toBeNull();
    expect(doc.setWordMorphemes).toHaveBeenCalledWith(home, ['house']);
    await view.unmount();
  });

  it('asks before another number of words replaces annotated ones, naming what goes', async () => {
    const doc = setup({ annotations: 2, relations: 1, forms: 0 });
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
    const bare = setup({ annotations: 0, relations: 0, forms: 0 });
    let view = await mount();
    await act(async () => visualized.props.onWordDelete('w1'));
    expect(dialog()).toBeNull();
    expect(bare.deleteWord).toHaveBeenCalledWith('w1');
    await view.unmount();

    const doc = setup({ annotations: 1, relations: 0, forms: 0 });
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

  it("asks before deleting a token whose only annotation is its words' forms", async () => {
    const doc = setup({ annotations: 0, relations: 0, forms: 2 });
    const view = await mount();
    let done;
    await act(async () => {
      done = visualized.props.onWordDelete('w1');
    });
    expect(dialog().textContent).toContain('Deletes 2 annotations on “home”.');
    await press('Cancel');
    await act(async () => done);
    expect(doc.deleteWord).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('retypes words in another number without asking about the forms it replaces', async () => {
    const doc = setup({ annotations: 0, relations: 0, forms: 2 });
    const view = await mount();
    await act(async () => visualized.props.onSetWordMorphemes(home, ['ho', 'me']));
    expect(dialog()).toBeNull();
    expect(doc.setWordMorphemes).toHaveBeenCalledWith(home, ['ho', 'me']);
    await view.unmount();
  });

  it('asks before deleting a token another layer annotates, counting it with its own', async () => {
    const doc = setup(
      { annotations: 1, relations: 0, forms: 0 },
      { other: { annotations: 3, links: 2 } },
    );
    const view = await mount();
    let done;
    await act(async () => {
      done = visualized.props.onWordDelete('w1');
    });
    expect(dialog().textContent).toContain(
      'Deletes 4 annotations and 2 vocabulary links on “home”.',
    );
    expect(dialog().textContent).not.toMatch(/glossing|another app|IGT|layer/i);
    await press('Cancel');
    await act(async () => done);
    expect(doc.deleteWord).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('asks before deleting a token whose only annotations are on other layers', async () => {
    const doc = setup(
      { annotations: 0, relations: 0, forms: 0 },
      { other: { annotations: 0, links: 1 } },
    );
    const view = await mount();
    let done;
    await act(async () => {
      done = visualized.props.onWordDelete('w1');
    });
    expect(dialog().textContent).toContain('Deletes 1 vocabulary link on “home”.');
    await press('Delete');
    await act(async () => done);
    expect(doc.deleteWord).toHaveBeenCalledWith('w1');
    await view.unmount();
  });
});

describe('the Text Editor asking before the sentences go', () => {
  const clearButton = () =>
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Clear tokens');

  it('Clear tokens names what goes on every layer', async () => {
    const doc = setup(
      { annotations: 0, relations: 0, forms: 0 },
      { clear: { sentences: 2, tokens: 12, words: 13, annotations: 25, links: 9 } },
    );
    const view = await mount();
    let done;
    await act(async () => {
      done = clearButton().click();
    });
    expect(dialog().textContent).toContain(
      'Deletes 2 sentences, 12 tokens and 13 words, with 25 annotations and 9 vocabulary links. This cannot be undone.',
    );
    await press('Cancel');
    await act(async () => done);
    expect(doc.clearTokens).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('Clear tokens on bare tokens names only the tokens', async () => {
    const doc = setup(
      { annotations: 0, relations: 0, forms: 0 },
      { clear: { sentences: 1, tokens: 1, words: 0, annotations: 0, links: 0 } },
    );
    const view = await mount();
    await act(async () => clearButton().click());
    expect(dialog().textContent).toContain(
      'Deletes 1 sentence and 1 token. This cannot be undone.',
    );
    await press('Clear');
    expect(doc.clearTokens).toHaveBeenCalled();
    await view.unmount();
  });

  it('a sentence split asks only when it takes relations another layer holds', async () => {
    const quiet = setup({ annotations: 0, relations: 0, forms: 0 });
    let view = await mount();
    await act(async () => visualized.props.onSentenceToggle(2));
    expect(dialog()).toBeNull();
    expect(quiet.toggleSentenceBoundary).toHaveBeenCalledWith(2);
    await view.unmount();

    const doc = setup(
      { annotations: 0, relations: 0, forms: 0 },
      { split: { annotations: 2, links: 0 } },
    );
    view = await mount();
    let done;
    await act(async () => {
      done = visualized.props.onSentenceToggle(2);
    });
    expect(dialog().textContent).toContain('Split sentence?');
    expect(dialog().textContent).toContain('Deletes 2 annotations.');
    await press('Split');
    await act(async () => done);
    expect(doc.toggleSentenceBoundary).toHaveBeenCalledWith(2);
    await view.unmount();
  });
});
