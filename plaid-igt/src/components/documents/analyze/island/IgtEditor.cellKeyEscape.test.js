import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';

// A cell key carries its field's name, which is whatever a maintainer typed.
// Put into a selector unescaped, a quote in the name made querySelector
// throw, so a refused edit lost its value with no note and no message.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

const FIELD = 'Gloss "a"';

let host;
let editor;

function mount() {
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = new IgtDocument({
    raw: buildRawDoc({ morphFields: [FIELD] }),
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: ['lead@x.com'], writers: [] },
    vocabularies: {},
    client,
    projectId: 'proj-1',
    user: null,
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, {});
  return { doc, client };
}

const cellOf = (key) =>
  [...host.querySelectorAll('[data-cell-key]')].find((el) => el.dataset.cellKey === key);
const settle = async (n = 30) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => resetIds());
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('a field whose name holds a quote', () => {
  it('keeps a refused value in its cell', async () => {
    const { doc, client } = mount();
    const before = JSON.parse(JSON.stringify(doc.raw));
    client.documents.get = async () => JSON.parse(JSON.stringify(before));
    const errors = [];
    const onError = (e) => errors.push(e);
    window.addEventListener('error', onError);
    const spans = { ...client.spans };
    for (const method of Object.keys(spans)) {
      client.spans[method] = async () => {
        throw Object.assign(new Error('Server error'), { status: 500 });
      };
    }
    const key = `ma:m-1:${FIELD}`;
    const a = cellOf(key);
    expect(a).toBeTruthy();
    a.focus();
    a.value = 'AAA';
    a.dispatchEvent(new Event('input', { bubbles: true }));
    const other = [...host.querySelectorAll('[data-cell-key]')].find(
      (el) => el.dataset.cellKey !== key && el.tagName === 'INPUT',
    );
    other.focus();
    await settle();
    window.removeEventListener('error', onError);
    const now = cellOf(key);
    expect(now.value).toBe('AAA');
    expect(now.classList.contains('igt-field--unsent')).toBe(true);
    expect(errors).toEqual([]);
  });
});
