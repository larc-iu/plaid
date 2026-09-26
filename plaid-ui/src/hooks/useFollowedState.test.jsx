import { describe, it, expect } from 'vitest';
import { renderComponent } from '../test/renderComponent.jsx';
import { useFollowedState } from './useFollowedState.js';
import { pendingId, recordSettled } from '../domain/pendingIds.js';

const mount = async (initial) => {
  const seen = { current: null, renders: 0 };
  const Probe = ({ n = 0 }) => {
    seen.renders++;
    seen.current = useFollowedState(initial);
    return <span>{n}</span>;
  };
  const r = await renderComponent(<Probe />);
  return { ...r, Probe, seen };
};

describe('state holding a pending id', () => {
  it('follows the id to the server one once it has answered', async () => {
    const id = pendingId();
    const r = await mount(id);
    expect(r.seen.current[0]).toBe(id);
    recordSettled(new Map([[id, 'server-1']]));
    await r.rerender(<r.Probe n={1} />);
    expect(r.seen.current[0]).toBe('server-1');
    await r.unmount();
  });

  it('follows an id deep in an object, and keeps the rest of it', async () => {
    const id = pendingId();
    const r = await mount(null);
    await r.step(() => r.seen.current[1]({ kind: 'edge', sourceId: id, x: 3 }));
    recordSettled(new Map([[id, 'server-2']]));
    await r.rerender(<r.Probe n={1} />);
    expect(r.seen.current[0]).toEqual({ kind: 'edge', sourceId: 'server-2', x: 3 });
    await r.unmount();
  });

  it('keeps the same value, and renders once, when nothing has settled', async () => {
    const value = { id: 'a', tokens: ['b'] };
    const r = await mount(value);
    const before = r.seen.renders;
    await r.rerender(<r.Probe n={1} />);
    expect(r.seen.current[0]).toBe(value);
    expect(r.seen.renders).toBe(before + 1);
    await r.unmount();
  });
});
