// A core in memory that several pages write to, each through a client of its
// own: one document, one version, and every write stamped with an older
// version than the document's refused 409 with nothing written, as core's
// strict mode refuses it. A batch is one request: checked once, written
// whole or not at all. A read hands back the document and the version it is
// at. For tests of two people on one UMR document. Not a test file itself, so
// the runner does not pick it up.
//
// Core, as modelled: a row is made under the id the create sends, deleting a
// token deletes a span left with no token, and deleting a span deletes every
// relation on it.
import { applyMetadataOps } from '@larc-iu/plaid-client';
import { UmrDocument } from '../src/domain/UmrDocument.js';

class BatchRef {
  constructor(op, index) {
    this.$ref = op;
    if (index !== undefined) this.index = index;
  }
}

const conflict = () =>
  Object.assign(new Error('HTTP 409 Document version mismatch'), { status: 409, method: 'POST' });
const missing = (id) =>
  Object.assign(new Error(`HTTP 404 ${id} not found`), { status: 404, method: 'POST' });

// Every layer of a raw document, by id.
function layersById(raw) {
  const out = new Map();
  const visit = (layer) => {
    out.set(layer.id, layer);
    (layer.spanLayers || []).forEach(visit);
    (layer.relationLayers || []).forEach(visit);
  };
  raw.textLayers.forEach((tl) => (tl.tokenLayers || []).forEach(visit));
  return out;
}

const tokensOf = (raw) => [...layersById(raw).values()].filter((l) => l.tokens);
const spansOf = (raw) => [...layersById(raw).values()].filter((l) => l.spans);
const relationsOf = (raw) => [...layersById(raw).values()].filter((l) => l.relations);

function find(raw, kind, id) {
  const lists =
    kind === 'tokens' ? tokensOf(raw) : kind === 'spans' ? spansOf(raw) : relationsOf(raw);
  for (const l of lists) {
    const row = l[kind].find((x) => x.id === id);
    if (row) return row;
  }
  throw missing(id);
}

// The cascade core runs when tokens go.
function deleteTokens(raw, ids) {
  const gone = new Set(ids);
  tokensOf(raw).forEach((l) => (l.tokens = l.tokens.filter((t) => !gone.has(t.id))));
  const spansGone = new Set();
  spansOf(raw).forEach((l) => {
    l.spans = l.spans.filter((s) => {
      s.tokens = (s.tokens || []).filter((t) => !gone.has(t));
      if (s.tokens.length) return true;
      spansGone.add(s.id);
      return false;
    });
  });
  relationsOf(raw).forEach(
    (l) =>
      (l.relations = l.relations.filter(
        (r) => !spansGone.has(r.source) && !spansGone.has(r.target),
      )),
  );
}

// Each op, written into `raw`. Answers what the server answers.
function ops(raw, mint) {
  const layer = (id) => {
    const l = layersById(raw).get(id);
    if (!l) throw missing(id);
    return l;
  };
  const needSpan = (id) => find(raw, 'spans', id);
  return {
    tokens: {
      bulkCreate: (list) => {
        const ids = list.map((op) => {
          const token = { id: op.id ?? mint(), begin: op.begin, end: op.end };
          if (op.metadata) token.metadata = structuredClone(op.metadata);
          layer(op.tokenLayerId).tokens.push(token);
          return token.id;
        });
        return { ids };
      },
      bulkDelete: (ids) => {
        ids.forEach((id) => find(raw, 'tokens', id));
        deleteTokens(raw, ids);
      },
      bulkUpdate: (entries) =>
        entries.forEach((e) => {
          const t = find(raw, 'tokens', e.id);
          if (e.metadata) t.metadata = applyMetadataOps(t.metadata || {}, e.metadata);
        }),
      update: (id, begin, end) => {
        const t = find(raw, 'tokens', id);
        [t.begin, t.end] = [begin, end];
      },
      patchMetadata: (id, list) => {
        const t = find(raw, 'tokens', id);
        t.metadata = applyMetadataOps(t.metadata || {}, list);
      },
    },
    spans: {
      create: (layerId, tokens, value, metadata, _x, { id } = {}) => {
        tokens.forEach((t) => find(raw, 'tokens', t));
        const span = { id: id ?? mint(), tokens: [...tokens], value };
        if (metadata) span.metadata = structuredClone(metadata);
        layer(layerId).spans.push(span);
        return { id: span.id };
      },
      bulkCreate: (list) => ({
        ids: list.map((op) => {
          const span = { id: op.id ?? mint(), tokens: [...op.tokens], value: op.value };
          if (op.metadata) span.metadata = structuredClone(op.metadata);
          layer(op.spanLayerId).spans.push(span);
          return span.id;
        }),
      }),
      update: (id, value) => {
        needSpan(id).value = value;
      },
      setTokens: (id, tokens) => {
        needSpan(id).tokens = [...tokens];
      },
      patchMetadata: (id, list) => {
        const s = needSpan(id);
        s.metadata = applyMetadataOps(s.metadata || {}, list);
      },
    },
    relations: {
      create: (layerId, source, target, value, metadata, _x, { id } = {}) => {
        needSpan(source);
        needSpan(target);
        const rel = { id: id ?? mint(), source, target, value };
        if (metadata) rel.metadata = structuredClone(metadata);
        layer(layerId).relations.push(rel);
        return { id: rel.id };
      },
      bulkCreate: (list) => ({
        ids: list.map((op) => {
          needSpan(op.source);
          needSpan(op.target);
          const rel = {
            id: op.id ?? mint(),
            source: op.source,
            target: op.target,
            value: op.value,
          };
          if (op.metadata) rel.metadata = structuredClone(op.metadata);
          layer(op.relationLayerId).relations.push(rel);
          return rel.id;
        }),
      }),
      update: (id, value) => {
        find(raw, 'relations', id).value = value;
      },
      patchMetadata: (id, list) => {
        const r = find(raw, 'relations', id);
        r.metadata = applyMetadataOps(r.metadata || {}, list);
      },
      delete: (id) => {
        find(raw, 'relations', id);
        relationsOf(raw).forEach((l) => (l.relations = l.relations.filter((r) => r.id !== id)));
      },
    },
  };
}

/**
 * The core: `raw` is the document as stored, `version` its version, and
 * `writes` the requests it took, by writer.
 */
export function twoWriterCore(raw) {
  let n = 0;
  const core = { raw: structuredClone(raw), version: 1, writes: [], refused: [] };
  const mint = () => `core${++n}`;

  // One request of `who`: refused when it is stamped with a version the
  // document has moved past, else `fn` runs on a copy that replaces the
  // document only when all of it went through.
  const request = (client, who, name, fn) => {
    const strict = client.strictModeDocumentId;
    if (strict && client.documentVersions?.[strict] !== core.version) {
      core.refused.push({ who, name });
      throw conflict();
    }
    const next = structuredClone(core.raw);
    const answer = fn(ops(next, mint));
    core.raw = next;
    core.version += 1;
    core.writes.push({ who, name });
    if (strict) client.documentVersions = { [strict]: core.version };
    return answer;
  };

  /** A client for `who`, as the page's client is: in strict mode once a page holds it. */
  core.client = (who) => {
    const client = {
      strictModeDocumentId: null,
      documentVersions: {},
      serverNow: () => new Date(),
      withOperation: async (label, fn) => fn(() => {}),
      documents: {
        get: async (id) => {
          client.documentVersions = { [id]: core.version };
          return structuredClone(core.raw);
        },
        checkLock: async () => null,
        auditPage: async () => ({ entries: [], nextCursor: null }),
      },
      batched: async (fn) => {
        const queue = [];
        const proxy = (group) =>
          new Proxy(
            {},
            {
              get:
                (_, method) =>
                (...args) =>
                  queue.push({ group, method, args }),
            },
          );
        const ref = (k = -1, index) => new BatchRef(k < 0 ? queue.length + k : k, index);
        await fn({
          tokens: proxy('tokens'),
          spans: proxy('spans'),
          relations: proxy('relations'),
          ref,
        });
        return request(client, who, 'batch', (api) => {
          const out = [];
          const fill = (v) => {
            if (v instanceof BatchRef) {
              const body = out[v.$ref]?.body;
              return v.index === undefined ? body?.id : body?.ids?.[v.index];
            }
            if (Array.isArray(v)) return v.map(fill);
            if (v && Object.getPrototypeOf(v) === Object.prototype) {
              return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
            }
            return v;
          };
          for (const op of queue)
            out.push({ body: api[op.group][op.method](...op.args.map(fill)) });
          return out;
        });
      },
    };
    for (const group of ['tokens', 'spans', 'relations']) {
      client[group] = new Proxy(
        {},
        {
          get:
            (_, method) =>
            async (...args) =>
              request(client, who, `${group}.${method}`, (api) => api[group][method](...args)),
        },
      );
    }
    return client;
  };

  /**
   * A page of `who` with the document open, as the shell opens it: read,
   * held, strict. `errors` collects what it reports.
   */
  core.open = async (who) => {
    const client = core.client(who);
    const raw = await client.documents.get(core.raw.id);
    const doc = new UmrDocument({ raw, client });
    client.strictModeDocumentId = doc.id;
    const errors = [];
    doc.onError = (msg, err) => errors.push(err ?? msg);
    const release = doc.hold();
    return { doc, client, errors, release };
  };

  return core;
}
