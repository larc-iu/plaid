// Live e2e for the project Bulk Edit tab: all four activities, planned and
// applied through the real runner against a real core, on a throwaway project
// of its own (a sweep searches the WHOLE project, so it must never be pointed
// at the shared fixture).
//   cd plaid-igt && node --import ./e2e/live/aliases.mjs e2e/live/bulk-edit.mjs
//
// Every write here goes to a bulk endpoint. The unit tests drive a fake client
// and so can only say which method was called with what — they cannot say that
// the body is the one the server accepts, or that a bulk update of spans in two
// documents lands in both. That is what this is for: each assertion re-reads
// the documents and the lexicon from the server.
import PlaidClient, { ROLES, cpLength } from '@larc-iu/plaid-client';
import { IgtDocument, loadProjectVocabularies } from '../../src/domain/IgtDocument.js';
import { executeProjectSetup } from '../../src/components/projects/setup/executeSetup.js';
import { buildReplacer } from '../../src/components/projects/bulk/bulkPlan.js';
import {
  planRespell,
  applyRespell,
  planField,
  applyField,
  planReanalyze,
  applyReanalyze,
  planMerge,
  applyMerge,
} from '../../src/components/projects/bulk/bulkRunner.js';
import { metadataUpdates } from '../../src/components/projects/bulk/bulkPlan.js';
import { getIgtLayerInfo } from '../../src/domain/layerInfo.js';
import { searchDomains } from '../../src/components/projects/search/searchQueries.js';
import { readToken } from '../fixtures.js';

const client = new PlaidClient(
  process.env.PLAID_CORE_URL || 'http://localhost:8085',
  readToken().token,
);
const roleOf = (l) => l?.config?.plaid?.role;
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${label}${ok || !detail ? '' : `  ${detail}`}`);
  if (!ok) failures++;
};
const section = (s) => console.log(`\n== ${s}`);

// A form nothing else in the project carries, so discovery finds exactly the
// documents this script seeded.
const RARE = 'zqxwv';

const name = `bulk-edit ${Date.now()}`;
const setup = await executeProjectSetup({
  client,
  isNewProject: true,
  resumeProjectId: null,
  setupData: {
    basicInfo: { projectName: name },
    orthographies: { orthographies: [{ name: 'Baseline', isBaseline: true }] },
    fields: {
      fields: [
        { name: 'Gloss', scope: 'Morpheme', isCustom: true },
        { name: 'Part of Speech', scope: 'Word', isCustom: true },
      ],
      ignoredTokens: {
        mode: 'unicode-punctuation',
        unicodePunctuationExceptions: [],
        explicitIgnoredTokens: [],
      },
    },
    vocabulary: {
      vocabularies: [{ id: 'new-1', name: `${name} Lexicon`, enabled: true, isCustom: true }],
    },
    documentMetadata: { enabledFields: [] },
  },
});
if (setup.failures.length) throw new Error(setup.failures.join('; '));
const PID = setup.projectId;
const VID = setup.resources.vocabularies[0].id;

try {
  const project = await client.projects.get(PID);
  const textLayer = project.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const L = Object.fromEntries(
    ['SENTENCE', 'WORD', 'MORPHEME'].map((k) => [
      k,
      textLayer.tokenLayers.find((l) => roleOf(l) === ROLES[k]).id,
    ]),
  );
  const glossLayer = textLayer.tokenLayers
    .find((l) => l.id === L.MORPHEME)
    .spanLayers.find((s) => s.name === 'Gloss');

  const mkdoc = async (docName, body) => {
    const d = await client.documents.create(PID, docName);
    await client.texts.create(textLayer.id, d.id, body);
    const raw = await client.documents.get(d.id, true);
    const textId = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE).text.id;
    const cps = [...body];
    const words = [];
    let i = 0;
    while (i < cps.length) {
      while (i < cps.length && /\s/.test(cps[i])) i++;
      if (i >= cps.length) break;
      const begin = i;
      while (i < cps.length && !/\s/.test(cps[i])) i++;
      words.push({ begin, end: i });
    }
    await client.tokens.bulkCreate([
      { tokenLayerId: L.SENTENCE, text: textId, begin: 0, end: cpLength(body) },
    ]);
    const wordIds = (
      await client.tokens.bulkCreate(
        words.map((w) => ({ tokenLayerId: L.WORD, text: textId, ...w })),
      )
    ).ids;
    const morphIds = (
      await client.tokens.bulkCreate(
        words.map((w) => ({ tokenLayerId: L.MORPHEME, text: textId, ...w, precedence: 1 })),
      )
    ).ids;
    return { id: d.id, textId, words, wordIds, morphIds, body };
  };

  const load = (id) => IgtDocument.load(client, PID, id);
  const wordsOf = (d) => d.sentences.flatMap((s) => s.tokens);
  const project2 = () => client.projects.get(PID);
  const info = () => getIgtLayerInfo(project);

  // Two documents, so every cross-document claim is actually tested.
  const body = `${RARE} and ${RARE} again`;
  const A = await mkdoc('Doc A', body);
  const B = await mkdoc('Doc B', `one ${RARE} more`);
  // A gloss on every morpheme of the rare word, in BOTH documents.
  for (const doc of [A, B]) {
    const marks = doc.words.map((w, i) => [w, doc.morphIds[i]]);
    const specs = marks
      .filter(([w]) => doc.body.slice(w.begin, w.end) === RARE)
      .map(([, mId]) => ({
        spanLayerId: glossLayer.id,
        tokens: [mId],
        value: 'old gloss',
      }));
    if (specs.length) await client.spans.bulkCreate(specs);
  }
  // Two lexicon entries spelled with the rare form, plus one link each.
  const keep = (await client.vocabItems.create(VID, RARE, { gloss: 'keeper' })).id;
  const lose = (await client.vocabItems.create(VID, RARE, { gloss: 'loser' })).id;
  const other = (await client.vocabItems.create(VID, 'other', { seeAlso: lose })).id;
  await client.vocabLinks.create(lose, [A.morphIds[0]]);
  await client.vocabLinks.create(lose, [B.morphIds[1]]);

  // ================= respell =================
  section('respell');
  {
    const { apply } = buildReplacer(RARE, 'exact', 'QQ');
    const plan = await planRespell(client, project, info(), {
      find: RARE,
      matchType: 'exact',
      apply,
    });
    check(
      plan.rows.length === 3,
      'respell previews every occurrence, in both documents',
      `${plan.rows.length} rows`,
    );
    check(plan.lexiconRows.length === 2, 'and both lexicon entries spelled that way');
    const res = await applyRespell(client, plan, {
      includeMorphemes: true,
      includeLexicon: true,
      label: 'Respell (live check)',
    });
    check(res.docsChanged === 2 && res.wordsChanged === 3, 'reports 2 documents, 3 words');
    const a = await load(A.id);
    const b = await load(B.id);
    check(
      wordsOf(a).filter((t) => t.content === 'QQ').length === 2 &&
        wordsOf(b).filter((t) => t.content === 'QQ').length === 1,
      'the text is respelled in both documents',
      `${a.sentences[0].tokens.map((t) => t.content).join('|')} / ${b.sentences[0].tokens
        .map((t) => t.content)
        .join('|')}`,
    );
    check(
      wordsOf(a).every((t) => t.morphemes.every((m) => m.metadata?.form !== RARE)),
      'no morpheme is left holding the old spelling',
    );
    const { vocabularies } = await loadProjectVocabularies(client, await project2());
    const forms = (vocabularies[VID]?.items || []).map((it) => it.form).sort();
    check(
      forms.filter((f) => f === 'QQ').length === 2 && !forms.includes(RARE),
      'both lexicon entries are respelled — the new bulk vocab-item update',
      JSON.stringify(forms),
    );
  }

  // ================= field replace =================
  section('field replace');
  {
    const target = searchDomains(info(), [])
      .filter((d) => d.kind === 'span')
      .find((d) => d.layerId === glossLayer.id);
    const { apply } = buildReplacer('old', 'contains', 'new');
    const plan = await planField(client, project, target, {
      find: 'old',
      matchType: 'contains',
      apply,
    });
    check(plan.rows.length === 3, 'previews the glosses in both documents', `${plan.rows.length}`);
    const res = await applyField(client, plan, { label: 'Replace (live check)' });
    check(res.changed === 3, 'reports every value replaced');
    const values = [];
    for (const id of [A.id, B.id]) {
      const d = await load(id);
      for (const w of wordsOf(d))
        for (const m of w.morphemes)
          if (m.annotations?.Gloss) values.push(m.annotations.Gloss.value);
    }
    check(
      values.length === 3 && values.every((v) => v === 'new gloss'),
      'one bulk span update reached BOTH documents',
      JSON.stringify(values),
    );
  }

  // ================= merge entries =================
  section('merge entries');
  {
    const { vocabularies } = await loadProjectVocabularies(client, await project2());
    const items = vocabularies[VID]?.items || [];
    const plan = await planMerge(client, project, VID, [lose]);
    check(plan.links.length === 2, 'finds the losing entry’s links in both documents');
    const refUpdates = metadataUpdates(
      [{ id: other, metadata: { seeAlso: keep } }],
      new Map(items.map((it) => [it.id, it.metadata])),
    );
    const res = await applyMerge(
      client,
      { links: plan.links, refUpdates },
      { survivorId: keep, loserIds: [lose], label: 'Merge (live check)' },
    );
    check(res.linksMoved === 2 && res.entriesRemoved === 1, 'reports the links moved');
    const after = await loadProjectVocabularies(client, await project2());
    const left = (after.vocabularies[VID]?.items || []).map((it) => it.id);
    check(!left.includes(lose), 'the losing entry is gone');
    const repointed = (after.vocabularies[VID]?.items || []).find((it) => it.id === other);
    check(
      repointed?.metadata?.seeAlso === keep,
      'the reference is repointed by the bulk vocab-item update',
      JSON.stringify(repointed?.metadata),
    );
    let onSurvivor = 0;
    for (const id of [A.id, B.id]) {
      const d = await load(id);
      for (const w of wordsOf(d))
        for (const m of w.morphemes) if (m.vocabItem?.id === keep) onSurvivor++;
    }
    check(onSurvivor === 2, 'both links were recreated on the survivor', `${onSurvivor}`);
  }

  // ================= re-analyze =================
  section('re-analyze a word');
  {
    // Every occurrence already carries material a replace has to STRIP: a
    // gloss span on its morpheme, and for two of them a vocabulary link the
    // merge recreated. That is the half of this path that deletes.
    const before = await load(A.id);
    check(
      wordsOf(before).some((t) => t.content === 'QQ' && t.morphemes[0]?.annotations?.Gloss),
      'the occurrences have an analysis to replace',
    );
    const plan = await planReanalyze(client, project, info(), 'QQ');
    check(plan.rows.length === 3, 'previews every occurrence of the form', `${plan.rows.length}`);
    const analysis = {
      word: { vocabItemId: null, fields: { 'Part of Speech': 'N' } },
      morphemes: [
        { form: 'Q', morphType: null, vocabItemId: null, fields: { Gloss: 'one' } },
        { form: 'Q', morphType: 'suffix', vocabItemId: null, fields: { Gloss: 'two' } },
      ],
    };
    const res = await applyReanalyze(client, plan, { analysis, label: 'Re-analyze (live check)' });
    check(!res.failedDoc, 'no document failed', String(res.failedDoc));
    let two = 0;
    let glossed = 0;
    for (const id of [A.id, B.id]) {
      const d = await load(id);
      for (const t of wordsOf(d)) {
        if (t.content !== 'QQ') continue;
        if (t.morphemes.length === 2) two++;
        if (t.morphemes.map((m) => m.annotations?.Gloss?.value).join(',') === 'one,two') glossed++;
      }
    }
    check(two === 3, 'every occurrence carries the two-morpheme analysis', `${two}`);
    check(glossed === 3, 'and both glosses, written by bulk span create', `${glossed}`);
  }
} finally {
  await client.projects.delete(PID).catch(() => {});
  await client.vocabLayers.delete(VID).catch(() => {});
}
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
