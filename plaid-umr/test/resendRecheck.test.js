// An edit refused because someone else wrote to the document goes again by
// itself when their write touched nothing it writes (Luke's ruling Q2). Sent
// again, a UMR edge skipped the checks the canvas made when it was drawn: two
// stale edges that shared no node closed a cycle (REV-F-NET D-7). The resend
// now asks the edit's own check again on the document read after the
// refusal (decision D21).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';
import { settledId } from '../../plaid-ui/src/domain/pendingIds.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'umr',
  'english_umr-0001.umr',
);

const conflict = () =>
  Object.assign(new Error('HTTP 409 Document version mismatch'), { status: 409, method: 'POST' });

// A document in strict mode whose first write of `kind` is refused 409, as
// the server refuses a write stamped with a version someone else has moved
// past. The read after it answers `fresh(raw)`.
const load = (fresh) => {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  const plan = planImport(parseUmrFile(text).sentences, []);
  const { client, calls } = recordingClient();
  const raw = rawFromPlan(plan);
  const doc = new UmrDocument({ raw, client });
  client.strictModeDocumentId = doc.id;
  client.documentVersions = { [doc.id]: 1 };
  const create = client.relations.create;
  let refused = false;
  client.relations.create = async (...args) => {
    if (!refused) {
      refused = true;
      calls.push({ name: 'relations.create (refused)', args });
      throw conflict();
    }
    return create(...args);
  };
  client.documents.get = async () => {
    client.documentVersions = { [doc.id]: 2 };
    return fresh(structuredClone(raw), doc);
  };
  const errors = [];
  doc.onError = (msg, err) => errors.push(err);
  const release = doc.hold();
  return { doc, calls, errors, release };
};

// REV-F-NET D-7's shape: existing edges n2 -> a and bp -> n1 in one
// sentence. Another user adds n1 -> n2, and this page, not having read it,
// adds a -> bp. The two new edges share no node, and together they close
// a -> bp -> n1 -> n2 -> a.
function cycleCase(doc, sentenceIndex) {
  const edges = doc
    .sentence(sentenceIndex)
    .edges.filter((e) => e.role === ':ARG0' || e.role === ':ARG1');
  for (const e1 of edges) {
    for (const e2 of edges) {
      const ids = new Set([e1.source, e1.target, e2.source, e2.target]);
      if (ids.size !== 4) continue;
      const [n2, a, bp, n1] = [e1.source, e1.target, e2.source, e2.target];
      if (doc.wouldCycle(n1, n2, ':ARG1') || doc.wouldCycle(a, bp, ':ARG1')) continue;
      return { n1, n2, a, bp };
    }
  }
  throw new Error(`No two edges of four nodes in sentence ${sentenceIndex}`);
}

// Two nodes of one sentence, neither of which reaches the other.
function unrelated(doc, sentenceIndex) {
  const nodes = doc.sentence(sentenceIndex).nodes;
  for (const a of nodes) {
    for (const b of nodes) {
      if (
        a.id !== b.id &&
        !doc.wouldCycle(a.id, b.id, ':ARG1') &&
        !doc.wouldCycle(b.id, a.id, ':ARG1')
      ) {
        return [a, b];
      }
    }
  }
  throw new Error(`No two unrelated nodes in sentence ${sentenceIndex}`);
}

// Another user's edge, as the read after the refusal holds it.
const withEdge = (raw, doc, source, target) => {
  const layer = doc.layerInfo.relationLayer.id;
  const find = (node) => {
    if (node && typeof node === 'object') {
      if (node.id === layer) return node;
      for (const v of Object.values(node)) {
        const hit = find(v);
        if (hit) return hit;
      }
    }
    return null;
  };
  find(raw).relations.push({
    id: 'theirs',
    source,
    target,
    value: ':ARG1',
    metadata: { umr: { order: 9 } },
  });
  return raw;
};

const created = (calls) => calls.filter((c) => c.name === 'relations.create');

test('an edge that would close a cycle with an edge added meanwhile is refused, not sent again', async () => {
  let c;
  const { doc, calls, errors, release } = load((raw, d) => withEdge(raw, d, c.n1, c.n2));
  c = cycleCase(doc, 1);
  const result = await doc.createEdge(c.a, c.bp, ':ARG1');
  assert.equal(result, false);
  assert.equal(created(calls).length, 0, 'the edge was sent once, and refused');
  assert.deepEqual(
    errors.map((e) => e?.status),
    [409],
  );
  release();
});

test('an edge goes again when the edge added meanwhile is elsewhere', async () => {
  let c;
  let d;
  const { doc, calls, errors, release } = load((raw, dd) => withEdge(raw, dd, d.id, c.id));
  const [a, b] = unrelated(doc, 1);
  [c, d] = unrelated(doc, 2);
  const result = await doc.createEdge(a.id, b.id, ':ARG1');
  assert.ok(result, 'the edge was written');
  assert.equal(created(calls).length, 1);
  assert.deepEqual(errors, []);
  release();
});

// A node takes the next free variable of its sentence when it is made. Sent
// again after another user's node took that variable, it would give the
// sentence two nodes of one name.
test('a node whose variable another user took meanwhile is refused, not sent again', async () => {
  let taken = null;
  const { doc, calls, errors, release } = load((raw, d) => {
    const layer = d.layerInfo.conceptLayer.id;
    const find = (node) => {
      if (node && typeof node === 'object') {
        if (node.id === layer) return node;
        for (const v of Object.values(node)) {
          const hit = find(v);
          if (hit) return hit;
        }
      }
      return null;
    };
    // Their node, on the same sentence's first node's anchor.
    const piece = d.sentence(1).nodes[0].pieces[0];
    find(raw).spans.push({
      id: 'theirs',
      tokens: [settledId(piece.id)],
      value: 'thing',
      metadata: { umr: { var: taken } },
    });
    return raw;
  });
  // The first request of an add is its anchor, refused as the edge was.
  const bulk = doc._client.tokens.bulkCreate;
  let refused = false;
  doc._client.tokens.bulkCreate = async (ops) => {
    if (!refused) {
      refused = true;
      throw conflict();
    }
    return bulk(ops);
  };
  const pending = doc.createNode({ sentenceIndex: 1, concept: 'thing' });
  // The variable the add took, read off the node it shows at once.
  taken = doc.layerInfo.conceptLayer.spans.at(-1).metadata.umr.var;
  assert.ok(taken);
  assert.equal(await pending, false);
  assert.equal(calls.filter((c) => c.name === 'spans.create').length, 0, 'not sent again');
  assert.deepEqual(
    errors.map((e) => e?.status),
    [409],
  );
  release();
});

// A rename is checked against every variable in the document when it is
// made. Sent again after another user renamed another node to the same name,
// it gave two nodes one variable (REV-W-RESEND).
test('a rename to a variable another user took meanwhile is refused, not sent again', async () => {
  let theirs = null;
  let mine;
  const { doc, calls, errors, release } = load((raw) => {
    const find = (node) => {
      if (node && typeof node === 'object') {
        if (node.id === theirs.id) return node;
        for (const v of Object.values(node)) {
          const hit = find(v);
          if (hit) return hit;
        }
      }
      return null;
    };
    find(raw).metadata.umr.var = 's1zz';
    return raw;
  });
  [theirs, mine] = doc.sentence(1).nodes.filter((n) => !n.root);
  const patch = doc._client.spans.patchMetadata;
  let refused = false;
  doc._client.spans.patchMetadata = async (...args) => {
    if (!refused) {
      refused = true;
      throw conflict();
    }
    return patch(...args);
  };
  assert.equal(await doc.setVariable(mine.id, 's1zz'), false);
  assert.equal(calls.filter((c) => c.name === 'spans.patchMetadata').length, 0, 'not sent again');
  assert.deepEqual(
    errors.map((e) => e?.status),
    [409],
  );
  release();
});

// Text mode writes the whole sentence. Sent again after another user renamed
// a node of it to the variable the text gives a new node, it gave two nodes
// one variable (REV-W-RESEND).
test('a sentence text sent again after another user changed that sentence is refused', async () => {
  let theirs = null;
  const { doc, calls, errors, release } = load((raw) => {
    const find = (node) => {
      if (node && typeof node === 'object') {
        if (node.id === theirs.id) return node;
        for (const v of Object.values(node)) {
          const hit = find(v);
          if (hit) return hit;
        }
      }
      return null;
    };
    find(raw).metadata.umr.var = 's1zz';
    return raw;
  });
  const root = doc.sentence(1).nodes.find((n) => n.root);
  theirs = doc.sentence(1).nodes.find((n) => !n.root);
  const text = doc
    .penmanOf(1)
    .replace(`(${root.var} / ${root.concept}`, `(${root.var} / ${root.concept} :mod (s1zz / huge)`);
  assert.notEqual(text, doc.penmanOf(1));
  const batched = doc._client.batched;
  let sent = 0;
  doc._client.batched = async (...args) => {
    sent += 1;
    if (sent === 1) throw conflict();
    return batched(...args);
  };
  assert.equal(await doc.applyPenman(1, text), false);
  assert.equal(sent, 1, 'not sent again');
  assert.deepEqual(
    errors.map((e) => e?.status),
    [409],
  );
  void calls;
  release();
});
