import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all, texts } from '@ui/test/renderComponent.jsx';
import { TALL_LIST_PAGE_SIZE } from '@ui/hooks/usePagedList';
import { MatchGroups, Progress } from './parts.jsx';

// A sweep over a corpus previews thousands of matches, and every row carries a
// change grid, a marked sentence and a link into Analyze. The list is paged, so
// what these hold onto is that paging never changes what a tick MEANS: a
// document's heading speaks for the whole document, not for the part of it on
// the page.

const row = (docId, docName, i) => ({
  id: `${docId}-r${i}`,
  docId,
  docName,
  sentenceId: `${docId}-s${i}`,
  sentenceIndex: i,
  text: `sentence ${i}`,
  marks: [],
  old: 'kat',
  new: 'cat',
});

const rowsIn = (docId, docName, n) => Array.from({ length: n }, (_, i) => row(docId, docName, i));

const mount = (rows, selected = new Set(), handlers = {}) =>
  renderComponent(
    <MemoryRouter initialEntries={['/projects/p1?tab=bulk']}>
      <MatchGroups
        projectId="p1"
        rows={rows}
        selected={selected}
        toggle={handlers.toggle ?? (() => {})}
        toggleMany={handlers.toggleMany ?? (() => {})}
        renderRow={(r) => <span data-row={r.id}>{r.new}</span>}
      />
    </MemoryRouter>,
  );

const rowCount = (container) => all(container, '[data-row]').length;
const headings = (container) => texts(container, '.bg-muted\\/50');

describe('MatchGroups', () => {
  it('draws one page of rows, not the whole preview', async () => {
    const { container, unmount } = await mount(rowsIn('d1', 'Doc one', 60));
    expect(rowCount(container)).toBe(TALL_LIST_PAGE_SIZE);
    await unmount();
  });

  it("a document's heading counts the whole document, not the page", async () => {
    const rows = rowsIn('d1', 'Doc one', 60);
    const { container, unmount } = await mount(rows, new Set(rows.map((r) => r.id)));
    expect(headings(container)[0]).toContain('60 of 60 matches selected');
    await unmount();
  });

  // Ticking the heading applies to every match in the document. Had it governed
  // only the rendered rows, which page you were standing on would decide what
  // got written.
  it("the heading's tick names every id in the document", async () => {
    const rows = rowsIn('d1', 'Doc one', 60);
    let asked = null;
    const { container, unmount } = await mount(rows, new Set(), {
      toggleMany: (ids, on) => {
        asked = { ids, on };
      },
    });
    const box = all(container, 'input[type="checkbox"]')[0];
    box.click();
    expect(asked.on).toBe(true);
    expect(asked.ids).toHaveLength(60);
    await unmount();
  });

  it('repeats the heading on the page a document continues onto', async () => {
    const { container, step, unmount } = await mount(rowsIn('d1', 'Doc one', 60));
    expect(all(container, '[data-row]')[0].dataset.row).toBe('d1-r0');
    const next = all(container, 'button[aria-label="Next page"]')[0];
    await step(() => next.click());
    // Page two, and still headed, so a reader who turns the page knows which
    // document they are in.
    expect(all(container, '[data-row]')[0].dataset.row).toBe(`d1-r${TALL_LIST_PAGE_SIZE}`);
    expect(headings(container)[0]).toContain('Doc one');
    expect(rowCount(container)).toBe(TALL_LIST_PAGE_SIZE);
    await unmount();
  });

  it('heads each document that begins on the page', async () => {
    const rows = [...rowsIn('d1', 'Doc one', 3), ...rowsIn('d2', 'Doc two', 3)];
    const { container, unmount } = await mount(rows);
    const heads = headings(container);
    expect(heads).toHaveLength(2);
    expect(heads[0]).toContain('Doc one');
    expect(heads[1]).toContain('Doc two');
    expect(rowCount(container)).toBe(6);
    await unmount();
  });
});

describe('Progress', () => {
  it('is the Loading line with the step named, and no spinning ring', async () => {
    const view = await renderComponent(<Progress text="Reading document 3 of 40…" />);
    expect(view.container.textContent).toBe('Reading document 3 of 40…');
    expect(view.container.querySelector('.animate-spin')).toBe(null);
    expect(view.container.querySelector('p').className).toContain('text-muted-foreground');
    await view.unmount();
  });

  it('draws nothing once there is nothing to report', async () => {
    const view = await renderComponent(<Progress text={null} />);
    expect(view.container.innerHTML).toBe('');
    await view.unmount();
  });
});

describe('the run line', () => {
  it('says what the run is doing beside a clock counting from its start', async () => {
    const view = await renderComponent(
      <Progress text="Applying to document 3 of 67…" startedAt={Date.now() - 65_000} />,
    );
    expect(document.body.textContent).toContain('Applying to document 3 of 67…');
    expect(document.body.textContent).toContain('1:05');
    await view.unmount();
  });
});
