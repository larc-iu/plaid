// Every column of the CoNLL-U export goes through the one flattener, so a
// tab or newline in any stored value can never add a column, a row or a
// sentence to the file.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildConllu } from '../src/domain/conlluSerialize.js';
import { parseCoNLLU } from '../src/utils/conlluParser.js';

const BAD = 'x\ty\r\nz';

const tok = (id, over = {}) => ({
  tokenForm: 'w',
  lemma: { value: 'l' },
  upos: { value: 'NOUN' },
  xpos: null,
  feats: [],
  spanIds: { lemma: 'L' + id },
  word: null,
  ...over,
});

const build = (sentences) =>
  buildConllu({ name: 'd', layerInfo: { isConfigured: true }, sentences });

const sentence = (tokens, over = {}) => ({
  tokens,
  relations: [{ source: 'L1', target: 'L1', value: 'root' }],
  enhancedRelations: [],
  text: 'w',
  sentenceToken: { metadata: {} },
  ...over,
});

function assertShape(out, sentenceCount, rowsPerSentence) {
  const parsed = parseCoNLLU(out);
  assert.equal(parsed.sentences.length, sentenceCount);
  parsed.sentences.forEach((s, i) => assert.equal(s.tokens.length, rowsPerSentence[i]));
  for (const line of out.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    assert.equal(line.split('\t').length, 10, `row has ten columns: ${JSON.stringify(line)}`);
  }
}

test('a stored sent_id with a newline cannot add a sentence', () => {
  const out = build([
    sentence([tok(1)], {
      sentenceToken: {
        metadata: {
          sent_id: 's0\n1\tphantom\tphantom\tVERB\t_\t_\t0\troot\t_\t_\n\n# sent_id = s1',
        },
      },
    }),
  ]);
  assertShape(out, 1, [1]);
});

test('FORM with a tab or newline stays one column', () => {
  assertShape(build([sentence([tok(1, { tokenForm: BAD })])]), 1, [1]);
});

test('FEATS values with a tab or newline stay one column', () => {
  const feats = [{ value: 'Case=Nom\tX' }, { value: 'Number=Sing\nY' }];
  assertShape(build([sentence([tok(1, { feats })])]), 1, [1]);
});

test('the basic DEPREL with a tab or newline stays one column', () => {
  const out = build([
    sentence([tok(1), tok(2)], {
      relations: [
        { source: 'L1', target: 'L1', value: `root${BAD}` },
        { source: 'L1', target: 'L2', value: `obj${BAD}` },
      ],
    }),
  ]);
  assertShape(out, 1, [2]);
});

test('a multi-word token surface with a tab or newline stays one column', () => {
  const word = { id: 'W', metadata: { form: 'w' } };
  const out = build([sentence([tok(1, { word, wordForm: BAD }), tok(2, { word, wordForm: BAD })])]);
  assertShape(out, 1, [2]);
});

// L3-UD-LIVE-2: CoNLL-U ends every sentence with a blank line, the last one
// included, and UD's validator asks for it. Without it, two exported files
// joined with `cat` glued the last word of one to `# newdoc` of the next.
test('every sentence ends with its blank line, and the file with a newline', () => {
  for (const n of [1, 2, 3]) {
    const out = build(Array.from({ length: n }, () => sentence([tok(1)])));
    assert.ok(out.endsWith('\t_\n\n'), JSON.stringify(out.slice(-12)));
    assert.ok(!out.endsWith('\n\n\n'), JSON.stringify(out.slice(-12)));
    assert.equal(out.split('\n\n').length - 1, n, 'one blank line per sentence');
    const joined = out + out;
    assert.equal(parseCoNLLU(joined).sentences.length, 2 * n);
    assert.ok(!/\t_# newdoc/.test(joined));
  }
});
