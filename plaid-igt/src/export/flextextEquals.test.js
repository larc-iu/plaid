// Every chain shape through the flextext export and our reader's marker
// reading (REV-CLITIC round 3, flexall), over the chain table the grid and the
// Python client share (plaid-client-py/tests/clitic_chains.json). Linked or
// not, with or without a hand type on the second piece. A typed "=" is never
// written twice, never sits in front of a morph whose FLEx type is no clitic
// (CL-14), txt and cf agree about it, the forms come back whole, and every
// "=" comes back except the one accepted loss: a "=" before a morph typed as
// no clitic, which FLEx cannot say.
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFlextextDocument } from './flextext.js';
import { makeFixtureDoc, FLEXTEXT_OPTIONS } from './testFixtures.js';
import { equalsChain } from '../domain/mutations/equalsRule.js';
import { isClitic, morphemeJoiner, readAffixMarkers } from '../domain/affixMarkers.js';

const TABLE = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../plaid-client-py/tests/clitic_chains.json',
    ),
    'utf8',
  ),
);

it('writes every typed "=" the format can say, once, and reads it back', () => {
  const bad = [];
  for (const joints of Object.keys(TABLE).filter((j) => j.length > 0)) {
    for (const linked of [false, true]) {
      for (const hand of [null, 'stem', 'suffix']) {
        const befores = [false, ...[...joints].map((j) => j === '=')];
        const morphs = equalsChain(befores).map((c, i) => {
          const own = hand && i === 1 ? hand : c.morphType;
          const metadata = {
            form: `f${i}`,
            ...(own ? { morphType: own } : {}),
            ...(hand && i === 1 ? {} : c.equals || {}),
            ...(befores[i] ? { equalsBefore: true } : {}),
          };
          return {
            id: `m${i}`,
            metadata,
            morphType: own,
            annotations: {},
            vocabItem: linked ? { id: `v${i}`, form: `f${i}`, metadata: {} } : null,
          };
        });
        const doc = makeFixtureDoc();
        const w = doc.sortedSentences[0].pieces[0];
        w.content = morphs.map((m) => m.metadata.form).join('');
        w.morphemes = morphs;
        const xml = buildFlextextDocument([doc], { ...FLEXTEXT_OPTIONS, citationForms: true });
        const dom = new DOMParser().parseFromString(xml, 'text/xml');
        const ms = [...[...dom.querySelectorAll('word')][0].querySelectorAll('morph')];
        const txt = ms.map((m) => m.querySelector('item[type="txt"]')?.textContent);
        const cf = ms.map((m) => m.querySelector('item[type="cf"]')?.textContent ?? null);
        const back = ms.map((m, i) => readAffixMarkers(m.getAttribute('type'), txt[i]));
        const lost = (i) =>
          morphs[i].metadata.equalsBefore && morphs[i].morphType && !isClitic(morphs[i].morphType);
        const want = morphs.map((m, i) =>
          i
            ? morphemeJoiner(
                morphs[i - 1].morphType,
                m.morphType,
                !lost(i) && m.metadata.equalsBefore === true,
              )
            : '',
        );
        const got = back.map((b, i) =>
          i ? morphemeJoiner(back[i - 1].morphType, b.morphType) : '',
        );
        const faults = [
          txt.some((t, i) => i && txt[i - 1].endsWith('=') && t.startsWith('=')) && 'double',
          cf.some((c, i) => c != null && c.startsWith('=') !== txt[i].startsWith('=')) && 'cf',
          ms.some(
            (m, i) =>
              m.getAttribute('type') && !isClitic(m.getAttribute('type')) && txt[i].startsWith('='),
          ) && 'type',
          !back.every((b, i) => b.form === `f${i}`) && 'form',
          // A "=" written comes back as one (the morph after it reads back as
          // an enclitic, which may turn the joint after it into "=" too).
          want.some((j, i) => j === '=' && got[i] !== '=') && 'joint',
        ].filter(Boolean);
        if (faults.length) bad.push({ joints, linked, hand, faults, txt, cf, want, got });
      }
    }
  }
  expect(bad).toEqual([]);
});
