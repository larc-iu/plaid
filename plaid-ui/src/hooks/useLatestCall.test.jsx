import { describe, it, expect } from 'vitest';
import { renderComponent } from '../test/renderComponent.jsx';
import { useLatestCall } from './useLatestCall.js';

// The shape this exists for: two loads out at once, and the one started FIRST
// answering LAST. Nothing orders them, so a test that only checks the end state
// of a single load can never see it.

const mount = async () => {
  const seen = { current: null };
  const Probe = ({ n = 0 }) => {
    seen.current = useLatestCall();
    return <span>{n}</span>;
  };
  const r = await renderComponent(<Probe />);
  return { ...r, Probe, begin: () => seen.current };
};

describe('the newest call', () => {
  it('is current, and the one before it is not', async () => {
    const r = await mount();
    const first = r.begin()();
    expect(first()).toBe(true);
    const second = r.begin()();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    await r.unmount();
  });

  it('stays current however late an older one answers', async () => {
    const r = await mount();
    const a = r.begin()();
    const b = r.begin()();
    // A answers after B. It is still the older call.
    expect(a()).toBe(false);
    expect(b()).toBe(true);
    await r.unmount();
  });

  it('is a fresh answer every time it is asked, not a snapshot', async () => {
    const r = await mount();
    const a = r.begin()();
    expect(a()).toBe(true);
    r.begin()();
    expect(a()).toBe(false);
    await r.unmount();
  });

  it('survives a render: the same call stays current', async () => {
    const r = await mount();
    const a = r.begin()();
    await r.rerender(<r.Probe n={1} />);
    expect(a()).toBe(true);
    await r.unmount();
  });
});

describe('a call still out when the screen goes', () => {
  it('is not current, so nothing sets state on an unmounted component', async () => {
    const r = await mount();
    const a = r.begin()();
    expect(a()).toBe(true);
    await r.unmount();
    expect(a()).toBe(false);
  });
});
