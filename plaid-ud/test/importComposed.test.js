// A CoNLL-U file written decomposed is imported composed (NFC), as the server
// stores text: the text, the tokens measured on it and the values.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';

function recordingClient() {
  let n = 0;
  const calls = { texts: [], tokens: [], spans: [] };
  return {
    calls,
    documents: { create: async () => ({ id: 'doc-1' }), delete: async () => {} },
    batched: async (fn) => {
      const queued = [];
      const batch = {
        texts: {
          create: (layer, doc, body) => {
            calls.texts.push(body);
            queued.push([]);
          },
        },
        tokens: { bulkCreate: (ops) => (calls.tokens.push(ops), queued.push(ops)) },
        spans: { bulkCreate: (ops) => (calls.spans.push(ops), queued.push(ops)) },
        relations: { bulkCreate: (ops) => queued.push(ops) },
      };
      await fn(batch);
      return queued.map((ops) => ({ body: { ids: ops.map(() => `id-${n++}`) } }));
    },
  };
}

test('a decomposed file is imported composed, tokens and values', async () => {
  const input = [
    '# text = pʰa\u0301 bo\u0301',
    '1\tpʰa\u0301\tpʰa\u0301\tNOUN\t_\t_\t0\troot\t_\t_',
    '2\tbo\u0301\tbo\u0301\tNOUN\t_\t_\t1\tdep\t_\t_',
  ].join('\n');
  const info = getUdLayerInfo(rawDocFromConllu(input.normalize('NFC'), 'm'));
  const client = recordingClient();
  await ConlluDocument.importFromConllu(client, 'p1', 'm', input, info);
  const body = client.calls.texts[0];
  assert.equal(body, 'pʰá bó');
  const chars = [...body];
  const words = client.calls.tokens
    .flat()
    .filter((t) => t.tokenLayerId === info.wordTokenLayer?.id)
    .map((t) => chars.slice(t.begin, t.end).join(''));
  assert.ok(words.includes('pʰá'), JSON.stringify(words));
  assert.ok(words.includes('bó'), JSON.stringify(words));
  const values = client.calls.spans.flat().map((s) => s.value);
  assert.ok(values.includes('pʰá'));
  assert.ok(!values.some((v) => typeof v === 'string' && v !== v.normalize('NFC')));
});

test('a form that begins with a mark, joined to the one before, composes across the join', async () => {
  // no `# text`: the text is the forms, the first with no space after it
  const input = [
    '1\tpa\tpa\tNOUN\t_\t_\t0\troot\t_\tSpaceAfter=No',
    '2\t́x\t́x\tNOUN\t_\t_\t1\tdep\t_\t_',
  ].join('\n');
  const info = getUdLayerInfo(rawDocFromConllu(input.normalize('NFC'), 'm'));
  const client = recordingClient();
  await ConlluDocument.importFromConllu(client, 'p1', 'm', input, info);
  const body = client.calls.texts[0];
  assert.equal(body.normalize('NFC'), 'p\u00e1x');
  const chars = [...body];
  const words = client.calls.tokens
    .flat()
    .filter((t) => t.tokenLayerId === info.wordTokenLayer?.id)
    .map((t) => chars.slice(t.begin, t.end).join(''));
  // Where the mark goes is the server's composing rule (`composeText`, told
  // the words' edges). Either way the two words hold the text between them
  // and the second keeps its x.
  assert.equal(words.length, 2);
  assert.equal(words.join('').normalize('NFC'), 'p\u00e1x');
  assert.ok(words[1].endsWith('x'), JSON.stringify(words));
});
