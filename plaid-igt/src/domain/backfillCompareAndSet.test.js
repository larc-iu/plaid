// The repair on open declares which metadata keys survive a split, a config
// write a maintainer's page makes from the copy it loaded. Written whole and
// unchecked, it wrote over a settings save another maintainer made after the
// page loaded (REV-F-BULK). It now names the value it read (compare-and-set)
// and adds only what was missing.
import { describe, it, expect } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';

const canonical = (v) =>
  JSON.stringify(v ?? null, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );

// A config store that behaves as the core does: a write naming `expected` is
// refused with a 409 when the stored cell differs.
const configServer = (initial) => {
  const store = structuredClone(initial);
  const sent = [];
  const setConfig = (kind) => async (id, ns, key, value, _msg, options) => {
    sent.push({ kind, id, key, value, options });
    const cell = store[kind]?.[id]?.[ns]?.[key];
    if (options && 'expected' in options && canonical(options.expected) !== canonical(cell)) {
      throw Object.assign(new Error('Conflict'), { status: 409 });
    }
    store[kind] ??= {};
    store[kind][id] ??= {};
    store[kind][id][ns] ??= {};
    store[kind][id][ns][key] = value;
  };
  // A batch of config writes, all or nothing, as the core runs one.
  const batched = async (fn) => {
    const queued = [];
    await fn({
      tokenLayers: { setConfig: (...args) => queued.push(['token', args]) },
      spanLayers: { setConfig: (...args) => queued.push(['span', args]) },
    });
    const batch = sent.length;
    for (const [kind, [id, ns, key, value, _msg, options]] of queued) {
      sent.push({ kind, id, key, value, options, batch });
      const cell = store[kind]?.[id]?.[ns]?.[key];
      if (options && 'expected' in options && canonical(options.expected) !== canonical(cell)) {
        throw Object.assign(new Error('Conflict'), { status: 409 });
      }
    }
    for (const [kind, [id, ns, key, value]] of queued) {
      store[kind] ??= {};
      store[kind][id] ??= {};
      store[kind][id][ns] ??= {};
      store[kind][id][ns][key] = value;
    }
    return queued.map(() => ({ status: 200 }));
  };
  return { store, sent, setConfig, batched };
};

const loadedFields = {
  'gloss (ru)': { type: 'text' },
  note: { type: 'text' },
};

const setup = ({ serverFields = loadedFields, spanLayerLang } = {}) => {
  resetIds();
  const client = makeFakeClient();
  const server = configServer({
    vocab: { 'voc-1': { igt: { fields: serverFields } } },
    span: {},
    token: {},
  });
  client.vocabLayers.setConfig = server.setConfig('vocab');
  client.spanLayers = { ...client.spanLayers, setConfig: server.setConfig('span') };
  client.tokenLayers = { ...client.tokenLayers, setConfig: server.setConfig('token') };
  client.batched = server.batched;
  const doc = new IgtDocument({
    raw: buildRawDoc(),
    project: { id: 'proj-1', vocabs: [{ id: 'voc-1' }], maintainers: ['m@x'] },
    client,
    projectId: 'proj-1',
    user: { id: 'm@x' },
    vocabularies: {
      'voc-1': { id: 'voc-1', name: 'Lex', items: [], config: { igt: { fields: loadedFields } } },
    },
  });
  const info = doc.layerInfo;
  const sl = Object.values(info.spanLayers).flat()[0];
  sl.name = 'Gloss (nl)';
  if (spanLayerLang !== undefined) server.store.span[sl.id] = { igt: { lang: spanLayerLang } };
  return { doc, info, server, spanLayerId: sl.id };
};

// A field named "Gloss (nl)" whose language a maintainer cleared stays
// cleared: opening a document records nothing from a field's name, on a span
// layer or on a vocabulary's fields (R2-DEBT-APPS-2). It also asks no lexicon
// maintainer rights of a project maintainer (H9-FIRST-OPEN-6).
describe("a field's language on open", () => {
  it('is not written from the field name', async () => {
    const { doc, server } = setup();
    await doc.reconcileOnOpen();
    expect(server.sent.filter((s) => s.kind === 'span' || s.kind === 'vocab')).toEqual([]);
    expect(server.store.vocab['voc-1'].igt.fields).toEqual(loadedFields);
  });
});
