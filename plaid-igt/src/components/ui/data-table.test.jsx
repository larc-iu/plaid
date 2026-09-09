import { describe, it, expect } from 'vitest';
import { renderComponent, all } from '@/test/renderComponent';
import { DataTable } from './data-table';

// DataTable is the one browsable table every admin screen uses, so its sort,
// search and paging are load-bearing in a way a single screen's are not.

const ROWS = [
  { id: 'c', name: 'Carol', changes: 5 },
  { id: 'a', name: 'alice', changes: 30 },
  { id: 'b', name: 'Bob', changes: null },
];

const COLUMNS = [
  { key: 'name', label: 'Name', sort: (r) => r.name.toLowerCase(), render: (r) => r.name },
  { key: 'changes', label: 'Changes', sort: (r) => r.changes, render: (r) => r.changes },
  { key: 'note', label: 'Note', render: () => '-' },
];

const table = (props = {}) =>
  renderComponent(
    <DataTable rows={ROWS} columns={COLUMNS} rowKey={(r) => r.id} noun="person" {...props} />,
  );

const names = (container) =>
  all(container, 'tbody tr').map((tr) => tr.querySelector('td').textContent);

const header = (container, label) =>
  all(container, 'thead button').find((b) => b.textContent.startsWith(label));

describe('DataTable', () => {
  it('sorts by the first sortable column, case-insensitively', async () => {
    const { container, unmount } = await table();
    expect(names(container)).toEqual(['alice', 'Bob', 'Carol']);
    await unmount();
  });

  it('flips direction when the active heading is clicked again', async () => {
    const { container, step, unmount } = await table();
    await step(() => header(container, 'Name').click());
    expect(names(container)).toEqual(['Carol', 'Bob', 'alice']);
    await unmount();
  });

  it('sorts a numeric column numerically, not as text', async () => {
    const { container, step, unmount } = await table();
    await step(() => header(container, 'Changes').click());
    expect(names(container).slice(0, 2)).toEqual(['Carol', 'alice']);
    await unmount();
  });

  it('puts unknown values last whichever way the column points', async () => {
    const { container, step, unmount } = await table();
    await step(() => header(container, 'Changes').click());
    expect(names(container).at(-1)).toBe('Bob');
    await step(() => header(container, 'Changes').click());
    expect(names(container).at(-1)).toBe('Bob');
    await unmount();
  });

  it('gives a column with no sort accessor a plain heading', async () => {
    const { container, unmount } = await table();
    expect(header(container, 'Note')).toBeUndefined();
    expect(all(container, 'thead th').at(-1).textContent).toBe('Note');
    await unmount();
  });

  it('filters on the caller’s match and counts what is hidden', async () => {
    const { container, step, unmount } = await table({
      search: { placeholder: 'Search…', match: (r, q) => r.name.toLowerCase().includes(q) },
    });
    const box = container.querySelector('input');
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set;
    await step(() => {
      setValue.call(box, 'bo');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(names(container)).toEqual(['Bob']);
    expect(container.textContent).toContain('1 of 3 people');
    await unmount();
  });

  it('opens and closes a row when it can expand', async () => {
    const { container, step, unmount } = await table({
      expand: (r) => `details for ${r.name}`,
    });
    const chevrons = () => all(container, 'tbody button[aria-label="Expand"]');
    expect(container.textContent).not.toContain('details for');
    await step(() => chevrons()[0].click());
    expect(container.textContent).toContain('details for alice');
    // Only the one row opened.
    expect(all(container, 'tbody button[aria-label="Collapse"]').length).toBe(1);
    await step(() => all(container, 'tbody button[aria-label="Collapse"]')[0].click());
    expect(container.textContent).not.toContain('details for');
    await unmount();
  });

  it('spans the expanded cell across every column, chevron included', async () => {
    const { container, step, unmount } = await table({ expand: () => 'x' });
    await step(() => all(container, 'tbody button[aria-label="Expand"]')[0].click());
    const detail = all(container, 'tbody td[colspan]')[0];
    expect(detail.getAttribute('colspan')).toBe(String(COLUMNS.length + 1));
    await unmount();
  });

  it('says when a search matched nothing, distinctly from an empty list', async () => {
    const { container, unmount } = await table({ rows: [], empty: 'No accounts yet.' });
    expect(container.textContent).toContain('No accounts yet.');
    await unmount();
  });
});
