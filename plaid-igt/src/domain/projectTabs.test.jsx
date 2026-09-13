import { describe, it, expect } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

import { useTabParam } from '@/hooks/useTabParam';
import { contentTabsFor, TAB_ALIASES } from './projectTabs.js';

// The project page used to hand `useTabParam` every tab and correct the answer
// at render time, so a reader arriving at `?tab=bulk` saw Documents while the
// address went on saying bulk. The narrowing is the fix, and it has to happen
// before the hook sees the list.

const Probe = ({ canManage, onReady }) => {
  const [active] = useTabParam(contentTabsFor(canManage), 'documents', {
    aliases: TAB_ALIASES,
  });
  const { search } = useLocation();
  onReady({ active, search });
  return null;
};

const mount = async (initial, canManage) => {
  let last = null;
  const { unmount } = await renderComponent(
    <MemoryRouter initialEntries={[initial]}>
      <Probe canManage={canManage} onReady={(v) => (last = v)} />
    </MemoryRouter>,
  );
  return { unmount, read: () => last };
};

describe('contentTabsFor', () => {
  it('gives a maintainer every tab and a reader the open ones', () => {
    expect(contentTabsFor(true)).toContain('bulk');
    expect(contentTabsFor(false)).toEqual(['documents', 'search', 'assistant']);
  });
});

describe('the project page tabs for a non-maintainer', () => {
  it('drops ?tab=bulk from the address instead of showing Documents under it', async () => {
    const { read, unmount } = await mount('/projects/p1?tab=bulk', false);
    expect(read().active).toBe('documents');
    expect(read().search).toBe('');
    await unmount();
  });

  it('drops the label spelling too', async () => {
    const { read, unmount } = await mount('/projects/p1?tab=bulk-edit', false);
    expect(read().active).toBe('documents');
    expect(read().search).toBe('');
    await unmount();
  });

  it('leaves a maintainer on the tab they asked for', async () => {
    const { read, unmount } = await mount('/projects/p1?tab=bulk', true);
    expect(read().active).toBe('bulk');
    expect(read().search).toBe('?tab=bulk');
    await unmount();
  });
});
