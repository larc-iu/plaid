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

test("a brace in any of Grew's four contexts is not a brace", () => {
  // Grew has three value literals and a comment, and a brace inside any of
  // them is not a brace. A hand-rolled scanner that knew about "…" only
  // spliced the clause into the middle of a PCRE regex, and the result still
  // PARSED, as a silently different search. The block's end is lexed now.
  const cases = [
    'pattern { V [lemma=re".*}.*"] }',
    'pattern { V [lemma=re".*{.*"] }',
    'pattern { V [form=/a\\}b/] }',
    'pattern { V [form=/a\\{b/] }',
    "pattern { V [form=/o'clock/] }",
    'pattern {\n  % close it }\n  V [upos=VERB];\n}',
  ];
  for (const text of cases) {
    const out = refinePattern(text, 'V', 'upos', 'NOUN');
    assert.ok(out, `declined: ${text}`);
    // The clause lands after the user's own body, not inside a literal.
    assert.match(out, /V \[upos="NOUN"\] \}$/, `clause misplaced: ${out}`);
    parse(out);
  }
});

test('a feature key that cannot be written bare falls back to the whole FEATS string', () => {
  // A key is written bare in Grew, so it cannot be escaped. A project can hold
  // one that is not bare-safe, which is exactly what the Validation tab lists,
  // and the count row for it is one click away.
  for (const pair of ['odd key=x', 'a]=x', 'a"b=x', 'a.b=x']) {
    const out = refinePattern('pattern { V [upos=VERB] }', 'V', 'FEATS', pair);
    assert.ok(out, `declined: ${pair}`);
    assert.match(out, /FEATS=re"/, `key leaked into the syntax: ${out}`);
    parse(out);
  }
  // A well-formed key still gets the clause a reader would write by hand.
  assert.equal(
    refinePattern('pattern { V [upos=VERB] }', 'V', 'FEATS', 'Number=Sing'),
    'pattern { V [upos=VERB]; V [Number="Sing"] }',
  );
});

test('a node or field name that is not bare-safe is declined, not interpolated', () => {
  assert.equal(refinePattern('pattern { V [upos=VERB] }', 'V]', 'upos', 'NOUN'), null);
  assert.equal(refinePattern('pattern { V [upos=VERB] }', 'V', 'upos]', 'NOUN'), null);
});

test('a clause lands below a trailing comment, not inside it', () => {
  // The brace is found by lexing, but the whitespace strip in front of it used
  // to eat the newline that ended a `%` comment, so the new clause was
  // commented out and the pattern stopped parsing.
  const out = refinePattern('pattern {\n  V [upos=VERB] % main verb\n}', 'V', 'lemma', 'see');
  assert.match(out, /% main verb\n/);
  assert.match(out, /V \[lemma="see"\]/);
  assert.ok(!/% main verb.*lemma/.test(out), out);
  assert.doesNotThrow(() => parse(out));
});

test('a body that already ends in a semicolon does not get a second one', () => {
  const out = refinePattern('pattern {\n  V [upos=VERB];\n}', 'V', 'lemma', 'see');
  assert.ok(!/;\s*;/.test(out), out);
  assert.doesNotThrow(() => parse(out));
});
