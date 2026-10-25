// The import's warnings write a count the way every other count in Plaid is
// written, for the reader's locale (R2-IO-11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';

const RULE = '#'.repeat(80);
const block = (i) =>
  [
    RULE,
    '# meta-info',
    `Index:\t1`,
    `Words:\tw${i}`,
    '',
    '# sentence level graph:',
    '',
    '# alignment:',
    '',
    '# document level annotation:',
    '',
  ].join('\n');

test('1,204 sentences with no graph are counted as 1,204', () => {
  const text = Array.from({ length: 1204 }, (_, i) => block(i + 1)).join('\n');
  const warnings = [];
  planImport(parseUmrFile(text).sentences, warnings);
  assert.ok(
    warnings.includes('1,204 sentences have no graph.'),
    JSON.stringify(warnings.slice(-3)),
  );
});
