// What a sentence's own badge counts, against what the Validation tab reports.
//
// `validate.js` is a port of umrtools/validate.py, so `problems` holds every
// check it holds. Not all of them are worth saying beside a sentence while
// somebody annotates it, and `unaligned-token` is the clearest case: it warns
// about every word with no node, which is every determiner, auxiliary and
// preposition in a normal sentence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { rawFromPlan } from './rawFromPlan.js';

// "Lindsay left in order to eat lunch ." with a graph over some of it: "in",
// "order" and "to" are aligned to nothing, which is correct annotation.
const TEXT = `################################################################################
# :: snt1	Lindsay left in order to eat lunch .
Index: 1 2 3 4 5 6 7 8
Words: Lindsay left in order to eat lunch .

# sentence level graph:
(s1l / leave-02
    :ARG0 (s1p / person
        :name (s1n / name :op1 "Lindsay"))
    :aspect performance
    :purpose (s1e / eat-01 :ARG0 s1p :aspect performance))

# alignment:
s1l: 2-2
s1p: 1-1
s1n: 0-0
s1e: 6-6

# document level annotation:


`;

const load = () =>
  new UmrDocument({ raw: rawFromPlan(planImport(parseUmrFile(TEXT).sentences, [])) });

test('the Validation tab keeps every check the official validator runs', () => {
  const codes = load().problems.map((p) => p.code);
  assert.ok(
    codes.includes('unaligned-token'),
    `expected an unaligned-token finding, got ${JSON.stringify(codes)}`,
  );
});

test('a sentence badge does not count the unaligned words', () => {
  const doc = load();
  const onCanvas = [...doc.problemsBySentence.values()].flat();
  assert.deepEqual(
    onCanvas.filter((p) => p.code === 'unaligned-token'),
    [],
  );
  // Everything else still reaches it: the two lists differ by that check
  // alone, rather than by the badge having been switched off.
  assert.deepEqual(
    onCanvas.map((p) => p.code).sort(),
    doc.problems
      .filter((p) => p.code !== 'unaligned-token')
      .map((p) => p.code)
      .sort(),
  );
});
