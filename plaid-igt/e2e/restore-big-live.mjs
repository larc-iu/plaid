// Restore on a big document, through the server. Seeds a throwaway document
// of `sentences` x `wordsPerSentence` words with a morpheme, a gloss and a
// part of speech per word and a translation per sentence, remembers T,
// edits every region (a word inserted at the very start so every offset
// moves, three sentences cut out, fifty respellings, hundreds of
// annotations deleted or changed, a rename), restores to T with
// documents.restore and compares the live read with the as-of read, ids
// included. Prints the timings. Disposable, like the rest of e2e/.
//
//   node e2e/restore-big-live.mjs [sentences] [wordsPerSentence]

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

const SENTENCES = process.argv[2] ? Number(process.argv[2]) : 120;
const PER = process.argv[3] ? Number(process.argv[3]) : 13;
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

// The deep read minus what a restore rightly changes.
const comparable = (raw) => {
  const { version, timeModified, mediaUrl, ...rest } = raw;
  return JSON.stringify(rest);
};
const byRole = (raw, role) => {
  for (const tl of raw.textLayers)
    for (const l of tl.tokenLayers) if (l.config?.plaid?.role === role) return l;
  return null;
};

const projectId = await getFixtureProjectId(client);
const project = await client.projects.get(projectId);
const L = resolveLayers(project);

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
  let raw = await client.documents.get(documentId, true);
  const textId = raw.textLayers.find((l) => l.config?.plaid?.role === 'baseline').text.id;
  const wordL = byRole(raw, 'word');
  const morphL = byRole(raw, 'morpheme');
  const sentL = byRole(raw, 'sentence');
  const POS = wordL.spanLayers.find((s) => s.name === 'Part of Speech').id;
  const GLOSS = morphL.spanLayers.find((s) => s.name === 'Gloss').id;
  const TRANSLATION = sentL.spanLayers.find((s) => s.name === 'Translation').id;

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
  raw = await client.documents.get(documentId, true);
  const spanSpecs = [];
  for (const w of byRole(raw, 'word').tokens)
    spanSpecs.push({ spanLayerId: POS, tokens: [w.id], value: pick(rng, VALUES) });
  for (const m of byRole(raw, 'morpheme').tokens)
    spanSpecs.push({ spanLayerId: GLOSS, tokens: [m.id], value: pick(rng, WORDS).toUpperCase() });
  for (const s of byRole(raw, 'sentence').tokens)
    spanSpecs.push({
      spanLayerId: TRANSLATION,
      tokens: [s.id],
      value: `Translation of ${s.begin}`,
    });
  for (const layerId of [POS, GLOSS, TRANSLATION]) {
    const mine = spanSpecs.filter((sp) => sp.spanLayerId === layerId);
    for (const c of chunks(mine, 500)) await client.spans.bulkCreate(c);
  }
  raw = await client.documents.get(documentId, true);
  const count = (role) => byRole(raw, role).tokens.length;
  const spanCount = raw.textLayers.flatMap((tl) =>
    tl.tokenLayers.flatMap((l) => l.spanLayers.flatMap((s) => s.spans)),
  ).length;
  log(
    `seeded in ${ms(t0)}: ${cpLength(body)} code points, ${count('sentence')} sentences, ${count('word')} words, ${count('morpheme')} morphemes, ${spanCount} annotations`,
  );

  const audit = await client.documents.audit(documentId);
  const last = audit[audit.length - 1];
  const T = last.endTime || last.time;
  t0 = performance.now();
  const target = comparable(await client.documents.get(documentId, true, T));
  log(`as-of read of T in ${ms(t0)}`);
  if (target !== comparable(raw)) throw new Error('as-of read differs from live at T');

  // ---- edits after T -------------------------------------------------------
  t0 = performance.now();
  await client.texts.update(textId, 'Nuevo ' + raw.textLayers[0].text.body);
  raw = await client.documents.get(documentId, true);
  const sents = [...byRole(raw, 'sentence').tokens].sort((a, b) => a.begin - b.begin);
  const cut = sents.slice(40, 43);
  {
    const c = Array.from(raw.textLayers[0].text.body);
    c.splice(cut[0].begin, cut[2].end - cut[0].begin);
    await client.texts.update(textId, c.join(''));
  }
  raw = await client.documents.get(documentId, true);
  {
    const c = Array.from(raw.textLayers[0].text.body);
    const ws = byRole(raw, 'word').tokens.filter((w) => w.end - w.begin > 3);
    const picked = new Set();
    while (picked.size < 50) picked.add(pick(rng, ws));
    for (const w of [...picked].sort((a, b) => b.begin - a.begin)) {
      c.splice(w.begin, w.end - w.begin, ...c.slice(w.begin, w.end).join('').toUpperCase());
    }
    await client.texts.update(textId, c.join(''));
  }
  raw = await client.documents.get(documentId, true);
  const allSpans = raw.textLayers.flatMap((tl) =>
    tl.tokenLayers.flatMap((l) => l.spanLayers.flatMap((s) => s.spans)),
  );
  const doomed = new Set();
  while (doomed.size < 200) doomed.add(pick(rng, allSpans).id);
  await client.spans.bulkDelete([...doomed]);
  const changed = allSpans.filter((s) => !doomed.has(s.id)).slice(0, 300);
  for (const c of chunks(changed, 200)) {
    await client.batched(async () => {
      for (const s of c) client.spans.update(s.id, pick(rng, VALUES));
    });
  }
  const morphs = byRole(raw, 'morpheme').tokens.filter((m) => m.precedence === 2);
  await client.tokens.bulkDelete(morphs.slice(0, 100).map((m) => m.id));
  await client.documents.update(documentId, 'Big restore, renamed');
  await client.documents.setMetadata(documentId, { note: 'edited' });
  log(`edited in ${ms(t0)}`);

  // ---- restore ---------------------------------------------------------------
  t0 = performance.now();
  const preview = await client.documents.restore(documentId, T, { dryRun: true });
  log(
    `dry run in ${ms(t0)}: total ${preview.total}, tokens ${JSON.stringify({ ...preview.tokens, byLayer: undefined })}, spans ${JSON.stringify({ ...preview.spans, byLayer: undefined })}, skipped ${preview.skipped.length}`,
  );
  t0 = performance.now();
  const res = await client.documents.restore(documentId, T, {}, 'Big restore check');
  log(`restored in ${ms(t0)}: total ${res.total}, skipped ${res.skipped.length}`);
  t0 = performance.now();
  const after = comparable(await client.documents.get(documentId, true));
  log(`live read in ${ms(t0)}`);
  const again = await client.documents.restore(documentId, T, { dryRun: true });
  const audit2 = await client.documents.audit(documentId);
  const last2 = audit2[audit2.length - 1];
  const failures = [];
  if (after !== target) failures.push('restored state differs from the as-of read (ids included)');
  if (again.total !== 0) failures.push(`second restore would change ${again.total}`);
  const label = last2.message || last2.ops?.[0]?.description || '';
  if (!/^Big restore check/.test(label))
    failures.push(`newest history entry is not the restore: ${label}`);
  if ((last2.ops || []).length !== 1)
    failures.push(`the restore is ${last2.ops?.length} operations, not one`);
  if (failures.length) {
    console.error('FAIL\n  ' + failures.join('\n  '));
    process.exitCode = 1;
  } else log('ok: big document restored exactly, ids and all, in one operation');
} finally {
  await cleanupDoc(client, documentId);
}
