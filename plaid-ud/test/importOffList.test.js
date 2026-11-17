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

// H17-2: the DEPS column's labels are held to the same list as DEPREL, so a
// closed list names the ones the file writes outside it.
test('a closed relation list names DEPS labels outside it', () => {
  const file = [
    '# text = She came and left',
    '1\tShe\tshe\tPRON\t_\t_\t2\tnsubj\t2:nsubj|4:wrongenh\t_',
    '2\tcame\tcome\tVERB\t_\t_\t0\troot\t0:root\t_',
    '3\tand\tand\tCCONJ\t_\t_\t4\tcc\t4:cc\t_',
    '4\tleft\tleave\tVERB\t_\t_\t2\twrongbasic\t2:conj:and\t_',
  ].join('\n');
  assert.deepEqual(offListWarnings(parseCoNLLU(file), info({ deprel: MODES.CLOSED })), [
    '1 DEPREL value not on the list: wrongbasic.',
    '1 DEPS value not on the list: wrongenh.',
  ]);
});

// REV-HFU-7: DEPS repeats each basic edge, which the enhanced layer does not
// store again, so a DEPREL label off the list is counted once, as Validation
// counts it.
test('a DEPS edge repeating its row’s own head and relation is not counted again', () => {
  const file = [
    '# text = She left',
    '1\tShe\tshe\tPRON\t_\t_\t2\tfoo\t2:foo\t_',
    '2\tleft\tleave\tVERB\t_\t_\t0\troot\t0:root\t_',
  ].join('\n');
  assert.deepEqual(offListWarnings(parseCoNLLU(file), info({ deprel: MODES.CLOSED })), [
    '1 DEPREL value not on the list: foo.',
  ]);
});
