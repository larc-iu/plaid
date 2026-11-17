import { describe, it, expect, vi } from 'vitest';
import { useEffect } from 'react';
import { renderComponent } from '../test/renderComponent.jsx';
import { useUserSearch } from './useUserSearch.js';

const Probe = ({ client, excludeIds }) => {
  const search = useUserSearch({ client, excludeIds });
  const { activate } = search;
  useEffect(() => activate(), [activate]);
  return (
    <ul>
      {search.results.map((u) => (
        <li key={u.id}>{u.id}</li>
      ))}
    </ul>
  );
};

describe('useUserSearch', () => {
  // H12-2: a deactivated account was offered to Add a user, and the role it
  // was given came back when it was reactivated.
  it('offers neither the people already listed nor a deactivated account', async () => {
    const client = {
      users: {
        listPage: vi.fn().mockResolvedValue({
          entries: [
            { id: 'ada@x.org', deactivatedAt: null },
            { id: 'bo@x.org', deactivatedAt: null },
            { id: 'zed@x.org', deactivatedAt: '2026-11-17T10:00:00Z' },
          ],
        }),
      },
    };
    const { container, step, unmount } = await renderComponent(
      <Probe client={client} excludeIds={['bo@x.org']} />,
    );
    await step(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect([...container.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'ada@x.org',
    ]);
    await unmount();
  });
});
