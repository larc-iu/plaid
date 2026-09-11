// Item 12.1: "each row clickable to filter the hits". The click rewrites the
// pattern, so what it writes has to parse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/grew/parser.js';
import { clauseFor, refinePattern } from '../src/components/search/refine.js';

test('a clause names the field, and a FEATS count names its key', () => {
  assert.equal(clauseFor('V', 'upos', 'VERB'), 'V [upos="VERB"]');
  assert.equal(clauseFor('V', 'FEATS', 'Case=Nom'), 'V [Case="Nom"]');
  // Nothing to key on.
  assert.equal(clauseFor('V', 'FEATS', 'Case'), null);
  assert.equal(clauseFor('', 'upos', 'VERB'), null);
});

test('a value with a quote in it stays one literal', () => {
  assert.equal(clauseFor('W', 'lemma', 'o"clock'), 'W [lemma="o\\"clock"]');
  parse(`pattern { ${clauseFor('W', 'lemma', 'o"clock')} }`);
});

test('the clause joins the pattern the user already has, and it parses', () => {
  const out = refinePattern('pattern { V [upos=VERB] }', 'V', 'lemma', 'see');
  assert.equal(out, 'pattern { V [upos=VERB]; V [lemma="see"] }');
  parse(out);
});

test('a multi-line pattern keeps its line breaks', () => {
  const text = 'pattern {\n  H -[nsubj]-> W;\n  W [upos=NOUN];\n}';
  const out = refinePattern(text, 'W', 'lemma', 'dog');
  assert.equal(out, 'pattern {\n  H -[nsubj]-> W;\n  W [upos=NOUN]; W [lemma="dog"] }');
  parse(out);
});

test('an empty pattern block takes the clause on its own', () => {
  assert.equal(refinePattern('pattern { }', 'V', 'upos', 'VERB'), 'pattern { V [upos="VERB"] }');
});

test('no pattern block means nothing to narrow', () => {
  assert.equal(refinePattern('', 'V', 'upos', 'VERB'), null);
  assert.equal(refinePattern('dog', 'V', 'upos', 'VERB'), null);
});

test('a brace inside a string is not a brace', () => {
  // A pattern may legally look for one. Counting it closed the block early and
  // put the clause inside the regex, which then did not parse.
  for (const text of [
    'pattern { V [lemma=re".*}.*"] }',
    'pattern { V [lemma=re".*{.*"] }',
    'pattern { V [lemma=re".*[{}].*"] }',
    'pattern { V [lemma="a\\"}\\"b"] }',
  ]) {
    const out = refinePattern(text, 'V', 'upos', 'VERB');
    assert.ok(out, `declined: ${text}`);
    assert.ok(out.endsWith('V [upos="VERB"] }'), `clause misplaced: ${out}`);
    parse(out);
  }
});
