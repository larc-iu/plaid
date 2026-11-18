// Alt+Down in a lemma cell asks two questions, and they must split the words
// exactly: a word with a Form span is asked about by that span, a word with
// none by its token's text. The words of a multi-word token cover their whole
// token, so asking them by its text offered "de" and "el" for "del" (H2-9-2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precedentQueries } from '../src/domain/precedent.js';

const layers = { morpheme: 'm', form: 'f', lemma: 'l', xpos: 'x', features: 'ft' };

test('the token-text question leaves out every word with a Form span', () => {
  const [byText, byForm] = precedentQueries('p', layers, 'lemma', 'del');
  assert.deepEqual(byText.where[0], ['token', '?t', { layer: 'm', value: 'del' }]);
  const not = byText.where.find((c) => c[0] === 'not');
  assert.ok(not, 'a word with a Form span is not asked about by its token text');
  const [, span, covers] = not;
  assert.equal(span[0], 'span');
  assert.deepEqual(span[2], { layer: 'f' });
  assert.deepEqual(covers, ['covers', span[1], '?t']);
  // And the Form-span question asks by the span alone.
  assert.deepEqual(byForm.where[0], ['span', '?f', { layer: 'f', value: 'del' }]);
  assert.ok(!byForm.where.some((c) => c[0] === 'not'));
});
