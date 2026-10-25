// An import into a closed list is not refused (the server exempts it), so the
// result names the values it let in (Q2-UD-POLISH-8).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { offListWarnings } from '../src/domain/conlluImport.js';
import { parseCoNLLU } from '../src/utils/conlluParser.js';
import { MODES } from '../src/utils/udVocabMode.js';
import { UPOS_TAGS, UNIVERSAL_DEPRELS } from '../src/utils/udVocab.js';

const FILE = [
  '# text = big dog barks',
  '1\tbig\tbig\tADJECTIVE\tJJ\t_\t2\tamod\t_\t_',
  '2\tdog\tdog\tNOUN\tNN\t_\t3\tsubject\t_\t_',
  '3\tbarks\tbark\tADJECTIVE\tVBZ\t_\t0\troot\t_\t_',
].join('\n');

const info = (modes) => ({
  vocab: {
    upos: UPOS_TAGS,
    xpos: ['NN', 'VBZ'],
    deprel: UNIVERSAL_DEPRELS,
    featureInventory: { map: new Map() },
  },
  modes: { upos: MODES.OPEN, xpos: MODES.OPEN, deprel: MODES.OPEN, feats: MODES.OPEN, ...modes },
});

test('open lists say nothing', () => {
  assert.deepEqual(offListWarnings(parseCoNLLU(FILE), info({})), []);
});

test('each closed list names the values outside it, with how many rows', () => {
  const closed = { upos: MODES.CLOSED, xpos: MODES.CLOSED, deprel: MODES.CLOSED };
  assert.deepEqual(offListWarnings(parseCoNLLU(FILE), info(closed)), [
    '2 UPOS values not on the list: ADJECTIVE.',
    '1 XPOS value not on the list: JJ.',
    '1 DEPREL value not on the list: subject.',
  ]);
});

test('a count is written for the reader, as every count in Plaid is', () => {
  const rows = Array.from(
    { length: 1204 },
    (_, i) => `${i + 1}\tw\tw\tADJECTIVE\tNN\t_\t0\troot\t_\t_`,
  );
  const file = ['# text = many', ...rows].join('\n');
  assert.deepEqual(offListWarnings(parseCoNLLU(file), info({ upos: MODES.CLOSED })), [
    '1,204 UPOS values not on the list: ADJECTIVE.',
  ]);
});
