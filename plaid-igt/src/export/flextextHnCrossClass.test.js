// flextext hn across morph-type classes (REV-FX-POLISH-2, Luke 2026-10-31).
//
// A FLEx lexicon with two stems "ka" (FLEx homographs 1 and 2) and two
// suffixes "-ka" (FLEx homographs 1 and 2, FieldWorks numbers each class on
// its own). FieldWorks' flextext import (BIRDInterlinearImporter.cs) matches a
// morph by its decorated cf ("-ka"), then keeps the entries whose
// HomographNumber equals hn when any does. So hn must be the FLEx number
// within the class, or one it cannot match.
import { describe, it, expect } from 'vitest';
import { buildFlextextDocument } from './flextext.js';
import { makeFixtureDoc, FLEXTEXT_OPTIONS } from './testFixtures.js';

const items = [
  { id: 'stem1', form: 'ka', metadata: { homograph: 1, morphType: 'stem' } },
  { id: 'suf1', form: 'ka', metadata: { homograph: 1, morphType: 'suffix' } },
  { id: 'stem2', form: 'ka', metadata: { homograph: 2, morphType: 'stem' } },
  { id: 'suf2', form: 'ka', metadata: { homograph: 2, morphType: 'suffix' } },
];

const morphOf = (linked) => {
  const doc = makeFixtureDoc();
  doc.vocabularies = { v1: { id: 'v1', items } };
  for (const list of [doc.sortedSentences[0].tokens[0], doc.sortedSentences[0].pieces[0]]) {
    list.morphemes[0].vocabItem = { ...items.find((i) => i.id === linked), vocabId: 'v1' };
  }
  const xml = buildFlextextDocument([doc], FLEXTEXT_OPTIONS);
  const morph = new DOMParser().parseFromString(xml, 'text/xml').querySelector('morph');
  return {
    cf: morph.querySelector('item[type="cf"]')?.textContent ?? null,
    hn: morph.querySelector('item[type="hn"]')?.textContent ?? null,
  };
};

// What FieldWorks does with (cf, hn): the candidates its cf names, narrowed by hn.
const fieldworksPicks = ({ cf, hn }) => {
  const flex = [
    { id: 'stem1', cf: 'ka', hn: '1' },
    { id: 'stem2', cf: 'ka', hn: '2' },
    { id: 'suf1', cf: '-ka', hn: '1' },
    { id: 'suf2', cf: '-ka', hn: '2' },
  ];
  const byCf = flex.filter((e) => e.cf === cf);
  const byHn = byCf.filter((e) => e.hn === (hn ?? '0'));
  return (byHn.length ? byHn : byCf).map((e) => e.id);
};

describe('flextext hn across morph-type classes', () => {
  for (const id of ['stem1', 'stem2', 'suf1', 'suf2']) {
    it(`a morph linked to ${id} is matched back to ${id} (or left to its gloss)`, () => {
      const m = morphOf(id);
      const picks = fieldworksPicks(m);
      expect(picks, JSON.stringify(m)).toContain(id);
    });
  }
});
