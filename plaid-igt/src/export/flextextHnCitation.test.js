// flextext hn by citation form (REV-FX-POLISH-5). FieldWorks numbers
// homographs by HomographFormKey, the CITATION form (lexeme form when there is none), within a morph-type class
// (liblcm RepositoryAdditions.cs CollectHomographs, OverridesLing_Lex.cs
// HomographFormKey), and the .fwbackup importer stores that number as
// metadata.homograph and the citation form as item.form. FieldWorks' flextext
// import then picks the entries whose decorated lexeme form is cf and keeps
// those whose HomographNumber is hn, when any does (BIRDInterlinearImporter.cs).
//
// Four stems share the lexeme form "ktb" with two citation forms, each a
// homograph pair in FieldWorks: kataba 1, kataba 2, kitab 1, kitab 2.
import { describe, it, expect } from 'vitest';
import { buildFlextextDocument } from './flextext.js';
import { makeFixtureDoc, FLEXTEXT_OPTIONS } from './testFixtures.js';

const items = [
  {
    id: 'kataba1',
    form: 'kataba',
    metadata: { lexemeForm: 'ktb', homograph: 1, morphType: 'stem' },
  },
  { id: 'kitab1', form: 'kitab', metadata: { lexemeForm: 'ktb', homograph: 1, morphType: 'stem' } },
  {
    id: 'kataba2',
    form: 'kataba',
    metadata: { lexemeForm: 'ktb', homograph: 2, morphType: 'stem' },
  },
  { id: 'kitab2', form: 'kitab', metadata: { lexemeForm: 'ktb', homograph: 2, morphType: 'stem' } },
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

// FieldWorks: candidates by cf, narrowed by hn when any matches. Its numbers
// are the stored ones (per citation form).
const fieldworksPicks = ({ cf, hn }) => {
  const flex = items.map((i) => ({
    id: i.id,
    cf: i.metadata.lexemeForm,
    hn: String(i.metadata.homograph),
  }));
  const byCf = flex.filter((e) => e.cf === cf);
  const byHn = byCf.filter((e) => e.hn === (hn ?? '0'));
  return (byHn.length ? byHn : byCf).map((e) => e.id);
};

describe('flextext hn when lexeme and citation forms differ', () => {
  for (const id of ['kataba1', 'kitab1', 'kataba2', 'kitab2']) {
    it(`a morph linked to ${id} keeps ${id} among FieldWorks' candidates`, () => {
      const m = morphOf(id);
      expect(fieldworksPicks(m), JSON.stringify(m)).toContain(id);
    });
  }
});
