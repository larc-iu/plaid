// Live check of the LLM analyze service: it must follow the project's own
// data. Seeds a throwaway project with a lexicon (ler = PL, den = ABL, ev =
// house) and one fully analyzed example sentence, then asks the service to
// gloss a new sentence sharing those morphemes, and checks the proposal
// reuses the lexicon's glosses and segments, is stamped machine-made with
// the recorded prediction, and leaves the person's analysis alone.
// Needs the dev core on :8085 and the service running for all projects:
//   python services/igt_analyze_llm.py --url http://localhost:8085 --model openai/<id>
//   node e2e/llm-analyze-live.mjs
import PlaidClient, { ROLES, cpLength } from '@larc-iu/plaid-client';
import { IgtDocument } from '../src/domain/IgtDocument.js';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const name = `llm-analyze ${Date.now()}`;
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
        { name: 'Translation', scope: 'Sentence', isCustom: true },
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
  const trLayer = textLayer.tokenLayers
    .find((l) => l.id === L.SENTENCE)
    .spanLayers.find((s) => s.name === 'Translation');

  const splitWords = (body) => {
    const cps = [...body];
    const words = [];
    let i = 0;
    while (i < cps.length) {
      while (i < cps.length && /\s/.test(cps[i])) i++;
      if (i >= cps.length) break;
      const begin = i;
      while (i < cps.length && !/\s/.test(cps[i])) i++;
      words.push({ begin, end: i, text: cps.slice(begin, i).join('') });
    }
    return words;
  };
  // A document with sentence + word tokens and, per word, either one default
  // morpheme or the given chain [{form, gloss, morphType?}].
  const mkdoc = async (docName, body, translation, chains = {}) => {
    const d = await client.documents.create(PID, docName);
    await client.texts.create(textLayer.id, d.id, body);
    const raw = await client.documents.get(d.id, true);
    const textId = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE).text.id;
    const words = splitWords(body);
    const sent = await client.tokens.bulkCreate([
      { tokenLayerId: L.SENTENCE, text: textId, begin: 0, end: cpLength(body) },
    ]);
    await client.spans.create(trLayer.id, [sent.ids[0]], translation);
    const wt = await client.tokens.bulkCreate(
      words.map((w) => ({ tokenLayerId: L.WORD, text: textId, begin: w.begin, end: w.end })),
    );
    const morphReqs = [];
    const glossOf = [];
    words.forEach((w) => {
      const chain = chains[w.text] || [{}];
      chain.forEach((m, k) => {
        morphReqs.push({
          tokenLayerId: L.MORPHEME,
          text: textId,
          begin: w.begin,
          end: w.end,
          precedence: k + 1,
          metadata: {
            ...(m.form ? { form: m.form } : {}),
            ...(m.morphType ? { morphType: m.morphType } : {}),
          },
        });
        glossOf.push(m.gloss || null);
      });
    });
    const mt = await client.tokens.bulkCreate(morphReqs);
    for (let i = 0; i < mt.ids.length; i++) {
      if (glossOf[i]) await client.spans.create(glossLayer.id, [mt.ids[i]], glossOf[i]);
    }
    return { id: d.id, wordIds: wt.ids, morphIds: mt.ids };
  };

  // Lexicon: three entries the target sentence contains.
  const items = {};
  for (const [form, meta] of [
    ['ev', { gloss: 'house', pos: 'N' }],
    ['ler', { gloss: 'PL', morphType: 'suffix' }],
    ['den', { gloss: 'ABL', morphType: 'suffix' }],
    ['gel', { gloss: 'come', pos: 'V' }],
  ]) {
    items[form] = (await client.vocabItems.create(VID, form, meta)).id;
  }
  // Example sentence, fully analyzed by "a person" (no provenance), with links.
  const ex = await mkdoc('example', 'evler geliyor', 'the houses are coming', {
    evler: [
      { form: 'ev', gloss: 'house' },
      { form: 'ler', gloss: 'PL', morphType: 'suffix' },
    ],
    geliyor: [
      { form: 'gel', gloss: 'come' },
      { form: 'iyor', gloss: 'PROG', morphType: 'suffix' },
    ],
  });
  await client.vocabLinks.create(items.ev, [ex.morphIds[0]]);
  await client.vocabLinks.create(items.ler, [ex.morphIds[1]]);
  await client.vocabLinks.create(items.gel, [ex.morphIds[2]]);
  // Target: one unanalyzed sentence, plus one word a person already analyzed.
  const target = await mkdoc(
    'target',
    'evlerden geliyorum kedi',
    'I am coming from the houses cat',
    {
      kedi: [{ form: 'kedi', gloss: 'cat' }],
    },
  );

  let svc = null;
  for (let n = 0; n < 60 && !svc; n++) {
    const services = await client.messages.discoverServices(PID);
    svc = services.find(
      (s) =>
        s.online &&
        s.serviceId !== 'polygloss-analyzer' &&
        (s.extras?.tasks || []).includes('analyze'),
    );
    if (!svc) await sleep(2000);
  }
  if (!svc) throw new Error('no online LLM analyze service discovered on the project');
  console.log(`  using ${svc.serviceName} (${svc.serviceId})`);

  const result = await client.messages.requestService(
    PID,
    svc.serviceId,
    {
      language: 'Turkish',
      metalanguage: 'English',
      gloss_field: 'Gloss',
      translation_field: 'Translation',
      examples: 8,
      overwrite: false,
      documentId: target.id,
      projectId: PID,
      wordTokenLayerId: L.WORD,
      morphemeTokenLayerId: L.MORPHEME,
      sentenceTokenLayerId: L.SENTENCE,
    },
    300000,
    (p) => console.log('  progress', JSON.stringify(p)),
  );
  console.log('  result', JSON.stringify(result));

  const doc = await IgtDocument.load(client, PID, target.id);
  const ws = doc.sentences.flatMap((s) => s.tokens);
  const show = (w) =>
    w.morphemes
      .map((m) => `${m.metadata.form ?? m.content}=${m.annotations.Gloss?.value ?? '∅'}`)
      .join(' - ');
  for (const w of ws) console.log(`  ${w.content}: ${show(w)}`);
  const W = (c) => ws.find((w) => w.content === c);
  const chain = (w) =>
    w.morphemes.map((m) => [m.metadata.form ?? m.content, m.annotations.Gloss?.value ?? '']);

  check(
    result.lexiconEntries === 4 && result.exampleSentences === 1,
    'retrieval saw the lexicon and the example',
    JSON.stringify(result),
  );
  check(
    result.wordsWritten === 2 && result.skipped?.protected === 1,
    'two words written, the analyzed one skipped',
    JSON.stringify(result),
  );
  const evlerden = chain(W('evlerden'));
  check(
    evlerden.some(([f, g]) => f === 'ler' && g === 'PL') &&
      evlerden.some(([f, g]) => f === 'den' && g === 'ABL'),
    'evlerden: PL and ABL taken from the lexicon, with their segments',
    JSON.stringify(evlerden),
  );
  check(
    evlerden[0]?.[1] === 'house',
    'evlerden: ev glossed house as in the lexicon/example',
    JSON.stringify(evlerden),
  );
  const gel = chain(W('geliyorum'));
  check(
    gel[0]?.[0] === 'gel' && gel[0]?.[1] === 'come',
    'geliyorum: segmentation and gloss follow the example',
    JSON.stringify(gel),
  );
  const machine = (m) => m.metadata.prov === 'inferred' && !m.metadata.provConfirmed;
  check(
    W('evlerden').morphemes.every(
      (m) => machine(m) && m.metadata.provDetail?.form === (m.metadata.form ?? m.content),
    ) &&
      W('evlerden').morphemes.every(
        (m) => m.annotations.Gloss?.metadata?.provDetail?.value === m.annotations.Gloss?.value,
      ),
    'everything written is machine-unverified with the recorded prediction',
  );
  check(
    W('evlerden').morphemes[0].metadata.provSource === `service:${svc.serviceId}` &&
      W('evlerden').morphemes[0].metadata.provDetail?.model,
    'source and model recorded',
  );
  const kedi = chain(W('kedi'));
  check(
    kedi.length === 1 && kedi[0][1] === 'cat' && !W('kedi').morphemes[0].metadata.prov,
    "the person's analysis of kedi is untouched",
  );
} finally {
  await client.projects.delete(PID);
  await client.vocabLayers.delete(VID).catch(() => {});
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
