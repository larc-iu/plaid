// H21-ACCESS-4: a member demoted or removed while a document is open gets the
// read-only page without a reload. A write the server refuses for a missing
// permission reads the project again at once, and a project the server no
// longer lets this person read counts as one they hold no role in.
import { describe, it, expect, vi } from 'vitest';
import { DocumentModel } from './DocumentModel.js';
import { canEditProject, canReadProject } from './permissions.js';

const ME = { id: 'b@x.com', isAdmin: false };

const forbidden = () => {
  const err = new Error('HTTP 403: lacks sufficient privileges to write for project');
  err.status = 403;
  return err;
};

class Doc extends DocumentModel {
  set(key, value) {
    this._applyRawPatch((raw) => {
      raw.values = { ...raw.values, [key]: value };
    });
    return this._queueWrite(`Failed to set ${key}`, () => this._client.write(key, value));
  }
}

const load = (projectRead) => {
  const client = {
    withOperation: (label, fn) => fn(() => {}),
    documents: { get: async () => ({ id: 'd1', values: {} }) },
    projects: { get: vi.fn(projectRead) },
    write: async () => {
      throw forbidden();
    },
  };
  const doc = new Doc({
    raw: { id: 'd1', values: {} },
    client,
    projectId: 'p1',
    project: { id: 'p1', config: {}, maintainers: ['a@x.com'], writers: [ME.id], readers: [] },
    user: ME,
  });
  doc.onError = () => {};
  return { doc, client };
};

const settle = async (doc) => {
  for (let i = 0; i < 50 && doc.isSaving; i++) await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('a member who loses write access while the document is open', () => {
  it('is shown as a reader after the first refused write, without a reload', async () => {
    const { doc, client } = load(async () => ({
      id: 'p1',
      config: {},
      maintainers: ['a@x.com'],
      writers: [],
      readers: [ME.id],
    }));
    expect(canEditProject(doc.project, ME)).toBe(true);
    const seen = vi.fn();
    doc.subscribe(seen);

    await doc.set('pos', 'NOUN');
    await settle(doc);

    expect(client.projects.get).toHaveBeenCalled();
    expect(canEditProject(doc.project, ME)).toBe(false);
    expect(canReadProject(doc.project, ME)).toBe(true);
    expect(seen).toHaveBeenCalled();
  });

  it('holds no role once the project read is refused too (removed)', async () => {
    const { doc } = load(async () => {
      throw forbidden();
    });
    const before = doc.dataVersion;

    expect(await doc.refreshProject()).toBe(true);

    expect(canReadProject(doc.project, ME)).toBe(false);
    expect(canEditProject(doc.project, ME)).toBe(false);
    expect(doc.project.id).toBe('p1');
    expect(doc.dataVersion).toBe(before + 1);
    // Read again and refused again: nothing changes.
    expect(await doc.refreshProject()).toBe(false);
  });

  it('keeps the project as it was when the read fails for any other reason', async () => {
    const { doc } = load(async () => {
      throw new Error('Network error: Failed to fetch');
    });
    expect(await doc.refreshProject()).toBe(false);
    expect(canEditProject(doc.project, ME)).toBe(true);
  });
});
