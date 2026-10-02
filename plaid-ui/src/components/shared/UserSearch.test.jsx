import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';

import { useUserSearch, USER_SEARCH_LIMIT } from '../../hooks/useUserSearch.js';
import { UserSearch } from './UserSearch.jsx';

// Two halves of the capped-hint rule, both of which this screen got wrong.
//
// Capped-ness is the response's `nextCursor`, not `entries.length === limit`:
// the people already on the list are dropped AFTER the fetch, so a capped page
// can come back short. And the hint renders outside the empty branch, because
// a capped page whose every row was filtered out is the case that needs it.

const user = (id) => ({ id, displayName: id, isAdmin: false });

const clientReturning = (entries, nextCursor) => ({
  users: {
    listPage: vi.fn(async () => ({ entries, nextCursor })),
    avatarUrl: () => null,
  },
});

const Harness = ({ client, excludeIds }) => {
  const search = useUserSearch({ client, excludeIds });
  return <UserSearch client={client} search={search} renderAction={() => null} />;
};

const mount = async (client, excludeIds = []) => {
  const r = await renderComponent(<Harness client={client} excludeIds={excludeIds} />);
  // The search only runs once the box is touched, and it is debounced.
  await r.step(async () => {
    r.container.querySelector('input').dispatchEvent(new Event('focusin', { bubbles: true }));
  });
  await r.step(async () => {
    await new Promise((done) => setTimeout(done, 300));
  });
  return r;
};

const hint = (container) =>
  [...container.querySelectorAll('p, div')].map((n) => n.textContent).join(' ');

describe('the capped hint', () => {
  it('shows when every row was filtered out as someone already on the list', async () => {
    const ids = Array.from({ length: USER_SEARCH_LIMIT }, (_, i) => `u${i}`);
    const client = clientReturning(ids.map(user), 'more');
    const { container, unmount } = await mount(client, ids);
    expect(hint(container)).toContain('No other users to add.');
    expect(hint(container)).toContain(`Showing the first ${USER_SEARCH_LIMIT} matches`);
    await unmount();
  });

  it('shows on a short page the server says has more behind it', async () => {
    // Five rows back and a cursor: counting the entries against the limit said
    // "not capped" and the hint never appeared.
    const client = clientReturning([user('a'), user('b'), user('c')], 'more');
    const { container, unmount } = await mount(client);
    expect(hint(container)).toContain(`Showing the first ${USER_SEARCH_LIMIT} matches`);
    await unmount();
  });

  it('stays away when the server sent everything it had', async () => {
    const ids = Array.from({ length: USER_SEARCH_LIMIT }, (_, i) => `u${i}`);
    const client = clientReturning(ids.map(user), null);
    const { container, unmount } = await mount(client);
    expect(hint(container)).not.toContain('Showing the first');
    await unmount();
  });
});

// Q1-IGT-POLISH-6: after Add, the row with the Add button left the results
// and focus fell to the page, with the search still holding what was typed.
describe('after someone is added', () => {
  it('empties the search and puts focus in it', async () => {
    let search;
    const Grab = ({ client }) => {
      search = useUserSearch({ client, excludeIds: [] });
      return <UserSearch client={client} search={search} renderAction={() => null} />;
    };
    const client = clientReturning([user('b@x')]);
    const r = await renderComponent(<Grab client={client} />);
    const input = r.container.querySelector('input');
    await r.step(() => search.setQuery('b@x'));
    expect(input.value).toBe('b@x');
    await r.step(() => search.added());
    expect(r.container.querySelector('input').value).toBe('');
    expect(document.activeElement).toBe(r.container.querySelector('input'));
    await r.unmount();
  });
});
