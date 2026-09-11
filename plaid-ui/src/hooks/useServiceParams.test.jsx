import { describe, it, expect, beforeEach } from 'vitest';
import { renderComponent } from '../test/renderComponent.jsx';
import { useServiceParams } from './useServiceParams.js';

// The merge order is schema defaults, then the app's seed, then the project's
// defaults, then the user's cache. What is worth pinning is that none of them
// has to be there at the first render: discovery is one small GET and a
// project is not, so a spot commonly has its storage key before it has
// anything to seed with.

const SCHEMA = [
  { key: 'language', label: 'Language', type: 'string', default: 'en' },
  { key: 'overwrite', label: 'Overwrite', type: 'boolean', default: false },
];

async function mount(props) {
  const seen = { current: null };
  const Probe = (p) => {
    seen.current = useServiceParams(p);
    return null;
  };
  const r = await renderComponent(<Probe schema={SCHEMA} storageKey={null} {...props} />);
  const again = (next) => r.rerender(<Probe schema={SCHEMA} storageKey={null} {...next} />);
  return { ...r, params: () => seen.current, again };
}

describe('useServiceParams', () => {
  beforeEach(() => localStorage.clear());

  it('seeds from the schema when there is nothing else', async () => {
    const { params, unmount } = await mount({});
    expect(params().values.language).toBe('en');
    await unmount();
  });

  it('takes a seed that only arrives on a later render', async () => {
    // The spot's storage key is set from the SERVICE, which discovery returns
    // first. Keying the seed on that key alone meant the project's language
    // never reached the form.
    const { params, again, unmount } = await mount({ storageKey: 'k', seedParams: null });
    expect(params().values.language).toBe('en');

    await again({ storageKey: 'k', seedParams: { language: 'es' } });
    expect(params().values.language).toBe('es');
    await unmount();
  });

  it("takes the project's defaults late too, and they outrank the seed", async () => {
    const { params, again, unmount } = await mount({
      storageKey: 'k',
      seedParams: { language: 'es' },
    });
    expect(params().values.language).toBe('es');

    await again({
      storageKey: 'k',
      seedParams: { language: 'es' },
      defaultParams: { language: 'fr' },
    });
    expect(params().values.language).toBe('fr');
    await unmount();
  });

  it('does not re-seed when the same values arrive as a new object', async () => {
    const { params, step, again, unmount } = await mount({
      storageKey: 'k',
      seedParams: { language: 'es' },
    });
    await step(async () => params().setParam('language', 'pt'));
    expect(params().values.language).toBe('pt');

    // A caller that rebuilds this object every render must not stomp the edit.
    await again({ storageKey: 'k', seedParams: { language: 'es' } });
    expect(params().values.language).toBe('pt');
    await unmount();
  });
});
