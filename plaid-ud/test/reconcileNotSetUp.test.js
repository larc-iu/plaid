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

// H33-UD-2: no screen writes in such a project, the Text Editor included. Its
// Clear tokens deleted every sentence by role, and the server took the other
// app's words, morphemes and glosses with them. Every route in is refused at
// the model, before any patch or request.
test('every write to a document of a project not set up for UD is refused', async () => {
  const calls = [];
  const errors = [];
  const doc = new ConlluDocument({
    raw: igtOnly(),
    client: recordingClient(calls),
    project: { id: 'p1', maintainers: ['m@x'], writers: [] },
    user: { id: 'm@x' },
  });
  doc.onError = (message) => errors.push(message);
  const before = JSON.stringify(doc.layerInfo.wordTokenLayer.tokens);
  const sentence = doc.layerInfo.sentenceTokenLayer.tokens[0];
  const word = doc.layerInfo.wordTokenLayer.tokens[0];
  const writes = {
    clearTokens: () => doc.clearTokens(),
    tokenize: () => doc.tokenize('el perro'),
    toggleSentenceBoundary: () => doc.toggleSentenceBoundary(3),
    createWord: () => doc.createWord(0, 2, 'el perro'),
    deleteWord: () => doc.deleteWord(word.id),
    setWordMorphemes: () => doc.setWordMorphemes(word, ['e', 'l']),
    setDocumentMetadata: () => doc.setDocumentMetadata('k', 'v'),
    setSentenceMetadata: () => doc.setSentenceMetadata(sentence.id, 'k', 'v'),
    saveText: () => doc.saveText({ edits: [], base: 'el perro', raw: 'el gato' }),
  };
  for (const [name, write] of Object.entries(writes)) {
    assert.equal(await write(), false, name);
  }
  assert.deepEqual(calls, []);
  assert.equal(JSON.stringify(doc.layerInfo.wordTokenLayer.tokens), before);
  // Each says why. The ones that need the syntactic-word layer were already
  // refused for its absence.
  assert.equal(errors.length, Object.keys(writes).length);
  assert.ok(
    errors.every((m) => /not (fully )?set up/.test(m)),
    errors.join(),
  );
});
