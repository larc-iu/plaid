import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';

// A lexicon read again (the popover opening, the tab coming back) must not
// take off the screen an edit made while the read was out: the read was
// answered before the edit reached the server.

const makeDoc = (client) =>
  new IgtDocument({
    raw: buildRawDoc({}),
    project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: {} },
    vocabularies: {
      v1: { id: 'v1', name: 'Lex', items: [{ id: 'i-cat', form: 'cat' }], vocabLinks: [] },
    },
    client,
    projectId: 'proj-1',
  });

beforeEach(() => resetIds());

describe('a lexicon read again', () => {
  it('keeps an entry and a link made while it was out, and reads once more after them', async () => {
    const client = makeFakeClient();
    let open;
    const gate = new Promise((r) => (open = r));
    let reads = 0;
    let doc;
    // The server's list from before the edit, answered after it. The read
    // made after the edit has it.
    client.vocabLayers.get = async () => {
      reads += 1;
      if (reads === 1) {
        await gate;
        return { id: 'v1', timeModified: 1, items: [{ id: 'i-cat', form: 'cat' }] };
      }
      const made = doc.vocabularies.v1.items.find((i) => i.form === 'the');
      return { id: 'v1', timeModified: 2, items: [{ id: 'i-cat', form: 'cat' }, made] };
    };
    doc = makeDoc(client);
    const reading = doc.refreshVocabulary('v1');
    expect(await doc.createAndLinkVocabItem('m-1', 'v1', 'the')).toBe(true);
    open();
    expect(await reading).toBe(true);
    expect(doc.vocabularies.v1.items.map((i) => i.form)).toContain('the');
    expect(doc.sentences[0].tokens[0].morphemes[0].vocabItem?.form).toBe('the');
  });

  it('asked while a save is out, waits for it and reads, rather than skipping', async () => {
    const client = makeFakeClient();
    let release;
    const held = new Promise((r) => (release = r));
    const create = client.spans.create;
    client.spans.create = async (...args) => {
      await held;
      return create(...args);
    };
    client.vocabLayers.get = async () => ({
      id: 'v1',
      timeModified: 2,
      items: [
        { id: 'i-cat', form: 'cat' },
        { id: 'i-dog', form: 'dog' },
      ],
    });
    const doc = makeDoc(client);
    const saving = doc.updateMorphemeSpan('m-1', 'Gloss', 'X', null);
    expect(doc.isSaving).toBe(true);
    const reading = doc.refreshVocabulary('v1');
    release();
    await saving;
    expect(await reading).toBe(true);
    expect(doc.vocabularies.v1.items.map((i) => i.form)).toEqual(['cat', 'dog']);
  });

  it('still brings in what others added when nothing was edited meanwhile', async () => {
    const client = makeFakeClient();
    client.vocabLayers.get = async () => ({
      id: 'v1',
      timeModified: 2,
      items: [
        { id: 'i-cat', form: 'cat' },
        { id: 'i-sat', form: 'sat' },
      ],
    });
    const doc = makeDoc(client);
    expect(await doc.refreshVocabulary('v1')).toBe(true);
    expect(doc.vocabularies.v1.items.map((i) => i.form)).toEqual(['cat', 'sat']);
  });
});
