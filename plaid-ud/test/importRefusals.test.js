// What a CoNLL-U import refuses, and says it refused.
//
// H33-UD polish: a HEAD past the sentence's last row dropped that row's
// relation in silence, and a HEAD naming the row itself was imported as a
// root (and exported as `0`). Both are now dropped with a warning, as a DEPS
// head that is no row of the sentence already was.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { importErrorText } from '../src/domain/conlluImport.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';

const conllu = (lines) => lines.join('\n');

// Records the relations the importer writes, and hands back ids.
function recordingClient() {
  let n = 0;
  const relations = [];
  return {
    // The import is one operation (conlluImport.js).
    withOperation: (_label, fn) => fn(() => {}),
    relations,
    documents: {
      create: async () => ({ id: 'doc-1' }),
      get: async () => {
        throw new Error('the layer info is precomputed');
      },
      delete: async () => {},
    },
    batched: async (fn) => {
      const queued = [];
      const queue = (kind, ops) => queued.push({ kind, ops });
      await fn({
        texts: { create: () => queued.push({ kind: 'texts', ops: [] }) },
        tokens: { bulkCreate: (ops) => queue('tokens', ops) },
        spans: { bulkCreate: (ops) => queue('spans', ops) },
        relations: {
          bulkCreate: (ops) => {
            relations.push(...ops);
            queue('relations', ops);
          },
        },
      });
      return queued.map(({ kind, ops }) => ({ body: { ids: ops.map(() => `${kind}-${n++}`) } }));
    },
  };
}

const importOf = async (lines, options = {}) => {
  const input = conllu(lines);
  const info = getUdLayerInfo(rawDocFromConllu(input, 'm', options));
  const client = recordingClient();
  const out = await ConlluDocument.importFromConllu(client, 'p1', 'm', input, info);
  const basic = client.relations.filter((op) => op.relationLayerId === info.relationLayer.id);
  const enhanced = client.relations.filter(
    (op) => op.relationLayerId === info.enhancedRelationLayer?.id,
  );
  return { warnings: out.importWarnings, basic, enhanced };
};

test('a HEAD past the last row is dropped aloud', async () => {
  const { warnings, basic } = await importOf([
    '# text = a b c',
    '1\ta\t_\tX\t_\t_\t0\troot\t_\t_',
    '2\tb\t_\tX\t_\t_\t9\tdep\t_\t_',
    '3\tc\t_\tX\t_\t_\t1\tdep\t_\t_',
  ]);
  assert.deepEqual(warnings, [
    '1 dependency relation dropped: the head is not a row of the sentence.',
  ]);
  assert.equal(basic.length, 2);
});

test('a HEAD naming its own row is dropped aloud, not imported as a root', async () => {
  const { warnings, basic } = await importOf([
    '# text = a b c',
    '1\ta\t_\tX\t_\t_\t0\troot\t_\t_',
    '2\tb\t_\tX\t_\t_\t2\tdep\t_\t_',
    '3\tc\t_\tX\t_\t_\t3\tdep\t_\t_',
  ]);
  assert.deepEqual(warnings, ['2 dependency relations dropped: the head is the word itself.']);
  // Only the real root is a relation from a word to itself.
  assert.equal(basic.length, 1);
  assert.equal(basic[0].value, 'root');
});

test('a DEPS head naming its own row is dropped aloud, not imported as a root', async () => {
  const { warnings, enhanced } = await importOf(
    [
      '# text = a b',
      '1\ta\t_\tX\t_\t_\t0\troot\t0:root\t_',
      '2\tb\t_\tX\t_\t_\t1\tdep\t1:dep|2:nsubj\t_',
    ],
    { enhanced: true },
  );
  assert.deepEqual(warnings, ['1 enhanced dependency dropped: the head is the word itself.']);
  assert.deepEqual(enhanced, []);
});

test('a file with both faults says each once', async () => {
  const { warnings } = await importOf(
    [
      '# text = a b c',
      '1\ta\t_\tX\t_\t_\t0\troot\t0:root\t_',
      '2\tb\t_\tX\t_\t_\t7\tdep\t7:dep\t_',
      '3\tc\t_\tX\t_\t_\t3\tdep\t3:dep\t_',
    ],
    { enhanced: true },
  );
  assert.deepEqual(warnings, [
    '1 dependency relation dropped: the head is not a row of the sentence.',
    '1 dependency relation dropped: the head is the word itself.',
  ]);
});

// A HEAD of `_` names no head. Read as `0`, it made the row a root.
test('a HEAD of _ beside a DEPREL is dropped aloud, not imported as a root', async () => {
  const { warnings, basic, enhanced } = await importOf(
    [
      '# text = a b c',
      '1\ta\t_\tX\t_\t_\t0\troot\t0:root\t_',
      '2\tb\t_\tX\t_\t_\t_\tdep\t1:dep\t_',
      '3\tc\t_\tX\t_\t_\t_\t_\t_\t_',
    ],
    { enhanced: true },
  );
  assert.deepEqual(warnings, ['1 dependency relation dropped: no head is given.']);
  assert.equal(basic.length, 1);
  assert.equal(basic[0].value, 'root');
  // DEPS still states its own edge, which the tree no longer has.
  assert.deepEqual(
    enhanced.map((op) => op.value),
    ['dep'],
  );
});

test('an unannotated file, HEAD and DEPREL both _, says nothing', async () => {
  const { warnings, basic } = await importOf([
    '# text = a b',
    '1\ta\t_\t_\t_\t_\t_\t_\t_\t_',
    '2\tb\t_\t_\t_\t_\t_\t_\t_\t_',
  ]);
  assert.deepEqual(warnings, []);
  assert.deepEqual(basic, []);
});

// H33-UD polish: a file over the server's cap on a request read "too large
// to save in one request", which is not what the person did.
test('an import refused as too large says so in the words of an import', async () => {
  const input = conllu(['# text = a', '1\ta\t_\tX\t_\t_\t0\troot\t_\t_']);
  const info = getUdLayerInfo(rawDocFromConllu(input, 'm'));
  const tooLarge = () => Object.assign(new Error('HTTP 413 Payload Too Large'), { status: 413 });
  const said = 'This file is too large to import. Split it into shorter documents.';

  const deleted = [];
  const client = {
    // The import is one operation (conlluImport.js).
    withOperation: (_label, fn) => fn(() => {}),
    ...recordingClient(),
    batched: async () => {
      throw tooLarge();
    },
  };
  client.documents.delete = async (id) => deleted.push(id);
  const err = await ConlluDocument.importFromConllu(client, 'p1', 'm', input, info).then(
    () => null,
    (e) => e,
  );
  assert.equal(err.status, 413);
  assert.equal(importErrorText(err), said);
  assert.deepEqual(deleted, ['doc-1']);

  // The partial document could not be deleted either: the same words first.
  client.documents.delete = async () => {
    throw new Error('HTTP 500');
  };
  const err2 = await ConlluDocument.importFromConllu(client, 'p1', 'm', input, info).then(
    () => null,
    (e) => e,
  );
  assert.equal(
    importErrorText(err2),
    `${said} The partial document “m” was not deleted. Delete it by hand.`,
  );
});

// H3-5-1: a sentence's comments are one value per name, and a second
// `# comment = ...` overwrote the first in silence. The first line of each
// name is kept and every repeat is counted.
test('repeated comment lines are dropped aloud, and the first of each is kept', async () => {
  const input = conllu([
    '# sent_id = rc-1',
    '# text = один',
    '# comment = checked by A',
    '# comment = checked by B',
    '# not sure about the lemma',
    '# not sure about the lemma',
    '1\tодин\tодин\tNUM\t_\t_\t0\troot\t_\t_',
  ]);
  const info = getUdLayerInfo(rawDocFromConllu(input, 'm'));
  const sentences = [];
  const client = recordingClient();
  const batched = client.batched;
  client.batched = (fn) =>
    batched((b) =>
      fn({
        ...b,
        tokens: {
          bulkCreate: (ops) => {
            sentences.push(...ops.filter((op) => op.tokenLayerId === info.sentenceTokenLayer.id));
            return b.tokens.bulkCreate(ops);
          },
        },
      }),
    );
  const out = await ConlluDocument.importFromConllu(client, 'p1', 'm', input, info);
  assert.deepEqual(out.importWarnings, [
    '2 repeated comment lines dropped: Plaid UD stores one comment line of each name per sentence.',
  ]);
  assert.equal(sentences[0].metadata.comment, 'checked by A');
  assert.equal(sentences[0].metadata['not sure about the lemma'], true);
});

// H3-5-2: an unlabelled tree (HEADs with DEPREL `_`) was dropped whole in
// silence, while a DEPREL with no HEAD was counted.
test('a HEAD beside a DEPREL of _ is dropped aloud', async () => {
  const { warnings, basic } = await importOf([
    '# sent_id = u-1',
    '# text = the dog barked',
    '1\tthe\t_\tDET\t_\t_\t2\t_\t_\t_',
    '2\tdog\t_\tNOUN\t_\t_\t3\t_\t_\t_',
    '3\tbarked\t_\tVERB\t_\t_\t0\t_\t_\t_',
  ]);
  assert.deepEqual(warnings, ['3 HEAD values dropped: no DEPREL is given.']);
  assert.deepEqual(basic, []);
});
