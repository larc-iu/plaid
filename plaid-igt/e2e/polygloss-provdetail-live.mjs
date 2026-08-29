// Live check that the PolyGloss service records its prediction on every row it
// writes: provDetail.form on morpheme tokens, provDetail.value on gloss spans
// (plus provDetail.boundaries on the first morpheme). Needs the dev core on
// :8085 and the service running, serving all projects:
//   python services/igt_analyze_polygloss.py --url http://localhost:8085
//   node e2e/polygloss-provdetail-live.mjs
// Net-neutral: creates one throwaway project and deletes it at the end.
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

const name = `polygloss-provdetail ${Date.now()}`;
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
  const trLayer = textLayer.tokenLayers
    .find((l) => l.id === L.SENTENCE)
    .spanLayers.find((s) => s.name === 'Translation');

  const body = process.env.BODY || 'evlerimizden geliyorum';
  const d = await client.documents.create(PID, 'D1');
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
  const sent = await client.tokens.bulkCreate([
    { tokenLayerId: L.SENTENCE, text: textId, begin: 0, end: cpLength(body) },
  ]);
  await client.tokens.bulkCreate(words.map((w) => ({ tokenLayerId: L.WORD, text: textId, ...w })));
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: L.MORPHEME, text: textId, ...w, precedence: 1 })),
  );
  await client.spans.create(
    trLayer.id,
    [sent.ids[0]],
    process.env.TRANSLATION || 'I am coming from our houses',
  );

  let svc = null;
  for (let n = 0; n < 120 && !svc; n++) {
    const services = await client.messages.discoverServices(PID);
    svc = services.find((s) => s.online && (s.extras?.tasks || []).includes('analyze'));
    if (!svc) await sleep(2000);
  }
  if (!svc) throw new Error('no online analyze service discovered on the project');
  console.log(`  using ${svc.serviceName} (${svc.serviceId})`);

  const result = await client.messages.requestService(
    PID,
    svc.serviceId,
    {
      language: process.env.LANG_NAME || 'Turkish',
      metalanguage: 'English',
      gloss_field: 'Gloss',
      translation_field: 'Translation',
      overwrite: false,
      documentId: d.id,
      projectId: PID,
      wordTokenLayerId: L.WORD,
      morphemeTokenLayerId: L.MORPHEME,
      sentenceTokenLayerId: L.SENTENCE,
    },
    300000,
    (p) => console.log('  progress', JSON.stringify(p)),
  );
  console.log('  result', JSON.stringify(result));

  const doc = await IgtDocument.load(client, PID, d.id);
  const ws = doc.sentences.flatMap((s) => s.tokens);
  for (const w of ws) {
    console.log(
      `  ${w.content}: ` +
        w.morphemes
          .map(
            (m) =>
              `${m.metadata.form ?? m.content}[${JSON.stringify(m.metadata.provDetail)}]` +
              `=${m.annotations.Gloss?.value ?? '∅'}[${JSON.stringify(m.annotations.Gloss?.metadata?.provDetail)}]`,
          )
          .join(' - '),
    );
  }
  const machineMorphs = ws.flatMap((w) => w.morphemes).filter((m) => m.metadata.prov);
  const glossSpans = ws.flatMap((w) => w.morphemes.map((m) => m.annotations.Gloss)).filter(Boolean);
  check(machineMorphs.length > 0, 'service wrote machine morphemes');
  check(
    machineMorphs.every((m) => m.metadata.provDetail?.form === m.metadata.form),
    'every machine morpheme carries provDetail.form equal to its form',
  );
  check(
    ws.every(
      (w) =>
        !w.morphemes[0].metadata.prov ||
        typeof w.morphemes[0].metadata.provDetail?.boundaries === 'string',
    ),
    'first morphemes keep provDetail.boundaries',
  );
  check(glossSpans.length > 0, 'service wrote gloss spans');
  check(
    glossSpans.every((s) => s.metadata?.provDetail?.value === s.value),
    'every gloss span carries provDetail.value equal to its value',
  );
  check(
    glossSpans.every((s) => s.metadata?.provDetail?.model && !('provProb' in (s.metadata || {}))),
    'model recorded, no provProb (PolyGloss has no probabilities)',
  );
} finally {
  await client.projects.delete(PID);
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
