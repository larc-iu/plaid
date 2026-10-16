// The Text Editor asks how many tokens Tokenize would add on every render, for
// its "No untokenized text." hint. That is worked out once per data version
// and body, never per render (REV7-APPS-1).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { withOps } from './helpers/stubClient.js';

const INPUT = [
  '# text = del perro .',
  '1\tdel\tde\tADP\t_\t_\t2\tcase\t_\t_',
  '2\tperro\tperro\tNOUN\t_\t_\t0\troot\t_\t_',
  '3\t.\t.\tPUNCT\t_\t_\t2\tpunct\t_\t_',
].join('\n');

test('tokenizeGaps is worked out once per body and data version', () => {
  const doc = new ConlluDocument({ raw: rawDocFromConllu(INPUT, 'memo'), client: withOps({}) });
  let counted = 0;
  const real = doc._countGaps.bind(doc);
  doc._countGaps = (body) => {
    counted += 1;
    return real(body);
  };
  const body = doc.body;
  const first = doc.tokenizeGaps(body);
  for (let i = 0; i < 5; i += 1) assert.equal(doc.tokenizeGaps(body), first);
  assert.equal(counted, 1);
  doc.tokenizeGaps(`${body} x`);
  assert.equal(counted, 2);
});
