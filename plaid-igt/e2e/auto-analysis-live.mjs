// Live e2e for TEST_PLAN A5 (built-in auto-link) and A6 (analysis copy) auto
// rows. Precedent is project-wide, so this builds its OWN throwaway project
// (wizard setup helper + one lexicon), seeds precedent documents, and drives
// runBuiltinAnalysis exactly as the Auto-link dialog does. Every assertion
// reads a fresh IgtDocument from the server. Project + lexicon are deleted at
// the end.
//   cd plaid-igt && node e2e/auto-analysis-live.mjs
import PlaidClient, { ROLES, stampInferred, cpLength } from '@larc-iu/plaid-client';
import { IgtDocument } from '../src/domain/IgtDocument.js';
import { runBuiltinAnalysis } from '../src/domain/autoPass.js';
import { executeProjectSetup } from '../src/components/projects/setup/executeSetup.js';
import { readToken } from './fixtures.js';

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

const name = `auto-analysis ${Date.now()}`;
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
  const posLayer = textLayer.tokenLayers
    .find((l) => l.id === L.WORD)
    .spanLayers.find((s) => s.name === 'Part of Speech');
  const items = {};
  for (const [key, form] of [
    ['ser1', 'ser'],
    ['ser2', 'ser'],
    ['todos', 'todos'],
    ['gato', 'gato'],
    ['mesa', 'mesa'],
    ['emoji', '😀'],
    ['cas', 'cas'],
  ]) {
    items[key] = (await client.vocabItems.create(VID, form)).id;
  }

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
    await client.tokens.bulkCreate(
      words.map((w) => ({ tokenLayerId: L.WORD, text: textId, ...w })),
    );
    await client.tokens.bulkCreate(
      words.map((w) => ({ tokenLayerId: L.MORPHEME, text: textId, ...w, precedence: 1 })),
    );
    return { id: d.id, textId };
  };
  const load = (id) => IgtDocument.load(client, PID, id);
  const words = (d) => d.sentences.flatMap((s) => s.tokens);
  const W = (d, content, i = 0) => words(d).filter((t) => t.content === content)[i];
  const link = (m) => m?.vocabItem || null;
  // Second morpheme for a word (seeding an analysis by hand).
  const addMorph = (doc, word, prec, metadata) =>
    client.tokens.create(L.MORPHEME, doc.textId, word.begin, word.end, prec, metadata);

  // ================= A5: auto-link =================
  section('A5 auto-link');
  const T1 = await mkdoc('T1', 'ser Todos ... $ 😀 gato mesa');
  let d = await load(T1.id);
  let res = await runBuiltinAnalysis(d, { link: true, copy: false });
  check(
    res.ok && res.linked === 5,
    'A5-01 first run links ser, Todos, 😀, gato, mesa',
    JSON.stringify(res),
  );
  d = await load(T1.id);
  check(
    link(W(d, 'ser').morphemes[0])?.id === items.ser1,
    'A5-02 homonym without precedent: smallest id (ser₁)',
    JSON.stringify(link(W(d, 'ser').morphemes[0])),
  );
  check(
    link(W(d, 'ser').morphemes[0])?.prov === 'machine' && !W(d, 'ser').vocabItem,
    'A5-02 link is machine, on the morpheme only',
  );
  check(
    link(W(d, 'Todos').morphemes[0])?.id === items.todos,
    'A5-04 sentence-initial Todos links casefolded todos',
  );
  check(
    !link(W(d, '...').morphemes[0]) && !W(d, '...').vocabItem && !link(W(d, '$').morphemes[0]),
    'A5-08 ignored tokens never proposed',
  );
  check(
    link(W(d, '😀').morphemes[0])?.id === items.emoji,
    'A5-08 emoji is proposed when an entry exists',
  );
  const gatoLinkId = link(W(d, 'gato').morphemes[0])?.linkId;
  const before = JSON.stringify(words(d).map((t) => [t.morphemes[0].vocabItem?.linkId]));
  res = await runBuiltinAnalysis(d, { link: true, copy: false });
  d = await load(T1.id);
  check(
    res.linked === 0 &&
      before === JSON.stringify(words(d).map((t) => [t.morphemes[0].vocabItem?.linkId])),
    'A5-07 rerun: nothing to do, link ids unchanged',
    JSON.stringify(res),
  );

  // A5-03 precedent beats the homonym rule: P1 links ser -> ser₂ twice (human).
  const P1 = await mkdoc('P1', 'ser ser ser ser ser');
  let p = await load(P1.id);
  const pSer = words(p).map((t) => t.morphemes[0].id);
  await client.vocabLinks.create(items.ser2, [pSer[0]]);
  await client.vocabLinks.create(items.ser2, [pSer[1]]);
  const T2 = await mkdoc('T2', 'ser gato Todos');
  d = await load(T2.id);
  // gato's morpheme is hand-linked to `mesa`: a human link the rule must not touch.
  await client.vocabLinks.create(items.mesa, [W(d, 'gato').morphemes[0].id]);
  d = await load(T2.id);
  res = await runBuiltinAnalysis(d, { link: true, copy: false });
  d = await load(T2.id);
  check(
    link(W(d, 'ser').morphemes[0])?.id === items.ser2,
    'A5-03 precedent (ser₂) wins over the smallest-id rule',
  );
  const serLinkOld = link(W(d, 'ser').morphemes[0])?.linkId;
  check(
    link(W(d, 'gato').morphemes[0])?.id === items.mesa &&
      link(W(d, 'gato').morphemes[0])?.prov === 'human',
    'A5-05 human link left alone',
  );

  // A5-05 precedent flips: three ser -> ser₁ links now outvote the two ser₂ ones.
  await client.vocabLinks.create(items.ser1, [pSer[2]]);
  await client.vocabLinks.create(items.ser1, [pSer[3]]);
  await client.vocabLinks.create(items.ser1, [pSer[4]]);
  // Confirm T2's Todos link: verified links are protected too.
  d = await load(T2.id);
  await d.confirmVocabLink(W(d, 'Todos').morphemes[0].id);
  d = await load(T2.id);
  const todosLink = link(W(d, 'Todos').morphemes[0]);
  res = await runBuiltinAnalysis(d, { link: true, copy: false });
  d = await load(T2.id);
  const serNow = link(W(d, 'ser').morphemes[0]);
  check(
    res.linked === 1 &&
      serNow?.id === items.ser1 &&
      serNow.linkId !== serLinkOld &&
      serNow.prov === 'machine',
    'A5-05 machine link replaced by the new precedent (new link, still machine)',
    JSON.stringify({ res, serNow }),
  );
  check(
    link(W(d, 'Todos').morphemes[0])?.linkId === todosLink.linkId &&
      link(W(d, 'Todos').morphemes[0])?.prov === 'verified',
    'A5-05 verified link untouched',
  );
  check(link(W(d, 'gato').morphemes[0])?.id === items.mesa, 'A5-05 human link still untouched');
  res = await runBuiltinAnalysis(d, { link: true, copy: false });
  check(res.linked === 0, 'A5-05 unchanged proposals write nothing', JSON.stringify(res));

  // A5-06 the rule loses its opinion (item renamed): the machine link stays.
  await client.vocabItems.update(items.gato, 'perro');
  d = await load(T1.id);
  res = await runBuiltinAnalysis(d, { link: true, copy: false });
  d = await load(T1.id);
  check(
    res.linked === 0 && link(W(d, 'gato').morphemes[0])?.linkId === gatoLinkId,
    'A5-06 unresolvable form keeps its existing machine link',
    JSON.stringify(res),
  );

  // ================= A6: analysis copy =================
  section('A6 analysis copy');
  const S = await mkdoc('S', 'casa perro perro luna sol');
  let s = await load(S.id);
  const casa = W(s, 'casa');
  await client.tokens.patchMetadata(casa.morphemes[0].id, { form: 'cas' });
  const casaA = await addMorph(S, casa, 2, { form: 'a', morphType: 'suffix' });
  await client.spans.create(glossLayer.id, [casa.morphemes[0].id], 'house');
  await client.spans.create(glossLayer.id, [casaA.id], 'F');
  await client.vocabLinks.create(items.cas, [casa.morphemes[0].id]);
  await client.spans.create(posLayer.id, [casa.id], 'N');
  // perro: two different hand analyses (tie).
  const perro0 = W(s, 'perro', 0);
  const perro1 = W(s, 'perro', 1);
  await client.tokens.patchMetadata(perro0.morphemes[0].id, { form: 'per' });
  await addMorph(S, perro0, 2, { form: 'ro' });
  await client.tokens.patchMetadata(perro1.morphemes[0].id, { form: 'perr' });
  await addMorph(S, perro1, 2, { form: 'o' });
  // luna: only a machine-unverified analysis exists.
  const luna = W(s, 'luna');
  await client.tokens.patchMetadata(luna.morphemes[0].id, {
    form: 'lun',
    ...stampInferred('rule:analysis-precedent'),
  });
  await addMorph(S, luna, 2, { form: 'a', ...stampInferred('rule:analysis-precedent') });

  const T3 = await mkdoc('T3', 'casa casa perro luna sol');
  d = await load(T3.id);
  await client.spans.create(posLayer.id, [W(d, 'sol').id], 'N'); // already has a value: never a target
  d = await load(T3.id);
  const copyAll = { segmentation: true, links: true, fields: true };
  res = await runBuiltinAnalysis(d, { link: false, copy: true, copyContents: copyAll });
  d = await load(T3.id);
  check(res.ok && res.copied === 2, 'A6-01 two casa words copied', JSON.stringify(res));
  const c0 = W(d, 'casa', 0);
  const c1 = W(d, 'casa', 1);
  const shape = (w) =>
    w.morphemes.map((m) => [
      m.metadata.form,
      m.metadata.morphType ?? null,
      m.annotations.Gloss?.value ?? null,
      m.vocabItem?.id ?? null,
    ]);
  check(
    JSON.stringify(shape(c0)) ===
      JSON.stringify([
        ['cas', null, 'house', items.cas],
        ['a', 'suffix', 'F', null],
      ]),
    'A6-01 copied segmentation + morphTypes + glosses + link',
    JSON.stringify(shape(c0)),
  );
  check(c0.annotations['Part of Speech']?.value === 'N', 'A6-01 word field copied');
  const allMachine = (w) =>
    w.morphemes.every((m) => m.metadata.prov === 'inferred' && !m.metadata.provConfirmed) &&
    w.morphemes.every(
      (m) =>
        !m.annotations.Gloss ||
        (m.annotations.Gloss.metadata?.prov === 'inferred' &&
          !m.annotations.Gloss.metadata.provConfirmed),
    ) &&
    (!c0.morphemes[0].vocabItem || c0.morphemes[0].vocabItem.prov === 'machine');
  check(
    allMachine(c0) &&
      allMachine(c1) &&
      c0.annotations['Part of Speech'].metadata?.provSource === 'rule:analysis-precedent',
    'A6-01 everything copied is machine-unverified with the copy source',
  );
  // Prediction extras: the copy records what it wrote, per entity.
  check(
    c0.morphemes[0].metadata.provDetail?.form === 'cas' &&
      c0.morphemes[1].metadata.provDetail?.form === 'a' &&
      c0.morphemes[0].annotations.Gloss.metadata?.provDetail?.value === 'house' &&
      c0.morphemes[1].annotations.Gloss.metadata?.provDetail?.value === 'F' &&
      c0.annotations['Part of Speech'].metadata?.provDetail?.value === 'N',
    'A6-01b copied morphemes carry provDetail.form and copied spans provDetail.value',
    JSON.stringify(c0.morphemes.map((m) => m.metadata.provDetail)),
  );
  check(
    W(d, 'perro').morphemes.length === 1 && !W(d, 'perro').morphemes[0].metadata.form,
    'A6-02 tied form not copied',
  );
  check(
    W(d, 'luna').morphemes.length === 1,
    'A6-03 form whose only precedent is machine-unverified not copied',
  );
  check(
    W(d, 'sol').morphemes.length === 1 &&
      W(d, 'sol').annotations['Part of Speech'].value === 'N' &&
      !W(d, 'sol').annotations['Part of Speech'].metadata?.prov,
    'A6-04 word with a value never touched',
  );

  // A6-06 Ctrl+Enter on a copied word verifies everything in one go.
  await d.confirmWordAnalysis(c0.id);
  d = await load(T3.id);
  const v0 = W(d, 'casa', 0);
  const allVerified =
    v0.morphemes.every(
      (m) =>
        m.metadata.provConfirmed === true && m.annotations.Gloss.metadata.provConfirmed === true,
    ) &&
    v0.morphemes[0].vocabItem.prov === 'verified' &&
    v0.annotations['Part of Speech'].metadata.provConfirmed === true;
  check(allVerified, 'A6-06 confirm verifies token metadata, links and spans of the copied word');
  // A6-07 editing one copied gloss verifies only that span.
  await d.updateMorphemeSpan(c1.morphemes[0].id, 'Gloss', 'HOUSE');
  d = await load(T3.id);
  const v1 = W(d, 'casa', 1);
  check(
    v1.morphemes[0].annotations.Gloss.value === 'HOUSE' &&
      v1.morphemes[0].annotations.Gloss.metadata.provConfirmed === true,
    'A6-07 edited gloss verified',
  );
  check(
    !v1.morphemes[1].annotations.Gloss.metadata.provConfirmed &&
      !v1.morphemes[0].metadata.provConfirmed &&
      v1.morphemes[0].vocabItem.prov === 'machine',
    'A6-07 the rest of the word stays machine',
  );
  // A6-08 rerun: no targets left.
  const snap = JSON.stringify(words(d).map(shape));
  res = await runBuiltinAnalysis(d, { link: false, copy: true, copyContents: copyAll });
  d = await load(T3.id);
  check(
    res.copied === 0 && snap === JSON.stringify(words(d).map(shape)),
    'A6-08 rerun copies nothing',
    JSON.stringify(res),
  );
  // A6-03 (second half): once the machine analysis of luna is confirmed it counts as precedent.
  s = await load(S.id);
  await s.confirmWordAnalysis(W(s, 'luna').id);
  d = await load(T3.id);
  res = await runBuiltinAnalysis(d, { link: false, copy: true, copyContents: copyAll });
  d = await load(T3.id);
  check(
    res.copied === 1 &&
      W(d, 'luna')
        .morphemes.map((m) => m.metadata.form)
        .join('-') === 'lun-a',
    'A6-03 verified precedent now copies',
    JSON.stringify(res),
  );
  // A6-05 (data-level): copy contents toggles.
  const T4 = await mkdoc('T4', 'casa');
  d = await load(T4.id);
  res = await runBuiltinAnalysis(d, {
    link: false,
    copy: true,
    copyContents: { segmentation: true, links: false, fields: false },
  });
  d = await load(T4.id);
  const t4 = W(d, 'casa');
  check(
    res.copied === 1 &&
      t4.morphemes.map((m) => m.metadata.form).join('-') === 'cas-a' &&
      !t4.morphemes[0].vocabItem &&
      !t4.morphemes[0].annotations.Gloss &&
      !t4.annotations['Part of Speech'],
    'A6-05 segmentation only: no links, no fields',
    JSON.stringify(shape(t4)),
  );
} finally {
  await client.projects.delete(PID).catch(() => {});
  await client.vocabLayers.delete(VID).catch(() => {});
}
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
