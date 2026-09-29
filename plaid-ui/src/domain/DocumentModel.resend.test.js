import { describe, it, expect } from 'vitest';
import { DocumentModel } from './DocumentModel.js';
import { pendingId, settledId } from './pendingIds.js';

// What goes again by itself after a refusal (Luke's ruling Q2, decision D21)
// and what never does: an edit the app checks against the whole document
// is checked again on the version it would now go on (REV-F-NET D-7), an
// edit to what is kept beside the document is not sent again (D-3b), and an
// edit that names a row a refused edit made is refused unsent (F-IGT's
// queue note).

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

const words = [
  { id: 't1', begin: 0, end: 3 },
  { id: 't2', begin: 4, end: 7 },
  { id: 't3', begin: 8, end: 12 },
];

// A server holding a document of the core's shape, with a version. A write
// stamped with an old version is refused 409, as plaid-core does.
function docServer() {
  const server = {
    spans: [],
    // Another app's layer over the same text (UMR's nodes).
    nodes: [],
    version: 1,
    sent: [],
    fail: [],
    raw() {
      return {
        id: 'd1',
        version: server.version,
        textLayers: [
          {
            id: 'tl',
            tokenLayers: [
              {
                id: 'words',
                tokens: structuredClone(words),
                spanLayers: [{ id: 'gloss', spans: structuredClone(server.spans) }],
              },
              { id: 'nodes', tokens: structuredClone(server.nodes) },
            ],
          },
        ],
      };
    },
  };
  let seq = 0;
  const client = {
    strictModeDocumentId: 'd1',
    documentVersions: { d1: 1 },
    withOperation: async (label, fn) => fn(() => {}),
    documents: {
      get: async () => {
        client.documentVersions = { ...client.documentVersions, d1: server.version };
        return server.raw();
      },
    },
    write: async (what, apply) => {
      server.sent.push(what);
      const failure = server.fail.shift();
      if (failure) throw failure();
      if (client.documentVersions.d1 !== server.version) {
        throw Object.assign(new Error('HTTP 409 Document version mismatch'), {
          status: 409,
          method: 'POST',
        });
      }
      const result = apply();
      server.version += 1;
      client.documentVersions = { ...client.documentVersions, d1: server.version };
      return result;
    },
  };
  server.elsewhere = (token, value) => {
    server.spans.push({ id: `x${++seq}`, tokens: [token], value });
    server.version += 1;
  };
  server.nextId = () => `s${++seq}`;
  return { server, client };
}

const spansOf = (raw) => raw.textLayers[0].tokenLayers[0].spanLayers[0].spans;

class GlossDoc extends DocumentModel {
  constructor(args) {
    super(args);
    this.beside = [];
  }
  _snapshot(raw) {
    return new GlossDoc({ raw, client: this._client });
  }
  valueOn(token) {
    return spansOf(this._raw).find((s) => s.tokens[0] === token)?.value ?? null;
  }
  // A gloss, with an optional app check to make again on a later version.
  gloss(token, value, { recheck = null, besideToo = false, byEntity = true } = {}) {
    const id = pendingId();
    this._applyRawPatch((raw, beside) => {
      spansOf(raw).push({ id, tokens: [token], value });
      if (besideToo) beside.push(value);
    });
    // Glosses, opted in to the rule by entity as igt's are, unless the test
    // says otherwise.
    const queue = () =>
      this._queueWrite(
        'Failed to update Gloss',
        () =>
          this._client.write(`add ${token} ${value}`, () => {
            const made = { id: this._server.nextId(), tokens: [token], value };
            this._server.spans.push(made);
            this._settle(new Map([[id, made.id]]));
          }),
        undefined,
        { recheck },
      );
    const done = byEntity ? this.resendsByEntity(queue) : queue();
    return { id, done };
  }
  // A second write to a gloss this page made, naming it by its pending id.
  regloss(spanId, value) {
    this._applyRawPatch((raw) => {
      const span = spansOf(raw).find((s) => s.id === spanId);
      if (span) span.value = value;
    });
    return this.resendsByEntity(() =>
      this._queueWrite('Failed to update Gloss', () =>
        this._client.write(`patch ${settledId(spanId)} ${value}`, () => {
          const span = this._server.spans.find((s) => s.id === settledId(spanId));
          span.value = value;
        }),
      ),
    );
  }
  _patchContext() {
    return [[...this.beside]];
  }
  _afterPatch(next, [beside]) {
    this.beside = beside;
  }
  _changesBeside([beside]) {
    return beside.length !== this.beside.length;
  }
}

const openDoc = () => {
  const { server, client } = docServer();
  const doc = new GlossDoc({ raw: server.raw(), client });
  doc._server = server;
  const errors = [];
  doc.onError = (msg, err) => errors.push(err);
  return { server, client, doc, errors };
};

describe("an edit the app checks against the whole document (D21's recheck)", () => {
  it('goes again when its check still holds on the version read after the refusal', async () => {
    const { server, doc, errors } = openDoc();
    server.elsewhere('t1', 'DEF');
    const seen = [];
    const { done } = doc.gloss('t2', 'CANINE', {
      recheck: (fresh) => {
        seen.push(fresh.valueOn('t1'));
        return true;
      },
    });
    expect(await done).toBe(true);
    // Asked on the version read after the refusal, as a document of the
    // app's own kind.
    expect(seen).toEqual(['DEF']);
    expect(errors).toEqual([]);
    expect(server.spans.map((s) => s.value)).toEqual(['DEF', 'CANINE']);
  });

  it('is refused like a conflict, and not sent again, when its check fails there', async () => {
    const { server, doc, errors } = openDoc();
    server.elsewhere('t1', 'DEF');
    // The check a UMR edge makes (no cycle): here, no DEF anywhere.
    const { done } = doc.gloss('t2', 'CANINE', {
      recheck: (fresh) => fresh.valueOn('t1') !== 'DEF',
    });
    expect(await done).toBe(false);
    expect(errors.map((e) => e.status)).toEqual([409]);
    expect(server.sent).toEqual(['add t2 CANINE']);
    await flush();
    expect(doc.valueOn('t2')).toBe(null);
  });

  it('checks an edit waiting behind a real conflict on the read with the edits ahead of it shown', async () => {
    const { server, doc, errors } = openDoc();
    server.elsewhere('t1', 'HOUND');
    const first = doc.gloss('t1', 'CANINE');
    const second = doc.gloss('t2', 'BIG');
    const seen = [];
    const third = doc.gloss('t3', 'RUN', {
      recheck: (fresh) => {
        seen.push([fresh.valueOn('t1'), fresh.valueOn('t2')]);
        return fresh.valueOn('t1') !== 'HOUND';
      },
    });
    expect(await first.done).toBe(false);
    expect(await second.done).toBe(true);
    expect(await third.done).toBe(false);
    expect(seen).toEqual([['HOUND', 'BIG']]);
    expect(errors.map((e) => e.status)).toEqual([409, 409]);
    expect(server.sent).toEqual(['add t1 CANINE', 'add t2 BIG']);
  });
});

describe('an edit to what is kept beside the document (REV-F-NET D-3b)', () => {
  it('is not sent again after a refusal, since no read shows what it changed', async () => {
    const { server, doc, errors } = openDoc();
    server.elsewhere('t1', 'DEF');
    const { done } = doc.gloss('t2', 'CANINE', { besideToo: true });
    expect(await done).toBe(false);
    expect(errors.map((e) => e.status)).toEqual([409]);
    expect(server.sent).toEqual(['add t2 CANINE']);
  });

  it('while the same edit with nothing beside goes again', async () => {
    const { server, doc } = openDoc();
    server.elsewhere('t1', 'DEF');
    expect(await doc.gloss('t2', 'CANINE').done).toBe(true);
  });
});

describe('an edit naming a row that a refused edit made', () => {
  const forbidden = () =>
    Object.assign(new Error('HTTP 403 You lack sufficient privileges'), {
      status: 403,
      method: 'POST',
    });

  it('is refused without being sent, whatever refused the first', async () => {
    const { server, doc, errors } = openDoc();
    server.fail.push(forbidden);
    const made = doc.gloss('t1', 'DEF');
    const again = doc.regloss(made.id, 'ART');
    const other = doc.gloss('t2', 'CANINE');
    expect(await made.done).toBe(false);
    expect(await again).toBe(false);
    expect(await other.done).toBe(true);
    expect(server.sent).toEqual(['add t1 DEF', 'add t2 CANINE']);
    expect(errors.map((e) => e.status)).toEqual([403, 400]);
    expect(errors[1].message).toMatch(/should be a uuid/);
  });

  it('is sent when the row was made after all', async () => {
    const { server, doc, errors } = openDoc();
    const made = doc.gloss('t1', 'DEF');
    const again = doc.regloss(made.id, 'ART');
    expect(await made.done).toBe(true);
    expect(await again).toBe(true);
    expect(errors).toEqual([]);
    expect(server.spans.map((s) => s.value)).toEqual(['ART']);
  });
});

// Luke's ruling Q2 narrowed (2026-09-30): an edit not opted in goes again
// only when what changed is all in layers it neither reads nor writes.
describe('an edit not opted in to the rule by entity', () => {
  it('is refused when someone wrote on another word of the layer it writes', async () => {
    const { server, doc, errors } = openDoc();
    server.elsewhere('t1', 'DEF');
    const { done } = doc.gloss('t2', 'CANINE', { byEntity: false });
    expect(await done).toBe(false);
    expect(errors.map((e) => e.status)).toEqual([409]);
    expect(server.spans.map((s) => s.value)).toEqual(['DEF']);
    expect(server.sent).toEqual(['add t2 CANINE']);
  });

  it('goes again when what changed is in a layer it neither reads nor writes', async () => {
    const { server, doc, errors } = openDoc();
    server.nodes.push({ id: 'n1', begin: 0, end: 3 });
    server.version += 1;
    const { done } = doc.gloss('t2', 'CANINE', { byEntity: false });
    expect(await done).toBe(true);
    expect(errors).toEqual([]);
    expect(server.spans.map((s) => s.value)).toEqual(['CANINE']);
  });

  it('is judged by layer when it waits behind an edit that was refused', async () => {
    const { server, doc } = openDoc();
    server.elsewhere('t1', 'HOUND');
    const first = doc.gloss('t1', 'DEF');
    const behind = doc.gloss('t3', 'RUN', { byEntity: false });
    const opted = doc.gloss('t2', 'CANINE');
    expect(await first.done).toBe(false);
    expect(await behind.done).toBe(false);
    expect(await opted.done).toBe(true);
    expect(server.sent).toEqual(['add t1 DEF', 'add t2 CANINE']);
  });
});
