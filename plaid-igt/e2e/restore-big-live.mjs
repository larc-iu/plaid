// Restore on a big document. Seeds a throwaway document of `sentences` x
// `wordsPerSentence` words with a morpheme, a gloss and a part of speech per
// word and a translation per sentence, remembers T, edits every region (a
// word inserted at the very start so every offset moves, three sentences cut
// out, fifty respellings, hundreds of annotations deleted or changed, a
// rename), restores to T and compares with the server's as-of read, id-free.
// Prints how long each phase took. Disposable, like the rest of e2e/.
//
//   node e2e/restore-big-live.mjs [sentences] [wordsPerSentence]
//   PLAID_STRICT=1 node e2e/restore-big-live.mjs

import {
  makeClient,
  getFixtureProjectId,
  resolveLayers,
  cpTokenize,
  cleanupDoc,
  makeRng,
  pick,
  randInt,
  cpLength,
} from './bugbash/harness.mjs';
import { runAllInvariants } from './bugbash/invariants.mjs';
import { IgtDocument } from '../src/domain/IgtDocument.js';
import { indexDocument, normalizeState, compareStates } from '../src/restore/restorePlan.js';
import { runRestore, previewRestore } from '../src/restore/restoreRunner.js';

const SENTENCES = process.argv[2] ? Number(process.argv[2]) : 120;
const PER = process.argv[3] ? Number(process.argv[3]) : 13;
const STRICT = process.env.PLAID_STRICT === '1';
const rng = makeRng(2026);
const client = makeClient();
const log = (...a) => console.log(...a);
const ms = (t0) => `${(performance.now() - t0).toFixed(0)}ms`;
const chunks = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

const WORDS = [
  'todos',
  'los',
  'seres',
  'humanos',
  'nacen',
  'libres',
  'iguales',
  'dignidad',
  'derechos',
  'razón',
  'conciencia',
  'deben',
  'comportarse',
  'fraternalmente',
  'unos',
  'otros',
];
const VALUES = ['NOUN', 'VERB', 'ADJ', 'DET', 'ADP', 'PUNCT'];

const read = async (id, asOf) => indexDocument(await client.documents.get(id, true, asOf));

const projectId = await getFixtureProjectId(client);
const project = await client.projects.get(projectId);
const L = resolveLayers(project);

// ---- seed -------------------------------------------------------------------
let t0 = performance.now();
const sentenceTexts = Array.from(
  { length: SENTENCES },
  () => Array.from({ length: PER }, () => pick(rng, WORDS)).join(' ') + '.',
);
const body = sentenceTexts.join(' ');
const created = await client.documents.create(projectId, `Big restore ${Date.now()}`);
const documentId = created.id;
try {
  await client.texts.create(L.textLayerId, documentId, body);
  let idx = await read(documentId);
  const textId = idx.text.id;
  const spanLayerOf = (role, name) => idx.layers[role].spanLayers.find((s) => s.name === name)?.id;
  const POS = spanLayerOf('word', 'Part of Speech');
  const GLOSS = spanLayerOf('morpheme', 'Gloss');
  const TRANSLATION = spanLayerOf('sentence', 'Translation');
  if (!POS || !GLOSS || !TRANSLATION) throw new Error('fixture span layers missing');

  // Sentences tile the text: each runs to the start of the next.
  const sentSpecs = [];
  let at = 0;
  for (const [i, s] of sentenceTexts.entries()) {
    const end = i === sentenceTexts.length - 1 ? cpLength(body) : at + cpLength(s) + 1;
    sentSpecs.push({ tokenLayerId: L.sentenceLayerId, text: textId, begin: at, end });
    at = end;
  }
  await client.tokens.bulkCreate(sentSpecs);
  const words = cpTokenize(body);
  for (const c of chunks(words, 500)) {
    await client.tokens.bulkCreate(
      c.map((w) => ({ tokenLayerId: L.wordLayerId, text: textId, begin: w.begin, end: w.end })),
    );
  }
  // One morpheme per word, two for every fifth word.
  const morphSpecs = [];
  const cps = Array.from(body);
  words.forEach((w, i) => {
    const form = cps.slice(w.begin, w.end).join('');
    if (i % 5 === 4 && form.length > 2) {
      const cut = Math.floor(form.length / 2);
      morphSpecs.push(
        {
          tokenLayerId: L.morphemeLayerId,
          text: textId,
          begin: w.begin,
          end: w.end,
          precedence: 1,
          metadata: { form: form.slice(0, cut) },
        },
        {
          tokenLayerId: L.morphemeLayerId,
          text: textId,
          begin: w.begin,
          end: w.end,
          precedence: 2,
          metadata: { form: form.slice(cut) },
        },
      );
    } else {
      morphSpecs.push({
        tokenLayerId: L.morphemeLayerId,
        text: textId,
        begin: w.begin,
        end: w.end,
        precedence: 1,
        metadata: { form },
      });
    }
  });
  for (const c of chunks(morphSpecs, 500)) await client.tokens.bulkCreate(c);
  idx = await read(documentId);
  const spanSpecs = [];
  for (const w of idx.layers.word.tokens.values())
    spanSpecs.push({ spanLayerId: POS, tokens: [w.id], value: pick(rng, VALUES) });
  for (const m of idx.layers.morpheme.tokens.values())
    spanSpecs.push({ spanLayerId: GLOSS, tokens: [m.id], value: pick(rng, WORDS).toUpperCase() });
  for (const s of idx.layers.sentence.tokens.values())
    spanSpecs.push({
      spanLayerId: TRANSLATION,
      tokens: [s.id],
      value: `Translation of ${s.begin}`,
    });
  for (const layerId of [POS, GLOSS, TRANSLATION]) {
    const mine = spanSpecs.filter((sp) => sp.spanLayerId === layerId);
    for (const c of chunks(mine, 500)) await client.spans.bulkCreate(c);
  }
  idx = await read(documentId);
  log(
    `seeded in ${ms(t0)}: ${cpLength(body)} code points, ${idx.layers.sentence.tokens.size} sentences, ${idx.layers.word.tokens.size} words, ${idx.layers.morpheme.tokens.size} morphemes, ${idx.spans.size} annotations`,
  );

  const audit = await client.documents.audit(documentId);
  const last = audit[audit.length - 1];
  const T = last.endTime || last.time;
  t0 = performance.now();
  const target = normalizeState(await read(documentId, T));
  log(`as-of read of T in ${ms(t0)}`);
  const sanity = compareStates(normalizeState(idx), target);
  if (sanity.length) throw new Error(`as-of read differs from live at T: ${sanity.join('; ')}`);

  // ---- edits after T -------------------------------------------------------
  t0 = performance.now();
  // A word at the very start: every offset in the document moves.
  await client.texts.update(textId, 'Nuevo ' + idx.text.body);
  idx = await read(documentId);
  // Three sentences cut out of the middle.
  const sents = [...idx.layers.sentence.tokens.values()].sort((a, b) => a.begin - b.begin);
  const cut = sents.slice(40, 43);
  {
    const c = Array.from(idx.text.body);
    c.splice(cut[0].begin, cut[2].end - cut[0].begin);
    await client.texts.update(textId, c.join(''));
  }
  idx = await read(documentId);
  // Fifty respellings in one text update.
  {
    const c = Array.from(idx.text.body);
    const ws = [...idx.layers.word.tokens.values()].filter((w) => w.end - w.begin > 3);
    const picked = new Set();
    while (picked.size < 50) picked.add(pick(rng, ws));
    for (const w of [...picked].sort((a, b) => b.begin - a.begin)) {
      c.splice(w.begin, w.end - w.begin, ...c.slice(w.begin, w.end).join('').toUpperCase());
    }
    await client.texts.update(textId, c.join(''));
  }
  idx = await read(documentId);
  // Annotations: 200 deleted, 300 changed. Morphemes: 100 deleted.
  const allSpans = [...idx.spans.values()];
  const doomed = new Set();
  while (doomed.size < 200) doomed.add(pick(rng, allSpans).id);
  await client.spans.bulkDelete([...doomed]);
  const changed = allSpans.filter((s) => !doomed.has(s.id)).slice(0, 300);
  for (const c of chunks(changed, 200)) {
    await client.batched(async () => {
      for (const s of c) client.spans.update(s.id, pick(rng, VALUES));
    });
  }
  const morphs = [...idx.layers.morpheme.tokens.values()].filter((m) => m.precedence === 2);
  await client.tokens.bulkDelete(morphs.slice(0, 100).map((m) => m.id));
  await client.documents.update(documentId, 'Big restore, renamed');
  await client.documents.setMetadata(documentId, { note: 'edited' });
  log(`edited in ${ms(t0)}`);

  // ---- restore ---------------------------------------------------------------
  if (STRICT) {
    client.enterStrictMode(documentId);
    await client.documents.get(documentId, true, T);
  }
  t0 = performance.now();
  const preview = await previewRestore({ client, documentId, asOf: T });
  log(`preview in ${ms(t0)}: ${JSON.stringify(preview.summary)}`);
  t0 = performance.now();
  let phaseStart = performance.now();
  let phase = null;
  const res = await runRestore({
    client,
    documentId,
    asOf: T,
    label: 'seed',
    onProgress: (p) => {
      if (phase) log(`  ${phase}: ${ms(phaseStart)}`);
      phase = p;
      phaseStart = performance.now();
    },
  });
  log(`  ${phase}: ${ms(phaseStart)}`);
  log(`restored in ${ms(t0)}: exact ${res.exact}, ${res.warnings.length} warnings`);
  const after = normalizeState(await read(documentId));
  const diffs = compareStates(after, target);
  const again = await runRestore({ client, documentId, asOf: T });
  if (STRICT) client.exitStrictMode();
  const inv = runAllInvariants(await IgtDocument.load(client, projectId, documentId));
  const failures = [];
  if (diffs.length) failures.push(`restored state differs: ${diffs.join('; ')}`);
  if (!res.exact) failures.push(`self-check: ${res.differences.join('; ')}`);
  if (res.warnings.length) failures.push(`warnings: ${res.warnings.join('; ')}`);
  if (again.summary.total !== 0) failures.push(`second restore planned ${again.summary.total}`);
  if (!inv.ok)
    failures.push(`invariants: ${inv.violations.map((v) => `${v.name}: ${v.msg}`).join('; ')}`);
  if (failures.length) {
    console.error('FAIL\n  ' + failures.join('\n  '));
    process.exitCode = 1;
  } else log('ok: big document restored exactly');
} finally {
  if (STRICT) client.exitStrictMode();
  await cleanupDoc(client, documentId);
}
