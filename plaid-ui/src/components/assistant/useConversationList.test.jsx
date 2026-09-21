import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { notifyError } = await import('../../lib/notify.js');
const { renderComponent } = await import('../../test/renderComponent.jsx');
const { useConversationList } = await import('./useConversationList.js');
const { buildMeta, jobs } = await import('./jobs.js');

// The saved conversations behind both surfaces: which keys the read asks for,
// what widening to every project changes, and what a delete does to the row.

const meta = (id, at, over = {}) => ({
  id,
  title: `Thread ${id}`,
  updatedAt: at,
  serviceId: 'igt:assist:one',
  ...over,
});

const fakeClient = (entries, projects = []) => ({
  userData: {
    // A prefix narrows the listing, as the server's does: deleting a
    // conversation lists its files by one, and a fake that ignored it handed
    // back the conversation's own entry as though it were an attachment.
    list: vi.fn(async (userId, { prefix } = {}) =>
      prefix ? entries.filter((e) => e.key.startsWith(prefix)) : entries,
    ),
    delete: vi.fn().mockResolvedValue(undefined),
  },
  projects: { list: vi.fn().mockResolvedValue(projects) },
});

// Renders the hook's answer as text, and hands the whole thing back so a test
// can drive it.
const mount = async (client, { onRemoved } = {}) => {
  const box = {};
  const Probe = () => {
    box.list = useConversationList({
      client,
      userId: 'u1',
      app: 'igt',
      projectId: 'here',
      onRemoved,
    });
    return (
      <span data-testid="rows">
        {box.list.rows.map((m) => `${m.id}@${m.projectId}`).join(',') || 'none'}
      </span>
    );
  };
  const r = await renderComponent(<Probe />);
  return { ...r, box, read: () => r.container.querySelector('[data-testid="rows"]').textContent };
};

beforeEach(() => {
  jobs.clear();
  vi.clearAllMocks();
});

describe('useConversationList', () => {
  it('reads this project by prefix, newest first', async () => {
    const client = fakeClient([
      { key: 'igt:assistant:here:meta:old', value: meta('old', '2026-09-01T00:00:00Z') },
      { key: 'igt:assistant:here:meta:new', value: meta('new', '2026-09-09T00:00:00Z') },
    ]);
    const { box, read, step, unmount } = await mount(client);
    await step(() => box.list.reload());
    expect(read()).toBe('new@here,old@here');
    expect(client.userData.list).toHaveBeenCalledWith('u1', {
      prefix: 'igt:assistant:here:meta:',
      includeValues: true,
    });
    await unmount();
  });

  it('widens to a glob, tags each row with the project off its key, and names them', async () => {
    const client = fakeClient(
      [
        { key: 'igt:assistant:here:meta:a', value: meta('a', '2026-09-09T00:00:00Z') },
        { key: 'igt:assistant:there:meta:b', value: meta('b', '2026-09-08T00:00:00Z') },
      ],
      [{ id: 'there', name: 'Another project' }],
    );
    const { box, read, step, unmount } = await mount(client);
    await step(() => box.list.setAllProjects(true));
    await step(() => box.list.reload());
    expect(read()).toBe('a@here,b@there');
    expect(client.userData.list).toHaveBeenLastCalledWith('u1', {
      pattern: 'igt:assistant:*:meta:*',
      includeValues: true,
    });
    // The names are only asked for once the list reaches past this project.
    expect(box.list.projectNames.get('there')).toBe('Another project');
    await unmount();
  });

  it('does not ask for project names while the list is this project alone', async () => {
    const client = fakeClient([]);
    const { step, box, unmount } = await mount(client);
    await step(() => box.list.reload());
    expect(client.projects.list).not.toHaveBeenCalled();
    await unmount();
  });

  it("deletes under the row's own project and drops it", async () => {
    const client = fakeClient([
      { key: 'igt:assistant:there:meta:b', value: meta('b', '2026-09-08T00:00:00Z') },
    ]);
    const onRemoved = vi.fn();
    const { box, read, step, unmount } = await mount(client, { onRemoved });
    await step(() => box.list.setAllProjects(true));
    await step(() => box.list.reload());
    expect(read()).toBe('b@there');
    await step(() => box.list.remove({ id: 'b', projectId: 'there' }));
    expect(client.userData.delete.mock.calls.map((c) => c[1])).toEqual([
      'igt:assistant:there:conv:b',
      'igt:assistant:there:meta:b',
    ]);
    expect(read()).toBe('none');
    expect(onRemoved).toHaveBeenCalledWith('b');
    await unmount();
  });

  it('refuses to delete a conversation with work in flight, and says which', async () => {
    const client = fakeClient([
      { key: 'igt:assistant:here:meta:a', value: meta('a', '2026-09-09T00:00:00Z') },
    ]);
    const onRemoved = vi.fn();
    const { box, read, step, unmount } = await mount(client, { onRemoved });
    await step(() => box.list.reload());
    jobs.set('a', { id: 'a', kind: 'apply', done: false });
    await step(() => box.list.remove({ id: 'a', projectId: 'here' }));
    expect(client.userData.delete).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith('That conversation is still applying changes.');
    expect(read()).toBe('a@here');
    expect(onRemoved).not.toHaveBeenCalled();
    await unmount();
  });

  it('puts a written entry back in its place rather than at the front', async () => {
    // Opening a conversation re-reads its record without changing it, and
    // hoisting it moved every other row under the pointer that had just
    // clicked one.
    const client = fakeClient([
      { key: 'igt:assistant:here:meta:old', value: meta('old', '2026-09-01T00:00:00Z') },
      { key: 'igt:assistant:here:meta:new', value: meta('new', '2026-09-09T00:00:00Z') },
    ]);
    const { box, read, step, unmount } = await mount(client);
    await step(() => box.list.reload());
    await step(() =>
      box.list.applyMeta(meta('old', '2026-09-01T00:00:00Z', { projectId: 'here' })),
    );
    expect(read()).toBe('new@here,old@here');
    await unmount();
  });

  it('leaves a settled row with the project it was listed under', async () => {
    // Settling a turn rebuilds the sidebar entry and puts it back over the
    // listed one. The entry the read tagged from its key is replaced, so what
    // goes back has to carry the project itself.
    const client = fakeClient([
      { key: 'igt:assistant:here:meta:a', value: meta('a', '2026-09-09T00:00:00Z') },
    ]);
    const { box, read, step, unmount } = await mount(client);
    await step(() => box.list.reload());
    expect(read()).toBe('a@here');
    await step(() =>
      box.list.applyMeta(
        buildMeta(box.list.store, { id: 'a' }, { id: 'a', messages: [], display: [] }, null),
      ),
    );
    expect(read()).toBe('a@here');
    await unmount();
  });

  it('says so when the list cannot be read, and keeps rendering', async () => {
    const client = fakeClient([]);
    client.userData.list.mockRejectedValue(new Error('nope'));
    const { box, read, step, unmount } = await mount(client);
    await step(() => box.list.reload());
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(read()).toBe('none');
    expect(box.list.loading).toBe(false);
    await unmount();
  });
});
