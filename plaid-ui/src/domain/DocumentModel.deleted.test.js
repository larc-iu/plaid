// H36-SETTINGS-LIVE-2: a document deleted while it is open. The write that
// finds it out is refused (403 for an id the server cannot place), and the
// read of the document after it is refused the same way. That read says the
// document was deleted, once, and the page goes read-only: the project kept
// is one this person holds no role in, whatever a later read of the project
// says, and every later edit is refused unsent, with nothing more said.
import { describe, it, expect, vi } from 'vitest';
import { DocumentModel } from './DocumentModel.js';
import { canEditProject, canManageProject, readOnlyReason } from './permissions.js';

const ME = { id: 'b@x.com', isAdmin: false };
const PROJECT = { id: 'p1', config: {}, maintainers: ['a@x.com'], writers: [ME.id], readers: [] };

const unresolved = () =>
  Object.assign(new Error('HTTP 403: lacks sufficient privileges'), {
    status: 403,
    responseData: { error: 'lacks sufficient privileges', unresolved: true },
  });

class Doc extends DocumentModel {
  set(key, value) {
    const label = `Failed to set ${key}`;
    if (!this._canWrite(label)) return Promise.resolve(false);
    this._applyRawPatch((raw) => {
      raw.values = { ...raw.values, [key]: value };
    });
    return this._queueWrite(label, () => this._client.write(key, value));
  }
}

const load = ({ readError = unresolved, user = ME } = {}) => {
  const client = {
    withOperation: (label, fn) => fn(() => {}),
    documents: {
      get: vi.fn(async () => {
        throw readError();
      }),
    },
    projects: { get: vi.fn(async () => PROJECT) },
    write: vi.fn(async () => {
      throw unresolved();
    }),
  };
  const doc = new Doc({
    raw: { id: 'd1', values: {} },
    client,
    projectId: 'p1',
    project: PROJECT,
    user,
  });
  const errors = [];
  doc.onError = (msg, err, label) => errors.push({ msg, err, label });
  return { doc, client, errors };
};

const settle = async (doc) => {
  for (let i = 0; i < 50 && doc.isSaving; i++) await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('a document deleted while it is open', () => {
  it('is announced once and goes read-only after the first refused write', async () => {
    const { doc, errors } = load();
    expect(canEditProject(doc.project, ME)).toBe(true);

    expect(await doc.set('gloss', 'person')).toBe(false);
    await settle(doc);

    expect(doc.deleted).toBe(true);
    expect(canEditProject(doc.project, ME)).toBe(false);
    expect(errors.map((e) => e.label)).toEqual(['Failed to set gloss', 'Read-only']);
    expect(errors[1].msg).toBe('This document was deleted.');
    // The notice says what happened: no banner beside it (L2-IGT-MULTI polish).
    expect(doc.error).toBe('');
  });

  it('stays read-only when the project is read again', async () => {
    const { doc } = load();
    await doc.set('gloss', 'person');
    await settle(doc);
    await doc.refreshProject();
    expect(canEditProject(doc.project, ME)).toBe(false);
  });

  it('refuses every later edit without sending it', async () => {
    const { doc, client, errors } = load();
    await doc.set('gloss', 'person');
    await settle(doc);
    const sent = client.write.mock.calls.length;
    const said = errors.length;

    expect(await doc.set('gloss', 'hut')).toBe(false);
    await settle(doc);

    expect(client.write.mock.calls.length).toBe(sent);
    expect(doc.raw.values.gloss).toBe('person');
    expect(errors.length).toBe(said + 1);
    expect(errors.at(-1).msg).toBe('Failed to set gloss: This document was deleted.');
  });

  it('refuses unsent the edits queued behind the one that found it out', async () => {
    const { doc, client, errors } = load();
    const first = doc.set('gloss', 'person');
    const second = doc.set('pos', 'NOUN');
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    await settle(doc);
    expect(client.write).toHaveBeenCalledTimes(1);
    expect(errors.filter((e) => e.label === 'Read-only')).toHaveLength(1);
    expect(errors.filter((e) => e.label === 'Failed to set pos')).toHaveLength(0);
  });

  it('a 404 for the document reads the same way', async () => {
    const { doc } = load({
      readError: () => Object.assign(new Error('HTTP 404 Not found'), { status: 404 }),
    });
    await expect(doc.reload()).rejects.toThrow();
    expect(doc.deleted).toBe(true);
  });

  it('a 403 that is not for a missing document leaves it writable', async () => {
    const { doc } = load({
      readError: () =>
        Object.assign(new Error('HTTP 403 lacks sufficient privileges'), { status: 403 }),
    });
    await expect(doc.reload()).rejects.toThrow();
    expect(doc.deleted).toBe(false);
    expect(canEditProject(doc.project, ME)).toBe(true);
  });

  it('says why on the read-only notice, and stays a project for every other purpose', async () => {
    const { doc } = load();
    await doc.set('gloss', 'person');
    await settle(doc);
    expect(readOnlyReason(doc.project, ME)).toBe('This document was deleted.');
    expect(doc.project.id).toBe('p1');
    expect(doc.project.writers).toEqual([ME.id]);
    expect(JSON.stringify(doc.project)).toBe(JSON.stringify(PROJECT));
  });

  it('is read-only for an admin too', async () => {
    const ADMIN = { id: 'a@b.com', isAdmin: true };
    const { doc, client } = load({ user: ADMIN });
    expect(canEditProject(doc.project, ADMIN)).toBe(true);
    await doc.set('gloss', 'person');
    await settle(doc);
    expect(doc.deleted).toBe(true);
    expect(canEditProject(doc.project, ADMIN)).toBe(false);
    expect(canManageProject(doc.project, ADMIN)).toBe(false);
    expect(readOnlyReason(doc.project, ADMIN)).toBe('This document was deleted.');
    await doc.refreshProject();
    expect(canEditProject(doc.project, ADMIN)).toBe(false);
    expect(client.write).toHaveBeenCalledTimes(1);
  });
});
