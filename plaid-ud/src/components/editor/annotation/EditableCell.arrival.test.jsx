import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { press } from '../../../test/keyboard.js';
import { EditableCell } from './EditableCell.jsx';
import { EditorSessionContext } from './editorSession.js';

// A cell selects its text on arrival, one tick after the focus. In Chromium
// `select()` also FOCUSES the input, so a select that fires after the caret has
// already moved on pulls the caret back. The cell it came back to arrives
// again and asks for another select, the cell it left does the same, and the
// two take the caret from each other until something else intervenes. The
// review sweep (Ctrl/Cmd+Shift+Down) moves the caret twice inside that tick on
// a busy page.

const SESSION = { isReadOnly: false, onAnnotationUpdate: () => Promise.resolve() };

const cell = (tokenId, field) => (
  <EditableCell
    value="x"
    tokenId={tokenId}
    tokenIndex={0}
    field={field}
    tokenForm="x"
    tabIndex={1}
    columnWidth={80}
  />
);

describe('EditableCell select on arrival', () => {
  for (const field of ['lemma', 'upos']) {
    it(`never selects a ${field} cell the caret has already left`, async () => {
      const { container, step, unmount } = await renderComponent(
        <EditorSessionContext.Provider value={{ ...SESSION, vocab: { upos: ['NOUN'] } }}>
          {cell('a', field)}
          {cell('b', field)}
        </EditorSessionContext.Provider>,
      );
      const [a, b] = all(container, 'input');
      const selectA = vi.spyOn(a, 'select');

      // Arrive in `a` and leave it for `b` before a's deferred select has run.
      await step(async () => {
        a.focus();
        b.focus();
      });
      await step(() => new Promise((resolve) => setTimeout(resolve, 20)));

      expect(document.activeElement).toBe(b);
      expect(selectA).not.toHaveBeenCalled();
      await unmount();
    });

    // The select waits a tick so that a click's own caret placement cannot undo
    // it, and a busy page can make that tick long. A key pressed inside it
    // still has to replace the value, not go in where the click left the caret
    // ("dog" typed into "do|g" arrived as "dodogg").
    it(`selects a ${field} cell before the first key pressed on arrival`, async () => {
      const { container, step, unmount } = await renderComponent(
        <EditorSessionContext.Provider value={{ ...SESSION, vocab: { upos: ['NOUN'] } }}>
          {cell('a', field)}
        </EditorSessionContext.Provider>,
      );
      const [a] = all(container, 'input');

      await step(async () => {
        a.focus();
        a.setSelectionRange(1, 1);
        press(a, 'd');
        expect([a.selectionStart, a.selectionEnd]).toEqual([0, a.value.length]);
      });
      await unmount();
    });
  }
});
