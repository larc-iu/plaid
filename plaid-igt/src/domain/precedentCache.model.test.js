import { describe, it, expect, vi } from 'vitest';

// A randomized model check of the precedent cache across tabs, reloads, other
// people's saves and sign-outs. The one property: once a tab has asked
// whether the project changed and everything it started has landed, the
// tally it hands the editor is exactly the documents other than the open one,
// as the server holds them now. It may count again needlessly, never wrongly.
//
// Every server request and every browser-store operation waits in a queue
// and runs at a random later step, so reads, writes, reloads and sign-outs
// interleave in every order. Each tab is its own copy of the module, as a
// browser tab is. The store is one, shared by every tab of the machine.
//
// PRECEDENT_SEEDS=200 runs more seeds (PRECEDENT_SEED_BASE to start
// elsewhere), and PRECEDENT_COLLECT=1 lists every failing seed instead of
// stopping at the first. A failure prints the steps that led to it.
//
// The project shares its vocabulary with a sister project, whose documents
// link the same entries and are saved by someone else as the run goes. The
// counts cover the open project only (ruling, 2026-09-27), so none of the
// sister's links may show in the tally, and none of its saves need a recount.

const world = vi.hoisted(() => ({
  records: new Map(),
  storeQueue: [],
  storeFail: 0,
  rand: Math.random,
}));

vi.mock('./precedentStore.js', () => {
  // One per tab: the factory runs again for every fresh copy of the module.
  let closed = false;
  const op = (fn, tab, label) =>
    new Promise((resolve) =>
      world.storeQueue.push({
        tab,
        label,
        run: () => resolve(world.rand() < world.storeFail ? null : fn()),
      }),
    );
  const tab = () => world.currentTab;
  return {
    loginHash: (token) => `h:${token}`,
    readStored: (key, login) =>
      op(
        () => {
          const rec = world.records.get(key);
          return rec && rec.login === login ? structuredClone(rec) : null;
        },
        tab(),
        `read ${key.slice(-4)}`,
      ),
    writeStored: (key, record) =>
      closed
        ? Promise.resolve(null)
        : op(
            () => {
              world.records.set(key, structuredClone(record));
              return key;
            },
            tab(),
            `write ${key.slice(-4)} ${record.readId} ${JSON.stringify(record.versions ? [...record.versions] : record.docs?.map(([id, r]) => [id, r.version, r.overlayVersion]))}`,
          ),
    clearStored: () => op(() => world.records.clear(), tab(), 'clear'),
    closeStore: () => {
      closed = true;
      return op(() => world.records.clear(), tab(), 'close');
    },
  };
});

const { createTally, foldDocument } = await import('./precedent.js');

const layerInfo = {
  primaryTokenLayer: { id: 'wordL' },
  morphemeTokenLayer: null,
  spanLayers: { word: [{ id: 'glossL', name: 'Gloss' }], morpheme: [], sentence: [] },
};
const LEAVE_OPTS = { wordFields: ['Gloss'], morphFields: [] };
const FORMS = ['kai', 'lo', 'mu'];
const VALUES = ['go', 'eat', 'sit'];
const ITEMS = ['kai1', 'kai2', 'lo1'];
const VOCABULARIES = { voc: { id: 'voc', items: [] } };

function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const sentencesOf = (content) => [
  {
    tokens: content.map(([form, value, item]) => ({
      content: form,
      annotations: value ? { Gloss: { value, metadata: {} } } : {},
      ...(item ? { vocabItem: { id: item, prov: null } } : {}),
      morphemes: [],
    })),
  },
];

// Every count in a tally, as `key|value -> n`, zeros left out.
function flat(tally) {
  const out = new Map();
  for (const [k, byValue] of tally || []) {
    for (const [v, c] of byValue) if (c.n !== 0) out.set(`${k}|${v}`, c.n);
  }
  return out;
}

function run(seed, { steps = 400, storeFail = 0 } = {}) {
  const rand = makeRng(seed);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  world.rand = rand;
  world.records = new Map();
  world.storeQueue = [];
  world.storeFail = storeFail;
  const log = [];

  // The server: documents with content and a version, in project p1, and
  // the sister project p2's documents, which link the same vocabulary.
  const server = { docs: new Map(), sister: new Map(), next: 0, queue: [] };
  const newContent = () =>
    Array.from({ length: 1 + Math.floor(rand() * 3) }, () => [
      pick(FORMS),
      rand() < 0.8 ? pick(VALUES) : null,
      rand() < 0.6 ? pick(ITEMS) : null,
    ]);
  const addDoc = () => {
    const id = `d${server.next++}`;
    server.docs.set(id, { content: newContent(), version: 1 });
    return id;
  };
  for (let i = 0; i < 4; i++) addDoc();
  for (let i = 0; i < 3; i++) server.sister.set(`s${i}`, { content: newContent(), version: 1 });
  const PROJECTS = { p1: server.docs, p2: server.sister };

  const request = (tab, fn, label) =>
    new Promise((resolve, reject) => server.queue.push({ tab, fn, resolve, reject, label }));

  function clientFor(tab) {
    const client = {
      baseUrl: 'http://core',
      token: tab.token,
      documentVersions: {},
      projects: {
        listDocuments: () =>
          request(
            tab,
            () => [...server.docs].map(([id, d]) => ({ id, version: d.version })),
            'list',
          ),
      },
      // Link rows over every project in the query's scope (every project
      // this login reads when it names none, as the server does), value rows
      // over p1's Gloss layer.
      query: (q) => {
        const links = q.where[0][0] === 'vocab';
        const docId = (links ? q.where[2] : q.where[0])[2].doc;
        return request(
          tab,
          () => {
            const counts = new Map();
            for (const p of q.scope?.projectIds ?? Object.keys(PROJECTS)) {
              if (!links && p !== 'p1') continue;
              for (const [id, d] of PROJECTS[p] || []) {
                if (docId && id !== docId) continue;
                for (const [form, value, item] of d.content) {
                  const k = links
                    ? item && `${item}\u0000${form}`
                    : value && `${form}\u0000${value}`;
                  if (k) counts.set(k, (counts.get(k) || 0) + 1);
                }
              }
            }
            return {
              results: [...counts].map(([k, n]) =>
                links
                  ? [...k.split('\u0000'), null, 'word', 'stem', n]
                  : [...k.split('\u0000'), null, null, n],
              ),
            };
          },
          `${links ? 'links' : 'rows'} ${docId || 'project'}`,
        );
      },
    };
    return client;
  }

  const tabs = [];
  let tabSeq = 0;
  async function newTab(token) {
    vi.resetModules();
    const tab = { name: `T${tabSeq++}`, token, alive: true, open: null, cache: null };
    world.currentTab = tab;
    tab.cache = await import('./precedentCache.js');
    tabs.push(tab);
    return tab;
  }
  // Run a tab's code with the store knowing whose it is.
  const inTab = (tab, fn) => {
    world.currentTab = tab;
    return fn();
  };

  // A document as the editor holds it: read now, with its own client.
  function model(tab, id) {
    const d = server.docs.get(id);
    const m = {
      id,
      raw: { id, version: d.version },
      projectId: 'p1',
      client: clientFor(tab),
      layerInfo,
      vocabularies: VOCABULARIES,
      dataVersion: 0,
      content: structuredClone(d.content),
      sentences: sentencesOf(d.content),
      saving: 0,
      chain: Promise.resolve(),
      get isSaving() {
        return this.saving > 0;
      },
    };
    return m;
  }
  const versionOf = (m) => m.client.documentVersions[m.id] ?? m.raw.version;

  const render = (tab) => {
    if (!tab.open) return;
    inTab(tab, () => tab.cache.openPrecedent(tab.open));
  };

  // An edit: shown at once, sent behind any write in flight, refused (and
  // the document read again) when someone else saved it meanwhile.
  function edit(tab) {
    const m = tab.open;
    if (!m || !server.docs.has(m.id)) return;
    const i = Math.floor(rand() * m.content.length);
    m.content[i] = [m.content[i][0], pick(VALUES), m.content[i][2]];
    m.sentences = sentencesOf(m.content);
    m.dataVersion++;
    m.saving++;
    const snapshot = structuredClone(m.content);
    m.chain = m.chain.then(() =>
      request(
        tab,
        () => {
          const d = server.docs.get(m.id);
          if (!d || d.version !== versionOf(m)) return { refused: true };
          d.content = snapshot;
          d.version++;
          return { version: d.version };
        },
        `save ${m.id}`,
      )
        .then(
          (res) =>
            // The answer comes back on a later step than the save.
            new Promise((resolve) =>
              server.queue.push({ tab, fn: () => res, resolve, reject: resolve }),
            ),
        )
        .then((res) => {
          if (res?.refused) {
            const d = server.docs.get(m.id);
            if (d) {
              m.raw = { id: m.id, version: d.version };
              m.client.documentVersions = { ...m.client.documentVersions, [m.id]: d.version };
              m.content = structuredClone(d.content);
              m.sentences = sentencesOf(m.content);
              m.dataVersion++;
            }
          } else if (res?.version) {
            m.client.documentVersions = { ...m.client.documentVersions, [m.id]: res.version };
          }
          m.saving--;
          render(tab);
        }),
    );
  }

  function leave(tab) {
    if (!tab.open) return;
    const m = tab.open;
    inTab(tab, () => tab.cache.leavePrecedent(m, LEAVE_OPTS));
    tab.open = null;
  }

  function openDoc(tab, id) {
    if (tab.open) leave(tab);
    tab.open = model(tab, id);
    render(tab);
  }

  async function reload(tab, token = tab.token) {
    tab.alive = false;
    tabs.splice(tabs.indexOf(tab), 1);
    // A store operation the old page queued may or may not have run.
    world.storeQueue = world.storeQueue.filter((op) => op.tab !== tab || rand() < 0.5);
    const openId = tab.open?.id;
    const fresh = await newTab(token);
    if (openId && server.docs.has(openId)) openDoc(fresh, openId);
    return fresh;
  }

  const flush = () => new Promise((r) => setTimeout(r, 0));

  async function pumpServer() {
    if (!server.queue.length) return false;
    const i = Math.floor(rand() * server.queue.length);
    const [req] = server.queue.splice(i, 1);
    if (!req.tab.alive) return true;
    world.currentTab = req.tab;
    const out = req.fn();
    log.push(
      `    ${req.tab.name} ${req.label || 'answer'} ${req.label === 'list' ? JSON.stringify(out.map((d) => [d.id, d.version])) : ''}`,
    );
    req.resolve(out);
    await flush();
    return true;
  }
  async function pumpStore() {
    if (!world.storeQueue.length) return false;
    const op = world.storeQueue.shift();
    log.push(`    ${op.tab.name} store ${op.label}`);
    world.currentTab = op.tab;
    op.run();
    await flush();
    return true;
  }
  async function drain() {
    for (let n = 0; n < 5000; n++) {
      await flush();
      const any =
        rand() < 0.5
          ? (await pumpServer()) || (await pumpStore())
          : (await pumpStore()) || (await pumpServer());
      if (!any) {
        await flush();
        if (!server.queue.length && !world.storeQueue.length) return;
      }
    }
    throw new Error('did not settle');
  }

  // Ask whether the project changed, let everything land, and compare.
  async function verify(tab) {
    const m = tab.open;
    if (!m || !server.docs.has(m.id)) return;
    await drain();
    inTab(tab, () => tab.cache.openPrecedent(m, { check: true }));
    await drain();
    for (let n = 0; n < 20; n++) {
      const p = inTab(tab, () => tab.cache.openPrecedent(m));
      if (!p) break;
      await drain();
    }
    const base = tab.cache.precedentBase(m);
    const want = createTally();
    for (const [id, d] of server.docs) {
      if (id !== m.id) foldDocument(want, sentencesOf(d.content), LEAVE_OPTS);
    }
    const got = flat(base);
    const expected = flat(want);
    log.push(
      `  ${tab.name} ${m.id} got ${JSON.stringify([...got])} want ${JSON.stringify([...expected])} model v${versionOf(m)} ${JSON.stringify(m.content)}`,
    );
    const same =
      base && got.size === expected.size && [...got].every(([k, n]) => expected.get(k) === n);
    if (!same) {
      const err = new Error(
        `seed ${seed}: ${tab.name} in ${m.id} counts ${JSON.stringify([...got])}, ` +
          `server says ${JSON.stringify([...expected])}\n${log.join('\n')}`,
      );
      err.log = log;
      throw err;
    }
  }

  return (async () => {
    const first = await newTab('alice');
    openDoc(first, 'd0');
    for (let step = 0; step < steps; step++) {
      const r = rand();
      const tab = pick(tabs);
      const openIds = new Set(tabs.map((t) => t.open?.id).filter(Boolean));
      if (r < 0.25) {
        const busy = rand() < 0.5 ? await pumpServer() : await pumpStore();
        if (!busy) await flush();
        continue;
      }
      if (r < 0.37) {
        log.push(`${tab.name} edit ${tab.open?.id}`);
        edit(tab);
      } else if (r < 0.47) {
        const id = pick([...server.docs.keys()]);
        log.push(`${tab.name} open ${id}`);
        openDoc(tab, id);
      } else if (r < 0.52) {
        log.push(`${tab.name} leave ${tab.open?.id}`);
        leave(tab);
      } else if (r < 0.57) {
        log.push(`${tab.name} reload`);
        await reload(tab);
      } else if (r < 0.6 && tabs.length < 3) {
        const t = await newTab(pick(['alice', 'alice', 'bob']));
        log.push(`new tab ${t.name} ${t.token}`);
        openDoc(t, pick([...server.docs.keys()]));
      } else if (r < 0.64) {
        const id = pick([...server.sister.keys()]);
        const d = server.sister.get(id);
        d.content = newContent();
        d.version++;
        log.push(`someone saves ${id} in the sister project`);
      } else if (r < 0.7) {
        const id = pick([...server.docs.keys()]);
        const d = server.docs.get(id);
        d.content = newContent();
        d.version++;
        log.push(`someone saves ${id} v${d.version}`);
      } else if (r < 0.73) {
        const id = addDoc();
        log.push(`someone creates ${id}`);
      } else if (r < 0.76) {
        const gone = [...server.docs.keys()].filter((id) => !openIds.has(id));
        if (gone.length > 1) {
          const id = pick(gone);
          server.docs.delete(id);
          log.push(`someone deletes ${id}`);
        }
      } else if (r < 0.79) {
        log.push(`${tab.name} signs out`);
        inTab(tab, () => tab.cache.forgetPrecedent());
        // The page leaves once the store has let go, or after a while.
        const next = await reload(tab, tab.token === 'alice' ? 'bob' : 'alice');
        next.open = null;
        openDoc(next, pick([...server.docs.keys()]));
        log.push(`  as ${next.name} ${next.token}`);
      } else if (r < 0.81) {
        // Bulk Edit: saves in several documents, and forgets the counts.
        for (const id of [...server.docs.keys()].filter(() => rand() < 0.5)) {
          const d = server.docs.get(id);
          if (openIds.has(id)) continue;
          d.content = newContent();
          d.version++;
        }
        log.push(`${tab.name} bulk edit`);
        inTab(tab, () => tab.cache.dropPrecedent());
      } else if (r < 0.9) {
        render(tab);
      } else {
        log.push(`${tab.name} verify ${tab.open?.id}`);
        await verify(tab);
      }
    }
    for (const t of [...tabs]) await verify(t);
  })();
}

describe('precedent cache against a recount from scratch', () => {
  const seeds = Number(process.env.PRECEDENT_SEEDS || 8);
  const base = Number(process.env.PRECEDENT_SEED_BASE || 1);
  it(`${seeds} random runs agree after every check`, async () => {
    const failed = [];
    for (let s = base; s < base + seeds; s++) {
      try {
        await run(s);
      } catch (err) {
        if (!process.env.PRECEDENT_COLLECT) throw err;
        failed.push(err.message.split('\n')[0]);
      }
    }
    expect(failed).toEqual([]);
  }, 600_000);

  it('the same with a browser store that fails a quarter of the time', async () => {
    for (let s = base; s < base + Math.ceil(seeds / 2); s++) await run(s, { storeFail: 0.25 });
  }, 600_000);
});
