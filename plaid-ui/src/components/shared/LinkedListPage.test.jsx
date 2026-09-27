import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '../../test/renderComponent.jsx';
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
  it('takes the width and padding the app shell gives it, adding none of its own', async () => {
    const { container, unmount } = await mount();
    const page = container.firstElementChild;
    expect(page.className).not.toMatch(/\b(mx-auto|max-w-\S+|px-\d+|py-\d+)\b/);
    await unmount();
  });

  it('puts a real link in every cell, pointing at the same row', async () => {
    const { container, unmount } = await mount();
    const first = all(container, 'tbody tr')[0];
    const hrefs = all(first, 'a').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/things/a', '/things/a']);
    // The cell keeps no padding of its own, so the link fills it.
    expect(all(first, 'td').every((td) => td.className.includes('p-0'))).toBe(true);
    await unmount();
  });

  it('gives the fill column the width left over, but never less than a readable name', async () => {
    const { container, unmount } = await mount({
      columns: [{ ...COLUMNS[0], fill: true }, COLUMNS[1]],
    });
    const [name, count] = all(container, 'tbody tr')[0].querySelectorAll('td');
    // happy-dom lays nothing out, so the classes are the contract: `max-w-0`
    // lets a long name truncate, and without a floor it also let a narrow
    // window squeeze the name to "Fi…" while the counts kept their width.
    expect(name.className.split(' ')).toEqual(expect.arrayContaining(['w-full', 'max-w-0']));
    expect(name.className.split(' ')).toContain('min-w-40');
    expect(count.className).not.toContain('max-w-0');
    await unmount();
  });

  it('tells a count, an uncountable row and a row still counting apart', async () => {
    const { container, unmount } = await mount();
    // Gamma has no count yet, so its cell is the muted ellipsis a cell shows
    // while it loads, not a spinning ring and not a number.
    const cells = all(container, 'tbody tr td:nth-child(2)');
    expect(cells[0].textContent).toBe('3');
    expect(cells[1].textContent).toBe('—');
    expect(cells[2].querySelector('[data-loading]')).not.toBe(null);
    expect(cells[2].querySelector('[aria-hidden="true"]').textContent).toBe('…');
    expect(cells[2].querySelector('.animate-spin')).toBe(null);
    expect(cells[1].querySelector('[data-loading]')).toBe(null);
    await unmount();
  });

  it('says Loading… while it loads, with no spinner, and wears the error tone for a failure', async () => {
    const loading = await mount({ loading: true });
    expect(loading.container.textContent).toContain('Loading…');
    expect(loading.container.querySelector('.animate-spin')).toBe(null);
    await loading.unmount();
    const failed = await mount({ error: 'Failed to reach the server' });
    const alert = failed.container.querySelector('[role="alert"]');
    expect(alert.getAttribute('data-tone')).toBe('error');
    expect(alert.textContent).toBe('Failed to reach the server');
    await failed.unmount();
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
