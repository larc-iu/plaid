// Live check of the LLM translation service against the write contract and
// the recorded prediction. A throwaway project with three sentences: one
// glossed (the draft must follow the glosses), one bare, one already
// translated by a person (must be left alone, twice).
// Needs the dev core on :8085 and the service running for all projects:
//   python services/igt_translate_llm.py --url http://localhost:8085 --model openai/<id>
//   node e2e/translate-live.mjs
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

const name = `translate ${Date.now()}`;
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
    vocabulary: { vocabularies: [] },
    documentMetadata: { enabledFields: [] },
  },
});
if (setup.failures.length) throw new Error(setup.failures.join('; '));
const PID = setup.projectId;
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

  // Three sentences, one per line. Chains: word -> [{form, gloss}].
  const lines = ['evler geliyor', 'kedi uyuyor', 'ben gidiyorum'];
  const body = lines.join('\n');
  const chains = {
    evler: [
      { form: 'ev', gloss: 'house' },
      { form: 'ler', gloss: 'PL' },
    ],
    geliyor: [
      { form: 'gel', gloss: 'come' },
      { form: 'iyor', gloss: 'PROG' },
    ],
  };
  const d = await client.documents.create(PID, 'D1');
  await client.texts.create(textLayer.id, d.id, body);
  const raw = await client.documents.get(d.id, true);
  const textId = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE).text.id;
  const cps = [...body];
  const sentReqs = [];
  const wordReqs = [];
  const morphReqs = [];
  const glossOf = [];
  let pos = 0;
  lines.forEach((line, li) => {
    const begin = pos;
    const end = pos + cpLength(line);
    // Sentences must partition the text without gaps: each one also covers
    // the newline that follows it.
    const sentEnd = li === lines.length - 1 ? cpLength(body) : end + 1;
    sentReqs.push({ tokenLayerId: L.SENTENCE, text: textId, begin, end: sentEnd });
    let i = begin;
    while (i < end) {
      while (i < end && /\s/.test(cps[i])) i++;
      if (i >= end) break;
      const wb = i;
      while (i < end && !/\s/.test(cps[i])) i++;
      const w = cps.slice(wb, i).join('');
      wordReqs.push({ tokenLayerId: L.WORD, text: textId, begin: wb, end: i });
      (chains[w] || [{}]).forEach((m, k) => {
        morphReqs.push({
          tokenLayerId: L.MORPHEME,
          text: textId,
          begin: wb,
          end: i,
          precedence: k + 1,
          metadata: m.form ? { form: m.form } : {},
        });
        glossOf.push(m.gloss || null);
      });
    }
    pos = end + 1;
  });
  const sents = await client.tokens.bulkCreate(sentReqs);
  await client.tokens.bulkCreate(wordReqs);
  const morphs = await client.tokens.bulkCreate(morphReqs);
  for (let i = 0; i < morphs.ids.length; i++) {
    if (glossOf[i]) await client.spans.create(glossLayer.id, [morphs.ids[i]], glossOf[i]);
  }
  // Sentence 3 already translated by a person.
  await client.spans.create(trLayer.id, [sents.ids[2]], 'I am going');

  let svc = null;
  for (let n = 0; n < 60 && !svc; n++) {
    const services = await client.messages.discoverServices(PID);
    svc = services.find((s) => s.online && (s.extras?.tasks || []).includes('translate'));
    if (!svc) await sleep(2000);
  }
  if (!svc) throw new Error('no online translate service discovered on the project');
  console.log(`  using ${svc.serviceName} (${svc.serviceId})`);
  const request = (overrides = {}) =>
    client.messages.requestService(
      PID,
      svc.serviceId,
      {
        language: 'Turkish',
        metalanguage: 'English',
        translation_field: 'Translation',
        use_glosses: true,
        gloss_field: 'Gloss',
        context: 2,
        overwrite: false,
        documentId: d.id,
        projectId: PID,
        wordTokenLayerId: L.WORD,
        morphemeTokenLayerId: L.MORPHEME,
        sentenceTokenLayerId: L.SENTENCE,
        ...overrides,
      },
      300000,
    );

  const r1 = await request();
  console.log('  run 1', JSON.stringify(r1));
  let doc = await IgtDocument.load(client, PID, d.id);
  const tr = (i) => doc.sentences[i].annotations.Translation;
  for (let i = 0; i < 3; i++)
    console.log(`  S${i + 1}: ${JSON.stringify(tr(i)?.value)}`, tr(i)?.metadata?.prov ?? 'human');
  check(
    r1.sentencesWritten === 2 && r1.sentencesReplaced === 0 && r1.skipped?.protected === 1,
    'run 1: two drafts, the human translation skipped',
    JSON.stringify(r1),
  );
  check(
    /house/i.test(tr(0)?.value || '') && /com/i.test(tr(0)?.value || ''),
    'S1 draft follows the glosses (house, come)',
    tr(0)?.value,
  );
  check(!!tr(1)?.value, 'S2 (no glosses) got a draft', tr(1)?.value);
  const machineOk = (s) =>
    s?.metadata?.prov === 'inferred' &&
    !s.metadata.provConfirmed &&
    s.metadata.provSource === `service:${svc.serviceId}` &&
    s.metadata.provDetail?.value === s.value &&
    !!s.metadata.provDetail?.model &&
    !('provProb' in s.metadata);
  check(
    machineOk(tr(0)) && machineOk(tr(1)),
    'drafts are machine-unverified with the recorded prediction, no provProb',
  );
  check(
    tr(2)?.value === 'I am going' && !tr(2)?.metadata?.prov,
    "the person's translation is untouched",
  );

  const r2 = await request();
  doc = await IgtDocument.load(client, PID, d.id);
  check(
    r2.sentencesWritten === 2 && r2.sentencesReplaced === 2 && r2.skipped?.protected === 1,
    'run 2: machine drafts replaced, human one still skipped',
    JSON.stringify(r2),
  );
  check(tr(2)?.value === 'I am going' && !tr(2)?.metadata?.prov, 'still untouched after the rerun');
  check(machineOk(tr(0)), 'a replaced draft is stamped afresh');
} finally {
  await client.projects.delete(PID);
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
