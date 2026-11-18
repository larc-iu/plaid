// What plaid-ud's grid holds up for review in a document, opened as the
// editor opens it (ConlluDocument), so test_ud_discard_live.py can say what a
// person sees after the assistant's discard: per sentence, the words a
// verifier's Ctrl+Enter stops at (`reviewWords` with `needsReview`, the
// policy's predicate for a verifier) and whether Discard predictions has
// anything to do (`hasDiscardable`, what lights the sentence's button).
//
// Reads a document JSON path (camelCase, as the JavaScript client hands it
// over) as argv[2] and writes [{words, discardable}] to stdout.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const UD = resolve(dirname(fileURLToPath(import.meta.url)), '../../plaid-ud');
const { ConlluDocument } = await import(`${UD}/src/domain/ConlluDocument.js`);
const { reviewWords, hasDiscardable } = await import(`${UD}/src/domain/reviewTargets.js`);
const { sentenceArcs } = await import(`${UD}/src/domain/enhancedGraph.js`);
const { needsReview } = await import(`${UD}/node_modules/@larc-iu/plaid-client/src/index.js`);

const raw = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const doc = new ConlluDocument({ raw });
const out = doc.sentences.map((sentence) => ({
  words: reviewWords([sentence], needsReview).length,
  discardable: hasDiscardable(sentence.tokens, sentenceArcs(sentence)),
}));
process.stdout.write(JSON.stringify(out));
