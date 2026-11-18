// H3-7-4: a tokenizer locale or project language typed as `en_US` (not a
// BCP-47 tag) made Tokenize throw inside the segmenter, so the dialog closed
// and nothing happened. Tokenize says why instead, and the count the Text
// Editor reads on every render does not throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';

const INPUT = [
  '# text = the dog',
  '1\tthe\tthe\tDET\t_\t_\t2\tdet\t_\t_',
  '2\tdog\tdog\tNOUN\t_\t_\t0\troot\t_\t_',
].join('\n');

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

// The document's text with no tokens on it, in a project whose language is `tag`.
const untokenized = (tag) => {
  const raw = rawDocFromConllu(INPUT, 'd1');
  for (const layer of raw.textLayers[0].tokenLayers) layer.tokens = [];
  const calls = [];
  const errors = [];
  const doc = new ConlluDocument({
    raw,
    client: recordingClient(calls),
    project: { id: 'p1', maintainers: ['m@x'], writers: [], config: { ud: { language: tag } } },
    user: { id: 'm@x' },
  });
  doc.onError = (message) => errors.push(message);
  return { doc, calls, errors, body: raw.textLayers[0].text.body };
};

test('Tokenize with a locale that is not a language tag says so and writes nothing', async () => {
  const { doc, calls, errors, body } = untokenized('en_US');
  assert.equal(await doc.tokenize(body), false);
  assert.deepEqual(errors, ['The tokenizer locale "en_US" is not a BCP-47 language tag.']);
  assert.deepEqual(
    calls.filter((c) => c !== 'withOperation'),
    [],
  );
  assert.equal(doc.tokenizeGaps(body), null);
});

test('the same with a language tag tokenizes', async () => {
  const { doc, errors, body } = untokenized('en-US');
  assert.equal(doc.tokenizeGaps(body), 2);
  assert.deepEqual(errors, []);
});
