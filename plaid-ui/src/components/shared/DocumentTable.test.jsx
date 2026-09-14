import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, texts, all } from '../../test/renderComponent.jsx';
import { DocumentTable } from './DocumentTable.jsx';

const { toast } = vi.hoisted(() => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock('sonner', () => ({ toast }));

const DOCS = [
  { id: 'd1', name: 'Alpha', timeModified: '2026-09-01T00:00:00Z' },
  { id: 'd2', name: 'Beta', timeModified: '2026-09-02T00:00:00Z' },
];

const client = (over = {}) => ({
  query: async () => ({ results: [['d1', 42]] }),
  projects: { myLastEdits: async () => ({}) },
  ...over,
});

const mount = (props) =>
  renderComponent(
    <MemoryRouter>
      <DocumentTable
        documents={DOCS}
        client={client()}
        projectId="p1"
        wordLayerId="wl"
        href={(id) => `/projects/p1/documents/${id}`}
        defaultSort={{ key: 'name', dir: 'asc' }}
        {...props}
      />
    </MemoryRouter>,
  );

// The Words cell of each row, in row order.
const wordCells = (container) =>
  all(container, 'tbody tr').map((tr) => tr.children[1].textContent.trim());

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('DocumentTable', () => {
  it('counts the layer it was given, and reads zero for a document with none', async () => {
    const { container, unmount } = await mount();
    expect(texts(container, 'tbody tr td:first-child')).toEqual(['AlphaID: d1', 'BetaID: d2']);
    expect(wordCells(container)).toEqual(['42', '0']);
    await unmount();
  });

  it('reads as a dash, not as zero, when there is no layer to count', async () => {
    const query = vi.fn();
    const { container, unmount } = await mount({
      wordLayerId: undefined,
      client: client({ query }),
    });
    expect(query).not.toHaveBeenCalled();
    expect(wordCells(container)).toEqual(['—', '—']);
    await unmount();
  });

  it('warns and drops the column when the count query fails, keeping the list', async () => {
    const { container, unmount } = await mount({
      client: client({
        query: async () => {
          throw new Error('nope');
        },
      }),
    });
    expect(toast.warning).toHaveBeenCalled();
    expect(wordCells(container)).toEqual(['—', '—']);
    expect(all(container, 'tbody tr')).toHaveLength(2);
    await unmount();
  });

  it('hands the counts to the caller’s href, so an empty document can be sent elsewhere', async () => {
    const { container, unmount } = await mount({
      href: (id, { wordCount, hasWordLayer, wordsLoading }) =>
        hasWordLayer && !wordsLoading && (wordCount ?? 0) === 0
          ? `/projects/p1/documents/${id}/edit`
          : `/projects/p1/documents/${id}/annotate`,
    });
    const hrefs = all(container, 'tbody tr td:first-child a').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/projects/p1/documents/d1/annotate', '/projects/p1/documents/d2/edit']);
    await unmount();
  });

  it('reads a document this reader never touched as a dash', async () => {
    const { container, unmount } = await mount({
      client: client({ projects: { myLastEdits: async () => ({ d1: '2026-09-03T00:00:00Z' }) } }),
    });
    const mine = all(container, 'tbody tr').map((tr) => tr.children[3].textContent.trim());
    expect(mine[1]).toBe('—');
    expect(mine[0]).not.toBe('—');
    await unmount();
  });

  it('warns when the last-edit read fails, and leaves every cell empty', async () => {
    const { container, unmount } = await mount({
      client: client({
        projects: {
          myLastEdits: async () => {
            throw new Error('nope');
          },
        },
      }),
    });
    expect(toast.warning).toHaveBeenCalledWith('Column unavailable', {
      description: 'Your last edit could not be loaded for the document list.',
    });
    const mine = all(container, 'tbody tr').map((tr) => tr.children[3].textContent.trim());
    expect(mine).toEqual(['—', '—']);
    await unmount();
  });
});
