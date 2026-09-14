import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';

// What the island does after it is taken down. The shell builds one per
// document, so stepping through history or moving to the next document
// destroys this one while its requests are still out.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
let editor;

// `query` is the project-precedent fetch, the one request the island makes on
// its own. Held open so a test can answer it after the teardown.
const mount = ({ query } = {}) => {
  const client = makeFakeClient();
  client.query = query ?? (async () => ({ results: [] }));
  const doc = new IgtDocument({
    raw: buildRawDoc({}),
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: ['lead@x.com'], writers: [] },
    vocabularies: {},
    client,
    projectId: 'proj-1',
    user: null,
  });
  client.documents.get = async () => doc.raw;
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, {});
  return { doc, client };
};

const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  resetIds();
});
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('an island that has been taken down', () => {
  it('does not repaint when its precedent query finally answers', async () => {
    // One promise per query the island fires, all held until the teardown.
    const answers = [];
    mount({ query: () => new Promise((resolve) => answers.push(resolve)) });
    expect(host.querySelector('.igt-sentence')).not.toBeNull();

    editor.destroy();
    // lit leaves its own marker behind; what matters is that the grid is gone.
    const emptied = host.innerHTML;
    expect(host.querySelector('.igt-sentence')).toBeNull();

    expect(answers.length).toBeGreaterThan(0);
    answers.forEach((resolve) => resolve({ results: [] }));
    await settle();
    expect(host.innerHTML).toBe(emptied);
  });

  it('does not repaint when a mutation lands', async () => {
    const { doc } = mount();
    editor.destroy();
    const emptied = host.innerHTML;

    await doc.updateMorphemeSpan('m-1', 'Gloss', 'cat');
    await settle();
    expect(host.innerHTML).toBe(emptied);
    expect(host.querySelector('.igt-sentence')).toBeNull();
  });
});
