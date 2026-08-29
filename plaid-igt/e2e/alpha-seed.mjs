// Seeds the projects TEST_PLAN.md (repo root, section 0.4) expects on the dev
// core. Idempotent by project name: re-running finds existing projects and only
// fills in what's missing. Prints a JSON map of names -> ids.
//
//   nvm use 24.1.0 && node e2e/alpha-seed.mjs [--big]
//
// Recipe mirrors e2e/fixture.js (the setup wizard's layer hierarchy + `igt`
// config). All offsets are Unicode code points (the emoji token matters).
import PlaidClient from '@larc-iu/plaid-client';
import { ROLES, stampInferred, confirmedInferred } from '@larc-iu/plaid-client';
import { readToken } from './fixtures.js';

const CORE_URL = process.env.PLAID_CORE_URL || 'http://localhost:8085';
const BIG = process.argv.includes('--big');
const roleOf = (l) => l?.config?.plaid?.role;
const cpLen = (s) => [...s].length;

const USERS = {
  reader: 'alpha-reader@x.com',
  writer: 'alpha-writer@x.com',
  maint: 'alpha-maint@x.com',
  vocab: 'alpha-vocab@x.com',
};

const { token } = readToken();
const client = new PlaidClient(CORE_URL, token);

// ---------- generic helpers ----------
async function findProject(name) {
  return (await client.projects.list()).find((p) => p.name === name) || null;
}

function resolveLayers(project) {
  const tl =
    (project.textLayers || []).find((l) => roleOf(l) === ROLES.BASELINE) ||
    (project.textLayers || [])[0];
  const tokenLayers = tl?.tokenLayers || [];
  const find = (r) => tokenLayers.find((l) => roleOf(l) === r);
  const spanLayersOf = (l) => l?.spanLayers || [];
  return {
    textLayerId: tl?.id,
    sentence: find(ROLES.SENTENCE),
    word: find(ROLES.WORD),
    morpheme: find(ROLES.MORPHEME),
    alignment: find(ROLES.TIME_ALIGNMENT),
    spanByName: Object.fromEntries(
      [...spanLayersOf(find(ROLES.SENTENCE)), ...spanLayersOf(find(ROLES.WORD)), ...spanLayersOf(find(ROLES.MORPHEME))].map(
        (sl) => [sl.name, sl],
      ),
    ),
  };
}

// Create a project with the full IGT hierarchy. `opts.ignored` = ignoredTokens
// config or null, `opts.fields` = [{name, scope}].
async function ensureProject(name, opts = {}) {
  let project = await findProject(name);
  if (project) {
    const full = await client.projects.get(project.id);
    if (full?.config?.igt?.initialized === true) return full;
    project = full;
  } else {
    project = await client.projects.create(name);
  }
  const projectId = project.id;
  const textLayer = await client.textLayers.create(projectId, 'Main Text');
  await client.textLayers.setConfig(textLayer.id, 'plaid', 'role', ROLES.BASELINE);
  const sentenceLayer = await client.tokenLayers.create(textLayer.id, 'Sentences', 'partitioning');
  await client.tokenLayers.setConfig(sentenceLayer.id, 'plaid', 'role', ROLES.SENTENCE);
  const wordLayer = await client.tokenLayers.create(
    textLayer.id,
    'Main Tokens',
    'non-overlapping',
    sentenceLayer.id,
  );
  await client.tokenLayers.setConfig(wordLayer.id, 'plaid', 'role', ROLES.WORD);
  const morphemeLayer = await client.tokenLayers.create(
    textLayer.id,
    'Main Morphemes',
    'any',
    wordLayer.id,
  );
  await client.tokenLayers.setConfig(morphemeLayer.id, 'plaid', 'role', ROLES.MORPHEME);
  const alignmentLayer = await client.tokenLayers.create(
    textLayer.id,
    'Time Alignment',
    'non-overlapping',
  );
  await client.tokenLayers.setConfig(alignmentLayer.id, 'plaid', 'role', ROLES.TIME_ALIGNMENT);
  await client.tokenLayers.setConfig(wordLayer.id, 'igt', 'orthographies', [{ name: 'IPA' }]);
  const fields = opts.fields ?? [
    { name: 'Gloss', scope: 'Morpheme' },
    { name: 'Part of Speech', scope: 'Word' },
    { name: 'Translation', scope: 'Sentence' },
  ];
  const parentFor = { Morpheme: morphemeLayer.id, Word: wordLayer.id, Sentence: sentenceLayer.id };
  for (const f of fields) {
    const sl = await client.spanLayers.create(parentFor[f.scope], f.name);
    await client.spanLayers.setConfig(sl.id, 'igt', 'scope', f.scope);
  }
  if (opts.ignored !== null) {
    await client.tokenLayers.setConfig(
      wordLayer.id,
      'igt',
      'ignoredTokens',
      opts.ignored ?? { type: 'unicodePunctuation', whitelist: ['?'] },
    );
  }
  await client.projects.setConfig(projectId, 'igt', 'documentMetadata', [
    { name: 'Date' },
    { name: 'Speakers' },
  ]);
  await client.projects.setConfig(projectId, 'igt', 'initialized', true);
  return client.projects.get(projectId);
}

// Vocab by name (names are not unique server-side; `nth` picks the nth
// same-named one, creating up to it).
async function ensureVocab(name, items, nth = 0) {
  const same = (await client.vocabLayers.list()).filter((v) => v.name === name);
  let vocab = same[nth];
  if (!vocab) {
    const created = await client.vocabLayers.create(name);
    vocab = { id: created.id, name };
    for (const form of items) await client.vocabItems.create(vocab.id, form);
  }
  const full = await client.vocabLayers.get(vocab.id, true);
  return full;
}

async function linkVocab(project, vocabId) {
  const fresh = await client.projects.get(project.id);
  if (!(fresh.vocabs || []).some((v) => v.id === vocabId)) {
    await client.projects.linkVocab(project.id, vocabId);
  }
}

// Document with `text`; one sentence token per line, word tokens per
// whitespace run, one default morpheme per word (precedence 1).
async function ensureDoc(project, name, text) {
  const layers = resolveLayers(project);
  const docs = await client.projects.listDocuments(project.id);
  let doc = docs.find((d) => d.name === name);
  if (!doc) {
    doc = await client.documents.create(project.id, name);
    await client.texts.create(layers.textLayerId, doc.id, text);
  }
  const raw = await client.documents.get(doc.id, true);
  const tl = (raw.textLayers || []).find((l) => roleOf(l) === ROLES.BASELINE);
  const textObj = tl?.text;
  const body = textObj.body;
  const wordLayer = (tl.tokenLayers || []).find((l) => roleOf(l) === ROLES.WORD);
  if ((wordLayer?.tokens || []).length === 0) {
    // sentences by line (code-point offsets)
    // The sentence layer is a partition: contiguous, no gaps, so each
    // sentence owns its trailing newline and the last one runs to the end.
    const sents = [];
    const lines = body.split('\n');
    let cp = 0;
    lines.forEach((line, i) => {
      const len = cpLen(line);
      const end = i === lines.length - 1 ? cp + len : cp + len + 1;
      sents.push({ begin: cp, end });
      cp = end;
    });
    await client.tokens.bulkCreate(
      sents.map((s) => ({ tokenLayerId: layers.sentence.id, text: textObj.id, ...s })),
    );
    const words = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      const begin = cpLen(body.slice(0, m.index));
      words.push({ begin, end: begin + cpLen(m[0]) });
    }
    await client.tokens.bulkCreate(
      words.map((w) => ({ tokenLayerId: layers.word.id, text: textObj.id, ...w })),
    );
    await client.tokens.bulkCreate(
      words.map((w) => ({
        tokenLayerId: layers.morpheme.id,
        text: textObj.id,
        ...w,
        precedence: 1,
      })),
    );
  }
  return client.documents.get(doc.id, true);
}

// Word tokens of a raw doc, in order, with content + their morphemes.
function wordsOf(raw) {
  const tl = (raw.textLayers || []).find((l) => roleOf(l) === ROLES.BASELINE);
  const body = tl.text.body;
  const cps = [...body];
  const wordLayer = (tl.tokenLayers || []).find((l) => roleOf(l) === ROLES.WORD);
  const morphLayer = (tl.tokenLayers || []).find((l) => roleOf(l) === ROLES.MORPHEME);
  const words = [...(wordLayer.tokens || [])].sort((a, b) => a.begin - b.begin);
  return words.map((w) => ({
    ...w,
    content: cps.slice(w.begin, w.end).join(''),
    morphemes: (morphLayer.tokens || [])
      .filter((m) => m.begin === w.begin && m.end === w.end)
      .sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0)),
    textId: tl.text.id,
  }));
}

// Apply a full analysis to the nth occurrence of `content` in the doc:
//   { morphs: [{ form, gloss?, item? }], pos?, stamp? }
// `stamp` = metadata fragment for provenance (null = human). `items` maps
// form -> vocab item id.
async function analyze(project, raw, content, spec, items, nth = 0) {
  const layers = resolveLayers(project);
  const word = wordsOf(raw).filter((w) => w.content === content)[nth];
  if (!word) throw new Error(`no word ${content} #${nth}`);
  if ((word.morphemes[0]?.metadata || {}).form != null || word.morphemes.length > 1) return; // done
  const stamp = spec.stamp || {};
  const gloss = layers.spanByName['Gloss'];
  const pos = layers.spanByName['Part of Speech'];
  const morphIds = [word.morphemes[0].id];
  for (let i = 1; i < spec.morphs.length; i++) {
    const r = await client.tokens.create(
      layers.morpheme.id,
      word.textId,
      word.begin,
      word.end,
      i + 1,
      { form: spec.morphs[i].form, ...stamp },
    );
    morphIds.push(r?.id || r);
  }
  await client.tokens.patchMetadata(morphIds[0], { form: spec.morphs[0].form, ...stamp });
  for (let i = 0; i < spec.morphs.length; i++) {
    const m = spec.morphs[i];
    if (m.gloss) await client.spans.create(gloss.id, [morphIds[i]], m.gloss, Object.keys(stamp).length ? stamp : undefined);
    if (m.item && items[m.item]) await client.vocabLinks.create(items[m.item], [morphIds[i]], Object.keys(stamp).length ? stamp : undefined);
  }
  if (spec.pos) await client.spans.create(pos.id, [word.id], spec.pos, Object.keys(stamp).length ? stamp : undefined);
  if (spec.wordItem && items[spec.wordItem]) await client.vocabLinks.create(items[spec.wordItem], [word.id], Object.keys(stamp).length ? stamp : undefined);
}

async function userId(email) {
  // A user's id IS their email address.
  const u = (await client.users.list()).find((x) => x.id === email);
  if (!u) throw new Error(`user ${email} missing`);
  return u.id;
}

const SPANISH = ' Todos los seres humanos nacen libres e iguales en dignidad y derechos.';
const EDGE_TEXT = [
  'Todos los derechos. ¿Qué? ? dog\'s 😀 ... $',
  '"hola," ser ser los',
  'los los ngoko',
].join('\n');

const out = {};

// ---------- P-MAIN ----------
{
  const p = await ensureProject('P-MAIN');
  const lexA = await ensureVocab('LEX-A', [
    'all', 'the', 'human', 'be.born', 'free', 'equal', 'ser', 'ser', 'derechos', 'Qué', 'todos',
  ]);
  const lexB = await ensureVocab('LEX-B', ['the', 'human']);
  await linkVocab(p, lexA.id);
  await linkVocab(p, lexB.id);
  const d1 = await ensureDoc(p, 'Sample IGT Document', SPANISH);
  const d2 = await ensureDoc(p, 'Edge cases', EDGE_TEXT);
  out['P-MAIN'] = { projectId: p.id, docs: { sample: d1.id, edge: d2.id }, lexA: lexA.id, lexB: lexB.id };
}

// ---------- P-NOVOCAB ----------
{
  const p = await ensureProject('P-NOVOCAB');
  const d = await ensureDoc(p, 'Sample IGT Document', SPANISH);
  out['P-NOVOCAB'] = { projectId: p.id, docs: { sample: d.id } };
}

// ---------- P-DUP ----------
{
  const p = await ensureProject('P-DUP');
  const l1 = await ensureVocab('Lexicon', ['uno', 'dos'], 0);
  const l2 = await ensureVocab('Lexicon', ['tres'], 1);
  await linkVocab(p, l1.id);
  await linkVocab(p, l2.id);
  const d = await ensureDoc(p, 'Sample IGT Document', 'uno dos tres');
  out['P-DUP'] = { projectId: p.id, docs: { sample: d.id }, lexicons: [l1.id, l2.id] };
}

// ---------- P-PREC ----------
{
  const p = await ensureProject('P-PREC');
  const lexP = await ensureVocab('LEX-P', [
    'ngo', 'ko', 'bal', 'a', 'ba', 'la', 'machi', 'wiri', 'todos', 'ser', 'ser',
  ]);
  await linkVocab(p, lexP.id);
  const full = await client.vocabLayers.get(lexP.id, true);
  const items = {};
  const sers = [];
  for (const it of full.items || []) {
    if (it.form === 'ser') sers.push(it.id);
    else items[it.form] = it.id;
  }
  sers.sort();
  items.ser1 = sers[0];
  items.ser2 = sers[1];
  const d1 = await ensureDoc(p, 'Precedent 1', 'ngoko bala machi wiri ser ser');
  const d2 = await ensureDoc(p, 'Precedent 2', 'ngoko bala ser');
  const d3 = await ensureDoc(p, 'Target', 'Todos ngoko bala machi wiri ser');
  const A = { morphs: [{ form: 'ngo', gloss: 'go', item: 'ngo' }, { form: 'ko', gloss: 'PST', item: 'ko' }], pos: 'V' };
  await analyze(p, d1, 'ngoko', A, items);
  await analyze(p, d2, 'ngoko', A, items);
  await analyze(p, d1, 'bala', { morphs: [{ form: 'bal', gloss: 'ball', item: 'bal' }, { form: 'a', gloss: 'PL', item: 'a' }] }, items);
  await analyze(p, d2, 'bala', { morphs: [{ form: 'ba', gloss: 'hit', item: 'ba' }, { form: 'la', gloss: 'NMLZ', item: 'la' }] }, items);
  await analyze(p, d1, 'machi', { morphs: [{ form: 'machi', gloss: 'shaman', item: 'machi' }], stamp: stampInferred('rule:analysis-precedent') }, items);
  await analyze(p, d1, 'wiri', { morphs: [{ form: 'wiri', gloss: 'grass', item: 'wiri' }], pos: 'N', stamp: confirmedInferred('flex-import') }, items);
  // precedent for the homonym: both `ser` in doc 1 link to the NEWER item
  await analyze(p, d1, 'ser', { morphs: [{ form: 'ser', item: 'ser2' }] }, items, 0);
  await analyze(p, d1, 'ser', { morphs: [{ form: 'ser', item: 'ser2' }] }, items, 1);
  out['P-PREC'] = { projectId: p.id, docs: { p1: d1.id, p2: d2.id, target: d3.id }, lexP: lexP.id, items };
}

// ---------- P-PERM ----------
{
  const p = await ensureProject('P-PERM');
  const lexA = (await client.vocabLayers.list()).find((v) => v.name === 'LEX-A');
  await linkVocab(p, lexA.id);
  const d = await ensureDoc(p, 'Edge cases', EDGE_TEXT);
  const ids = Object.fromEntries(
    await Promise.all(Object.entries(USERS).map(async ([k, u]) => [k, await userId(u)])),
  );
  const fresh = await client.projects.get(p.id);
  const has = (list, id) => (fresh[list] || []).includes(id);
  if (!has('readers', ids.reader)) await client.projects.addReader(p.id, ids.reader);
  if (!has('writers', ids.writer)) await client.projects.addWriter(p.id, ids.writer);
  if (!has('maintainers', ids.maint)) await client.projects.addMaintainer(p.id, ids.maint);
  const vocab = await client.vocabLayers.get(lexA.id);
  if (!(vocab.maintainers || []).includes(ids.vocab)) await client.vocabLayers.addMaintainer(lexA.id, ids.vocab);
  out['P-PERM'] = { projectId: p.id, docs: { edge: d.id }, lexA: lexA.id, users: ids };
}

// ---------- P-BIG (opt-in) ----------
if (BIG) {
  const p = await ensureProject('P-BIG');
  const forms = Array.from({ length: 5000 }, (_, i) => `w${i.toString(36)}`);
  const same = (await client.vocabLayers.list()).find((v) => v.name === 'LEX-BIG');
  let big = same;
  if (!big) {
    big = await client.vocabLayers.create('LEX-BIG');
    for (let i = 0; i < forms.length; i += 500) {
      await client.vocabItems.bulkCreate(forms.slice(i, i + 500).map((f) => ({ vocabLayerId: big.id, form: f })));
    }
  }
  await linkVocab(p, big.id);
  const lines = Array.from({ length: 420 }, (_, i) =>
    Array.from({ length: 8 }, (_, j) => forms[(i * 8 + j) % 3000]).join(' '),
  );
  const d = await ensureDoc(p, 'Big', lines.join('\n'));
  out['P-BIG'] = { projectId: p.id, docs: { big: d.id }, lexBig: big.id };
}

console.log(JSON.stringify(out, null, 2));
