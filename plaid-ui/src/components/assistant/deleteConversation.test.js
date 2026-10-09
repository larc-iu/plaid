import { describe, it, expect, vi } from 'vitest';
import { deleteConversation } from './jobs.js';

// Deleting a conversation. The assistant service does it (it stops a turn
// running there first), and the page writes nothing. With no assistant of
// this app online on the conversation's project, the page deletes the keys
// itself (Luke's ruling, 2026-10-09), the one write it makes.
//
// The keys are the ROW's own project: with the list widened to All projects,
// a row from another project was once deleted under the project on SCREEN.

const SERVICE = {
  serviceId: 'igt:assist:one',
  online: true,
  extras: { tasks: ['assist'], app: 'igt', record: 2 },
};

const store = ({ online = true, files = [], refused = null } = {}) => {
  const del = vi.fn().mockResolvedValue(undefined);
  const list = vi.fn(async (userId, { prefix }) =>
    files.filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
  );
  const requestService = vi.fn(async () => refused ?? { kind: 'done', meta: null });
  const discoverServices = vi.fn(async () => (online ? [SERVICE] : []));
  return {
    del,
    requestService,
    discoverServices,
    store: {
      client: { userData: { delete: del, list }, messages: { requestService, discoverServices } },
      userId: 'u1',
      app: 'igt',
      projectId: 'here',
    },
  };
};

describe('deleteConversation', () => {
  it("asks the row's own project's assistant, and writes nothing", async () => {
    const { del, requestService, discoverServices, store: s } = store();
    await deleteConversation(s, { id: 'c1', projectId: 'elsewhere' }, { tab: 't1' });
    expect(discoverServices).toHaveBeenCalledWith('elsewhere');
    expect(requestService.mock.calls[0][0]).toBe('elsewhere');
    expect(requestService.mock.calls[0][2]).toMatchObject({
      projectId: 'elsewhere',
      conversationId: 'c1',
      op: 'delete',
      tab: 't1',
    });
    expect(del).not.toHaveBeenCalled();
  });

  it('says why when the assistant turns it down', async () => {
    const { store: s } = store({
      refused: {
        kind: 'refused',
        why: 'busy',
        message: 'That conversation is still applying changes.',
      },
    });
    await expect(deleteConversation(s, { id: 'c1', projectId: 'here' })).rejects.toThrow(
      'That conversation is still applying changes.',
    );
  });

  it('deletes the keys itself with no assistant online: files, transcript, then entry', async () => {
    const {
      del,
      requestService,
      store: s,
    } = store({
      online: false,
      files: [
        'igt:assistant:here:file:c4:f1:part:0',
        'igt:assistant:here:file:c4:f1:part:1',
        'igt:assistant:here:file:c40:f9:part:0',
      ],
    });
    await deleteConversation(s, { id: 'c4', projectId: 'here' });
    expect(requestService).not.toHaveBeenCalled();
    expect(del.mock.calls.map((c) => c[1])).toEqual([
      'igt:assistant:here:file:c4:f1:part:0',
      'igt:assistant:here:file:c4:f1:part:1',
      'igt:assistant:here:conv:c4',
      'igt:assistant:here:meta:c4',
    ]);
  });

  it('counts an assistant of another app, or one that writes no record, as none', async () => {
    const { del, requestService, discoverServices, store: s } = store();
    discoverServices.mockResolvedValue([
      { ...SERVICE, extras: { tasks: ['assist'], app: 'ud', record: 2 } },
      { ...SERVICE, extras: { tasks: ['assist'], app: 'igt' } },
    ]);
    await deleteConversation(s, { id: 'c5', projectId: 'here' });
    expect(requestService).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledTimes(2);
  });
});
