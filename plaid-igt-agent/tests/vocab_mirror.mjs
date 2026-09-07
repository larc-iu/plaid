// The app's own vocabulary domain, run over the fixtures test_vocab_mirror.py
// generates, so the Python port in plaid_igt_agent/vocab.py can be compared
// against it function by function.
//
// Reads a fixtures JSON path as argv[2], writes one result object per case to
// stdout. Every key here has a counterpart in the Python runner; a key added
// on one side and not the other fails the test rather than passing quietly.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DOMAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../../plaid-igt/src/domain');
const dictMod = await import(`${DOMAIN}/vocabDictionary.js`);
const fieldsMod = await import(`${DOMAIN}/vocabFields.js`);
const {
  buildSenseTree, buildItemNumbers, planDeleteRefs, planMergeRefs, planSenseDrop,
  nextSenseOrder, descendantsOf, referencesTo, validateVocabRefs,
  homographGroup, planHomographOrder, homographOf, arrangeAsTree,
} = dictMod;
const { buildHomonymIndex } = await import(`${DOMAIN}/vocabHomonyms.js`);
const { normalizeVocabFields } = fieldsMod;

// The names the app exports, for the surface check: a function added there and
// not ported (or not deliberately exempted) is drift the value comparison
// below cannot see, because it only ever runs what both sides already have.
if (process.argv[2] === '--surface') {
  const fns = (mod) =>
    Object.keys(mod)
      .filter((k) => typeof mod[k] === 'function')
      .sort();
  process.stdout.write(
    JSON.stringify({ vocabDictionary: fns(dictMod), vocabFields: fns(fieldsMod) }),
  );
  process.exit(0);
}

const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = cases.map((c) => {
  const t = buildSenseTree(c.items);
  return {
    // buildSenseTree, in every part the port reproduces
    numberOf: Object.fromEntries(t.numberOf),
    parentOf: Object.fromEntries(t.parentOf),
    depthOf: Object.fromEntries(t.depthOf),
    rootOf: Object.fromEntries(t.rootOf),
    roots: t.roots.map((x) => x.id),
    childrenOf: Object.fromEntries([...t.childrenOf].map(([k, v]) => [k, v.map((x) => x.id)])),
    // the number a form goes by, in both kinds of vocabulary
    itemNumbers: Object.fromEntries(buildItemNumbers(c.items)),
    homonyms: Object.fromEntries(buildHomonymIndex(c.items)),
    homographOf: Object.fromEntries(c.items.map((it) => [it.id, homographOf(it)])),
    homographGroup: homographGroup(c.items, c.moveId).map((r) => r.id),
    planHomographOrder: planHomographOrder(homographGroup(c.items, c.moveId), c.losers),
    // moving, deleting, merging, and the integrity sweep
    planSenseDrop: c.drops.map((d) => planSenseDrop(t, c.moveId, d)),
    nextSenseOrder: nextSenseOrder(t, c.orderParent),
    descendantsOf: descendantsOf(t, c.orderParent).map((x) => x.id),
    referencesTo: referencesTo(c.items, c.fields, c.orderParent)
      .map((x) => [x.item.id, x.field ? x.field.name : null]),
    planDeleteRefs: planDeleteRefs(c.items, c.fields, c.deleted),
    planMergeRefs: planMergeRefs(c.items, c.fields, c.survivor, c.losers),
    validateVocabRefs: validateVocabRefs(c.items, c.fields).patches,
    // laying a filtered list out as a tree, context rows and all
    arrangeAsTree: arrangeAsTree(
      c.items.filter((it) => c.listed.includes(it.id)),
      t,
    ).map((r) => [r.item.id, r.depth, !!r.context]),
    // the field schema
    normalizeVocabFields: normalizeVocabFields(c.rawFields),
  };
});
process.stdout.write(JSON.stringify(out));
