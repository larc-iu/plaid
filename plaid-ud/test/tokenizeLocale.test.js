// H3-7-4: a tokenizer locale or project language the browser's segmenter
// cannot read (`en_US`) made Tokenize throw inside the segmenter, so the
// dialog closed and nothing happened. Any tag may be stored (REV-U3-1: umr
// and igt projects use private-use tags and Glottocodes). The segmenter runs
// with the language-neutral locale for one it cannot read, and the tag stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { withOps } from './helpers/stubClient.js';

const INPUT = [
  '# text = the dog',
  '1\tthe\tthe\tDET\t_\t_\t2\tdet\t_\t_',
  '2\tdog\tdog\tNOUN\t_\t_\t0\troot\t_\t_',
].join('\n');

// A client that records each write it is sent and accepts it.
const recordingClient = (calls) => {
  let n = 0;
  const record = (name, answer) =>
    new Proxy(
      {},
      {
        get:
          (_t, method) =>
          async (...args) => {
            calls.push({ path: `${name}.${String(method)}`, args });
            return answer(args);
          },
      },
    );
  const ids = ([rows]) => ({ ids: rows.map(() => `id-${n++}`) });
  return withOps({
    tokens: record('tokens', ids),
    spans: record('spans', ids),
    textLayers: record('textLayers', () => ({})),
    projects: record('projects', () => ({})),
  });
};

// The document's text with no tokens on it, in a project whose language is
// `tag`, or with `tag` as the text layer's tokenizer locale.
const untokenized = (tag, where) => {
  const raw = rawDocFromConllu(INPUT, 'd1');
  for (const layer of raw.textLayers[0].tokenLayers) layer.tokens = [];
  if (where === 'locale') raw.textLayers[0].config.ud = { tokenizerLocale: tag };
  const calls = [];
  const errors = [];
  const doc = new ConlluDocument({
    raw,
    client: recordingClient(calls),
    project: {
      id: 'p1',
      maintainers: ['m@x'],
      writers: [],
      config: where === 'locale' ? {} : { ud: { language: tag } },
    },
    user: { id: 'm@x' },
  });
  doc.onError = (message) => errors.push(message);
  return { doc, calls, errors, body: raw.textLayers[0].text.body };
};

for (const where of ['language', 'locale']) {
  for (const tag of ['x-kukama', 'stan1293', 'en_US', 'zh-yue', '', 'en-US']) {
    test(`Tokenize with the ${where} ${JSON.stringify(tag)} makes the two words`, async () => {
      const { doc, calls, errors, body } = untokenized(tag, where);
      assert.equal(doc.tokenizeGaps(body), 2);
      assert.equal(await doc.tokenize(body), true);
      assert.deepEqual(errors, []);
      // The two words and their lemmas are written, and the stored tag is not touched.
      assert.deepEqual(
        calls.map((c) => c.path),
        ['tokens.bulkCreate', 'tokens.bulkCreate', 'tokens.bulkCreate', 'spans.bulkCreate'],
      );
      assert.equal(calls[1].args[0].length, 2);
    });
  }
}
