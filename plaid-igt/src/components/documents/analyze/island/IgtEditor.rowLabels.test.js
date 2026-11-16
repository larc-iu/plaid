import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildRawDoc,
  makeFakeClient,
  resetIds,
  makeIgtDoc,
  mountIsland,
} from '@/domain/test-helpers.js';

// The row labels say which row is the text as typed and which an additional
// orthography: a person saw their words on an unlabelled row and an empty row
// under it named for their orthography, and took the empty row for where their
// text should have gone.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
let editor;

beforeEach(() => {
  resetIds();
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = makeIgtDoc({
    raw: buildRawDoc({ orthographies: [{ name: 'Wolof Ajami' }] }),
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: ['lead@x.com'], writers: [] },
    client,
    user: null,
  });
  ({ host, editor } = mountIsland(doc));
});
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('the row labels', () => {
  it('names the word-form row Baseline, the text as typed', () => {
    const label = host.querySelector('.igt-row-label--spacer');
    expect(label.textContent.trim()).toBe('Baseline');
    expect(label.getAttribute('title')).toBe('Baseline: the text as typed');
  });

  it("names an orthography's row as given, an additional orthography", () => {
    const label = host.querySelector('.igt-row-label--orth');
    expect(label.textContent.trim()).toBe('Wolof Ajami');
    expect(label.getAttribute('title')).toBe('Wolof Ajami (additional orthography)');
  });
});
