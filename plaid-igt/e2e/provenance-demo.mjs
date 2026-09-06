// Seeds a "Provenance demo" project on the dev core for poking at the four
// provenance states and the "Review writers' work" setting: a glossed Spanish
// text where every word shows a different mix of plain, machine-made,
// contributed and confirmed material, a linked lexicon, and two extra
// accounts, a writer (the contributor) and a maintainer (a verifier), both
// with the password `password`. Idempotent by project name: a second run
// prints the links again.
//
// Usage:  node e2e/provenance-demo.mjs        (dev core on :8085, app on :5174)
import PlaidClient, {
  ROLES,
  stampInferred,
  confirmedInferred,
  stampContributed,
} from '@larc-iu/plaid-client';
import { readToken } from './fixtures.js';

const BASE = process.env.PLAID_CORE_URL || 'http://localhost:8085';
const APP = process.env.PLAID_APP_URL || 'http://localhost:5174';
const PROJECT_NAME = 'Provenance demo';
const DOC_NAME = 'UDHR Article 1';
const VOCAB_NAME = 'Provenance demo lexicon';
const WRITER = { email: 'demo-writer@x.com', name: 'Ann Writer' };
const MAINT = { email: 'demo-maint@x.com', name: 'Lea Maintainer' };
const PASSWORD = 'password';

// Stamps: who "wrote" each piece. The script writes everything under the
// admin token; the stamps are what the app reads.
const MACHINE = (extra = {}) => stampInferred('service:demo-glosser', extra);
const CONTRIB = () => stampContributed(WRITER.email);
const VERIFIED_MACHINE = (extra = {}) => confirmedInferred('service:demo-glosser', extra);
const VERIFIED_CONTRIB = () => ({ ...stampContributed(WRITER.email), provConfirmed: true });

// Per word: pos/vocab/morphs as in comments-demo, plus optional stamps:
//   stamp        every piece of the word (segmentation, glosses, pos, link)
//   glossStamp   the glosses only; posStamp / linkStamp likewise
const ANALYSIS = [
  {
    translation: 'All human beings are born free and equal in dignity and rights.',
    translationStamp: CONTRIB(),
    words: [
      // plain: a verifier typed it
      {
        surface: 'Todos',
        pos: 'DET',
        vocab: 'todo',
        morphs: [
          ['tod', 'all'],
          ['os', 'M.PL'],
        ],
      },
      // machine-made throughout, with a recorded prediction
      {
        surface: 'los',
        pos: 'DET',
        vocab: 'el',
        morphs: [['los', 'DEF.M.PL']],
        stamp: MACHINE({
          prob: 0.91,
          detail: { value: 'DEF.M.PL', valueProbs: { 'DEF.M.PL': 0.91, 'DEF.PL': 0.09 } },
        }),
      },
      // contributed throughout: the writer segmented, glossed and linked it
      {
        surface: 'seres',
        pos: 'NOUN',
        vocab: 'ser',
        morphs: [
          ['ser', 'being'],
          ['es', 'PL'],
        ],
        stamp: CONTRIB(),
      },
      // machine-made, then confirmed by a maintainer
      {
        surface: 'humanos',
        pos: 'ADJ',
        vocab: 'humano',
        morphs: [
          ['human', 'human'],
          ['os', 'M.PL'],
        ],
        stamp: VERIFIED_MACHINE(),
      },
      // contributed, then confirmed by a maintainer
      {
        surface: 'nacen',
        pos: 'VERB',
        vocab: 'nacer',
        morphs: [
          ['nac', 'be.born'],
          ['en', '3PL.PRS'],
        ],
        stamp: VERIFIED_CONTRIB(),
      },
      // a mix: machine POS, contributed glosses, plain segmentation and link
      {
        surface: 'libres',
        pos: 'ADJ',
        vocab: 'libre',
        morphs: [
          ['libre', 'free'],
          ['s', 'PL'],
        ],
        posStamp: MACHINE(),
        glossStamp: CONTRIB(),
      },
      { surface: 'e', pos: 'CONJ', morphs: [['e', 'and']] },
      // machine link only (the word itself is a person's)
      {
        surface: 'iguales',
        pos: 'ADJ',
        vocab: 'igual',
        morphs: [
          ['igual', 'equal'],
          ['es', 'PL'],
        ],
        linkStamp: MACHINE(),
      },
      { surface: 'en', pos: 'ADP', morphs: [['en', 'in']] },
      // contributed link only
      {
        surface: 'dignidad',
        pos: 'NOUN',
        vocab: 'dignidad',
        morphs: [
          ['dign', 'worthy'],
          ['idad', 'NMLZ'],
        ],
        linkStamp: CONTRIB(),
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
    translationStamp: MACHINE({ prob: 0.77 }),
    words: [
      {
        surface: 'Dotados',
        pos: 'VERB',
        morphs: [
          ['dot', 'endow'],
          ['ados', 'PTCP.M.PL'],
        ],
        stamp: MACHINE(),
      },
      { surface: 'como', pos: 'SCONJ', morphs: [['como', 'as']], stamp: MACHINE() },
      {
        surface: 'están',
        pos: 'AUX',
        morphs: [
          ['est', 'be'],
          ['án', '3PL.PRS'],
        ],
        stamp: CONTRIB(),
      },
      { surface: 'de', pos: 'ADP', morphs: [['de', 'of']], stamp: CONTRIB() },
      // left for whoever logs in to analyze
      { surface: 'razón', morphs: [['razón', '']] },
      { surface: 'y', morphs: [['y', '']] },
      { surface: 'conciencia', morphs: [['conciencia', '']] },
      { surface: '.', pos: '', morphs: [['.', '']] },
    ],
  },
  {
    translation: '',
    words: [
      { surface: 'Deben', morphs: [['Deben', '']] },
      { surface: 'comportarse', morphs: [['comportarse', '']] },
      { surface: 'fraternalmente', morphs: [['fraternalmente', '']] },
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
  { form: 'dignidad', gloss: 'dignity' },
  { form: 'razón', gloss: 'reason' },
  { form: 'conciencia', gloss: 'conscience' },
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
    sentences.push({ ...s, contentBegin, contentEnd: body.length, words });
  });
  sentences.forEach((s, i) => {
    s.partBegin = i === 0 ? 0 : sentences[i - 1].partEnd;
    s.partEnd = i === sentences.length - 1 ? body.length : sentences[i + 1].contentBegin;
  });
  return { body, sentences };
}

const client = new PlaidClient(BASE, readToken().token);

// --- accounts ------------------------------------------------------------------
async function ensureUser({ email, name }) {
  const existing = (await client.users.list()).find((u) => u.id === email);
  if (existing) return existing.id;
  const u = await client.users.create(email, PASSWORD, false, name);
  return u?.id || email;
}
const writerId = await ensureUser(WRITER);
const maintId = await ensureUser(MAINT);

const print = (projectId, docId, vocabId) => {
  console.log(`analyze grid:  ${APP}/#/projects/${projectId}/documents/${docId}?tab=analyze`);
  console.log(`access:        ${APP}/#/projects/${projectId}/access`);
  if (vocabId) console.log(`lexicon:       ${APP}/#/vocabularies/${vocabId}`);
  console.log(
    `contributor:   ${WRITER.email} / ${PASSWORD}   (a writer; the project reviews writers)`,
  );
  console.log(`verifier:      ${MAINT.email} / ${PASSWORD}   (a maintainer), or your admin login`);
};

const existing = (await client.projects.list()).find((p) => p.name === PROJECT_NAME);
if (existing) {
  const docs = await client.projects.listDocuments(existing.id);
  const vocab = (await client.projects.get(existing.id)).vocabs?.[0];
  console.log('already seeded');
  print(existing.id, docs[0]?.id, vocab?.id);
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
// The setting under test: writers are contributors here.
await client.projects.setConfig(projectId, 'igt', 'reviewWriters', true);
await client.projects.setConfig(projectId, 'igt', 'initialized', true);
await client.projects.addWriter(projectId, writerId);
await client.projects.addMaintainer(projectId, maintId);

// --- lexicon -------------------------------------------------------------------
const { id: vocabId } = await client.vocabLayers.create(VOCAB_NAME);
await client.vocabLayers.setConfig(vocabId, 'igt', 'fields', {
  gloss: { inline: true },
  pos: { inline: false },
});
await client.projects.linkVocab(projectId, vocabId);
// The contributor may add entries too.
await client.vocabLayers.addMaintainer(vocabId, writerId);
await client.vocabLayers.addMaintainer(vocabId, maintId);
const itemByForm = {};
for (const e of ENTRIES) {
  const it = await client.vocabItems.create(vocabId, e.form, { gloss: e.gloss });
  itemByForm[e.form] = it.id;
}

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
const meta = (stamp) => (stamp ? stamp : undefined);
for (let si = 0; si < sentences.length; si++) {
  const s = sentences[si];
  if (s.translation)
    await client.spans.create(
      spanLayers.Translation,
      [sentIds[si]],
      s.translation,
      meta(s.translationStamp),
    );
  for (const w of s.words) {
    const posStamp = w.posStamp || w.stamp;
    const glossStamp = w.glossStamp || w.stamp;
    const linkStamp = w.linkStamp || w.stamp;
    const segStamp = w.morphs.length > 1 ? w.stamp : null; // a lone default morpheme is substrate
    const wt = await client.tokens.create(wordLayer.id, text.id, w.begin, w.end);
    if (w.pos)
      await client.spans.create(spanLayers['Part of Speech'], [wt.id], w.pos, meta(posStamp));
    if (w.vocab) await client.vocabLinks.create(itemByForm[w.vocab], [wt.id], meta(linkStamp));
    let prec = 1;
    for (const [form, gloss] of w.morphs) {
      const mt = await client.tokens.create(morphemeLayer.id, text.id, w.begin, w.end, prec, {
        form,
        ...(segStamp || {}),
      });
      if (gloss) await client.spans.create(spanLayers.Gloss, [mt.id], gloss, meta(glossStamp));
      prec += 1;
    }
  }
}

console.log('seeded');
print(projectId, doc.id, vocabId);
