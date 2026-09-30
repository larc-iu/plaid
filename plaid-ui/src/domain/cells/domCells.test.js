import { afterEach, describe, expect, it } from 'vitest';
import { domCells } from './domCells.js';

// The hand-DOM view of a cell: what a refusal may do to a drawn input, and
// the focus rule (E2 and DOGCHASE): a value goes back into its cell with focus
// only from that cell or from nowhere, never from another cell.

let root;
afterEach(() => {
  root?.remove();
  root = null;
});

function grid() {
  root = document.createElement('div');
  root.innerHTML = '<input data-cell-key="a"><input data-cell-key="b">';
  document.body.appendChild(root);
  const [a, b] = root.querySelectorAll('input');
  const shown = [];
  const putBacks = {};
  const view = domCells({
    find: (key) => root.querySelector(`[data-cell-key="${key}"]`),
    putBackOf: (key) => putBacks[key] ?? null,
    shown: (el, value) => shown.push([el.dataset.cellKey, value]),
  });
  return { a, b, view, shown, putBacks };
}

describe('domCells', () => {
  it('has no view for a cell that is not drawn', () => {
    const { view } = grid();
    expect(view('z')).toBe(null);
  });

  it('takes a value up into its cell with focus from the body', () => {
    const { a, view, shown } = grid();
    a.value = 'stored';
    document.activeElement?.blur?.();
    expect(view('a').takeUp({ typed: 'mine', saved: 'stored' })).toBe(true);
    expect(document.activeElement).toBe(a);
    expect(a.value).toBe('mine');
    expect(a.dataset.orig).toBe('stored');
    expect(shown).toEqual([['a', 'mine']]);
  });

  it('takes a value up into its cell when the cell has focus', () => {
    const { a, view } = grid();
    a.focus();
    expect(view('a').takeUp({ typed: 'mine', saved: '' })).toBe(true);
    expect(a.value).toBe('mine');
  });

  it('never takes focus from another cell', () => {
    const { a, b, view } = grid();
    b.focus();
    expect(view('a').takeUp({ typed: 'mine', saved: '' })).toBe(false);
    expect(document.activeElement).toBe(b);
    expect(a.value).toBe('');
  });

  it('tells newer typing in the focused cell from the value sent, the baseline and a put-back', () => {
    const { a, view, putBacks } = grid();
    a.focus();
    a.dataset.orig = 'stored';
    a.value = 'sent';
    expect(view('a').typedSince('sent')).toBe(false);
    a.value = 'stored';
    expect(view('a').typedSince('sent')).toBe(false);
    putBacks.a = 'older';
    a.value = 'older';
    expect(view('a').typedSince('sent')).toBe(false);
    a.value = 'newer';
    expect(view('a').typedSince('sent')).toBe(true);
    a.blur();
    expect(view('a').typedSince('sent')).toBe(false);
  });

  it('shows what is stored, and a conflict takes focus only on the same terms', () => {
    const { a, b, view } = grid();
    b.focus();
    view('a').showStored('theirs', { conflict: true });
    expect(a.value).toBe('theirs');
    expect(a.dataset.orig).toBe('theirs');
    expect(document.activeElement).toBe(b);
    b.blur();
    view('a').showStored('theirs', { conflict: true });
    expect(document.activeElement).toBe(a);
  });
});
