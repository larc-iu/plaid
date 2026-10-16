import { describe, it, expect } from 'vitest';
import { renderComponent } from '../test/renderComponent.jsx';
import { useCellEngine } from './useCellEngine.js';
import { releaseCellEngines } from '../domain/cells/heldCells.js';
import { hasUnsavedDraft } from './useUnsavedDraft.js';

// A refused value waiting for keep-yours, or put back to be sent again, is
// the open document's: a grid drawn again finds it (after a history entry was
// on screen in its place, or a tab switch), and it goes when the document
// closes (the parent's ruling, 2026-10-16).

const mount = async (doc, stored) => {
  const seen = { current: null };
  const Grid = () => {
    seen.current = useCellEngine(doc, { read: (key) => stored[key] });
    return null;
  };
  const r = await renderComponent(<Grid />);
  return { ...r, engine: () => seen.current };
};

const refused = { landed: false, status: 409, readBack: true };

describe('useCellEngine', () => {
  it('keeps a conflict and a value put back across the grid drawn again', async () => {
    const doc = { dataVersion: 1 };
    const stored = { a: 'theirs', b: 'old' };
    const first = await mount(doc, stored);
    const engine = first.engine();
    engine.settle(engine.sending('a', { saved: 'old', typed: 'mine' }), refused);
    engine.settle(engine.sending('b', { saved: 'old', typed: 'new' }), {
      landed: false,
      status: 500,
      readBack: true,
    });
    expect(engine.conflictOf('a')).toMatchObject({ typed: 'mine', stored: 'theirs' });
    expect(engine.unsentOf('b')).toMatchObject({ typed: 'new' });
    await first.unmount();

    // Something else was on screen. The grid is drawn again on the same document.
    const again = await mount(doc, stored);
    expect(again.engine()).toBe(engine);
    expect(again.engine().conflictOf('a')).toMatchObject({ typed: 'mine', stored: 'theirs' });
    expect(again.engine().unsentOf('b')).toMatchObject({ typed: 'new' });
    expect(hasUnsavedDraft()).toBeTruthy();

    // The document closes.
    await again.unmount();
    releaseCellEngines(doc);
    expect(engine.conflictOf('a')).toBe(null);
    expect(engine.unsentOf('b')).toBe(null);
    expect(hasUnsavedDraft()).toBe(null);
  });

  it('gives another document, and another grid of the same one, an engine of its own', async () => {
    const doc = { dataVersion: 1 };
    const one = await mount(doc, {});
    const other = await mount({ dataVersion: 1 }, {});
    expect(other.engine()).not.toBe(one.engine());
    await one.unmount();
    await other.unmount();
    releaseCellEngines(doc);
  });
});
