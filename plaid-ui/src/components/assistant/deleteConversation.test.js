import { describe, it, expect, vi } from 'vitest';
import { buildMeta, deleteConversation } from './jobs.js';

// Which keys a delete asks for. With the list widened to All projects, a row
// from another project was deleted under the project on SCREEN: a key that has
// never existed, so a 404 every time and the row stayed where it was.

const store = (over) => {
  const del = vi.fn().mockResolvedValue(undefined);
  return {
    del,
    store: {
      client: { userData: { delete: del } },
      userId: 'u1',
      app: 'igt',
      projectId: 'here',
      ...over,
    },
  };
};

describe('deleteConversation', () => {
  it("uses the row's own project", async () => {
    const { del, store: s } = store();
    await deleteConversation(s, { id: 'c1', projectId: 'elsewhere' });
    expect(del.mock.calls.map((c) => c[1])).toEqual([
      'igt:assistant:elsewhere:conv:c1',
      'igt:assistant:elsewhere:meta:c1',
    ]);
  });

  it('finds the project on the entry of a conversation just started here', async () => {
    // Its entry carries the project from the first write, so a row never has
    // to be told where it lives by the screen it happens to be listed on.
    const { del, store: s } = store();
    const meta = buildMeta(s, null, { id: 'c2', messages: [], display: [] }, null);
    await deleteConversation(s, meta);
    expect(del.mock.calls.map((c) => c[1])).toEqual([
      'igt:assistant:here:conv:c2',
      'igt:assistant:here:meta:c2',
    ]);
  });

  it('deletes both keys, never one', async () => {
    const { del, store: s } = store();
    await deleteConversation(s, { id: 'c3', projectId: 'here' });
    expect(del).toHaveBeenCalledTimes(2);
  });
});
