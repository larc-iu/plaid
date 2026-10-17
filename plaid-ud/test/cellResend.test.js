// A grid value refused because someone else saved in the same document goes
// again by itself when what they saved touches nothing it writes (a value on
// another word), as igt's glosses do (Luke, H17-UD-3). A value on the same
// word is still refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { withOps } from './helpers/stubClient.js';

console.error = () => {};

const INPUT = [
  '# text = she came home',
  '1\tshe\tshe\tPRON\t_\t_\t2\tnsubj\t_\t_',
  '2\tcame\tcome\tVERB\t_\t_\t0\troot\t_\t_',
  '3\thome\thome\tNOUN\t_\t_\t2\tobj\t_\t_',
].join('\n');

const xposOf = (raw) =>
  raw.textLayers[0].tokenLayers[2].spanLayers.find((l) => l.id === 'xpos-layer').spans;

// A server holding the document at a version. A write made on an older one
// is refused 409, as plaid-core does. `elsewhere(word, value)` is another
// user's XPOS stored on the n-th syntactic word.
function server() {
  const raw = rawDocFromConllu(INPUT, 'd');
  const morphemes = raw.textLayers[0].tokenLayers[2].tokens.map((t) => t.id);
  const state = { raw, version: 1, creates: 0, n: 0 };
  const client = withOps({
    strictModeDocumentId: raw.id,
    documentVersions: { [raw.id]: 1 },
    documents: {
      get: async () => {
        client.documentVersions = { [raw.id]: state.version };
        return structuredClone(state.raw);
      },
    },
    spans: {
      create: async (layer, tokens, value, metadata, _, { id } = {}) => {
        state.creates += 1;
        if (client.documentVersions[raw.id] !== state.version) {
          throw Object.assign(new Error('HTTP 409 Document version mismatch'), { status: 409 });
        }
        const made = { id: id ?? `s${++state.n}`, tokens, value };
        xposOf(state.raw).push(made);
        state.version += 1;
        client.documentVersions = { [raw.id]: state.version };
        return made;
      },
    },
  });
  client.withOperation = async (message, fn) => fn(() => {});
  const elsewhere = (word, value) => {
    xposOf(state.raw).push({ id: `x${++state.n}`, tokens: [morphemes[word]], value });
    state.version += 1;
  };
  const doc = new ConlluDocument({ raw: structuredClone(raw), client });
  return { doc, state, elsewhere, morphemes };
}

test("a value on one word goes again past another user's value on another word", async () => {
  const { doc, state, elsewhere, morphemes } = server();
  elsewhere(0, 'PRP');
  const answer = await doc.cellWrite(() => doc.updateAnnotation(morphemes[1], 'xpos', 'VBD'), {
    engine: true,
  });
  assert.equal(answer.landed, true);
  assert.equal(state.creates, 2);
  assert.deepEqual(
    xposOf(state.raw)
      .map((s) => s.value)
      .sort(),
    ['PRP', 'VBD'],
  );
});

test('a value on a word another user gave a value meanwhile is refused', async () => {
  const { doc, state, elsewhere, morphemes } = server();
  elsewhere(1, 'VBZ');
  const answer = await doc.cellWrite(() => doc.updateAnnotation(morphemes[1], 'xpos', 'VBD'), {
    engine: true,
  });
  assert.equal(answer.landed, false);
  assert.equal(answer.status, 409);
  assert.equal(state.creates, 1);
  assert.deepEqual(
    xposOf(state.raw).map((s) => s.value),
    ['VBZ'],
  );
});
