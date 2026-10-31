import { describe, it, expect, vi, afterEach } from 'vitest';

import { renderComponent } from '../../test/renderComponent.jsx';
import { useAssistantAvailable } from './useAssistantAvailable.js';

// The panel holds the last project it was about while the reader is on a page
// with none, so a project deleted from its Settings stayed the one this hook
// asked about.

const failing = (status) => ({
  messages: {
    discoverServices: vi.fn(async () => {
      const e = new Error('nope');
      e.status = status;
      throw e;
    }),
  },
});

const mount = async (client, projectId) => {
  const seen = { current: undefined };
  const Probe = () => {
    seen.current = useAssistantAvailable(client, projectId, 'igt');
    return null;
  };
  const r = await renderComponent(<Probe />);
  return { ...r, value: () => seen.current };
};

afterEach(() => vi.useRealTimers());

describe('useAssistantAvailable', () => {
  it.each([404, 403])(
    'asks once about a project that answers %i, and offers nothing',
    async (status) => {
      vi.useFakeTimers();
      const client = failing(status);
      const r = await mount(client, `gone-${status}`);
      await r.step(async () => {
        await vi.advanceTimersByTimeAsync(60000);
      });
      expect(client.messages.discoverServices).toHaveBeenCalledTimes(1);
      expect(r.value()).toBe(false);
      await r.unmount();
    },
  );

  it('asks again after a failure that is not an answer about the project', async () => {
    vi.useFakeTimers();
    const client = failing(undefined);
    const r = await mount(client, 'blip');
    await r.step(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(client.messages.discoverServices).toHaveBeenCalledTimes(6);
    await r.unmount();
  });
});
