import { describe, it, expect, beforeEach } from 'vitest';
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
    <DataTable
      rows={ROWS}
      columns={COLUMNS}
      rowKey={(r) => r.id}
      id="test-people"
      noun="person"
      {...props}
    />,
  );

const names = (container) =>
  all(container, 'tbody tr').map((tr) => tr.querySelector('td').textContent);

const header = (container, label) =>
  all(container, 'thead button').find((b) => b.textContent.startsWith(label));

describe('DataTable', () => {
  // The sort is remembered per `id`, so it survives an unmount. Each test gets
  // a clean slate or it would inherit whatever the previous one clicked.
  beforeEach(() => localStorage.clear());

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
    // 5 before 30. As text it would be the other way round.
    const { container, step, unmount } = await table();
    await step(() => header(container, 'Changes').click());
    expect(names(container)).toEqual(['Bob', 'Carol', 'alice']);
    await unmount();
  });

  it('treats a missing value as the smallest, so it flips with the column', async () => {
    // Bob has no `changes`. Ascending it sorts first, descending it sorts
    // last, exactly as a zero would: "never" is the oldest, not a special case
    // pinned to one end.
    const { container, step, unmount } = await table();
    await step(() => header(container, 'Changes').click());
    expect(names(container)[0]).toBe('Bob');
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

  it('lets a caller quote the query in its no-match line', async () => {
    const { container, step, unmount } = await table({
      search: { match: (r, q) => r.name.toLowerCase().includes(q) },
      noMatch: (q) => `No people match “${q}”.`,
    });
    const box = container.querySelector('input');
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set;
    await step(() => {
      setValue.call(box, 'zzz');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).toContain('No people match “zzz”.');
    await unmount();
  });

  it('remembers the chosen sort under its id, without the caller asking', async () => {
    const first = await table();
    await first.step(() => header(first.container, 'Changes').click());
    await first.unmount();

    // A second mount of the same list opens the way it was left.
    const second = await table();
    expect(names(second.container)).toEqual(['Bob', 'Carol', 'alice']);
    await second.unmount();
  });

  it('keeps one list’s order out of another’s, via scope', async () => {
    const a = await table({ scope: 'project-a' });
    await a.step(() => header(a.container, 'Changes').click());
    await a.unmount();

    const b = await table({ scope: 'project-b' });
    expect(names(b.container)).toEqual(['alice', 'Bob', 'Carol']);
    await b.unmount();
  });

  it('drops the count, and the whole bar with it, when the caller says its own', async () => {
    const { container, unmount } = await table({ showCount: false });
    expect(container.textContent).not.toContain('people');
    expect(container.querySelector('thead')).not.toBeNull();
    await unmount();
  });

  it('says when a search matched nothing, distinctly from an empty list', async () => {
    const { container, unmount } = await table({ rows: [], empty: 'No accounts yet.' });
    expect(container.textContent).toContain('No accounts yet.');
    await unmount();
  });
});
