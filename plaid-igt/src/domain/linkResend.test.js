import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, resetIds } from './test-helpers.js';
import { linkChangedTo } from '@ui/lib/cellConflict.js';

// A lexicon link edit refused because the document moved on (409) after a
// write elsewhere (D8-PRODLOG-2: Accept on a proposed link while an
// assistant wrote to the same document from another view). It goes again on
// the new version when what it changes is as it was, the way a gloss does,
// and is refused with what changed when someone changed that first.

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

const uuid = (n) => `01a00000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const PROPOSED = { prov: 'inferred', provSource: 'auto' };

// A server holding one document and one lexicon, with a document version
// checked on every write as plaid-core does in strict mode. Deleting an
// entry takes its links with it, as core does.
function linkServer() {
  const server = {
    version: 1,
    items: [
      { id: 'i-dog', form: 'dog' },
      { id: 'i-cat', form: 'cat' },
    ],
    links: [
      { id: 'L1', tokens: ['w-1'], vocabItem: { id: 'i-dog', form: 'dog' }, metadata: PROPOSED },
    ],
    translations: [],
    sent: [],
    seq: 0,
  };
  server.raw = () => {
    const raw = buildRawDoc({
      wordVocabs: [{ id: 'v1', name: 'Lexicon', vocabLinks: structuredClone(server.links) }],
    });
    raw.version = server.version;
    raw.textLayers[0].tokenLayers[0].spanLayers[0].spans = structuredClone(server.translations);
    return raw;
  };
  const project = { id: 'proj-1', vocabs: [{ id: 'v1' }], config: {} };
  const client = {
    strictModeDocumentId: 'doc-1',
    documentVersions: { 'doc-1': 1 },
    withOperation: async (label, fn) => fn(() => {}),
    keySeed: () => null,
    documents: {
      get: async () => {
        client.documentVersions = { ...client.documentVersions, 'doc-1': server.version };
        return server.raw();
      },
    },
    projects: { get: async () => structuredClone(project) },
    vocabLayers: {
      get: async (id, withItems) => ({
        id: 'v1',
        name: 'Lexicon',
        timeModified: `t${server.seq}`,
        ...(withItems ? { items: structuredClone(server.items) } : {}),
      }),
    },
  };
  const checked = (what, apply) => {
    server.sent.push(what);
    if (client.documentVersions['doc-1'] !== server.version) {
      throw Object.assign(new Error('HTTP 409 Document version mismatch'), {
        status: 409,
        method: 'POST',
      });
    }
    const result = apply();
    server.version += 1;
    client.documentVersions = { ...client.documentVersions, 'doc-1': server.version };
    return result;
  };
  const linkOps = {
    patchMetadata: (id, ops) => {
      const link = server.links.find((l) => l.id === id);
      for (const op of ops) {
        if (op.op === 'set') link.metadata = { ...link.metadata, [op.path[0]]: op.value };
      }
    },
    delete: (id) => {
      server.links = server.links.filter((l) => l.id !== id);
    },
    create: (item, tokens, metadata, opts) => {
      const form = server.items.find((i) => i.id === item)?.form;
      const made = { id: opts?.id ?? uuid(++server.seq), tokens, vocabItem: { id: item, form } };
      if (metadata) made.metadata = metadata;
      server.links.push(made);
      return { id: made.id };
    },
  };
  // A write naming a link that is gone is refused 403 `unresolved` before
  // the version is looked at, as core does.
  const gone = (id) => {
    if (server.links.some((l) => l.id === id)) return;
    server.sent.push(`gone ${id}`);
    throw Object.assign(new Error('HTTP 403 lacks sufficient privileges'), {
      status: 403,
      method: 'PATCH',
      responseData: { unresolved: true },
    });
  };
  client.vocabLinks = {
    patchMetadata: async (id, ops) => {
      gone(id);
      return checked(`patch ${id}`, () => linkOps.patchMetadata(id, ops));
    },
    delete: async (id) => checked(`delete ${id}`, () => linkOps.delete(id)),
    create: async (item, tokens, metadata, _x, opts) =>
      checked(`create ${tokens.join(',')}`, () => linkOps.create(item, tokens, metadata, opts)),
  };
  // A batch: every op lands, or none does.
  client.batched = async (build) => {
    const ops = [];
    const b = {
      ref: () => ({ $ref: ops.length - 1 }),
      vocabLinks: {
        delete: (id) => ops.push(['delete', () => linkOps.delete(id)]),
        create: (item, tokens, metadata, _x, opts) =>
          ops.push(['create', () => linkOps.create(item, tokens, metadata, opts)]),
      },
      tokens: { patchMetadata: (id) => ops.push(['type', () => ({ id })]) },
    };
    await build(b);
    return checked(`batch ${ops.map(([k]) => k).join(' ')}`, () => ops.map(([, run]) => run()));
  };
  // Another writer: a Translation on the sentence, a document write that
  // touches no link.
  server.translateElsewhere = (value) => {
    server.translations.push({ id: uuid(900 + ++server.seq), tokens: ['s-1'], value });
    server.version += 1;
  };
  server.elsewhere = (fn) => {
    fn(server);
    server.seq += 1;
    server.version += 1;
  };
  return { server, client, project };
}

const openDoc = async () => {
  const { server, client, project } = linkServer();
  const doc = new IgtDocument({
    raw: server.raw(),
    project,
    vocabularies: { v1: { id: 'v1', name: 'Lexicon', items: structuredClone(server.items) } },
    client,
    projectId: 'proj-1',
  });
  const errors = [];
  doc.onError = (msg, err, label) => errors.push({ msg, err, label });
  return { server, doc, errors };
};

const linkOn = (doc, token) =>
  Object.values(doc.vocabularies)
    .flatMap((v) => v.vocabLinks || [])
    .find((l) => l.tokens.length === 1 && l.tokens[0] === token);

beforeEach(() => resetIds());

describe('Accept on a proposed link after a write elsewhere (D8-PRODLOG-2)', () => {
  it('goes again on the new version and lands, with nothing said', async () => {
    const { server, doc, errors } = await openDoc();
    server.translateElsewhere('The cat.');
    expect(await doc.confirmVocabLink('w-1')).toBe(true);
    expect(server.sent).toEqual(['patch L1', 'patch L1']);
    expect(server.links[0].metadata.provConfirmed).toBe(true);
    expect(errors).toEqual([]);
    expect(doc.error).toBe('');
    await flush();
    expect(linkOn(doc, 'w-1').metadata.provConfirmed).toBe(true);
  });

  it('is refused with a notice and no banner when the link was changed elsewhere', async () => {
    const { server, doc, errors } = await openDoc();
    // Someone pointed the link at another entry first.
    server.elsewhere((s) => {
      s.links[0].vocabItem = { id: 'i-cat', form: 'cat' };
    });
    expect(await doc.confirmVocabLink('w-1')).toBe(false);
    expect(server.sent).toEqual(['patch L1']);
    expect(errors).toHaveLength(1);
    expect(errors[0].err.linkConflict).toMatchObject({ kind: 'changed' });
    expect(errors[0].label).toBe('Failed to accept link');
    expect(doc.error).toBe('');
    await flush();
    expect(linkOn(doc, 'w-1').vocabItem.id).toBe('i-cat');
    expect(linkOn(doc, 'w-1').metadata.provConfirmed).toBeUndefined();
  });

  it('is refused with a notice when the link was removed elsewhere', async () => {
    const { server, doc, errors } = await openDoc();
    server.elsewhere((s) => {
      s.links = [];
    });
    expect(await doc.confirmVocabLink('w-1')).toBe(false);
    expect(server.sent).toEqual(['gone L1']);
    expect(doc.error).toBe('');
    expect(errors[0].err.linkConflict).toMatchObject({ kind: 'removed' });
    expect(linkChangedTo('b', errors[0].err.linkConflict)).toBe('b removed this link.');
  });

  it('is refused with what it is now when the word was linked to another entry elsewhere', async () => {
    const { server, doc, errors } = await openDoc();
    server.elsewhere((s) => {
      s.links = [{ id: uuid(79), tokens: ['w-1'], vocabItem: { id: 'i-cat', form: 'cat' } }];
    });
    expect(await doc.confirmVocabLink('w-1')).toBe(false);
    expect(server.sent).toEqual(['gone L1']);
    expect(errors[0].err.linkConflict).toMatchObject({ kind: 'linked', form: 'cat' });
    expect(linkChangedTo('b', errors[0].err.linkConflict)).toBe('b linked this to cat.');
    await flush();
    expect(linkOn(doc, 'w-1').vocabItem.id).toBe('i-cat');
  });

  it('is refused when it was accepted elsewhere first', async () => {
    const { server, doc, errors } = await openDoc();
    server.elsewhere((s) => {
      s.links[0].metadata = { ...s.links[0].metadata, provConfirmed: true };
    });
    expect(await doc.confirmVocabLink('w-1')).toBe(false);
    expect(server.sent).toEqual(['patch L1']);
    expect(errors[0].err.linkConflict).toMatchObject({ kind: 'changed' });
  });
});

describe('a link, an unlink and a multi-word expression after a write elsewhere', () => {
  it('a new link goes again and lands', async () => {
    const { server, doc, errors } = await openDoc();
    server.translateElsewhere('The cat.');
    expect(await doc.linkVocab('w-2', 'i-cat')).not.toBe(false);
    expect(server.sent).toEqual(['batch create', 'batch create']);
    expect(server.links.map((l) => [l.tokens[0], l.vocabItem.id])).toEqual([
      ['w-1', 'i-dog'],
      ['w-2', 'i-cat'],
    ]);
    expect(errors).toEqual([]);
  });

  it('a new link is refused when someone linked the same word first', async () => {
    const { server, doc, errors } = await openDoc();
    server.elsewhere((s) => {
      s.links.push({ id: uuid(77), tokens: ['w-2'], vocabItem: { id: 'i-dog', form: 'dog' } });
    });
    expect(await doc.linkVocab('w-2', 'i-cat')).toBe(false);
    expect(server.sent).toEqual(['batch create']);
    expect(errors[0].err.linkConflict).toMatchObject({ kind: 'linked', form: 'dog' });
    expect(linkChangedTo('b', errors[0].err.linkConflict)).toBe('b linked this to dog.');
    await flush();
    expect(linkOn(doc, 'w-2').vocabItem.id).toBe('i-dog');
  });

  it('a new link is refused when its entry was deleted elsewhere', async () => {
    const { server, doc, errors } = await openDoc();
    server.elsewhere((s) => {
      s.items = s.items.filter((i) => i.id !== 'i-cat');
    });
    expect(await doc.linkVocab('w-2', 'i-cat')).toBe(false);
    expect(server.sent).toEqual(['batch create']);
    expect(errors[0].err.linkConflict).toMatchObject({ kind: 'entryGone' });
  });

  it('an unlink goes again and lands', async () => {
    const { server, doc, errors } = await openDoc();
    server.translateElsewhere('The cat.');
    expect(await doc.unlinkVocab('w-1')).not.toBe(false);
    expect(server.sent).toEqual(['delete L1', 'delete L1']);
    expect(server.links).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('a multi-word expression goes again and lands', async () => {
    const { server, doc, errors } = await openDoc();
    server.translateElsewhere('The cat.');
    expect(await doc.linkMwe(['w-1', 'w-2'], 'i-cat')).not.toBe(false);
    expect(server.sent).toEqual(['create w-1,w-2', 'create w-1,w-2']);
    expect(errors).toEqual([]);
  });

  it('a multi-word expression is refused when someone made one over the same words first', async () => {
    const { server, doc, errors } = await openDoc();
    server.elsewhere((s) => {
      s.links.push({
        id: uuid(78),
        tokens: ['w-1', 'w-2'],
        vocabItem: { id: 'i-dog', form: 'dog' },
      });
    });
    expect(await doc.linkMwe(['w-1', 'w-2'], 'i-cat')).toBe(false);
    expect(server.sent).toEqual(['create w-1,w-2']);
    expect(errors[0].err.linkConflict).toMatchObject({ kind: 'linked' });
  });

  it('two link edits waiting behind each other both go again', async () => {
    const { server, doc, errors } = await openDoc();
    server.translateElsewhere('The cat.');
    const first = doc.confirmVocabLink('w-1');
    const second = doc.linkVocab('w-2', 'i-cat');
    expect(await first).toBe(true);
    expect(await second).not.toBe(false);
    expect(server.sent).toEqual(['patch L1', 'patch L1', 'batch create']);
    expect(errors).toEqual([]);
  });
});
