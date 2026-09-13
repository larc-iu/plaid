import { describe, it, expect } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { useTabParam, tabTo } from './useTabParam.js';

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
  onReady,
}) => {
  const [active, setActive] = useTabParam(tabs, fallback, 'tab', writeFallback, aliases);
  const { search } = useLocation();
  onReady({ active, setActive, search });
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

describe('tabTo', () => {
  it('makes the fallback the bare page, unless the group writes it', () => {
    expect(tabTo('/p', 'documents', 'documents')).toBe('/p');
    expect(tabTo('/p', 'search', 'documents')).toBe('/p?tab=search');
    expect(tabTo('/d', 'metadata', 'metadata', 'tab', true)).toBe('/d?tab=metadata');
  });
});
