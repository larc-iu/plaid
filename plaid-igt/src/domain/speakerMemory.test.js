// The project's speaker list (`config.igt.speakers`) is project config, which
// only a maintainer may write. A writer's row edit tried to add to it anyway
// and was refused 403 on every edit. Only someone who may write it does, and a
// writer's suggestions still hold every speaker the document's own rows use.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';

const project = () => ({
  id: 'proj-1',
  vocabs: [],
  maintainers: ['m@x.com'],
  writers: ['w@x.com'],
  config: { igt: { speakers: ['Ana'] } },
});

const raw = () =>
  buildRawDoc({
    body: 'kai pele',
    alignmentTokens: [
      {
        id: 'a-1',
        text: 'text-1',
        begin: 0,
        end: 8,
        metadata: { timeBegin: 0, timeEnd: 1, speaker: 'Ben' },
      },
    ],
  });

const open = (user) => {
  const client = makeFakeClient();
  client.projects.setConfig = vi.fn(async () => ({}));
  const doc = new IgtDocument({
    raw: raw(),
    project: project(),
    client,
    projectId: 'proj-1',
    user,
  });
  return { doc, client };
};

beforeEach(() => resetIds());

describe('remembering a speaker', () => {
  it("is not tried for a writer, whose suggestions still hold the document's speakers", async () => {
    const { doc, client } = open({ id: 'w@x.com', isAdmin: false });
    expect(await doc.updateAlignmentSpeaker('a-1', 'Cy')).toBe(true);
    expect(client.projects.setConfig).not.toHaveBeenCalled();
    expect(doc.knownSpeakers).toEqual(['Ana', 'Cy']);
  });

  it('adds to the project list for a maintainer', async () => {
    const { doc, client } = open({ id: 'm@x.com', isAdmin: false });
    await doc.updateAlignmentSpeaker('a-1', 'Cy');
    expect(client.projects.setConfig).toHaveBeenCalledWith(
      'proj-1',
      'igt',
      'speakers',
      ['Ana', 'Cy'],
      undefined,
      expect.anything(),
    );
  });

  it('adds to the project list for an admin', async () => {
    const { doc, client } = open({ id: 'x@x.com', isAdmin: true });
    await doc.updateAlignmentSpeaker('a-1', 'Cy');
    expect(client.projects.setConfig).toHaveBeenCalled();
  });
});
