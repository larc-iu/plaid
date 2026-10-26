// R47 over random edit sequences (REV-CLITIC CL-1 and CL-9), checked after
// every step: the types against the position rule over the tracked joints and
// the choices a person made, the joint every reader draws against the
// tracked joints and clitic types, and the local metadata against the sent
// ops replayed on a mirror. Clearing a clitic's type takes back the "=" that
// typed it, clearing any other type keeps the "=". The reviewer's oracle
// (REV-CLITIC round 2, fuzz2). FUZZ_N and FUZZ_SEED widen a run by hand.
import { it, expect } from 'vitest';
import { applyMetadataOps } from '@larc-iu/plaid-client';
import { IgtDocument } from '../IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '../test-helpers.js';
import { cliticSideOfBoundary } from './equalsRule.js';
import { morphemeJoiner, isClitic } from '@ui/domain/morphemes.js';

const N = Number(process.env.FUZZ_N || 1500);
let seed = Number(process.env.FUZZ_SEED || 1);
const rnd = () => {
  seed = (seed * 48271) % 2147483647;
  return seed / 2147483647;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const BODY = 'abcdefghij';
const mk = () => {
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
const ms = (d) => d.sentences[0].tokens[0].morphemes;
const TYPES = ['stem', 'suffix', 'enclitic', 'proclitic', null];
const cliticOf = (b, n) => {
  const s = cliticSideOfBoundary({ leftIdx: b, count: n });
  return s === 'left' ? b : s === 'right' ? b + 1 : null;
};
const ideal = (n, joins, hand) => {
  const want = Array(n).fill(null);
  joins.forEach((j, b) => {
    if (j !== '=') return;
    const k = cliticOf(b, n);
    if (k != null) want[k] = k === b ? 'proclitic' : 'enclitic';
  });
  return want.map((w, k) => (hand[k] !== undefined ? hand[k] : w));
};
it(`${N} random edit sequences hold the rule after every step`, async () => {
  const bad = { type: 0, joint: 0, mirror: 0, hand: 0 };
  const ex = [];
  for (let t = 0; t < N; t++) {
    const d = mk();
    const mirror = new Map([['m-1', { form: BODY }]]);
    const alias = new Map();
    let joins = [];
    let hand = [undefined];
    const log = [];
    for (let s = 0; s < 7; s++) {
      const m = ms(d);
      const n = m.length;
      const r = rnd();
      const before = d.client.calls.length;
      if (r < 0.45) {
        const i = Math.floor(rnd() * n);
        const f = m[i].metadata.form ?? '';
        if (f.length < 2) continue;
        const pos = [
          ...new Set(
            Array.from(
              { length: rnd() < 0.7 ? 1 : 2 },
              () => 1 + Math.floor(rnd() * (f.length - 1)),
            ),
          ),
        ].sort((a, b) => a - b);
        const segs = [];
        let last = 0;
        pos.forEach((p) => {
          segs.push(f.slice(last, p));
          last = p;
        });
        segs.push(f.slice(last));
        const js = segs.slice(1).map(() => pick(['-', '=']));
        log.push(`split ${i} ${segs.map((x, k) => (k ? js[k - 1] : '') + x).join('')}`);
        await d.splitMorphemeMulti(m[i].id, segs, { joiners: js });
        joins = [...joins.slice(0, i), ...js, ...joins.slice(i)];
        hand = [...hand.slice(0, i + 1), ...js.map(() => undefined), ...hand.slice(i + 1)];
      } else if (r < 0.6 && n > 1) {
        const i = 1 + Math.floor(rnd() * (n - 1));
        log.push(`merge ${i}`);
        await d.mergeMorphemes(m[i].id);
        joins.splice(i - 1, 1);
        hand.splice(i, 1);
      } else if (r < 0.75 && n > 1) {
        const i = Math.floor(rnd() * n);
        log.push(`delete ${i}`);
        await d.deleteMorpheme(m[i].id);
        joins.splice(i > 0 ? i - 1 : 0, 1);
        hand.splice(i, 1);
      } else if (r < 0.9) {
        const i = Math.floor(rnd() * n);
        const ty = pick(TYPES);
        log.push(`type ${i} ${ty}`);
        const cur = m[i].morphType;
        await d.setMorphemeType(m[i].id, ty);
        if (ty == null) {
          // ruling: clearing a clitic's type takes back the "=" that typed it
          if (isClitic(cur))
            joins.forEach((j, b) => {
              if (j === '=' && cliticOf(b, n) === i) joins[b] = '-';
            });
          hand[i] = undefined;
        } else hand[i] = ty;
      } else continue;
      // mirror the sent ops
      for (const c of d.client.calls.slice(before)) {
        const id = (x) => alias.get(x) ?? x;
        if (c.kind === 'tokens.create') {
          const o = c.args[7] || {};
          mirror.set(o.id, { ...c.args[5] });
        } else if (c.kind === 'tokens.patchMetadata') {
          const k = id(c.args[0]);
          mirror.set(k, applyMetadataOps(mirror.get(k) || {}, c.args[1]));
        } else if (c.kind === 'tokens.delete') mirror.delete(id(c.args[0]));
        else if (c.kind === 'tokens.bulkDelete') c.args[0].forEach((x) => mirror.delete(id(x)));
      }
      // alias pending local ids to created ids by form + unmatched
      const now = ms(d);
      for (const lm of now)
        if (!mirror.has(lm.id) && !alias.has(lm.id)) {
          const cand = [...mirror.entries()].find(
            ([k, v]) =>
              ![...alias.values()].includes(k) &&
              !now.some((x) => x.id === k) &&
              v.form === lm.metadata.form,
          );
          if (cand) {
            alias.set(lm.id, cand[0]);
          }
        }
      // aliased entries: patches name local id; move them
      for (const [l, s2] of alias)
        if (mirror.has(l)) {
          mirror.set(
            s2,
            applyMetadataOps(
              mirror.get(s2) || {},
              Object.entries(mirror.get(l)).map(([k, v]) => ({ op: 'set', path: [k], value: v })),
            ),
          );
          mirror.delete(l);
        }
      const got = now.map((x) => x.metadata.morphType ?? null);
      const want = ideal(now.length, joins, hand);
      const shown = now.map((x, k) =>
        k
          ? morphemeJoiner(now[k - 1].morphType, x.morphType, x.metadata.equalsBefore === true)
          : '',
      );
      const wantShown = now.map((x, k) =>
        k
          ? joins[k - 1] === '=' || isClitic(now[k - 1].morphType) || isClitic(x.morphType)
            ? '='
            : '-'
          : '',
      );
      const mis = now.filter(
        (x) =>
          JSON.stringify(mirror.get(alias.get(x.id) ?? x.id)) !==
            JSON.stringify(Object.fromEntries(Object.entries(x.metadata).sort())) &&
          JSON.stringify(
            Object.fromEntries(Object.entries(mirror.get(alias.get(x.id) ?? x.id) || {}).sort()),
          ) !== JSON.stringify(Object.fromEntries(Object.entries(x.metadata).sort())),
      );
      let fail = null;
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        bad.type++;
        fail = 'type';
      }
      if (JSON.stringify(shown) !== JSON.stringify(wantShown)) {
        bad.joint++;
        fail = fail || 'joint';
      }
      if (mis.length) {
        bad.mirror++;
        fail = fail || 'mirror';
      }
      if (fail) {
        if (ex.length < 6)
          ex.push({
            fail,
            log,
            forms: now.map((x) => x.metadata.form),
            joins,
            hand,
            got,
            want,
            md: now.map((x) => x.metadata),
            mirror: now.map((x) => mirror.get(alias.get(x.id) ?? x.id)),
          });
        break;
      }
    }
  }
  expect({ bad, ex }).toEqual({ bad: { type: 0, joint: 0, mirror: 0, hand: 0 }, ex: [] });
}, 600000);
