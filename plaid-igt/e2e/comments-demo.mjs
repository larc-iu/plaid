// Seeds a "Comments demo" project on the dev core: a three-sentence Spanish text
// glossed the way uxseed.mjs does, a linked lexicon, and comments in every
// state the Comments UI has: current threads on the document, a sentence, a
// word, a gloss, and two entries, plus one word and one entry deleted
// afterwards so their threads show up under Outdated. Idempotent by project
// name: a second run prints the links again.
//
// Usage:  node e2e/comments-demo.mjs        (dev core on :8085, app on :5174)
import PlaidClient, { ROLES } from '@larc-iu/plaid-client';
import { readToken } from './fixtures.js';

const BASE = process.env.PLAID_CORE_URL || 'http://localhost:8085';
const APP = process.env.PLAID_APP_URL || 'http://localhost:5174';
const PROJECT_NAME = 'Comments demo';
const DOC_NAME = 'UDHR Article 1';
const VOCAB_NAME = 'Comments demo lexicon';

const ANALYSIS = [
  {
    translation: 'All human beings are born free and equal in dignity and rights.',
    words: [
      {
        surface: 'Todos',
        pos: 'DET',
        vocab: 'todo',
        morphs: [
          ['tod', 'all'],
          ['os', 'M.PL'],
        ],
      },
      { surface: 'los', pos: 'DET', vocab: 'el', morphs: [['los', 'DEF.M.PL']] },
      {
        surface: 'seres',
        pos: 'NOUN',
        vocab: 'ser',
        morphs: [
          ['ser', 'being'],
          ['es', 'PL'],
        ],
      },
      {
        surface: 'humanos',
        pos: 'ADJ',
        vocab: 'humano',
        morphs: [
          ['human', 'human'],
          ['os', 'M.PL'],
        ],
      },
      {
        surface: 'nacen',
        pos: 'VERB',
        vocab: 'nacer',
        morphs: [
          ['nac', 'be.born'],
          ['en', '3PL.PRS'],
        ],
      },
      {
        surface: 'libres',
        pos: 'ADJ',
        vocab: 'libre',
        morphs: [
          ['libre', 'free'],
          ['s', 'PL'],
        ],
      },
      { surface: 'e', pos: 'CONJ', morphs: [['e', 'and']] },
      {
        surface: 'iguales',
        pos: 'ADJ',
        vocab: 'igual',
        morphs: [
          ['igual', 'equal'],
          ['es', 'PL'],
        ],
      },
      { surface: 'en', pos: 'ADP', morphs: [['en', 'in']] },
      {
        surface: 'dignidad',
        pos: 'NOUN',
        morphs: [
          ['dign', 'worthy'],
          ['idad', 'NMLZ'],
        ],
      },
      { surface: 'y', pos: 'CONJ', morphs: [['y', 'and']] },
      {
        surface: 'derechos',
        pos: 'NOUN',
        morphs: [
          ['derech', 'right'],
          ['os', 'M.PL'],
        ],
      },
      { surface: '.', pos: '', morphs: [['.', '']] },
    ],
  },
  {
    translation: 'They are endowed with reason and conscience.',
    words: [
      {
        surface: 'Dotados',
        pos: 'VERB',
        morphs: [
          ['dot', 'endow'],
          ['ados', 'PTCP.M.PL'],
        ],
      },
      { surface: 'como', pos: 'SCONJ', morphs: [['como', 'as']] },
      {
        surface: 'están',
        pos: 'AUX',
        morphs: [
          ['est', 'be'],
          ['án', '3PL.PRS'],
        ],
      },
      { surface: 'de', pos: 'ADP', morphs: [['de', 'of']] },
      { surface: 'razón', pos: 'NOUN', morphs: [['razón', 'reason']] },
      { surface: 'y', pos: 'CONJ', morphs: [['y', 'and']] },
      {
        surface: 'conciencia',
        pos: 'NOUN',
        morphs: [
          ['concienci', 'conscience'],
          ['a', 'F.SG'],
        ],
      },
      { surface: '.', pos: '', morphs: [['.', '']] },
    ],
  },
  {
    translation: 'They should behave fraternally toward one another.',
    words: [
      {
        surface: 'Deben',
        pos: 'VERB',
        morphs: [
          ['deb', 'must'],
          ['en', '3PL.PRS'],
        ],
      },
      {
        surface: 'comportarse',
        pos: 'VERB',
        morphs: [
          ['comport', 'behave'],
          ['ar', 'INF'],
          ['se', 'REFL'],
        ],
      },
      {
        surface: 'fraternalmente',
        pos: 'ADV',
        morphs: [
          ['fraternal', 'brotherly'],
          ['mente', 'ADV'],
        ],
      },
      { surface: '.', pos: '', morphs: [['.', '']] },
    ],
  },
];

const ENTRIES = [
  { form: 'todo', gloss: 'all' },
  { form: 'el', gloss: 'the' },
  { form: 'ser', gloss: 'being' },
  { form: 'humano', gloss: 'human' },
  { form: 'nacer', gloss: 'be born' },
  { form: 'libre', gloss: 'free' },
  { form: 'igual', gloss: 'equal' },
];

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
  sentences.forEach((s, i) => {
    s.partBegin = i === 0 ? 0 : sentences[i - 1].partEnd;
    s.partEnd = i === sentences.length - 1 ? body.length : sentences[i + 1].contentBegin;
  });
  return { body, sentences };
}

const client = new PlaidClient(BASE, readToken().token);
const existing = (await client.projects.list()).find((p) => p.name === PROJECT_NAME);
if (existing) {
  const docs = await client.projects.listDocuments(existing.id);
  const vocab = (await client.projects.get(existing.id)).vocabs?.[0];
  console.log('already seeded');
  console.log(`${APP}/#/projects/${existing.id}/documents/${docs[0]?.id}?tab=comments`);
  if (vocab) console.log(`${APP}/#/vocabularies/${vocab.id}?tab=comments`);
  process.exit(0);
}

// --- project, set up as the wizard does it ---------------------------------
const { id: projectId } = await client.projects.create(PROJECT_NAME);
const textLayer = await client.textLayers.create(projectId, 'Main Text');
await client.textLayers.setConfig(textLayer.id, 'plaid', 'role', ROLES.BASELINE);
const sentenceLayer = await client.tokenLayers.create(textLayer.id, 'Sentences', 'partitioning');
await client.tokenLayers.setConfig(sentenceLayer.id, 'plaid', 'role', ROLES.SENTENCE);
const wordLayer = await client.tokenLayers.create(
  textLayer.id,
  'Words',
  'non-overlapping',
  sentenceLayer.id,
);
await client.tokenLayers.setConfig(wordLayer.id, 'plaid', 'role', ROLES.WORD);
const morphemeLayer = await client.tokenLayers.create(
  textLayer.id,
  'Morphemes',
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
const spanLayers = {};
for (const f of [
  { name: 'Gloss', scope: 'Morpheme', parent: morphemeLayer.id },
  { name: 'Part of Speech', scope: 'Word', parent: wordLayer.id },
  { name: 'Translation', scope: 'Sentence', parent: sentenceLayer.id },
]) {
  const sl = await client.spanLayers.create(f.parent, f.name);
  await client.spanLayers.setConfig(sl.id, 'igt', 'scope', f.scope);
  spanLayers[f.name] = sl.id;
}
await client.tokenLayers.setConfig(wordLayer.id, 'igt', 'ignoredTokens', {
  type: 'unicodePunctuation',
  whitelist: [],
});
await client.projects.setConfig(projectId, 'igt', 'documentMetadata', [
  { name: 'Date' },
  { name: 'Speakers' },
]);
await client.projects.setConfig(projectId, 'igt', 'initialized', true);

// --- lexicon -------------------------------------------------------------------
const { id: vocabId } = await client.vocabLayers.create(VOCAB_NAME);
await client.vocabLayers.setConfig(vocabId, 'igt', 'fields', {
  gloss: { inline: true },
  pos: { inline: false },
});
await client.projects.linkVocab(projectId, vocabId);
const itemByForm = {};
for (const e of ENTRIES) {
  const it = await client.vocabItems.create(vocabId, e.form, { gloss: e.gloss });
  itemByForm[e.form] = it.id;
}
// a homonym that will be deleted, so its thread ends up under Outdated
const serCopula = await client.vocabItems.create(vocabId, 'ser', { gloss: 'to be' });

// --- document ------------------------------------------------------------------
const doc = await client.documents.create(projectId, DOC_NAME);
const { body, sentences } = buildText(ANALYSIS);
const text = await client.texts.create(textLayer.id, doc.id, body);
const sentRes = await client.tokens.bulkCreate(
  sentences.map((s) => ({
    tokenLayerId: sentenceLayer.id,
    text: text.id,
    begin: s.partBegin,
    end: s.partEnd,
  })),
);
const sentIds = (Array.isArray(sentRes) ? sentRes : sentRes.ids || []).map((x) =>
  typeof x === 'object' ? x.id : x,
);
const wordIds = {}; // `${si}:${surface}` -> token id
const glossSpanIds = {}; // `${si}:${surface}:${form}` -> span id
for (let si = 0; si < sentences.length; si++) {
  const s = sentences[si];
  await client.spans.create(spanLayers.Translation, [sentIds[si]], s.translation);
  for (const w of s.words) {
    const wt = await client.tokens.create(wordLayer.id, text.id, w.begin, w.end);
    wordIds[`${si}:${w.surface}`] = wt.id;
    if (w.pos) await client.spans.create(spanLayers['Part of Speech'], [wt.id], w.pos);
    if (w.vocab) await client.vocabLinks.create(itemByForm[w.vocab], [wt.id]);
    let prec = 1;
    for (const [form, gloss] of w.morphs) {
      const mt = await client.tokens.create(morphemeLayer.id, text.id, w.begin, w.end, prec, {
        form,
      });
      if (gloss) {
        const sp = await client.spans.create(spanLayers.Gloss, [mt.id], gloss);
        glossSpanIds[`${si}:${w.surface}:${form}`] = sp.id;
      }
      prec += 1;
    }
  }
}

// --- comments, captioned the way the app captions them -------------------------
const post = (type, id, body, anchorLabel) =>
  client.comments.create(type, id, body, { anchorLabel });
await post(
  'document',
  doc.id,
  'UDHR Article 1 in Spanish, glossed with Leipzig abbreviations. Questions about a gloss go on the gloss; questions about a word go on the word.',
  DOC_NAME,
);
await post(
  'token',
  sentIds[0],
  'Should *e* be treated as a variant of *y* here, or glossed separately?',
  'Sentence 1',
);
await post(
  'token',
  wordIds['0:nacen'],
  'The 3PL ending is -en for -er verbs. Worth a note in the lexicon entry for *nacer*?',
  'nacen, sentence 1',
);
await post(
  'span',
  glossSpanIds['0:humanos:os'],
  'M.PL or just PL? The noun is masculine anyway, so the M carries nothing here.',
  'Gloss of os, in humanos, sentence 1',
);
await post(
  'span',
  glossSpanIds['0:humanos:os'],
  "Keep M.PL: it's the convention across the whole text, and the search relies on it.",
  'Gloss of os, in humanos, sentence 1',
);
// these two will become outdated when the word is deleted below
await post(
  'token',
  wordIds['1:Dotados'],
  'Participle or adjective here? The POS says VERB.',
  'Dotados, sentence 2',
);
await post(
  'span',
  glossSpanIds['1:Dotados:dot'],
  '"endow" or "endowed"? The participle suffix already carries the past.',
  'Gloss of dot, in Dotados, sentence 2',
);
// entries
await post(
  'vocab-item',
  itemByForm.libre,
  "Also 'available' (*una mesa libre*). Second sense, or a separate entry?",
  'libre, free',
);
await post(
  'vocab-item',
  itemByForm.nacer,
  'Regular -er verb, nothing irregular to note.',
  'nacer, be born',
);
await post(
  'vocab-item',
  serCopula.id,
  "Duplicate of the noun *ser* 'being'? Different lemma, so keep both, but mark which is which.",
  'ser, to be',
);

// --- edits that leave comments behind ------------------------------------------
await client.tokens.delete(wordIds['1:Dotados']); // cascades its morphemes and their glosses
await client.vocabItems.delete(serCopula.id);

console.log('seeded');
console.log(`document comments: ${APP}/#/projects/${projectId}/documents/${doc.id}?tab=comments`);
console.log(`analyze grid:      ${APP}/#/projects/${projectId}/documents/${doc.id}?tab=analyze`);
console.log(`lexicon comments:  ${APP}/#/vocabularies/${vocabId}?tab=comments`);
console.log(`entry libre:       ${APP}/#/vocabularies/${vocabId}?item=${itemByForm.libre}`);
