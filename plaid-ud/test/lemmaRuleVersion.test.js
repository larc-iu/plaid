// The lemma a new UD word starts with is a machine write, and every machine
// write names what made it and the version of that code in provDetail
// (provenance convention, R4-2-1), as igt's built-in rules do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newUdWord, lemmaFromForm, LEMMA_FROM_FORM } from '../src/domain/newUdWord.js';
import pkg from '../package.json' with { type: 'json' };

const REPO = normalize(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const RULE = JSON.parse(readFileSync(join(REPO, 'plaid-ud/src/domain/lemmaRuleVersion.json')));
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const read = (p) => readFileSync(join(REPO, p), 'utf8').replace(/\r\n/g, '\n');

test("a new word's lemma names the rule and its version", () => {
  const { lemma } = newUdWord({ begin: 0, end: 3 }, { text: 'dog' }, { id: 'L' }, () => 'id');
  assert.deepEqual(lemma.metadata, {
    prov: 'inferred',
    provSource: 'rule:lemma-from-form',
    provDetail: { model: 'builtin:lemma-from-form', version: `${pkg.version}+${RULE.hash}` },
  });
  assert.equal(lemma.metadata, LEMMA_FROM_FORM);
});

// The whole rule is in the hashed file: what the lemma is copied from too.
test("the rule copies a word's Form, else its text", () => {
  const mint = () => 'id';
  assert.equal(lemmaFromForm('w', { form: 'de', text: 'del' }, mint).value, 'de');
  assert.equal(lemmaFromForm('w', { form: '', text: 'del' }, mint).value, 'del');
  assert.equal(lemmaFromForm('w', { text: 'del' }, mint).value, 'del');
});

test('the version hash is the sha256sum recipe over the files it lists', () => {
  const lines = RULE.sources.map((p) => `${sha256(read(p))}  ${p}\n`).join('');
  assert.equal(
    sha256(lines).slice(0, 8),
    RULE.hash,
    'newUdWord.js changed: set "hash" in lemmaRuleVersion.json to the value above',
  );
});

// A rule's stamp with no detail cannot say which code wrote it.
test('no app source stamps a rule without its detail', () => {
  const walk = (dir) =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return f === 'node_modules' ? [] : walk(p);
      return /\.(js|jsx)$/.test(f) && !/\.test\.jsx?$/.test(f) ? [p] : [];
    });
  const bare = [];
  for (const app of ['plaid-ud', 'plaid-umr', 'plaid-igt', 'plaid-dict', 'plaid-ui']) {
    for (const file of walk(join(REPO, app, 'src'))) {
      for (const m of read(file.slice(REPO.length + 1)).matchAll(
        /stampInferred\(\s*['`"]rule:[^'`"]*['`"]\s*\)/g,
      ))
        bare.push(`${file.slice(REPO.length + 1)}: ${m[0]}`);
    }
  }
  assert.deepEqual(bare, []);
});
