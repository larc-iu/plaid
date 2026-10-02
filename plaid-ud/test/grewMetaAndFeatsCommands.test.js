import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { parseAndCompile } from '../src/grew/index.js';
import { parseGrs } from '../src/grew/parser.js';
import { graphFromSentence } from '../src/grew/rewrite/graph.js';
import { rewriteSentence } from '../src/grew/rewrite/engine.js';
import { GrewUnsupportedError } from '../src/grew/errors.js';

const LI = {
  sentenceTokenLayer: { id: 'SENT' },
  morphemeTokenLayer: { id: 'MORPH' },
  lemmaLayer: { id: 'LEMMA' },
  uposLayer: { id: 'UPOS' },
  xposLayer: { id: 'XPOS' },
  featuresLayer: { id: 'FEATS' },
  relationLayer: { id: 'REL' },
};

const metadataOf = (src) =>
  parseAndCompile(src, LI).query.where.find((c) => c[0] === 'token' && c[2]?.metadata)[2].metadata;

// The engine reads a bare metadata value beginning with `?` as a variable and
// answers 400, so a sentence field holding `?x` (a glottal stop in some
// orthographies) could not be searched. Every value goes as a literal.
test('a global metadata value is sent as a literal, one beginning with ? included', () => {
  assert.deepEqual(metadataOf('global { sent_id = "?a-1" }'), { sent_id: { literal: '?a-1' } });
  assert.deepEqual(metadataOf('global { sent_id = "s1" }'), { sent_id: { literal: 's1' } });
  assert.deepEqual(metadataOf('global { sent_id = "?a" | "b" }'), {
    sent_id: { literal: ['?a', 'b'] },
  });
  // A regex and a not-equal stay regexes.
  assert.deepEqual(metadataOf('global { sent_id = /^\\?/ }'), { sent_id: { regex: '^\\?' } });
  assert.ok(metadataOf('global { sent_id <> "?a" }').sent_id.regex);
});

const CONLLU = [
  '# text = the dog',
  '1\tthe\tthe\tDET\t_\tDefinite=Def\t2\tdet\t_\t_',
  '2\tdog\tdog\tNOUN\t_\tNumber=Sing\t0\troot\t_\t_',
].join('\n');
const graph = () =>
  graphFromSentence(new ConlluDocument({ raw: rawDocFromConllu(CONLLU) }).sentences[0]);

// A command naming FEATS wrote a feature called FEATS (a span `FEATS=a`).
// FEATS is the word's features as a whole, which no command sets or removes.
test('a command naming FEATS is refused, not written as a feature called FEATS', () => {
  for (const cmd of [
    'X.FEATS = "Number=Plur"',
    'del_feat X.FEATS',
    'X.feats = "a"',
    'X.lemma = X.FEATS',
  ]) {
    assert.throws(
      () =>
        rewriteSentence(
          parseGrs(`rule r { pattern { X [upos=NOUN] } commands { ${cmd} } }`),
          graph(),
        ),
      (e) => e instanceof GrewUnsupportedError && /FEATS/.test(e.message),
      cmd,
    );
  }
  // One feature is still set by name.
  const { graph: g } = rewriteSentence(
    parseGrs('rule r { pattern { X [upos=NOUN, !Gender] } commands { X.Gender = Masc } }'),
    graph(),
  );
  assert.equal([...g.nodes.values()].find((n) => n.form === 'dog').feats.get('Gender'), 'Masc');
});
