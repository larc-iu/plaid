// Exemplar round-trip test: CoNLL-U in → (parse → hierarchy → materialized
// document, via test/helpers/rawDoc.js, which mirrors importFromConllu's
// writes) → ConlluDocument.toConllu() out. Run with `npm test`.
//
// Note the EXPECTED text is not byte-identical to the INPUT — the exporter has
// deliberate conventions: it emits `# newdoc id` from the document name,
// synthesizes `# sent_id` (the parser drops incoming ones), and fills DEPS
// with `head:deprel`. Everything annotation-bearing must survive: the MWT
// bracket line with its surface form, per-row LEMMA/UPOS/XPOS/FEATS, heads
// and deprels (root encoded as a Lemma-span self-loop).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';

const conllu = (lines) => lines.join('\n');

const INPUT = conllu([
  '# text = del perro',
  '1-2\tdel\t_\t_\t_\t_\t_\t_\t_\t_',
  '1\tde\tde\tADP\t_\t_\t3\tcase\t_\t_',
  '2\tel\tel\tDET\t_\tDefinite=Def|PronType=Art\t3\tdet\t_\t_',
  '3\tperro\tperro\tNOUN\tNN\tGender=Masc|Number=Sing\t0\troot\t_\t_',
]);

const EXPECTED = conllu([
  '# newdoc id = rt-doc',
  '# sent_id = rt-doc-1',
  '# text = del perro',
  '1-2\tdel\t_\t_\t_\t_\t_\t_\t_\t_',
  '1\tde\tde\tADP\t_\t_\t3\tcase\t3:case\t_',
  '2\tel\tel\tDET\t_\tDefinite=Def|PronType=Art\t3\tdet\t3:det\t_',
  '3\tperro\tperro\tNOUN\tNN\tGender=Masc|Number=Sing\t0\troot\t0:root\t_',
]);

test('CoNLL-U survives the parse → document → export round trip', () => {
  const doc = new ConlluDocument({ raw: rawDocFromConllu(INPUT, 'rt-doc') });
  assert.equal(doc.toConllu(), EXPECTED);
});

test('export is a fixpoint: re-importing the export reproduces it', () => {
  const doc = new ConlluDocument({ raw: rawDocFromConllu(EXPECTED, 'rt-doc') });
  assert.equal(doc.toConllu(), EXPECTED);
});
