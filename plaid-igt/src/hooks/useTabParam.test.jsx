import { describe, it, expect } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { useTabParam } from './useTabParam.js';

// Two things a URL has to do here: say what is on screen, and be reproducible.
//
// `?tab=validation` rendered the Documents tab and left the wrong word in the
// address bar (the real slug is `validate`), so the half a colleague gets sent
// is the half that is wrong. And in the document editor the Metadata tab wrote
// nothing at all, since it is the fallback, while a bare document URL means
// "no tab chosen" and lands on Analyze: the one tab whose address did not
// reproduce it.

const TABS = ['documents', 'search', 'validate'];

const Probe = ({
  tabs = TABS,
  fallback = 'documents',
  writeFallback = false,
  aliases,
  ready = true,
  onReady,
}) => {
  const [active, setActive, tabHref] = useTabParam(tabs, fallback, {
    writeFallback,
    aliases,
    ready,
  });
  const { search } = useLocation();
  onReady({ active, setActive, search, tabHref });
  return <span data-active={active} />;
};

const mount = async (initial, props = {}) => {
  let last = null;
  const { container, unmount } = await renderComponent(
    <MemoryRouter initialEntries={[initial]}>
      <Probe {...props} onReady={(v) => (last = v)} />
    </MemoryRouter>,
  );
  return { container, unmount, read: () => last };
};

describe('useTabParam', () => {
  it('takes a legal value from the URL', async () => {
    const { read, unmount } = await mount('/p?tab=search');
    expect(read().active).toBe('search');
    expect(read().search).toBe('?tab=search');
    await unmount();
  });

  it('drops a value that names no tab, rather than leaving it in the address', async () => {
    const { read, unmount } = await mount('/p?tab=validation');
    expect(read().active).toBe('documents');
    expect(read().search).toBe('');
    await unmount();
  });

  it('resolves a spelling read off the tab bar, and rewrites it to the slug', async () => {
    // The tab is labelled Validation and lives at `?tab=validate`, so typing
    // the label is the ordinary way to arrive, and it landed on Documents.
    const { read, unmount } = await mount('/p?tab=validation', {
      aliases: { validation: 'validate' },
    });
    expect(read().active).toBe('validate');
    expect(read().search).toBe('?tab=validate');
    await unmount();
  });

  it('keeps the other params while correcting', async () => {
    const { read, unmount } = await mount('/p?item=abc&tab=nope');
    expect(read().search).toBe('?item=abc');
    await unmount();
  });

  it('writes the fallback too when the bare page is not the fallback tab', async () => {
    const { read, unmount } = await mount('/d?tab=nope', {
      tabs: ['metadata', 'analyze'],
      fallback: 'metadata',
      writeFallback: true,
    });
    expect(read().active).toBe('metadata');
    expect(read().search).toBe('?tab=metadata');
    await unmount();
  });

  it('leaves a bare page bare, which is what says no tab was chosen', async () => {
    const { read, unmount } = await mount('/d', {
      tabs: ['metadata', 'analyze'],
      fallback: 'metadata',
      writeFallback: true,
    });
    expect(read().active).toBe('metadata');
    expect(read().search).toBe('');
    await unmount();
  });
});

describe('tabHref', () => {
  it('keeps the rest of the query string, so a middle-click opens what is on screen', async () => {
    // A project search lives in `?q=&match=`, and the tab links dropped it:
    // opening Documents in a new browser tab threw the search away, while
    // clicking the same trigger kept it.
    const { read, unmount } = await mount('/p?tab=search&q=perro&match=exact');
    expect(read().tabHref('/p', 'validate')).toBe('/p?tab=validate&q=perro&match=exact');
    // The fallback still writes the bare page, plus whatever else is there.
    expect(read().tabHref('/p', 'documents')).toBe('/p?q=perro&match=exact');
    await unmount();
  });

  it('writes the fallback too where the group does', async () => {
    const { read, unmount } = await mount('/d?focusSentence=s7', {
      tabs: ['metadata', 'analyze'],
      fallback: 'metadata',
      writeFallback: true,
    });
    expect(read().tabHref('/d', 'metadata')).toBe('/d?focusSentence=s7&tab=metadata');
    await unmount();
  });
});

describe('an alias whose tab the reader does not have', () => {
  it('is dropped rather than resolved to a tab with no trigger', async () => {
    // `?tab=bulk-edit` for a reader: Bulk Edit is maintainers-only, so the
    // narrowed list does not carry `bulk` and the alias names nothing here.
    const { read, unmount } = await mount('/p?tab=bulk-edit', {
      tabs: ['documents', 'search'],
      aliases: { 'bulk-edit': 'bulk' },
    });
    expect(read().active).toBe('documents');
    expect(read().search).toBe('');
    await unmount();
  });
});

describe('useTabParam while the tab list can still grow', () => {
  it('leaves a value alone until the caller says the list is settled', async () => {
    // The vocabulary screen's tabs depend on the viewer's rights, so before the
    // load `settings` is not among them. Correcting against the short list threw
    // a bookmarked `?tab=settings` away before it was ever legal.
    const { read, unmount } = await mount('/v?tab=settings', {
      tabs: ['items', 'comments'],
      fallback: 'items',
      ready: false,
    });
    expect(read().search).toBe('?tab=settings');
    expect(read().active).toBe('items');
    await unmount();
  });

  it('takes the value once the list has grown to include it', async () => {
    const { read, unmount } = await mount('/v?tab=settings', {
      tabs: ['items', 'comments', 'settings'],
      fallback: 'items',
    });
    expect(read().active).toBe('settings');
    expect(read().search).toBe('?tab=settings');
    await unmount();
  });
});
