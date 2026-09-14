import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';

// The grid's two little menus: which rows show, and what format a sentence
// copies as. Both are opened from a control and close over it, so both have to
// hand focus back — a keyboard user who closes one should not land on the page.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
let editor;

const mount = () => {
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = new IgtDocument({
    raw: buildRawDoc({}),
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: ['lead@x.com'], writers: [] },
    vocabularies: {},
    client,
    projectId: 'proj-1',
    user: null,
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, {});
  return doc;
};

const click = (el) =>
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const escape = (el) =>
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );

beforeEach(() => {
  resetIds();
});
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('the row menu', () => {
  it('gives focus back to the label it was opened from', () => {
    mount();
    const label = host.querySelector('.igt-row-label:not(.igt-row-label--spacer)');
    label.focus();
    click(label);

    const box = host.querySelector('.igt-rowmenu input[type="checkbox"]');
    expect(box).not.toBeNull();
    box.focus();
    escape(box);

    expect(host.querySelector('.igt-rowmenu')).toBeNull();
    expect(document.activeElement).toBe(label);
  });

  it('leaves focus where it is when the menu closes from outside', () => {
    mount();
    const label = host.querySelector('.igt-row-label:not(.igt-row-label--spacer)');
    click(label);

    const cell = host.querySelector('input.igt-field');
    cell.focus();
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(host.querySelector('.igt-rowmenu')).toBeNull();
    expect(document.activeElement).toBe(cell);
  });
});

describe('the copy format menu', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it('gives focus back to the caret when it closes', () => {
    mount();
    const caret = host.querySelector('.igt-copy__caret');
    click(caret);

    const item = host.querySelector('.igt-copy__item');
    expect(item).not.toBeNull();
    item.focus();
    escape(item);

    expect(host.querySelector('.igt-copy__menu')).toBeNull();
    expect(document.activeElement).toBe(caret);
  });

  it('gives it back when a format is picked, too', async () => {
    mount();
    const caret = host.querySelector('.igt-copy__caret');
    click(caret);

    const item = host.querySelector('.igt-copy__item');
    item.focus();
    click(item);
    await new Promise((r) => setTimeout(r, 0));

    expect(host.querySelector('.igt-copy__menu')).toBeNull();
    expect(navigator.clipboard.writeText).toHaveBeenCalled();
    expect(document.activeElement).toBe(caret);
  });
});
