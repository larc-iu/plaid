import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildRawDoc,
  makeFakeClient,
  resetIds,
  makeIgtDoc,
  settle,
  mountIsland,
} from '@/domain/test-helpers.js';

// The save-status pill says "Saved ✓" only for a save the server took. A cell
// edit that lost to another user (Luke's ruling Q1: "b changed this to …"
// and "Yours: X · Enter to keep yours") was not saved.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

let host;
let editor;

const theirs = (value) => {
  const raw = buildRawDoc({});
  const layer = raw.textLayers[0].tokenLayers
    .flatMap((tl) => tl.spanLayers || [])
    .find((sl) => sl.id === 'msl-0');
  layer.spans.push({ id: 'span-b', tokens: ['m-1'], value });
  return raw;
};

function mount() {
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  client.documents.auditPage = async () => ({
    entries: [{ user: { id: 'b@x.com', displayName: 'b' }, ops: [] }],
    nextCursor: null,
  });
  const doc = makeIgtDoc({
    raw: buildRawDoc({}),
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: ['lead@x.com'], writers: [] },
    client,
    user: { id: 'c@x.com' },
  });
  ({ host, editor } = mountIsland(doc));
  return { doc, client };
}

const cell = (key) => host.querySelector(`[data-cell-key="${key}"]`);
const status = () => host.querySelector('.igt-status')?.textContent.trim() ?? '';
const type = (el, value) => {
  el.value = value;
  el.setSelectionRange(value.length, value.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

beforeEach(() => resetIds());
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('the save-status pill', () => {
  it('says "Saved ✓" once a cell edit is stored', async () => {
    mount();
    const c = cell('ma:m-1:Gloss');
    c.focus();
    type(c, 'hound');
    c.blur();
    await settle(30);
    expect(status()).toBe('Saved ✓');
  });

  it('does not say "Saved ✓" for a cell edit that lost to another user', async () => {
    const { client } = mount();
    client.documents.get = async () => theirs('dog.PL');
    client.spans.create = async () => {
      throw Object.assign(new Error('HTTP 409 refused'), { status: 409 });
    };
    const c = cell('ma:m-1:Gloss');
    c.focus();
    type(c, 'hound');
    c.blur();
    await settle(30);
    // The conflict is shown in the cell.
    expect(c.closest('.igt-cell__face')?.querySelector('.igt-field-conflict')?.textContent).toBe(
      'Yours: hound · Enter to keep yours',
    );
    expect(status()).not.toBe('Saved ✓');
  });
});
