// A document of a project that is not set up for UD, reached by a link
// straight to it: opening it writes nothing (H9-FIRST-OPEN-1). The back-fills
// once declared `splitOnSpace` on the shared word layer of an igt project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';

const INPUT = [
  '# text = el perro',
  '1\tel\tel\tDET\t_\t_\t2\tdet\t_\t_',
  '2\tperro\tperro\tNOUN\t_\t_\t0\troot\t_\t_',
].join('\n');

// Every call any part of the client gets, by its path.
const recordingClient = (calls) => {
  const at = (path) =>
    new Proxy(() => {}, {
      get: (_t, key) => (key === 'then' ? undefined : at([...path, String(key)])),
      apply: (_t, _this, args) => {
        calls.push(path.join('.'));
        const fn = args.find((a) => typeof a === 'function');
        return fn ? fn(() => {}) : Promise.resolve({});
      },
    });
  return at([]);
};

// The igt shape: text, sentences and words, no syntactic words under them.
const igtOnly = () => {
  const raw = rawDocFromConllu(INPUT, 'd1');
  raw.textLayers[0].tokenLayers = raw.textLayers[0].tokenLayers.filter(
    (l) => l.config?.plaid?.role !== 'syntactic-word',
  );
  return raw;
};

test("a maintainer's open of a document in a project not set up for UD writes nothing", async () => {
  const calls = [];
  const doc = new ConlluDocument({
    raw: igtOnly(),
    client: recordingClient(calls),
    project: { id: 'p1', maintainers: ['m@x'], writers: [] },
    user: { id: 'm@x' },
  });
  assert.equal(doc.layerInfo.isConfigured, false);
  assert.ok(doc.layerInfo.wordTokenLayer, 'the word layer the back-fill wrote to is there');
  const result = await doc.reconcileOnOpen();
  assert.deepEqual(result.findings, []);
  assert.equal(result.error, undefined);
  assert.deepEqual(
    calls.filter((c) => c !== 'withOperation'),
    [],
  );
});
