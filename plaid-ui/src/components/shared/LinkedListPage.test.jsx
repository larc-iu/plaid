import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, texts, all } from '../../test/renderComponent.jsx';
import { LinkedListPage, CountCell, TimeCell } from './LinkedListPage.jsx';

const ROWS = [
  { id: 'a', name: 'Alpha', count: 3 },
  { id: 'b', name: 'Beta', count: null },
  { id: 'c', name: 'Gamma' },
];

const COLUMNS = [
  { key: 'name', label: 'Thing', sort: (r) => r.name.toLowerCase(), cell: (r) => r.name },
  {
    key: 'count',
    label: 'Count',
    align: 'right',
    sort: (r) => r.count ?? null,
    cell: (r) => <CountCell value={r.count} loading={r.count === undefined} />,
  },
];

const mount = (props = {}) =>
  renderComponent(
    <MemoryRouter>
      <LinkedListPage
        title="Things"
        href={(r) => `/things/${r.id}`}
        rows={ROWS}
        columns={COLUMNS}
        loading={false}
        error=""
        empty={{ title: 'Nothing here', hint: 'Make one.' }}
        tableId="things"
        noun="thing"
        defaultSort={{ key: 'name', dir: 'asc' }}
        {...props}
      />
    </MemoryRouter>,
  );

describe('LinkedListPage', () => {
  it('puts a real link in every cell, pointing at the same row', async () => {
    const { container, unmount } = await mount();
    const first = all(container, 'tbody tr')[0];
    const hrefs = all(first, 'a').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/things/a', '/things/a']);
    // The cell keeps no padding of its own, so the link fills it.
    expect(all(first, 'td').every((td) => td.className.includes('p-0'))).toBe(true);
    await unmount();
  });

  it('tells a count, an uncountable row and a row still counting apart', async () => {
    const { container, unmount } = await mount();
    // Gamma has no count yet, so its cell is the spinner and reads as nothing.
    expect(texts(container, 'tbody tr td:nth-child(2)')).toEqual(['3', '—', '']);
    const cells = all(container, 'tbody tr td:nth-child(2)');
    expect(cells[2].querySelector('.animate-spin')).not.toBe(null);
    expect(cells[1].querySelector('.animate-spin')).toBe(null);
    await unmount();
  });

  it('shows the empty card instead of a table, and the header either way', async () => {
    const { container, unmount } = await mount({ rows: [] });
    expect(container.textContent).toContain('Things');
    expect(container.textContent).toContain('Nothing here');
    expect(container.querySelector('table')).toBe(null);
    await unmount();
  });

  it('keeps the header visible while it is still loading', async () => {
    const { container, unmount } = await mount({ loading: true });
    expect(container.textContent).toContain('Things');
    expect(container.querySelector('table')).toBe(null);
    expect(container.textContent).not.toContain('Nothing here');
    await unmount();
  });

  it('renders an error above the rows without hiding them', async () => {
    const { container, unmount } = await mount({ error: 'Failed to load things' });
    expect(container.querySelector('[role="alert"]').textContent).toBe('Failed to load things');
    expect(all(container, 'tbody tr')).toHaveLength(3);
    await unmount();
  });

  it('reads a missing timestamp as a dash', async () => {
    const { container, unmount } = await renderComponent(
      <MemoryRouter>
        <TimeCell at={null} />
      </MemoryRouter>,
    );
    expect(container.textContent).toBe('—');
    await unmount();
  });
});
