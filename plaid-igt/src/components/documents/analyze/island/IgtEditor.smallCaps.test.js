import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';

// A gloss cell draws its tags in small caps at rest, as the LaTeX export sets
// them: the cell is marked when every capital in its value is a tag
// (capsAreSmallCaps), and left as typed otherwise.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
let editor;

function mount(values) {
  const raw = buildRawDoc({
    body: 'the cat sat',
    words: [
      { id: 'w-1', begin: 0, end: 3 },
      { id: 'w-2', begin: 4, end: 7 },
      { id: 'w-3', begin: 8, end: 11 },
    ],
  });
  const layer = raw.textLayers[0].tokenLayers
    .flatMap((tl) => tl.spanLayers || [])
    .find((sl) => sl.id === 'wsl-0');
  layer.spans = values.map((value, i) => ({ id: `s-${i}`, tokens: [`w-${i + 1}`], value }));
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = new IgtDocument({
    raw,
    project: { id: 'proj-1', config: { plaid: {} } },
    client,
    projectId: 'proj-1',
  });
  client.documents.get = async () => doc.raw;
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, {});
}

const wordCell = (id) => host.querySelector(`[data-cell-key^="wa:${id}:"]`);
const smallCaps = (id) => wordCell(id).classList.contains('igt-field--smallcaps');

beforeEach(() => resetIds());
afterEach(() => {
  editor?.destroy?.();
  host?.remove();
  host = null;
  editor = null;
});

describe('small caps in gloss cells', () => {
  it('marks a cell whose capitals are all tags', () => {
    mount(['DET', 'cat', 'John-PL']);
    expect(smallCaps('w-1')).toBe(true);
  });

  it('leaves a cell with no capital, and one with a capitalised word, as typed', () => {
    mount(['DET', 'cat', 'John-PL']);
    expect(smallCaps('w-2')).toBe(false);
    expect(smallCaps('w-3')).toBe(false);
  });
});
