import { describe, it, expect } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { Turn } from '@ui/components/assistant/Turn.jsx';
import { IGT_ASSISTANT } from './adapter.js';

// A plan row is a link into the editor, and it behaves like every other link
// the panel draws. It used to be the odd one out: `target="_blank"`, so a row
// pointing at the very document the panel was docked beside opened a second
// browser tab instead of scrolling the grid, and a row pointing elsewhere left
// the thread behind.

const where = (sentence, documentId = 'd1') => ({
  kind: 'token',
  documentId,
  documentName: documentId === 'd1' ? 'Text 1' : 'Text 2',
  sentenceId: `s-${sentence}`,
  sentence,
  word: 1,
  morpheme: null,
  begin: 0,
  surface: documentId === 'd1' ? 'gam' : 'aku',
});

const turn = (onFocusHere) => (
  <Turn
    item={{
      kind: 'assistant',
      text: '',
      status: null,
      plan: {
        id: 'p1',
        summary: '2 field values',
        labels: ['a', 'b'],
        ops: [{}, {}],
        changes: [
          { label: 'a', where: where(1), change: 'Gloss = "x"' },
          { label: 'b', where: where(4, 'd2'), change: 'Gloss = "y"' },
        ],
      },
    }}
    projectId="p"
    adapter={IGT_ASSISTANT}
    onFocusHere={onFocusHere}
    results={new Map()}
    canWrite
    onApprove={() => {}}
    onDiscard={() => {}}
  />
);

const rowLink = (container, name) => all(container, 'a').find((a) => a.textContent === name);
const click = (el) => {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

describe('a plan row as a link', () => {
  it('scrolls the document beside the panel rather than opening a tab', async () => {
    const seen = [];
    const { container, unmount } = await renderComponent(
      turn((at) => {
        seen.push(at);
        return at.documentId === 'd1';
      }),
    );
    const link = rowLink(container, 'gam');
    expect(link.getAttribute('target')).toBeNull();
    expect(click(link).defaultPrevented).toBe(true);
    expect(seen).toEqual([{ documentId: 'd1', focus: 's-1', begin: 0 }]);
    await unmount();
  });

  it('lets a row into another document navigate', async () => {
    const { container, unmount } = await renderComponent(turn((at) => at.documentId === 'd1'));
    const link = rowLink(container, 'aku');
    expect(link.getAttribute('target')).toBeNull();
    expect(click(link).defaultPrevented).toBe(false);
    await unmount();
  });

  it('leaves a modified click to the browser', async () => {
    // cmd-click and middle-click are how people open a new tab, and a panel
    // that swallowed them would be the one place in the app where they did
    // nothing.
    const seen = [];
    const { container, unmount } = await renderComponent(
      turn((at) => {
        seen.push(at);
        return true;
      }),
    );
    const link = rowLink(container, 'gam');
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    link.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(seen).toEqual([]);
    await unmount();
  });

  it('names the document group as a link too, and does not claim it', async () => {
    // A group heading points at the document with no sentence, which no editor
    // can scroll to: the app refuses it and the link opens.
    const { container, unmount } = await renderComponent(turn(() => false));
    const heading = rowLink(container, 'Text 1');
    expect(heading.getAttribute('href')).toBe('#/projects/p/documents/d1');
    expect(heading.getAttribute('target')).toBeNull();
    await unmount();
  });
});
