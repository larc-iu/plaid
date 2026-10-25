import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAndCompile } from '../src/grew/index.js';

// fixtures/grewPatterns.json holds the patterns plaid-agent's Grew port is
// compared on (plaid-agent/tests/test_grew_mirror.py), so a pattern a test
// here compiles is one the mirror compiles with both. A pattern added to a
// test and not to the fixture is a construct the mirror never sees.

const HERE = dirname(fileURLToPath(import.meta.url));
const PATTERNS = new Set(
  JSON.parse(readFileSync(resolve(HERE, 'fixtures/grewPatterns.json'), 'utf8')),
);

// Every layer the Search tab can have, so a pattern refused for a layer
// missing is not left out.
const LAYERS = {
  sentenceTokenLayer: { id: 'SENT' },
  morphemeTokenLayer: { id: 'MORPH' },
  formLayer: { id: 'FORM' },
  lemmaLayer: { id: 'LEMMA', relationLayers: [{ id: 'REL' }, { id: 'EREL' }] },
  uposLayer: { id: 'UPOS' },
  xposLayer: { id: 'XPOS' },
  featuresLayer: { id: 'FEATS' },
  relationLayer: { id: 'REL' },
  enhancedRelationLayer: { id: 'EREL' },
};

// A string literal on one line: quoted, or a template with no `${`.
const LITERAL = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const PATTERN_START = /^\s*(pattern|global|with|without)\s*\{/;

function literalValue(source) {
  try {
    // A literal of a test file of this package, read as the test reads it.
    return (0, eval)(source);
  } catch {
    return null;
  }
}

function compiles(pattern) {
  try {
    parseAndCompile(pattern, LAYERS);
    return true;
  } catch {
    return false;
  }
}

test('every pattern a Grew test compiles is in the fixture the agent mirror reads', () => {
  const files = readdirSync(HERE).filter((f) => /^grew.*\.test\.js$/.test(f));
  assert.ok(files.length > 10);
  const missing = [];
  for (const f of files) {
    for (const m of readFileSync(resolve(HERE, f), 'utf8').matchAll(LITERAL)) {
      if (m[1] === '`' && m[2].includes('${')) continue;
      const s = literalValue(m[0]);
      if (typeof s !== 'string' || !PATTERN_START.test(s)) continue;
      if (compiles(s) && !PATTERNS.has(s)) missing.push(`${f}: ${s}`);
    }
  }
  assert.deepEqual(missing, []);
});
