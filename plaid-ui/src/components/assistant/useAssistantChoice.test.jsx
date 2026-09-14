import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { useAssistantChoice } from './useAssistantChoice.js';
import { serviceCache } from './jobs.js';

// Which assistant answers. A conversation keeps the one it started with, so
// the picker is offered while a thread is new and again only where the one it
// is bound to has gone offline.

const svc = (id, over = {}) => ({
  serviceId: id,
  serviceName: `Assistant ${id}`,
  tasks: ['assist'],
  online: true,
  extras: { model: `model/${id}`, app: 'igt', tasks: ['assist'] },
  ...over,
});

const fakeClient = (found) => ({
  messages: { discoverServices: vi.fn().mockResolvedValue(found) },
});

const mount = async (client, meta = null) => {
  const box = {};
  const Probe = ({ conversationMeta }) => {
    box.choice = useAssistantChoice({
      client,
      projectId: 'p1',
      app: 'igt',
      meta: conversationMeta,
    });
    return (
      <span data-testid="c">
        {[
          box.choice.service?.serviceId ?? 'none',
          box.choice.canChoose ? 'choose' : 'fixed',
          box.choice.wentOffline ? 'offline' : 'online',
        ].join('/')}
      </span>
    );
  };
  const r = await renderComponent(<Probe conversationMeta={meta} />);
  return {
    ...r,
    box,
    Probe,
    read: () => r.container.querySelector('[data-testid="c"]').textContent,
  };
};

beforeEach(() => {
  serviceCache.clear();
  vi.clearAllMocks();
});

describe('useAssistantChoice', () => {
  it('keeps only this app’s online assistants', async () => {
    const client = fakeClient([
      svc('igt:one'),
      svc('ud:one', { extras: { model: 'm', app: 'ud', tasks: ['assist'] } }),
      svc('igt:off', { online: false }),
    ]);
    const { box, read, unmount } = await mount(client);
    expect(box.choice.assistants.map((s) => s.serviceId)).toEqual(['igt:one']);
    expect(read()).toBe('igt:one/fixed/online');
    await unmount();
  });

  it('offers a choice only where there is more than one and no thread is bound', async () => {
    const client = fakeClient([svc('igt:one'), svc('igt:two')]);
    const { read, unmount } = await mount(client);
    expect(read()).toBe('igt:one/choose/online');
    await unmount();
  });

  it('pins a thread to the assistant it started with', async () => {
    const client = fakeClient([svc('igt:one'), svc('igt:two')]);
    const { read, unmount } = await mount(client, { serviceId: 'igt:two' });
    expect(read()).toBe('igt:two/fixed/online');
    await unmount();
  });

  it('says so when the thread’s own assistant is gone, and names a replacement', async () => {
    const client = fakeClient([svc('igt:one'), svc('igt:two')]);
    const { read, unmount } = await mount(client, { serviceId: 'igt:gone' });
    expect(read()).toBe('igt:one/choose/offline');
    await unmount();
  });

  it('takes a pick until the thread is bound', async () => {
    const client = fakeClient([svc('igt:one'), svc('igt:two')]);
    const { box, read, step, unmount } = await mount(client);
    await step(() => box.choice.choose('igt:two'));
    expect(read()).toBe('igt:two/choose/online');
    await unmount();
  });

  it('names the assistants running from before extras.app apart', async () => {
    const client = fakeClient([svc('old', { extras: { model: 'm', tasks: ['assist'] } })]);
    const { box, read, unmount } = await mount(client);
    expect(box.choice.stranded.map((s) => s.serviceId)).toEqual(['old']);
    expect(read()).toBe('none/fixed/online');
    await unmount();
  });

  it('shows what it already knew while it re-checks', async () => {
    // Switching tabs used to blank the picker on every visit.
    serviceCache.set('p1', [svc('igt:cached')]);
    let settle;
    const client = {
      messages: {
        discoverServices: vi.fn(() => new Promise((r) => (settle = r))),
      },
    };
    const { box, read, step, unmount } = await mount(client);
    expect(read()).toBe('igt:cached/fixed/online');
    expect(box.choice.discovering).toBe(false);
    await step(async () => {
      settle([svc('igt:fresh')]);
    });
    expect(read()).toBe('igt:fresh/fixed/online');
    await unmount();
  });

  it('keeps what it had when discovery fails', async () => {
    serviceCache.set('p1', [svc('igt:cached')]);
    const client = { messages: { discoverServices: vi.fn().mockRejectedValue(new Error('no')) } };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { read, unmount } = await mount(client);
    expect(read()).toBe('igt:cached/fixed/online');
    err.mockRestore();
    await unmount();
  });
});
