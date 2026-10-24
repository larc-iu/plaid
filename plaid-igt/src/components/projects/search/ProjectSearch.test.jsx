import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { ProjectSearch } from './ProjectSearch.jsx';
import { runHitsSearch } from './searchRunner.js';

vi.mock('@/utils/feedback', () => ({
  notifyError: vi.fn(),
  humanizeError: (e) => String(e?.message ?? e),
}));
vi.mock('@/domain/layerInfo', () => ({ getIgtLayerInfo: () => ({}) }));
vi.mock('./searchQueries.js', async (orig) => ({
  ...(await orig()),
  searchDomains: () => [{ id: 'words', kind: 'token', label: 'Words' }],
}));
vi.mock('./searchRunner.js', () => ({ runHitsSearch: vi.fn(), runFreqSearch: vi.fn() }));

const HITS = {
  mode: 'hits',
  totalHits: 1,
  totalDocs: 1,
  remainingDocs: 0,
  groups: [
    {
      docId: 'd1',
      docName: 'Story',
      docHits: 1,
      rows: [{ sentenceId: 's1', sentenceIndex: 0, text: 'el gato', marks: [], notes: [] }],
    },
  ],
};

const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
const search = async (view, q) => {
  const box = view.container.querySelector('input[placeholder="Search this project…"]');
  await view.step(() => {
    setter.call(box, q);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await view.step(async () => {
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
};

beforeEach(() => vi.clearAllMocks());

describe('ProjectSearch', () => {
  // HUNT-igt R5: the box said the new query while the old query's hits stayed
  // on screen under it, and only a toast said the search had failed.
  it('a failed search clears the previous hits', async () => {
    runHitsSearch.mockResolvedValue(HITS);
    const view = await renderComponent(
      <MemoryRouter>
        <ProjectSearch project={{ id: 'p1', vocabs: [] }} projectId="p1" client={{}} />
      </MemoryRouter>,
    );
    await search(view, 'gato');
    expect(view.container.textContent).toContain('Story');
    runHitsSearch.mockRejectedValue(Object.assign(new Error('bad'), { status: 400 }));
    await search(view, 'per(');
    expect(runHitsSearch.mock.calls.at(-1)[4]).toBe('per(');
    expect(view.container.textContent).not.toContain('Story');
    await view.unmount();
  });
});
