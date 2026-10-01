// The repair on open records a field's language from its name, and declares
// which metadata keys survive a split. Both are config writes a maintainer's
// page makes from the copy it loaded. Written whole and unchecked, they wrote
// over a settings save another maintainer made after the page loaded
// (REV-F-BULK). Each now names the value it read (compare-and-set) and adds
// only what was missing.
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

describe('the field language back-fill', () => {
  it('adds only the missing languages, naming what it read', async () => {
    const { doc, info, server } = setup();
    await doc._backfillFieldLangs(info);
    const w = server.sent.find((s) => s.kind === 'vocab');
    expect(w.options).toEqual({ expected: loadedFields });
    expect(server.store.vocab['voc-1'].igt.fields).toEqual({
      'gloss (ru)': { type: 'text', lang: 'ru' },
      note: { type: 'text' },
    });
  });

  it("does not write over another maintainer's fields saved after the page loaded", async () => {
    const saved = {
      'gloss (ru)': { type: 'text' },
      note: { type: 'text' },
      source: { type: 'text' },
    };
    const { doc, info, server } = setup({ serverFields: saved });
    await doc._backfillFieldLangs(info);
    expect(server.store.vocab['voc-1'].igt.fields).toEqual(saved);
  });

  it("does not write over a field's language recorded after the page loaded, and goes on", async () => {
    const { doc, info, server, spanLayerId } = setup({ spanLayerLang: 'fr' });
    await doc._backfillFieldLangs(info);
    expect(server.store.span[spanLayerId].igt.lang).toBe('fr');
    // The refusal stops nothing else: the vocabulary is still written.
    expect(server.store.vocab['voc-1'].igt.fields['gloss (ru)'].lang).toBe('ru');
  });
});

describe('the preserveOnSplit declaration', () => {
  it('keeps the keys a layer already declared and names them as expected', async () => {
    const { doc, info, server } = setup();
    const layer = info.primaryTokenLayer;
    layer.config = { ...(layer.config || {}), plaid: { preserveOnSplit: ['otherAppKey'] } };
    server.store.token[layer.id] = { plaid: { preserveOnSplit: ['otherAppKey'] } };
    await doc._backfillPreserveOnSplit(info);
    const w = server.sent.find((s) => s.kind === 'token' && s.id === layer.id);
    expect(w.options).toEqual({ expected: ['otherAppKey'] });
    const stored = server.store.token[layer.id].plaid.preserveOnSplit;
    expect(stored[0]).toBe('otherAppKey');
    expect(stored.length).toBeGreaterThan(1);
  });

  it('does not write over a declaration made after the page loaded', async () => {
    const { doc, info, server } = setup();
    const layer = info.primaryTokenLayer;
    server.store.token[layer.id] = { plaid: { preserveOnSplit: ['later'] } };
    await doc._backfillPreserveOnSplit(info);
    expect(server.store.token[layer.id].plaid.preserveOnSplit).toEqual(['later']);
  });
});
