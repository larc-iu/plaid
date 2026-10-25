import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightGrew } from '../src/components/search/grewSyntax.js';

test('colors keywords and strings, leaves identifiers plain', () => {
  const html = highlightGrew('pattern { X [lemma="be"] }');
  assert.match(html, /font-weight:600">pattern<\/span>/);
  assert.match(html, /color:var\(--grew-string\)[^>]*>&quot;be&quot;<\/span>/);
  assert.ok(html.includes('X')); // identifier present, not wrapped as keyword
});

test('escapes HTML so query text cannot inject markup', () => {
  const html = highlightGrew('pattern { X [v=re"<b>"] }');
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes('&lt;b&gt;'));
});

test('escapes both quotes, as every HTML writer here does', () => {
  const html = highlightGrew(`X [v="a'b"]`);
  assert.ok(html.includes('&quot;a&#39;b&quot;'));
  assert.ok(!/["']/.test(html.replace(/<[^>]*>/g, '')));
});

test('is tolerant of partial / malformed input while typing', () => {
  assert.doesNotThrow(() => highlightGrew('pattern { X [lemma="unterminated'));
  assert.doesNotThrow(() => highlightGrew('pattern { X -['));
  assert.doesNotThrow(() => highlightGrew(''));
});

test('highlights operators and global flags', () => {
  assert.match(highlightGrew('X ->> Y'), /color:var\(--grew-operator\)">-&gt;&gt;<\/span>/);
  assert.match(
    highlightGrew('global { is_projective }'),
    /color:var\(--grew-global\)">is_projective<\/span>/,
  );
});
