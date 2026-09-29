import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';
import { notifyError, notifyWarning } from '@/utils/feedback';

// A cell edited twice by one person while the first edit's save was still
// out. Whatever became of the first, the value on screen is theirs, not
// another user's: no conflict note, no toast naming someone, and Enter never
// writes the older value over the newer (as plaid-ud's 490ca14a).

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

let host;
let editor;

const withGloss = (value) => {
  const raw = buildRawDoc({});
  const layer = raw.textLayers[0].tokenLayers
    .flatMap((tl) => tl.spanLayers || [])
    .find((sl) => sl.id === 'msl-0');
  if (value != null) layer.spans.push({ id: 'span-b', tokens: ['m-1'], value });
  return raw;
};

// The server holds `server.value` for span-b. `answers` says, per update in
// order, what becomes of it: 'land', 'lost' (stored, answer lost), or a
// status the server refuses it with. Every answer waits on its gate.
function mount(answers) {
  const server = { value: 'dog' };
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  client.documents.get = async () => withGloss(server.value);
  client.documents.auditPage = async () => ({
    entries: [{ user: { id: 'a@b.com', displayName: 'a' }, ops: [] }],
    nextCursor: null,
  });
  const gates = [];
  let n = 0;
  client.spans.update = async (id, value) => {
    const answer = answers[n++] ?? 'land';
    await new Promise((r) => gates.push(r));
    if (answer === 'land' || answer === 'lost') server.value = value;
    if (answer === 'land') return {};
    const status = answer === 'lost' ? 0 : answer;
    throw Object.assign(new Error(`HTTP ${status}`), { status });
  };
  const doc = new IgtDocument({
    raw: withGloss('dog'),
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: ['lead@x.com'], writers: [] },
    vocabularies: {},
    client,
    projectId: 'proj-1',
    user: { id: 'c@x.com' },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, {});
  const release = async () => {
    for (let i = 0; i < 40; i++) {
      gates.splice(0).forEach((r) => r());
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return { client, server, release };
}

const cell = (key) => host.querySelector(`[data-cell-key="${key}"]`);
const note = (key) =>
  cell(key)?.closest('.igt-cell__face')?.querySelector('.igt-field-conflict') ?? null;
const type = (el, value) => {
  el.value = value;
  el.setSelectionRange(value.length, value.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const key = (el, k) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const settle = async (n = 30) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

// Edit the gloss of m-1 to A, move on, come back and edit it to B, move on.
const editTwice = async () => {
  const c = cell('ma:m-1:Gloss');
  const other = cell('ma:m-2:Gloss');
  c.focus();
  type(c, 'A');
  other.focus();
  await settle(5);
  c.focus();
  type(c, 'B');
  other.focus();
  await settle(5);
  return c;
};

beforeEach(() => {
  resetIds();
  vi.mocked(notifyWarning).mockClear();
  vi.mocked(notifyError).mockClear();
});
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('a cell edited again while its first save was out', () => {
  for (const [what, first] of [
    ['refused', 500],
    ['stored with its answer lost', 'lost'],
  ]) {
    it(`shows the newer value and no conflict when the first was ${what}`, async () => {
      const { server, release } = mount([first, 'land']);
      const c = await editTwice();
      await release();
      await settle();

      expect(server.value).toBe('B');
      expect(c.value).toBe('B');
      expect(note('ma:m-1:Gloss')).toBeNull();
      expect(notifyWarning).not.toHaveBeenCalled();
      // Enter in the cell writes nothing older over B.
      c.focus();
      key(c, 'Enter');
      await release();
      await settle();
      expect(server.value).toBe('B');
    });
  }

  it('puts the newer value back, not a conflict, when the first landed unheard and the second was refused', async () => {
    const { server, release } = mount(['lost', 500]);
    const c = await editTwice();
    await release();
    await settle();

    expect(server.value).toBe('A');
    expect(note('ma:m-1:Gloss')).toBeNull();
    expect(notifyWarning).not.toHaveBeenCalled();
    expect(c.value).toBe('B');
    expect(c.igtUnsent?.typed).toBe('B');
  });

  it("is still a conflict when another user's value is what the server holds", async () => {
    const { server, release } = mount([409, 409]);
    const c = await editTwice();
    server.value = 'theirs';
    await release();
    await settle();

    expect(c.value).toBe('theirs');
    expect(note('ma:m-1:Gloss')?.textContent).toBe('Yours: B · Enter to keep yours');
    expect(notifyWarning).toHaveBeenCalledTimes(1);
  });
});

describe('the conflict note', () => {
  it('describes its cell for a screen reader and takes the direction of the row it hangs in', async () => {
    const { server, release } = mount([409]);
    const c = cell('ma:m-1:Gloss');
    c.focus();
    type(c, 'hound');
    cell('ma:m-2:Gloss').focus();
    server.value = 'theirs';
    await release();
    await settle();

    const n = note('ma:m-1:Gloss');
    expect(n).not.toBeNull();
    expect(n.id).toBeTruthy();
    expect(c.getAttribute('aria-describedby')).toBe(n.id);
    expect(document.getElementById(n.id)).toBe(n);
    // No dir of its own: "Yours" would make it left to right, and it would
    // hang from the wrong edge of a right-to-left sentence.
    expect(n.hasAttribute('dir')).toBe(false);
    expect(n.querySelector('bdi')?.textContent).toBe('hound');

    c.focus();
    key(c, 'Escape');
    await settle();
    expect(note('ma:m-1:Gloss')).toBeNull();
    expect(c.hasAttribute('aria-describedby')).toBe(false);
  });
});

// A save whose answer was lost, but which landed: the refetch shows the typed
// value, which is stored. It is not put back as unsent, and a later edit of
// the cell refused for another reason is not taken for another user's change
// (REV-F-IGT D2, the igt side of plaid-ud's R4).
describe('an edit that landed with its answer lost', () => {
  const editOnce = async (value) => {
    const c = cell('ma:m-1:Gloss');
    c.focus();
    type(c, value);
    cell('ma:m-2:Gloss').focus();
    await settle(5);
    return c;
  };

  it('is shown as stored, not put back unsent', async () => {
    const { server, release } = mount(['lost']);
    const c = await editOnce('A');
    await release();
    await settle();

    expect(server.value).toBe('A');
    expect(c.value).toBe('A');
    expect(c.igtUnsent ?? null).toBeNull();
    expect(c.classList.contains('igt-field--unsent')).toBe(false);
    expect(note('ma:m-1:Gloss')).toBeNull();
  });

  it('then a later edit refused for another reason is no conflict', async () => {
    const { server, release } = mount(['lost', 500]);
    const c = await editOnce('A');
    await release();
    await settle();
    const c2 = cell('ma:m-1:Gloss');
    c2.focus();
    type(c2, 'B');
    cell('ma:m-2:Gloss').focus();
    await settle(5);
    await release();
    await settle();

    expect(server.value).toBe('A');
    expect(note('ma:m-1:Gloss')).toBeNull();
    expect(notifyWarning).not.toHaveBeenCalled();
    expect(cell('ma:m-1:Gloss').value).toBe('B');
    expect(cell('ma:m-1:Gloss').igtUnsent?.saved).toBe('A');
    void c;
  });
});

describe('a conflict that is not the cell’s own', () => {
  it('says the value is kept in its cell, not to redo the edit', async () => {
    const { release } = mount([409]);
    const c = cell('ma:m-1:Gloss');
    c.focus();
    type(c, 'hound');
    cell('ma:m-2:Gloss').focus();
    await release();
    await settle();

    expect(note('ma:m-1:Gloss')).toBeNull();
    expect(c.value).toBe('hound');
    expect(notifyError).toHaveBeenCalledWith(
      'Changed elsewhere. Your value is kept in its cell, and leaving the cell sends it again.',
      'Failed to update Gloss',
    );
  });
});
