import { describe, it, expect, vi } from 'vitest';
import { buildMeta, deleteConversation } from './jobs.js';

// Which keys a delete asks for. With the list widened to All projects, a row
// from another project was deleted under the project on SCREEN: a key that has
// never existed, so a 404 every time and the row stayed where it was.

const store = (over, files = []) => {
  const del = vi.fn().mockResolvedValue(undefined);
  const list = vi.fn(async (userId, { prefix }) =>
    files.filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
  );
  return {
    del,
    list,
    store: {
      client: { userData: { delete: del, list } },
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

  it("takes the files attached to it along, and no other conversation's", async () => {
    // Its files are only ever reachable through the conversation. Left behind,
    // nothing would name them again.
    const { del, store: s } = store({}, [
      'igt:assistant:here:file:c4:f1:part:0',
      'igt:assistant:here:file:c4:f1:part:1',
      'igt:assistant:here:file:c40:f9:part:0',
    ]);
    await deleteConversation(s, { id: 'c4', projectId: 'here' });
    expect(del.mock.calls.map((c) => c[1])).toEqual([
      'igt:assistant:here:file:c4:f1:part:0',
      'igt:assistant:here:file:c4:f1:part:1',
      'igt:assistant:here:conv:c4',
      'igt:assistant:here:meta:c4',
    ]);
  });
});
