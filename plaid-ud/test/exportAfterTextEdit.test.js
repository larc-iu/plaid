// The export after an edit to the text of an imported document says what the
// screen says. A `# text` kept from the import is dropped once a space in the
// sentence has changed (Q2-UD-POLISH-1, H4-UD-4), and a multi-word token is
// written as its text, not as a stored form the edit left behind (H4-UD-5).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { parseCoNLLU } from '../src/utils/conlluParser.js';

const INPUT = [
  '# sent_id = s1',
  '# text = vamos al pueblo del rey.',
  '1\tvamos\tir\tVERB\t_\t_\t0\troot\t_\t_',
  '2-3\tal\t_\t_\t_\t_\t_\t_\t_\t_',
  '2\ta\ta\tADP\t_\t_\t4\tcase\t_\t_',
  '3\tel\tel\tDET\t_\t_\t4\tdet\t_\t_',
  '4\tpueblo\tpueblo\tNOUN\t_\t_\t1\tobl\t_\t_',
  '5-6\tdel\t_\t_\t_\t_\t_\t_\t_\t_',
  '5\tde\tde\tADP\t_\t_\t7\tcase\t_\t_',
  '6\tel\tel\tDET\t_\t_\t7\tdet\t_\t_',
  '7\trey\trey\tNOUN\t_\t_\t4\tnmod\t_\t_',
  '8\t.\t.\tPUNCT\t_\t_\t1\tpunct\t_\t_',
].join('\n');

// What the server leaves after a text save: the body changed at `at` and
// every token after it moved by the difference. `at` is a code point offset
// between tokens, or inside one whose letters are replaced one for one.
function edit(raw, at, remove, insert) {
  const text = raw.textLayers[0].text;
  const cps = [...text.body];
  cps.splice(at, remove, ...insert);
  text.body = cps.join('');
  const shift = [...insert].length - remove;
  for (const layer of raw.textLayers[0].tokenLayers) {
    for (const t of layer.tokens) {
      if (t.begin >= at + remove) t.begin += shift;
      if (t.end > at) t.end += shift;
    }
  }
  return raw;
}

const cpIndex = (raw, s) => {
  const body = raw.textLayers[0].text.body;
  return [...body.slice(0, body.indexOf(s))].length;
};
const exported = (raw) => new ConlluDocument({ raw }).toConllu();
const textLine = (out) => out.split('\n').find((l) => l.startsWith('# text = '));
const row = (out, id) => out.split('\n').find((l) => l.startsWith(`${id}\t`));

test('an import with no edit keeps its own # text', () => {
  const out = exported(rawDocFromConllu(INPUT, 'd'));
  assert.equal(textLine(out), '# text = vamos al pueblo del rey.');
});

test('a space typed before the period reaches the # text line', () => {
  const raw = rawDocFromConllu(INPUT, 'd');
  const at = cpIndex(raw, '.');
  const out = exported(edit(raw, at, 0, ' '));
  assert.equal(textLine(out), '# text = vamos al pueblo del rey .');
  assert.equal(out.split('\n').filter((l) => l.startsWith('# text')).length, 1);
});

test('a space deleted between two words reaches the # text line', () => {
  const raw = rawDocFromConllu(INPUT, 'd');
  const at = cpIndex(raw, ' rey');
  const out = exported(edit(raw, at, 1, ''));
  assert.equal(textLine(out), '# text = vamos al pueblo delrey.');
});

test('a multi-word token whose letters were edited is written as its text', () => {
  const raw = rawDocFromConllu(INPUT, 'd');
  const at = cpIndex(raw, 'del') + 1;
  const out = exported(edit(raw, at, 1, 'u'));
  assert.equal(row(out, '5-6').split('\t')[1], 'dul');
  assert.equal(row(out, '2-3').split('\t')[1], 'al');
  // The file reads back with every token on its own letters.
  const back = rawDocFromConllu(out, 'd2');
  const body = back.textLayers[0].text.body;
  const words = back.textLayers[0].tokenLayers.find((l) => l.config.plaid.role === 'word');
  assert.deepEqual(
    words.tokens.map((t) => [...body].slice(t.begin, t.end).join('')),
    ['vamos', 'al', 'pueblo', 'dul', 'rey', '.'],
  );
  assert.equal(parseCoNLLU(out).sentences.length, 1);
});

test('a token with no space after it is written SpaceAfter=No, read off the text', () => {
  const out = exported(rawDocFromConllu(INPUT, 'd'));
  const misc = (id) => row(out, id).split('\t')[9];
  assert.equal(misc('7'), 'SpaceAfter=No');
  assert.equal(misc('1'), '_');
  assert.equal(misc('8'), '_');
  // On a multi-word token it goes on the bracket row, never on its words.
  const glued = [
    '# text = vamos al.',
    '1\tvamos\tir\tVERB\t_\t_\t0\troot\t_\t_',
    '2-3\tal\t_\t_\t_\t_\t_\t_\t_\t_',
    '2\ta\ta\tADP\t_\t_\t1\tcase\t_\t_',
    '3\tel\tel\tDET\t_\t_\t1\tdet\t_\t_',
    '4\t.\t.\tPUNCT\t_\t_\t1\tpunct\t_\t_',
  ].join('\n');
  const out2 = exported(rawDocFromConllu(glued, 'g'));
  assert.equal(row(out2, '2-3').split('\t')[9], 'SpaceAfter=No');
  assert.equal(row(out2, '2').split('\t')[9], '_');
  assert.equal(row(out2, '3').split('\t')[9], '_');
});

test('an import does not count SpaceAfter=No as a MISC value dropped', () => {
  const parsed = parseCoNLLU(
    [
      '# text = Al-Zaman',
      '1\tAl\t_\t_\t_\t_\t_\t_\t_\tSpaceAfter=No',
      '2\t-\t_\t_\t_\t_\t_\t_\t_\tSpaceAfter=No',
      '3\tZaman\t_\t_\t_\t_\t_\t_\t_\tEntity=X',
    ].join('\n'),
  );
  assert.equal(parsed.dropped.miscTokens, 1);
});

// Review F3: with no `# text`, the text is built from the forms, so
// SpaceAfter=No decides where they are joined, and the file round trips.
test('a file with no # text keeps SpaceAfter=No in the text it builds', () => {
  const file = [
    '1\tHello\thello\tINTJ\t_\t_\t0\troot\t_\tSpaceAfter=No',
    '2\t,\t,\tPUNCT\t_\t_\t1\tpunct\t_\t_',
    '3-4\tdel\t_\t_\t_\t_\t_\t_\t_\tSpaceAfter=No',
    '3\tde\tde\tADP\t_\t_\t5\tcase\t_\t_',
    '4\tel\tel\tDET\t_\t_\t5\tdet\t_\t_',
    '5\tworld\tworld\tNOUN\t_\t_\t1\tvocative\t_\tSpaceAfter=No',
    '6\t!\t!\tPUNCT\t_\t_\t1\tpunct\t_\t_',
  ].join('\n');
  assert.equal(parseCoNLLU(file).dropped.miscTokens, 0);
  const out = exported(rawDocFromConllu(file, 'd'));
  assert.equal(textLine(out), '# text = Hello, delworld!');
  const misc = (id) => row(out, id).split('\t')[9];
  assert.equal(misc('1'), 'SpaceAfter=No');
  assert.equal(misc('2'), '_');
  assert.equal(misc('3-4'), 'SpaceAfter=No');
  assert.equal(misc('5'), 'SpaceAfter=No');
});

// UD sorts FEATS by name case-insensitively: Number before NumType.
test('FEATS are written in UD order, case aside', () => {
  const file = [
    '# text = two',
    '1\ttwo\ttwo\tNUM\t_\tNumType=Card|Number=Plur|abbr=Yes\t0\troot\t_\t_',
  ].join('\n');
  const out = exported(rawDocFromConllu(file, 'd'));
  assert.equal(row(out, '1').split('\t')[5], 'abbr=Yes|Number=Plur|NumType=Card');
});
