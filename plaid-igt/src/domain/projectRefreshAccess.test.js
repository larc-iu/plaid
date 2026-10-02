// H21-ACCESS-4: the refetch after a refused write reads the project with the
// document. A member demoted meanwhile used to get the new project stored with
// nothing told: the screen kept the old membership, and the minute's read then
// found nothing new, so the page stayed editable until a reload.
import { describe, it, expect, vi } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';
import { canEditProject } from '@ui/domain/permissions.js';

const ME = { id: 'b@x.com', isAdmin: false };

const setup = () => {
  resetIds();
  const raw = buildRawDoc();
  const server = {
    project: { id: 'proj-1', vocabs: [], config: {}, writers: [ME.id], readers: [] },
  };
  const client = makeFakeClient();
  client.projects.get = async () => structuredClone(server.project);
  const doc = new IgtDocument({
    raw,
    project: structuredClone(server.project),
    client,
    projectId: 'proj-1',
    user: ME,
  });
  return { doc, server, raw };
};

describe('a membership changed while the document is open', () => {
  it('reaches the screen from the read beside a refetch, with no swap after it', async () => {
    const { doc, server, raw } = setup();
    server.project = { ...server.project, writers: [], readers: [ME.id] };
    const seen = vi.fn();
    doc.subscribe(seen);
    const before = doc.document;

    await doc._adoptReload(structuredClone(raw));

    expect(canEditProject(doc.project, ME)).toBe(false);
    expect(seen).toHaveBeenCalled();
    // What is derived from the project is derived again.
    expect(doc.document).not.toBe(before);
  });
});
