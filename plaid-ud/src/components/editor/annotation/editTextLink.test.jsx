import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { SentenceActions } from './SentenceActions.jsx';
import { EditorSessionContext } from './editorSession.js';

// Edit text takes the reader to the Text Editor at this sentence, a
// destination, so it is a real link: middle-click and cmd-click open the Text
// Editor in a new tab and leave the annotation where it was. Luke, 2026-10-08.

const SESSION = { isReadOnly: false, sentenceFields: [] };

const SENTENCE = { tokens: [], sentenceToken: null };

const mount = (editTextTo) =>
  renderComponent(
    <MemoryRouter>
      <EditorSessionContext.Provider value={SESSION}>
        <SentenceActions
          sentenceData={SENTENCE}
          sentenceNumber={1}
          commentAnchorLabel="Sentence 1"
          hasInferred={false}
          hasMachine={false}
          editTextTo={editTextTo}
        />
      </EditorSessionContext.Provider>
    </MemoryRouter>,
  );

describe('Edit text', () => {
  it('is a link to the Text Editor at the sentence', async () => {
    const { container, unmount } = await mount('/projects/p/documents/d/edit?sent=s1');
    const link = container.querySelector('.edit-text-btn');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/projects/p/documents/d/edit?sent=s1');
    expect(link.textContent).toContain('Edit text');
    await unmount();
  });

  it('is absent where there is nowhere to land', async () => {
    const { container, unmount } = await mount(undefined);
    expect(container.querySelector('.edit-text-btn')).toBeNull();
    await unmount();
  });
});
