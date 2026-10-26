// R47 over random edit sequences (REV-CLITIC CL-1): whatever order a word's
// morphemes are split ("-" or "="), merged, deleted and typed in, its types
// are the ones the position rule gives over the "=" boundaries the word holds
// now, with every type a person chose kept. Clearing a type takes back the
// "=" whose clitic it was. FUZZ_N and FUZZ_SEED widen a run by
// hand (the review ran 4000).
import { it, expect } from 'vitest';
import { IgtDocument } from '../IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '../test-helpers.js';
import { cliticSideOfBoundary } from './equalsRule.js';

const N = Number(process.env.FUZZ_N || 400);
let seed = Number(process.env.FUZZ_SEED || 1);
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const BODY = 'abcdefghij';
const TYPES = ['stem', 'suffix', 'enclitic', 'proclitic', null];

const word = () => {
  resetIds();
  return new IgtDocument({
    raw: buildRawDoc({
      words: [{ id: 'w-1', begin: 0, end: BODY.length }],
      morphemes: [
        { id: 'm-1', begin: 0, end: BODY.length, precedence: 1, metadata: { form: BODY } },
      ],
      body: BODY,
    }),
    project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
    vocabularies: {},
    client: makeFakeClient(),
    projectId: 'proj-1',
  });
};
const morphemes = (doc) => doc.sentences[0].tokens[0].morphemes;
const sideOf = (b, count) => {
  const side = cliticSideOfBoundary({ leftIdx: b, count });
  return side === 'left' ? b : side === 'right' ? b + 1 : null;
};

// The position rule over the joints, then each choice a person made.
const expected = (count, joins, hand) => {
  const want = Array.from({ length: count }, () => null);
  joins.forEach((j, b) => {
    const k = j === '=' ? sideOf(b, count) : null;
    if (k != null) want[k] = k === b ? 'proclitic' : 'enclitic';
  });
  return want.map((t, k) => (hand[k] !== undefined ? hand[k] : t));
};

it(`${N} random edit sequences end as the rule over the word as it stands`, async () => {
  const bad = [];
  for (let t = 0; t < N && bad.length < 3; t++) {
    const doc = word();
    let joins = [];
    let hand = [undefined];
    const log = [];
    for (let s = 0; s < 6; s++) {
      const ms = morphemes(doc);
      const n = ms.length;
      const r = rnd();
      if (r < 0.5) {
        const i = Math.floor(rnd() * n);
        const f = ms[i].metadata.form ?? '';
        if (f.length < 2) continue;
        const cuts = [
          ...new Set(
            Array.from(
              { length: rnd() < 0.7 ? 1 : 2 },
              () => 1 + Math.floor(rnd() * (f.length - 1)),
            ),
          ),
        ].sort((a, b) => a - b);
        const segs = [];
        let last = 0;
        cuts.forEach((p) => {
          segs.push(f.slice(last, p));
          last = p;
        });
        segs.push(f.slice(last));
        const js = segs.slice(1).map(() => pick(['-', '=']));
        log.push(`split ${i} ${segs.map((x, k) => (k ? js[k - 1] : '') + x).join('')}`);
        await doc.splitMorphemeMulti(ms[i].id, segs, { joiners: js });
        joins = [...joins.slice(0, i), ...js, ...joins.slice(i)];
        hand = [...hand.slice(0, i + 1), ...js.map(() => undefined), ...hand.slice(i + 1)];
      } else if (r < 0.65 && n > 1) {
        const i = 1 + Math.floor(rnd() * (n - 1));
        log.push(`merge ${i}`);
        await doc.mergeMorphemes(ms[i].id);
        joins.splice(i - 1, 1);
        hand.splice(i, 1);
      } else if (r < 0.8 && n > 1) {
        const i = Math.floor(rnd() * n);
        log.push(`delete ${i}`);
        await doc.deleteMorpheme(ms[i].id);
        joins.splice(i > 0 ? i - 1 : 0, 1);
        hand.splice(i, 1);
      } else if (r < 0.9) {
        const i = Math.floor(rnd() * n);
        const ty = pick(TYPES);
        log.push(`type ${i} ${ty}`);
        await doc.setMorphemeType(ms[i].id, ty);
        // A clear leaves no choice behind: a "=" typed later may type it.
        hand[i] = ty ?? undefined;
        if (ty == null) joins = joins.map((j, b) => (j === '=' && sideOf(b, n) === i ? '-' : j));
      }
      const got = morphemes(doc).map((m) => m.metadata.morphType ?? null);
      const want = expected(got.length, joins, hand);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        bad.push({ log, forms: morphemes(doc).map((m) => m.metadata.form), joins, got, want });
        break;
      }
    }
  }
  expect(bad).toEqual([]);
}, 600_000);
