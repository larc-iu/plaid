// H33-UD-3: "Set up for UD" plans from the project as it is when the button
// is pressed, never from the page's copy. A set-up another tab or maintainer
// ran since, or this page's own earlier click whose batch landed before a
// later step failed, made the layers already, and a plan from the old copy
// made a second set of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptSubstrate } from '../src/domain/udProjectSetup.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';

const INPUT = [
  '# text = el perro',
  '1\tel\tel\tDET\t_\t_\t2\tdet\t_\t_',
  '2\tperro\tperro\tNOUN\t_\t_\t0\troot\t_\t_',
].join('\n');

// A project set up for UD, and the same project without its enhanced layer
// (the one layer the Lezgi projects lacked).
const fullProject = () => ({ id: 'p1', textLayers: rawDocFromConllu(INPUT).textLayers });
const withoutEnhanced = () => {
  const project = fullProject();
  for (const tokenLayer of project.textLayers[0].tokenLayers) {
    for (const spanLayer of tokenLayer.spanLayers || []) {
      spanLayer.relationLayers = (spanLayer.relationLayers || []).filter(
        (r) => r.config?.ud?.enhancedDependency !== true,
      );
    }
  }
  return project;
};

// Every call any part of the client gets, by its path. `projects.get`
// answers the project as the server holds it.
const serverClient = (calls, stored) => {
  const at = (path) =>
    new Proxy(() => {}, {
      get: (_t, key) => (key === 'then' ? undefined : at([...path, String(key)])),
      apply: (_t, _this, args) => {
        const name = path.join('.');
        calls.push(name);
        if (name === 'projects.get') return Promise.resolve(stored());
        if (name === 'projects.listDocuments') return Promise.resolve([]);
        const fn = args.find((a) => typeof a === 'function');
        return fn ? fn(at(['batched'])) : Promise.resolve({});
      },
    });
  return at([]);
};

const creates = (calls) => calls.filter((c) => /\.create$/.test(c));

test('the fixture is what it says', () => {
  assert.ok(
    fullProject().textLayers[0].tokenLayers.some((t) =>
      (t.spanLayers || []).some((s) =>
        (s.relationLayers || []).some((r) => r.config?.ud?.enhancedDependency === true),
      ),
    ),
  );
});

test('a set-up from a stale page adds nothing the project has since gained', async () => {
  const calls = [];
  await adoptSubstrate(
    serverClient(calls, () => fullProject()),
    withoutEnhanced(),
  );
  assert.equal(calls[1], 'projects.get', 'reads the project before planning');
  assert.deepEqual(creates(calls), []);
});

test('a set-up adds what the project lacks as it is now', async () => {
  const calls = [];
  await adoptSubstrate(
    serverClient(calls, () => withoutEnhanced()),
    fullProject(),
  );
  assert.deepEqual(creates(calls), ['batched.relationLayers.create']);
});

// The project another app set up: sentences and words, none of UD's layers.
const substrateOnly = () => {
  const project = fullProject();
  const text = project.textLayers[0];
  text.tokenLayers = text.tokenLayers.filter((t) => t.config?.plaid?.role !== 'syntactic-word');
  return project;
};

test('a set-up declares the rules of every layer it makes in the batch that makes them', async () => {
  const calls = [];
  await adoptSubstrate(
    serverClient(calls, () => substrateOnly()),
    substrateOnly(),
  );
  const declared = calls.filter((c) => c.startsWith('batched.') && c.endsWith('.setConstraints'));
  // Syntactic words, Form, Lemma, UPOS, XPOS, and both relation layers: what
  // a failure after the batch would otherwise leave bare for good.
  assert.deepEqual(declared, [
    'batched.tokenLayers.setConstraints',
    'batched.spanLayers.setConstraints',
    'batched.spanLayers.setConstraints',
    'batched.spanLayers.setConstraints',
    'batched.spanLayers.setConstraints',
    'batched.relationLayers.setConstraints',
    'batched.relationLayers.setConstraints',
  ]);
});

// R3a (2026-10-24): a set-up makes every word's missing UD word, with its
// lemma copied from its form, in batches after the one making its layers, since Grew search,
// Rewrite and the Words count read stored words. An open after it writes
// nothing.

// A document as another app left it: words, and of UD's words only those
// whose text is in `keep`, with their spans.
const substrateDoc = (keep = []) => {
  const raw = rawDocFromConllu(INPUT, 'd1');
  const text = raw.textLayers[0];
  const body = [...text.text.body];
  const words = text.tokenLayers.find((l) => l.config?.plaid?.role === 'syntactic-word');
  words.tokens = words.tokens.filter((t) => keep.includes(body.slice(t.begin, t.end).join('')));
  const kept = new Set(words.tokens.map((t) => t.id));
  for (const layer of words.spanLayers) {
    layer.spans = (layer.spans || []).filter((sp) => sp.tokens.every((t) => kept.has(t)));
    for (const rel of layer.relationLayers || []) rel.relations = [];
  }
  return raw;
};

// A client holding `project` and `docs`, recording every batch as its ops.
const adoptClient = (project, docs) => {
  const batches = [];
  const read = [];
  const queue = (ops) =>
    new Proxy(
      {},
      {
        get: (_t, resource) =>
          new Proxy(
            {},
            {
              get:
                (_u, method) =>
                (...args) => {
                  ops.push({ op: `${String(resource)}.${String(method)}`, args });
                },
            },
          ),
      },
    );
  const layers = { checkConstraints: async () => ({ violations: [] }) };
  const client = {
    withOperation: async (_label, fn) => fn(() => {}),
    tokenLayers: layers,
    spanLayers: layers,
    relationLayers: layers,
    projects: {
      get: async () => structuredClone(project),
      listDocuments: async () => docs.map((d) => ({ id: d.id })),
    },
    documents: {
      get: async (id) => {
        read.push(id);
        return structuredClone(docs.find((d) => d.id === id));
      },
    },
    batched: async (fn) => {
      const ops = [];
      await fn(queue(ops));
      batches.push(ops);
      return ops.map(() => ({}));
    },
  };
  return { client, batches, read };
};

const opsNamed = (batches, name) => batches.flat().filter((o) => o.op === name);

// The document as the server holds it after the set-up: `doc` with the rows
// the set-up's batch made put on UD's word and lemma layers.
const afterSetUp = (doc, batches) => {
  const raw = structuredClone(doc);
  const words = raw.textLayers[0].tokenLayers.find(
    (l) => l.config?.plaid?.role === 'syntactic-word',
  );
  const lemmas = words.spanLayers.find((l) => l.config?.ud?.lemma);
  for (const { args } of opsNamed(batches, 'tokens.bulkCreate')) {
    words.tokens.push(
      ...args[0].map(({ id, begin, end, precedence }) => ({ id, begin, end, precedence })),
    );
  }
  for (const { args } of opsNamed(batches, 'spans.bulkCreate')) {
    lemmas.spans.push(
      ...args[0].map(({ id, tokens, value, metadata }) => ({ id, tokens, value, metadata })),
    );
  }
  return raw;
};

test("a set-up makes every word's missing UD word and its lemma after its layers, and an open after it writes nothing", async () => {
  const doc = substrateDoc();
  const { client, batches } = adoptClient(substrateOnly(), [doc]);
  await adoptSubstrate(client, substrateOnly());

  const made = opsNamed(batches, 'tokens.bulkCreate');
  assert.equal(made.length, 1, 'one create of words');
  const layerBatch = batches.find((ops) => ops.some((o) => o.op === 'tokenLayers.create'));
  assert.equal(batches.indexOf(layerBatch), 0, "UD's layers first");
  assert.ok(batches[1].includes(made[0]), 'the words in the batch after them');
  const wordLayerMade = layerBatch.find(
    (o) => o.op === 'tokenLayers.create' && o.args[1] === 'Words',
  );
  const rows = made[0].args[0];
  assert.deepEqual(
    rows.map((r) => [r.tokenLayerId, r.text, r.begin, r.end, r.precedence]),
    [
      [wordLayerMade.args[5].id, 'text-1', 0, 2, 0],
      [wordLayerMade.args[5].id, 'text-1', 3, 8, 0],
    ],
  );
  const lemmas = opsNamed(batches, 'spans.bulkCreate');
  assert.equal(lemmas.length, 1);
  assert.deepEqual(
    lemmas[0].args[0].map((sp) => [sp.tokens, sp.value, sp.metadata?.prov]),
    [
      [[rows[0].id], 'el', 'inferred'],
      [[rows[1].id], 'perro', 'inferred'],
    ],
  );

  // The document opened after it shows every word as stored and writes nothing.
  const { ConlluDocument } = await import('../src/domain/ConlluDocument.js');
  const sent = [];
  const opened = new ConlluDocument({
    raw: afterSetUp(doc, batches),
    client: new Proxy(
      {},
      {
        get:
          (_t, k) =>
          (...a) =>
            sent.push([k, a]),
      },
    ),
  });
  const entries = opened.sentences.flatMap((s) => s.tokens);
  assert.deepEqual(
    entries.map((e) => [e.virtual === true, e.tokenForm, e.lemma?.value]),
    [
      [false, 'el', 'el'],
      [false, 'perro', 'perro'],
    ],
  );
  assert.deepEqual(sent, []);

  // Grew reads the words made: a search for a lemma finds its word.
  const { graphFromSentence } = await import('../src/grew/rewrite/graph.js');
  const { findMatches } = await import('../src/grew/rewrite/match.js');
  const { parse } = await import('../src/grew/parser.js');
  const graph = graphFromSentence(opened.sentences[0]);
  const found = findMatches(parse('pattern { X [lemma="perro"] }'), graph);
  assert.equal(found.length, 1);
  assert.equal(graph.nodes.get(found[0].nodes.get('X')).form, 'perro');
});

test('a set-up makes only the UD words a document lacks, and none where it lacks none', async () => {
  const partial = substrateDoc(['el']);
  const full = { ...rawDocFromConllu(INPUT, 'full') };
  const { client, batches } = adoptClient(fullProject(), [partial, full]);
  await adoptSubstrate(client, fullProject());
  const made = opsNamed(batches, 'tokens.bulkCreate');
  assert.equal(made.length, 1);
  assert.deepEqual(
    made[0].args[0].map((r) => [r.tokenLayerId, r.begin, r.end]),
    [['morpheme-layer', 3, 8]],
  );
  const lemmas = opsNamed(batches, 'spans.bulkCreate');
  assert.deepEqual(
    lemmas.map((o) => o.args[0].map((sp) => [sp.spanLayerId, sp.value])),
    [[['lemma-layer', 'perro']]],
  );
});

test('a set-up of a project with no words reads no document', async () => {
  const project = substrateOnly();
  project.textLayers[0].tokenLayers = project.textLayers[0].tokenLayers.filter(
    (t) => t.config?.plaid?.role === 'sentence',
  );
  const { client, read } = adoptClient(project, [substrateDoc()]);
  await adoptSubstrate(client, project);
  assert.deepEqual(read, []);
});

// REV-W2B-OPENS H1: a project whose documents lack more UD words than fit in
// one request body is still set up. The layers go first, in a batch of their
// own, and the words follow in batches well under the core's body cap (10 MB
// by default) and op cap (1000), all under the set-up's one operation.
test('a set-up of a project lacking 30k UD words sends them in batches well under the body cap, after the layers', async () => {
  // A document of `count` words and one sentence over them, built by hand
  // (the CoNLL-U fixture builder is slow at this size), with no UD word.
  const big = (id, count) => {
    const raw = substrateDoc();
    raw.id = id;
    const layer = raw.textLayers[0];
    const forms = Array.from({ length: count }, (_, i) => `palabra${id}x${i}`);
    layer.text = { ...layer.text, id: `text-${id}`, body: forms.join(' ') };
    let at = 0;
    const tokens = forms.map((form, i) => {
      const token = { id: `${id}-w${i}`, begin: at, end: at + form.length, precedence: 0 };
      at += form.length + 1;
      return token;
    });
    for (const tl of layer.tokenLayers) {
      const role = tl.config?.plaid?.role;
      if (role === 'word') tl.tokens = tokens;
      if (role === 'sentence') tl.tokens = [{ id: `${id}-s`, begin: 0, end: at - 1 }];
    }
    return raw;
  };
  const docs = [big('d1', 25000), big('d2', 5000)];
  const { client, batches } = adoptClient(substrateOnly(), docs);
  let open = 0;
  const inOperation = [];
  const batched = client.batched;
  client.batched = async (fn) => {
    inOperation.push(open > 0);
    return batched(fn);
  };
  client.withOperation = async (_label, fn) => {
    open++;
    try {
      return await fn(() => {});
    } finally {
      open--;
    }
  };
  await adoptSubstrate(client, substrateOnly());

  const MB = 1024 * 1024;
  for (const ops of batches) {
    const body = Buffer.byteLength(JSON.stringify(ops.map((o) => [o.op, o.args])));
    assert.ok(body < 4 * MB, `a batch body of ${body} bytes`);
    assert.ok(ops.length <= 500, `a batch of ${ops.length} ops`);
  }
  assert.ok(inOperation.length > 2 && inOperation.every(Boolean), 'every batch in the operation');
  assert.ok(
    batches[0].some((o) => o.op === 'tokenLayers.create'),
    'the layers first',
  );
  assert.ok(!batches[0].some((o) => o.op === 'tokens.bulkCreate'), 'no word with the layers');
  const words = opsNamed(batches, 'tokens.bulkCreate').flatMap((o) => o.args[0]);
  const lemmas = opsNamed(batches, 'spans.bulkCreate').flatMap((o) => o.args[0]);
  assert.equal(words.length, 30000);
  assert.equal(new Set(words.map((w) => `${w.text}:${w.begin}`)).size, 30000);
  assert.deepEqual(
    lemmas.map((l) => l.tokens[0]),
    words.map((w) => w.id),
  );
});
