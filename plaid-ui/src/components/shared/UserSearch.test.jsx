import { describe, it, expect } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { UserSearch } from './UserSearch.jsx';

// H21-ACCESS: "No matching users." was said for the text in the box while the
// answer on screen was still for what the box read before the last keystrokes.
const search = (over) => ({
  query: '',
  setQuery: () => {},
  debounced: '',
  active: true,
  activate: () => {},
  results: [],
  loading: false,
  denied: false,
  capped: false,
  inputRef: { current: null },
  ...over,
});

describe('UserSearch', () => {
  it('says nothing matches only once the box as it reads was searched', async () => {
    const typing = await renderComponent(
      <UserSearch
        client={null}
        search={search({ query: 'reader', debounced: 'xr' })}
        renderAction={() => null}
      />,
    );
    expect(typing.container.textContent).not.toContain('No matching users.');
    await typing.unmount();
    const searched = await renderComponent(
      <UserSearch
        client={null}
        search={search({ query: 'reader', debounced: 'reader' })}
        renderAction={() => null}
      />,
    );
    expect(searched.container.textContent).toContain('No matching users.');
    await searched.unmount();
  });
});
