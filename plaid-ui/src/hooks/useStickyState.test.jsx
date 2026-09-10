import { describe, it, expect, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { renderComponent } from '../test/renderComponent.jsx';
import { listPrefKey, useStickyState, useStickySort } from './useStickyState.js';
import { usePagedList, pageKey } from './usePagedList.js';
import { configureUi } from '../lib/uiConfig.js';

const COLUMNS = ['name', 'words', 'updated'];

// Probes: each renders its state as text so a test can read it off the DOM.
const Sticky = ({ storageKey, initial = 'default', accept }) => {
  const [value, setValue] = useStickyState(storageKey, initial, accept);
  return (
    <button onClick={() => setValue('typed')} data-testid="v">
      {String(value)}
    </button>
  );
};

const Sorted = ({ storageKey }) => {
  const [sort, onSort] = useStickySort(storageKey, { key: 'updated', dir: 'desc' }, COLUMNS);
  return <button onClick={() => onSort('name')}>{`${sort.key}/${sort.dir}`}</button>;
};

const Paged = ({ storageKey, resetKey = 'a', count = 500 }) => {
  const items = Array.from({ length: count }, (_, i) => i);
  const paged = usePagedList(items, { resetKey, storageKey });
  return <button onClick={() => paged.setPage(2)}>{String(paged.page)}</button>;
};

const text = (c) => c.querySelector('button').textContent;
const click = (c) => c.querySelector('button').click();

describe('useStickyState', () => {
  beforeEach(() => localStorage.clear());

  it('opens at the default when nothing is stored, and remembers a change', async () => {
    const { container, step, unmount } = await renderComponent(<Sticky storageKey="k" />);
    expect(text(container)).toBe('default');
    await step(() => click(container));
    expect(text(container)).toBe('typed');
    expect(JSON.parse(localStorage.getItem('k'))).toBe('typed');
    await unmount();
  });

  it('seeds from what was stored', async () => {
    localStorage.setItem('k', JSON.stringify('stored'));
    const { container, unmount } = await renderComponent(<Sticky storageKey="k" />);
    expect(text(container)).toBe('stored');
    await unmount();
  });

  it('falls back to the default when the stored value is not acceptable', async () => {
    localStorage.setItem('k', JSON.stringify('gone'));
    const { container, unmount } = await renderComponent(
      <Sticky storageKey="k" accept={(v) => v === 'ok'} />,
    );
    expect(text(container)).toBe('default');
    await unmount();
  });

  it('falls back to the default when the stored value is not JSON', async () => {
    localStorage.setItem('k', '{oops');
    const { container, unmount } = await renderComponent(<Sticky storageKey="k" />);
    expect(text(container)).toBe('default');
    await unmount();
  });

  it('re-seeds when the key changes without a remount', async () => {
    localStorage.setItem('a', JSON.stringify('from-a'));
    localStorage.setItem('b', JSON.stringify('from-b'));
    const { container, rerender, unmount } = await renderComponent(<Sticky storageKey="a" />);
    expect(text(container)).toBe('from-a');
    await rerender(<Sticky storageKey="b" />);
    expect(text(container)).toBe('from-b');
    await unmount();
  });

  it('keeps plain state when there is no key', async () => {
    const { container, step, unmount } = await renderComponent(<Sticky storageKey={null} />);
    await step(() => click(container));
    expect(text(container)).toBe('typed');
    expect(localStorage.length).toBe(0);
    await unmount();
  });
});

describe('useStickySort', () => {
  beforeEach(() => localStorage.clear());

  it('starts a new column ascending and flips the active one', async () => {
    const { container, step, unmount } = await renderComponent(<Sorted storageKey="s" />);
    expect(text(container)).toBe('updated/desc');
    await step(() => click(container));
    expect(text(container)).toBe('name/asc');
    await step(() => click(container));
    expect(text(container)).toBe('name/desc');
    await unmount();
  });

  it('remembers the order for the next visit', async () => {
    const first = await renderComponent(<Sorted storageKey="s" />);
    await first.step(() => click(first.container));
    await first.unmount();

    const second = await renderComponent(<Sorted storageKey="s" />);
    expect(text(second.container)).toBe('name/asc');
    await second.unmount();
  });

  it('ignores a stored sort on a column the list no longer has', async () => {
    localStorage.setItem('s', JSON.stringify({ key: 'removed', dir: 'asc' }));
    const { container, unmount } = await renderComponent(<Sorted storageKey="s" />);
    expect(text(container)).toBe('updated/desc');
    await unmount();
  });
});

describe('usePagedList', () => {
  beforeEach(() => localStorage.clear());

  it('remembers the page, and StrictMode remounting does not clear it', async () => {
    const first = await renderComponent(<Paged storageKey="p" />);
    await first.step(() => click(first.container));
    expect(text(first.container)).toBe('2');
    await first.unmount();

    // StrictMode mounts, unmounts and mounts again on the same refs, which is
    // exactly what a run-once reset guard would not survive.
    const second = await renderComponent(
      <StrictMode>
        <Paged storageKey="p" />
      </StrictMode>,
    );
    expect(text(second.container)).toBe('2');
    await second.unmount();
  });

  it('turns back to the first page when the result set is re-scoped', async () => {
    const { container, step, rerender, unmount } = await renderComponent(<Paged storageKey="p" />);
    await step(() => click(container));
    expect(text(container)).toBe('2');
    await rerender(<Paged storageKey="p" resetKey="b" />);
    expect(text(container)).toBe('0');
    await unmount();
  });

  it('clamps a remembered page that is past the end of a shorter list', async () => {
    localStorage.setItem('p', JSON.stringify(9));
    const { container, unmount } = await renderComponent(<Paged storageKey="p" count={150} />);
    expect(text(container)).toBe('1'); // 150 rows at 100/page = pages 0 and 1
    await unmount();
  });

  it('pages per mount when no key is given', async () => {
    const first = await renderComponent(<Paged storageKey={undefined} />);
    await first.step(() => click(first.container));
    await first.unmount();
    const second = await renderComponent(<Paged storageKey={undefined} />);
    expect(text(second.container)).toBe('0');
    await second.unmount();
  });
});

describe('listPrefKey', () => {
  it('scopes a key to its list and, where there is one, its id', () => {
    configureUi({ appPrefix: 'plaid_igt' });
    expect(listPrefKey('sort', 'projects')).toBe('plaid_igt_list_sort:projects');
    expect(listPrefKey('sort', 'documents', 'p1')).toBe('plaid_igt_list_sort:documents:p1');
    expect(pageKey('documents', 'p1')).toBe('plaid_igt_list_page:documents:p1');
    configureUi();
  });

  // An app that never called configureUi, or a bundler that handed this module
  // out twice, must not quietly write keys under a prefix nobody chose.
  it('refuses to build a key for an app that named no prefix', () => {
    expect(() => listPrefKey('sort', 'projects')).toThrow(/appPrefix/);
  });

  // The prefix is the app's, so two apps' document lists never read each
  // other's remembered order. `plaid_igt` is what plaid-igt passes, and these
  // are the keys its readers already have.
  it('takes the app it was configured with', () => {
    configureUi({ appPrefix: 'plaid_igt' });
    expect(listPrefKey('sort', 'documents', 'p1')).toBe('plaid_igt_list_sort:documents:p1');
    configureUi({ appPrefix: 'plaid_ud' });
    expect(listPrefKey('sort', 'documents', 'p1')).toBe('plaid_ud_list_sort:documents:p1');
    configureUi();
  });
});
