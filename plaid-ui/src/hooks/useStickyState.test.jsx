import { describe, it, expect, beforeEach } from 'vitest';
import { StrictMode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MemoryRouter, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
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

// In a router because usePagedList can put the page in the query string, so it
// reads the URL whether or not a given list asks it to. `urlParam` is passed
// through so the URL half has its own coverage below.
const Paged = ({ storageKey, resetKey = 'a', count = 500, urlParam, at = '/' }) => (
  <MemoryRouter initialEntries={[at]}>
    <PagedInner {...{ storageKey, resetKey, count, urlParam }} />
  </MemoryRouter>
);

const PagedInner = ({ storageKey, resetKey, count, urlParam }) => {
  const items = Array.from({ length: count }, (_, i) => i);
  const paged = usePagedList(items, { resetKey, storageKey, urlParam });
  const { search } = useLocation();
  return <button onClick={() => paged.setPage(2)}>{`${paged.page}${search}`}</button>;
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

  // Only a value somebody set is remembered. A stored default would outlive a
  // change of default: the ud and umr document lists moved from name to last
  // updated, and every project a reader had merely opened kept sorting by name.
  it('stores nothing for a value nobody set', async () => {
    const { container, unmount } = await renderComponent(<Sticky storageKey="k" />);
    expect(text(container)).toBe('default');
    expect(localStorage.getItem('k')).toBeNull();
    await unmount();
  });

  it('stores nothing for the next key either, after a value was set under the first', async () => {
    const { container, step, rerender, unmount } = await renderComponent(<Sticky storageKey="a" />);
    await step(() => click(container));
    await rerender(<Sticky storageKey="b" />);
    expect(text(container)).toBe('default');
    expect(JSON.parse(localStorage.getItem('a'))).toBe('typed');
    expect(localStorage.getItem('b')).toBeNull();
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

  it('stores no order for a list nobody sorted', async () => {
    const first = await renderComponent(<Sorted storageKey="s" />);
    await first.unmount();
    expect(localStorage.getItem('s')).toBeNull();
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

  // The URL half. A bare project URL used to open EWT's documents on page 12
  // of 12 with nothing in the address saying so, and the link a colleague was
  // sent showed them a different page of the same list.
  it('writes the page to the URL, 1-based, and leaves page 1 off it', async () => {
    const { container, step, unmount } = await renderComponent(
      <Paged storageKey="p" urlParam="page" />,
    );
    expect(text(container)).toBe('0');
    await step(() => click(container));
    expect(text(container)).toBe('2?page=3');
    await unmount();
  });

  it('takes the page from the URL over the remembered one', async () => {
    localStorage.setItem('p', JSON.stringify(4));
    const { container, unmount } = await renderComponent(
      <Paged storageKey="p" urlParam="page" at="/?page=2" />,
    );
    expect(text(container)).toBe('1?page=2');
    await unmount();
  });

  // And says so: the bare URL is corrected in place.
  it('opens a bare URL on the remembered page, and writes it to the URL', async () => {
    localStorage.setItem('p', JSON.stringify(4));
    const { container, unmount } = await renderComponent(<Paged storageKey="p" urlParam="page" />);
    expect(text(container)).toBe('4?page=5');
    await unmount();
  });

  it('ignores a page the URL cannot mean', async () => {
    const { container, unmount } = await renderComponent(
      <Paged storageKey="p" urlParam="page" at="/?page=nope" />,
    );
    expect(text(container)).toBe('0?page=nope');
    await unmount();
  });

  // History, read off a probe with the router's own Back. The list is the
  // second entry, so a Back past its first entry lands on '/before'.
  describe('and history', () => {
    const Probe = ({ storageKey }) => {
      const items = Array.from({ length: 500 }, (_, i) => i);
      const [resetKey, setResetKey] = useState('a');
      const paged = usePagedList(items, { storageKey, resetKey, urlParam: 'page' });
      const { pathname, search } = useLocation();
      const navigate = useNavigate();
      return (
        <>
          <output>{`${paged.page} ${pathname}${search}`}</output>
          <button data-do="turn" onClick={() => paged.setPage(2)} />
          <button data-do="same" onClick={() => paged.setPage(paged.page)} />
          <button data-do="jump" onClick={() => paged.setPage(3, { replace: true })} />
          <button data-do="search" onClick={() => setResetKey('b')} />
          <button data-do="back" onClick={() => navigate(-1)} />
          <button data-do="forward" onClick={() => navigate(1)} />
        </>
      );
    };
    const mount = (props = {}, at = '/list') =>
      renderComponent(
        <MemoryRouter initialEntries={['/before', at]} initialIndex={1}>
          <Probe {...props} />
        </MemoryRouter>,
      );
    const shown = (c) => c.querySelector('output').textContent;
    const press = (r, what) => r.step(() => r.container.querySelector(`[data-do=${what}]`).click());

    it('shows page 1 on Back to the bare URL, not the page it remembers', async () => {
      const r = await mount({ storageKey: 'p' });
      await press(r, 'turn');
      expect(shown(r.container)).toBe('2 /list?page=3');
      await press(r, 'back');
      expect(shown(r.container)).toBe('0 /list');
      await press(r, 'forward');
      expect(shown(r.container)).toBe('2 /list?page=3');
      await r.unmount();
    });

    it('remembers where Back left the list', async () => {
      const r = await mount({ storageKey: 'p' });
      await press(r, 'turn');
      expect(JSON.parse(localStorage.getItem('p'))).toBe(2);
      await press(r, 'back');
      expect(JSON.parse(localStorage.getItem('p'))).toBe(0);
      await r.unmount();
    });

    it('restores the remembered page in place, so Back leaves the list', async () => {
      localStorage.setItem('p', JSON.stringify(4));
      const r = await mount({ storageKey: 'p' });
      expect(shown(r.container)).toBe('4 /list?page=5');
      await press(r, 'turn');
      await press(r, 'back');
      expect(shown(r.container)).toBe('4 /list?page=5');
      await press(r, 'back');
      expect(shown(r.container)).toBe('0 /before');
      await r.unmount();
    });

    it('pushes nothing for a turn to the page already shown', async () => {
      const r = await mount({ storageKey: 'p' }, '/list?page=3');
      await press(r, 'same');
      await press(r, 'back');
      expect(shown(r.container)).toBe('0 /before');
      await r.unmount();
    });

    it('replaces the entry for a turn the reader did not ask for', async () => {
      const r = await mount({ storageKey: 'p' });
      await press(r, 'jump');
      expect(shown(r.container)).toBe('3 /list?page=4');
      await press(r, 'back');
      expect(shown(r.container)).toBe('0 /before');
      await r.unmount();
    });

    // A deep link turns to its row's page in the same mount as the restore.
    // Under StrictMode the restore's effect ran twice and its second run
    // wrote the remembered page back over the link's.
    const Linked = ({ to }) => {
      const items = Array.from({ length: 500 }, (_, i) => i);
      const paged = usePagedList(items, { storageKey: 'p', urlParam: 'page' });
      const { setPage } = paged;
      const asked = useRef(false);
      useEffect(() => {
        if (asked.current) return;
        asked.current = true;
        setPage(to, { replace: true });
      }, [setPage, to]);
      const { search } = useLocation();
      return <output>{`${paged.page}${search}`}</output>;
    };
    for (const to of [3, 0]) {
      it(`lets a deep link to page ${to + 1} win over the remembered page`, async () => {
        localStorage.setItem('p', JSON.stringify(4));
        const r = await renderComponent(
          <StrictMode>
            <MemoryRouter initialEntries={['/list']}>
              <Linked to={to} />
            </MemoryRouter>
          </StrictMode>,
        );
        expect(shown(r.container)).toBe(to ? `${to}?page=${to + 1}` : '0');
        await r.unmount();
      });
    }

    // Another param written in the same moment as the restore, from the query
    // as it was (igt's project page drops an unknown `?tab=` as its Documents
    // list restores its page), lands last and takes `?page=` off. The list
    // then showed the remembered page under a bare URL until the next turn.
    const Clobbered = () => {
      const [params, setParams] = useSearchParams();
      useEffect(() => {
        if (params.get('tab') !== 'bogus') return;
        setParams(
          (prev) => {
            const out = new URLSearchParams(prev);
            out.delete('tab');
            return out;
          },
          { replace: true },
        );
      }, [params, setParams]);
      return <Probe storageKey="p" />;
    };
    it('shows what the URL says when a write of another param takes the page off', async () => {
      localStorage.setItem('p', JSON.stringify(4));
      const r = await renderComponent(
        <MemoryRouter initialEntries={['/before', '/list?tab=bogus']} initialIndex={1}>
          <Clobbered />
        </MemoryRouter>,
      );
      expect(shown(r.container)).toBe('0 /list');
      await press(r, 'turn');
      expect(shown(r.container)).toBe('2 /list?page=3');
      await press(r, 'back');
      expect(shown(r.container)).toBe('0 /list');
      await r.unmount();
    });

    // A turn made in the moment its previous turn reaches the URL (ud's review
    // sweep, Ctrl+Shift+Down to page 2 and straight back up). The router takes
    // a new location in a transition, so the list shows the page it is heading
    // to until then. The effect that drops a heading once its page has arrived
    // ran after the second turn had set its own, and dropped that one too: the
    // list stayed on page 2 until the router caught up, and the sweep, which
    // looks for its row on the next frame, found page 2 and gave up.
    const Chained = () => {
      const items = Array.from({ length: 500 }, (_, i) => i);
      const paged = usePagedList(items, { storageKey: 'p', urlParam: 'page' });
      const { search } = useLocation();
      const [armed, setArmed] = useState(false);
      const shownLog = useRef([]);
      const { setPage } = paged;
      useLayoutEffect(() => {
        shownLog.current.push(`${paged.page} ${search}`);
      });
      useLayoutEffect(() => {
        if (armed && search === '?page=3') {
          setArmed(false);
          setPage(0);
        }
      }, [armed, search, setPage]);
      return (
        <>
          <output>{shownLog.current.join(',')}</output>
          <button
            data-do="turn"
            onClick={() => {
              setArmed(true);
              paged.setPage(2);
            }}
          />
        </>
      );
    };
    it('turns straight back when the previous turn has just reached the URL', async () => {
      const r = await renderComponent(
        <MemoryRouter initialEntries={['/list']}>
          <Chained />
        </MemoryRouter>,
      );
      await press(r, 'turn');
      await r.step(() => {});
      const log = r.container.querySelector('output').textContent.split(',');
      const arrived = log.indexOf('2 ?page=3');
      expect(arrived).toBeGreaterThan(-1);
      // Page 1 from the moment it was asked for, never page 3 again.
      expect(log.slice(arrived + 1).filter((s) => !s.startsWith('0 '))).toEqual([]);
      await r.unmount();
    });

    // A push here would leave `?page=3` behind the new search, and Back would
    // show page 3 of the new results.
    it('replaces the entry when a new search turns back to page 1', async () => {
      const r = await mount({ storageKey: 'p' });
      await press(r, 'turn');
      await press(r, 'search');
      expect(shown(r.container)).toBe('0 /list');
      await press(r, 'back');
      expect(shown(r.container)).toBe('0 /list');
      await r.unmount();
    });
  });

  it('keeps the rest of the query when it turns a page', async () => {
    const { container, step, unmount } = await renderComponent(
      <Paged storageKey="p" urlParam="page" at="/?tab=documents" />,
    );
    await step(() => click(container));
    expect(text(container)).toContain('tab=documents');
    expect(text(container)).toContain('page=3');
    await unmount();
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
