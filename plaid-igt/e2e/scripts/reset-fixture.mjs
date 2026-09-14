// Put the shared "E2E IGT Fixture" document back to what fixtureProject.js
// seeds: one morpheme per word at precedence 1, no metadata on any token, and
// no annotation at all.
//
// Thirty-two specs share that project, and a run that dies partway leaves its
// writes behind. Residue reads as a regression in whatever spec trips over it
// next, and it compounds: a spec that snapshots the current value as "the
// original" and restores to that carries the drift forward for good, which is
// how the first morpheme came to be a proclitic called "Ə" with a gloss of
// TESTGLOSS on it.
//
// Idempotent. It reports what it found either way, and a second run says the
// fixture is already as seeded.
//
// Usage:
//   node e2e/scripts/reset-fixture.mjs            # report and put back
//   node e2e/scripts/reset-fixture.mjs --dry-run  # report only

import { getFixture, makeClient } from '../fixtureProject.js';

const DRY = process.argv.includes('--dry-run');
const roleOf = (l) => l?.config?.plaid?.role;
const found = [];
const note = (line) => {
  found.push(line);
  console.log(`  ${line}`);
};

const client = makeClient();
const { documentId } = await getFixture();
const raw = await client.documents.get(documentId, true);
const text = raw.textLayers[0];
const body = text.text.body;
const layer = (role) => text.tokenLayers.find((l) => roleOf(l) === role);
const words = layer('word');
const morphemes = layer('morpheme');
const alignment = layer('time-alignment');

// Every span on the document, whatever layer it hangs off. The seeder makes
// none: each spec creates the annotation it needs.
const spanLayers = [];
const walk = (tokenLayer) => {
  for (const sl of tokenLayer.spanLayers || []) spanLayers.push(sl);
  for (const child of tokenLayer.tokenLayers || []) walk(child);
};
for (const tl of text.tokenLayers || []) walk(tl);

console.log(`E2E IGT Fixture, document ${documentId}`);
console.log(DRY ? 'What is not as seeded:' : 'Putting back:');

// 1. Annotation. Deleted first, so nothing cascades out from under a token
// delete below and leaves the report wrong about what it removed.
for (const sl of spanLayers) {
  for (const span of sl.spans || []) {
    note(`span in ${sl.name}: ${JSON.stringify(span.value)}`);
    if (!DRY) await client.spans.delete(span.id);
  }
}

// 2. A word carries exactly one morpheme until a spec splits it. The one that
// stays is the lowest precedence, which is the one the seeder made.
const inWord = (w) => morphemes.tokens.filter((t) => t.begin >= w.begin && t.end <= w.end);
const keptMorphemes = [];
for (const word of words.tokens.slice().sort((a, b) => a.begin - b.begin)) {
  const mine = inWord(word).sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0));
  keptMorphemes.push(mine[0]);
  for (const extra of mine.slice(1)) {
    note(
      `extra morpheme on ${JSON.stringify(body.slice(word.begin, word.end))}: precedence ${extra.precedence}, form ${JSON.stringify(extra.metadata?.form)}`,
    );
    if (!DRY) await client.tokens.delete(extra.id);
  }
}

// 3. A seeded token carries no metadata: the form of an unsplit morpheme is the
// text under it, and a morpheme type is something a linguist sets.
const tokensOf = [
  ['sentence', layer('sentence').tokens],
  ['word', words.tokens],
  ['morpheme', keptMorphemes.filter(Boolean)],
];
for (const [what, tokens] of tokensOf) {
  for (const token of tokens) {
    if (!token.metadata || Object.keys(token.metadata).length === 0) continue;
    note(`metadata on a ${what} token: ${JSON.stringify(token.metadata)}`);
    if (!DRY) await client.tokens.deleteMetadata(token.id);
  }
}

// 4. The seeder creates the alignment layer and never puts a token in it.
for (const token of alignment?.tokens || []) {
  note(`alignment token ${token.begin}-${token.end}: ${JSON.stringify(token.metadata)}`);
  if (!DRY) await client.tokens.delete(token.id);
}

if (found.length === 0) {
  console.log('  nothing: the fixture is as seeded.');
} else {
  console.log(`${found.length} thing(s) ${DRY ? 'to put back' : 'put back'}.`);
}
