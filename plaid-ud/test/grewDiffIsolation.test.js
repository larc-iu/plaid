import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { parseGrs } from '../src/grew/parser.js';
import { graphFromSentence } from '../src/grew/rewrite/graph.js';
import { rewriteSentence } from '../src/grew/rewrite/engine.js';
import { diffGraphs } from '../src/grew/rewrite/diff.js';

// A change line reads "src → tgt: label ...". With an Arabic form on each
// side of the arrow the two forms and the arrow join one right-to-left run,
// and the line reads as the relation going the other way. Each line carries
// its parts, the line's own words at even indices and the values from the
// data at odd ones, so the preview can isolate every value.

const CONLLU = [
  '# text = قال الرئيس',
  '1\tقال\tقال\tVERB\t_\tAspect=Perf\t0\troot\t_\t_',
  '2\tالرئيس\tرئيس\tNOUN\t_\t_\t1\tnsubj\t_\t_',
].join('\n');

const run = (src) => {
  const doc = new ConlluDocument({ raw: rawDocFromConllu(CONLLU, 'doc', { enhanced: true }) });
  const before = graphFromSentence(doc.sentences[0]);
  const { graph: after } = rewriteSentence(parseGrs(src), before);
  return diffGraphs(before, after, doc.layerInfo);
};

const valuesOf = (c) => c.parts.filter((_, i) => i % 2 === 1);

test('an edge line keeps each form apart from the arrow', () => {
  const r = run('pattern { e: H -[nsubj]-> D } commands { e.label = obj }');
  assert.equal(r.changes.length, 1);
  const [c] = r.changes;
  assert.equal(c.text, 'قال → الرئيس: nsubj → obj');
  assert.equal(c.parts.join(''), c.text);
  assert.deepEqual(valuesOf(c), ['قال', 'الرئيس', 'nsubj', 'obj']);
});

test('every kind of line has parts that make up its text', () => {
  const r = run(`pattern { H [upos=VERB]; D [upos=NOUN]; e: H -[nsubj]-> D }
    commands { del_edge e; add_edge D -[dep]-> H; H.lemma = "قيل"; del_feat H.Aspect; D.Case = Nom }`);
  assert.ok(r.changes.length >= 4);
  for (const c of r.changes) {
    assert.ok(Array.isArray(c.parts), c.text);
    assert.equal(c.parts.join(''), c.text);
    // No value is ever left inside the line's own words.
    for (const [i, p] of c.parts.entries()) {
      if (i % 2 === 0) assert.doesNotMatch(p, /[؀-ۿ]/, c.text);
    }
  }
});

test('an enhanced line keeps its forms apart too', () => {
  const r = run(
    'pattern { e: H -[nsubj]-> D } without { H -[E:obj]-> D } commands { add_edge H -[E:obj]-> D }',
  );
  const texts = r.changes.map((c) => c.text);
  assert.ok(texts.includes('قال → الرئيس: nsubj left out of the enhanced graph'), texts.join('\n'));
  for (const c of r.changes) {
    assert.equal(c.parts.join(''), c.text);
    assert.deepEqual(valuesOf(c).slice(0, 2), ['قال', 'الرئيس']);
  }
});
