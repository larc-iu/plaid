import { describe, it, expect } from 'vitest';
import { DocumentModel } from './DocumentModel.js';
import { pendingId, settledId } from './pendingIds.js';

// An edit sent again by itself (Luke's ruling Q2) goes on the version read
// after its refusal, and so do the edits queued behind it. Those were made
// on the old version too: each is checked against what changed, as the
// refused one was, before it goes on the new version (REV-W-RESEND).

const words = [
  { id: 't1', begin: 0, end: 3 },
  { id: 't2', begin: 4, end: 7 },
  { id: 't3', begin: 8, end: 12 },
];

function docServer() {
  const server = {
    spans: [],
    version: 1,
    sent: [],
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
  _snapshot(raw) {
    return new GlossDoc({ raw, client: this._client });
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
          this._server.spans.find((s) => s.id === settledId(spanId)).value = value;
        }),
      ),
    );
  }
  gloss(token, value) {
    const id = pendingId();
    this._applyRawPatch((raw) => {
      spansOf(raw).push({ id, tokens: [token], value });
    });
    // Glosses, opted in to the rule by entity as igt's are.
    const done = this.resendsByEntity(() =>
      this._queueWrite('Failed to update Gloss', () =>
        this._client.write(`add ${token} ${value}`, () => {
          const made = { id: this._server.nextId(), tokens: [token], value };
          this._server.spans.push(made);
          this._settle(new Map([[id, made.id]]));
        }),
      ),
    );
    return Object.assign(done, { id });
  }
}

const openDoc = () => {
  const { server, client } = docServer();
  const doc = new GlossDoc({ raw: server.raw(), client });
  doc._server = server;
  const errors = [];
  doc.onError = (msg, err) => errors.push(err);
  return { server, doc, errors };
};

describe('the edits queued behind an edit sent again by itself', () => {
  it('are refused when what changed touches them, not sent on the new version', async () => {
    const { server, doc, errors } = openDoc();
    // Another user glossed "dog" (t2) before this page's three edits.
    server.elsewhere('t2', 'HOUND');
    const first = doc.gloss('t1', 'DEF');
    const second = doc.gloss('t2', 'CANINE');
    const third = doc.gloss('t3', 'RUN');
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(await third).toBe(true);
    expect(errors.map((e) => e.status)).toEqual([409]);
    // "dog" keeps the one gloss the other user gave it.
    expect(server.spans.filter((s) => s.tokens[0] === 't2').map((s) => s.value)).toEqual(['HOUND']);
    expect(server.spans.map((s) => s.value).sort()).toEqual(['DEF', 'HOUND', 'RUN']);
  });

  it('go when they only build on the edit sent again', async () => {
    const { server, doc, errors } = openDoc();
    server.elsewhere('t2', 'HOUND');
    const first = doc.gloss('t1', 'DEF');
    const again = doc.regloss(first.id, 'ART');
    expect(await first).toBe(true);
    expect(await again).toBe(true);
    expect(errors).toEqual([]);
    expect(server.spans.map((s) => s.value).sort()).toEqual(['ART', 'HOUND']);
  });
});
