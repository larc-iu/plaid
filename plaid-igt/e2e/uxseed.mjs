// UX-review seeder. Creates richly-populated, ISOLATED interlinear documents in
// the existing "E2E IGT Fixture" project so multiple review agents can poke the
// Analyze view (edit cells, split morphemes, link vocab) without colliding on
// shared data. Idempotent by document name: re-running rebuilds nothing it can
// find already tokenized.
//
// Usage:  node e2e/uxseed.mjs            # creates docs A..E + an empty-state doc
//         node e2e/uxseed.mjs --json     # same, print {name: {projectId, documentId}}
import PlaidClient from '@larc-iu/plaid-client';
import { readToken } from './fixtures.js';

const CORE_URL = process.env.PLAID_CORE_URL || 'http://localhost:8085';
const PROJECT_NAME = 'E2E IGT Fixture';
const DOC_NAMES = ['UX Review Doc A', 'UX Review Doc B', 'UX Review Doc C', 'UX Review Doc D', 'UX Final Demo'];
const EMPTY_DOC_NAME = 'UX Review Empty Doc';

// A small, realistic interlinear analysis of UDHR Article 1 (Spanish), with
// multi-morpheme words, glosses, POS, per-sentence free translation, some IPA,
// and a few vocab links. surface = word as it appears in the text body.
const ANALYSIS = [
  {
    translation: 'All human beings are born free and equal in dignity and rights.',
    words: [
      { surface: 'Todos',   pos: 'DET',  ipa: 'ˈto.ðos',   vocab: 'all',     morphs: [['tod', 'all'], ['os', 'M.PL']] },
      { surface: 'los',     pos: 'DET',  ipa: 'los',        vocab: 'the',     morphs: [['los', 'DEF.M.PL']] },
      { surface: 'seres',   pos: 'NOUN', ipa: 'ˈse.ɾes',    morphs: [['ser', 'being'], ['es', 'PL']] },
      { surface: 'humanos', pos: 'ADJ',  ipa: 'uˈma.nos',   vocab: 'human',   morphs: [['human', 'human'], ['os', 'M.PL']] },
      { surface: 'nacen',   pos: 'VERB', ipa: 'ˈna.θen',    vocab: 'be.born', morphs: [['nac', 'be.born'], ['en', '3PL.PRS']] },
      { surface: 'libres',  pos: 'ADJ',  ipa: 'ˈli.βɾes',   vocab: 'free',    morphs: [['libre', 'free'], ['s', 'PL']] },
      { surface: 'e',       pos: 'CONJ', morphs: [['e', 'and']] },
      { surface: 'iguales', pos: 'ADJ',  vocab: 'equal',    morphs: [['igual', 'equal'], ['es', 'PL']] },
      { surface: 'en',      pos: 'ADP',  morphs: [['en', 'in']] },
      { surface: 'dignidad', pos: 'NOUN', morphs: [['dign', 'worthy'], ['idad', 'NMLZ']] },
      { surface: 'y',       pos: 'CONJ', morphs: [['y', 'and']] },
      { surface: 'derechos', pos: 'NOUN', morphs: [['derech', 'right'], ['os', 'M.PL']] },
      { surface: '.',       pos: '',     morphs: [['.', '']] },
    ],
  },
  {
    translation: 'They are endowed with reason and conscience.',
    words: [
      { surface: 'Dotados',  pos: 'VERB', morphs: [['dot', 'endow'], ['ados', 'PTCP.M.PL']] },
      { surface: 'como',     pos: 'SCONJ', morphs: [['como', 'as']] },
      { surface: 'están',    pos: 'AUX',  ipa: 'esˈtan', morphs: [['est', 'be'], ['án', '3PL.PRS']] },
      { surface: 'de',       pos: 'ADP',  morphs: [['de', 'of']] },
      { surface: 'razón',    pos: 'NOUN', ipa: 'raˈson', morphs: [['razón', 'reason']] },
      { surface: 'y',        pos: 'CONJ', morphs: [['y', 'and']] },
      { surface: 'conciencia', pos: 'NOUN', morphs: [['concienci', 'conscience'], ['a', 'F.SG']] },
      { surface: '.',        pos: '',     morphs: [['.', '']] },
    ],
  },
  {
    translation: 'They should behave fraternally toward one another.',
    words: [
      { surface: 'Deben',   pos: 'VERB', morphs: [['deb', 'must'], ['en', '3PL.PRS']] },
      { surface: 'comportarse', pos: 'VERB', morphs: [['comport', 'behave'], ['ar', 'INF'], ['se', 'REFL']] },
      { surface: 'fraternalmente', pos: 'ADV', morphs: [['fraternal', 'brotherly'], ['mente', 'ADV']] },
      { surface: '.',       pos: '',     morphs: [['.', '']] },
    ],
  },
];

function makeClient() {
  const { token } = readToken();
  return new PlaidClient(CORE_URL, token);
}

// Normalize whatever shape /tokens/bulk returns into an ordered id array.
function normalizeBulkIds(res, expected) {
  let arr = res;
  if (res && !Array.isArray(res)) arr = res.ids || res.data || res.tokens || res.body || [];
  const ids = (arr || []).map((x) => (x && typeof x === 'object' ? (x.id ?? x['xt/id']) : x));
  if (ids.length !== expected) {
    throw new Error(`bulkCreate returned ${ids.length} ids, expected ${expected}: ${JSON.stringify(res).slice(0, 300)}`);
  }
  return ids;
}

async function findProjectByName(client, name) {
  const projects = await client.projects.list();
  return projects.find((p) => p.name === name) || null;
}

function resolveLayers(project) {
  const tl = (project.textLayers || []).find((l) => l.config?.plaid?.primary) || (project.textLayers || [])[0];
  const tokenLayers = tl?.tokenLayers || [];
  const wordLayer = tokenLayers.find((l) => l.config?.plaid?.primary);
  const morphemeLayer = tokenLayers.find((l) => l.config?.plaid?.morpheme);
  const sentenceLayer = tokenLayers.find((l) => l.config?.plaid?.sentence);
  const spanLayerByName = {};
  for (const l of [wordLayer, morphemeLayer, sentenceLayer]) {
    for (const sl of l?.spanLayers || []) spanLayerByName[sl.name] = sl.id;
  }
  return {
    textLayerId: tl?.id,
    sentenceLayerId: sentenceLayer?.id,
    wordLayerId: wordLayer?.id,
    morphemeLayerId: morphemeLayer?.id,
    glossSpanLayerId: spanLayerByName['Gloss'],
    posSpanLayerId: spanLayerByName['Part of Speech'],
    translationSpanLayerId: spanLayerByName['Translation'],
  };
}

// Build the text body + char offsets from the analysis (words joined by single
// spaces within a sentence, sentences joined by a space; punctuation words are
// still space-separated for simplicity — the grid renders one column each).
function buildText(analysis) {
  let body = '';
  const sentences = [];
  analysis.forEach((s, si) => {
    if (si > 0) body += ' ';
    const contentBegin = body.length;
    const words = [];
    s.words.forEach((w, i) => {
      if (i > 0) body += ' ';
      const begin = body.length;
      body += w.surface;
      words.push({ ...w, begin, end: body.length });
    });
    sentences.push({ contentBegin, contentEnd: body.length, translation: s.translation, words });
  });
  body = body.trimEnd();
  // Sentence layer is a partition: assign contiguous [partBegin, partEnd) ranges
  // that tile the whole body, absorbing inter-sentence spaces into the prior one.
  sentences.forEach((s, i) => {
    s.partBegin = i === 0 ? 0 : sentences[i - 1].partEnd;
    s.partEnd = i === sentences.length - 1 ? body.length : sentences[i + 1].contentBegin;
  });
  return { body, sentences };
}

async function ensureDoc(client, projectId, name, layers, vocabItemsByForm) {
  const docs = await client.projects.listDocuments(projectId);
  let doc = docs.find((d) => d.name === name);
  if (!doc) doc = await client.documents.create(projectId, name);

  // Skip if already tokenized.
  const raw = await client.documents.get(doc.id, true);
  const tl = (raw.textLayers || []).find((l) => l.config?.plaid?.primary);
  let text = tl?.text;
  const wordLayerTokens = (tl?.tokenLayers || []).find((l) => l.config?.plaid?.primary)?.tokens || [];
  if (wordLayerTokens.length > 0) return { projectId, documentId: doc.id };

  const { body, sentences } = buildText(ANALYSIS);
  if (!text?.body) {
    text = await client.texts.create(layers.textLayerId, doc.id, body);
  }
  const textId = text.id;

  // Sentence tokens must be bulk-created to establish the partition.
  const sentRes = await client.tokens.bulkCreate(
    sentences.map((s) => ({ tokenLayerId: layers.sentenceLayerId, text: textId, begin: s.partBegin, end: s.partEnd })),
  );
  const sentIds = normalizeBulkIds(sentRes, sentences.length);

  // Sentence tokens
  for (let si = 0; si < sentences.length; si++) {
    const s = sentences[si];
    const sentTokenId = sentIds[si];
    if (layers.translationSpanLayerId && s.translation) {
      await client.spans.create(layers.translationSpanLayerId, [sentTokenId], s.translation);
    }
    for (const w of s.words) {
      const wt = await client.tokens.create(layers.wordLayerId, textId, w.begin, w.end);
      const wtId = wt.id || wt;
      if (w.pos && layers.posSpanLayerId) await client.spans.create(layers.posSpanLayerId, [wtId], w.pos);
      if (w.ipa) await client.tokens.setMetadata(wtId, { 'orthog:IPA': w.ipa });
      if (w.vocab && vocabItemsByForm[w.vocab]) {
        await client.vocabLinks.create(vocabItemsByForm[w.vocab], [wtId]);
      }
      // Morphemes: same extent as the word, precedence 1..n, form in metadata.
      let prec = 1;
      for (const [form, gloss] of w.morphs) {
        const mt = await client.tokens.create(layers.morphemeLayerId, textId, w.begin, w.end, prec, { form });
        const mtId = mt.id || mt;
        if (gloss && layers.glossSpanLayerId) await client.spans.create(layers.glossSpanLayerId, [mtId], gloss);
        prec += 1;
      }
    }
  }
  return { projectId, documentId: doc.id };
}

// A document with body text but NO tokens — for evaluating the "No tokens yet"
// empty state of the Analyze view.
async function ensureEmptyDoc(client, projectId, name, layers) {
  const docs = await client.projects.listDocuments(projectId);
  let doc = docs.find((d) => d.name === name);
  if (!doc) doc = await client.documents.create(projectId, name);
  const raw = await client.documents.get(doc.id, true);
  const tl = (raw.textLayers || []).find((l) => l.config?.plaid?.primary);
  if (!tl?.text?.body) {
    await client.texts.create(layers.textLayerId, doc.id, 'Esta oración no ha sido segmentada todavía.');
  }
  return { projectId, documentId: doc.id };
}

async function main() {
  const client = makeClient();
  const project = await findProjectByName(client, PROJECT_NAME);
  if (!project) throw new Error(`Project "${PROJECT_NAME}" not found — run e2e/fixture.js first`);
  const projectId = project.id;
  const full = await client.projects.get(projectId);
  const layers = resolveLayers(full);

  // Map vocab item forms -> ids (across all linked vocabs).
  const vocabItemsByForm = {};
  for (const v of full.vocabs || []) {
    const vocab = await client.vocabLayers.get(v.id, true); // include items
    for (const it of vocab.items || []) vocabItemsByForm[it.form] = it.id;
  }

  const out = {};
  for (const name of DOC_NAMES) {
    out[name] = await ensureDoc(client, projectId, name, layers, vocabItemsByForm);
  }
  out[EMPTY_DOC_NAME] = await ensureEmptyDoc(client, projectId, EMPTY_DOC_NAME, layers);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
