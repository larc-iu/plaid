// A document open in the editor holds a copy of its project, and the editor
// checks typed values against that copy's tagsets. The copy was read once, at
// load, so a tagset closed after the page opened let any value through, and
// one opened since still refused values the server allows (V6 H6-4). The
// project is read again with every refetch and on a return to the tab.
import { describe, it, expect, afterEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';

const tagsets = (mode) => ({ igt: { tagsets: { Cats: { delimiters: '.', mode, values: [] } } } });
const loaded = { id: 'proj-1', vocabs: [], config: tagsets('suggest') };

const setup = () => {
  resetIds();
  const server = { project: { id: 'proj-1', vocabs: [], config: tagsets('closed') } };
  const client = makeFakeClient();
  client.projects.get = async () => structuredClone(server.project);
  const doc = new IgtDocument({
    raw: buildRawDoc(),
    project: structuredClone(loaded),
    client,
    projectId: 'proj-1',
  });
  return { doc, client, server };
};

const mode = (doc) => doc.project.config.igt.tagsets.Cats.mode;
const setVisibility = (state) =>
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });

afterEach(() => setVisibility('visible'));

describe('the project copy an open document holds', () => {
  it('is read again when the document is refetched', async () => {
    const { doc } = setup();
    expect(mode(doc)).toBe('suggest');
    await doc.reload();
    expect(mode(doc)).toBe('closed');
  });

  it('is read again when the tab comes back while a screen shows the document', async () => {
    const { doc, server } = setup();
    const release = doc.hold();
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 0));
    expect(mode(doc)).toBe('closed');

    // Opened again elsewhere: the reverse holds too.
    server.project.config = tagsets('suggest');
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 0));
    expect(mode(doc)).toBe('suggest');

    // Once no screen shows it, nothing listens.
    release();
    server.project.config = tagsets('closed');
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 0));
    expect(mode(doc)).toBe('suggest');
  });

  it('keeps the copy it has when the read fails', async () => {
    const { doc, client } = setup();
    client.projects.get = async () => {
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    };
    expect(await doc.refreshProject()).toBe(false);
    expect(mode(doc)).toBe('suggest');
  });

  it('re-derives the document metadata fields from the new copy', async () => {
    const { doc, server } = setup();
    doc.raw.metadata = { Place: 'Bloomington' };
    expect(doc.document.metadata).toEqual({});
    server.project.config.igt.documentMetadata = [{ name: 'Place' }];
    await doc.refreshProject();
    expect(doc.document.metadata).toEqual({ Place: 'Bloomington' });
  });
});

// The speaker list is one value in the project config. A page that loaded it
// before another document added a speaker wrote its own copy over theirs.
describe('remembering a speaker', () => {
  it('adds to the list as stored when someone else added one since', async () => {
    resetIds();
    const server = { id: 'proj-1', vocabs: [], config: { igt: { speakers: ['Ana', 'Bea'] } } };
    const client = makeFakeClient();
    client.projects.get = async () => structuredClone(server);
    client.projects.setConfig = async (_id, ns, key, value, _audit, options) => {
      if (JSON.stringify(options.expected) !== JSON.stringify(server.config[ns][key])) {
        throw Object.assign(new Error('HTTP 409'), { status: 409 });
      }
      server.config[ns][key] = value;
    };
    const doc = new IgtDocument({
      raw: buildRawDoc(),
      project: { id: 'proj-1', vocabs: [], config: { igt: { speakers: ['Ana'] } } },
      client,
      projectId: 'proj-1',
    });
    await doc._rememberSpeaker('Cy');
    expect(server.config.igt.speakers).toEqual(['Ana', 'Bea', 'Cy']);
    expect(doc.knownSpeakers).toEqual(['Ana', 'Bea', 'Cy']);
  });
});
