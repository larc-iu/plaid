// The kitchen sink: projects that between them hold every feature in
// src/test/fidelity/catalog.js at least once.
//
// Wherever the app has a code path for a feature, the builder takes it: the
// setup wizard's executor, the settings screens' config writes, and the
// editor's own IgtDocument mutations. A fixture assembled from hand-written
// shapes only proves that an exporter agrees with the fixture's author, which
// is the failure this campaign exists to stop. The raw client is used only for
// what no screen makes: data an importer, a service or another app writes, and
// the unusual shapes a format still has to survive (an annotation over several
// words, overlapping speech). A shape the project's layer rules refuse, such as
// a second annotation in a field on one word or a morpheme matching no word,
// cannot be stored, so it is not built.
//
// Five projects:
//   Kitchen sink            everything that fits in one project
//   Kitchen sink blacklist  the ignored-tokens rule a project can only have one of
//   Kitchen sink twins      two vocabularies with one name, which the native
//                           import and the CLDF export refuse (ruled a user
//                           error), so it cannot share a project with the rest
//   Bare                    setup and nothing else, the negative control
//   Kitchen sink ud only    a project plaid-ud set up and plaid-igt never did,
//                           which the native archive brings back without igt
//
// `buildKitchenSink(client)` returns `{projects: [{role, id, name}], users}`.
// A second user (a reviewed contributor) is created for provenance and for
// comment attribution, so the client has to be an admin's.

import { File } from 'node:buffer';
import PlaidClient, {
  PLAID_NAMESPACE,
  REVIEW_KEY,
  metadataOps,
  stampInferred,
  withReviewedUser,
} from '@larc-iu/plaid-client';
import { executeProjectSetup } from '../../src/components/projects/setup/executeSetup.js';
import { IgtDocument } from '../../src/domain/IgtDocument.js';
import {
  IGNORED_TOKEN_MODES,
  IGT_NAMESPACE,
  defaultIgnoredTokensSetup,
} from '../../src/domain/igtConfig.js';
import {
  declarePreserveOnSplit,
  declareSplitOnSpace,
} from '../../../plaid-ui/src/domain/substrateConfig.js';
import { discoverExportLayers } from '../../src/export/exportLayers.js';
import { newPreset } from '../../src/export/presets.js';
import { wavBytes } from '../bugbash/harness.mjs';

const CONTRIBUTOR = {
  email: 'contributor@example.com',
  password: 'contributor-password',
  displayName: 'Cora Contributor',
};

// ---- helpers -------------------------------------------------------------------

/** Run an IgtDocument mutation and throw with its message when it reports failure. */
async function must(doc, label, promise) {
  const result = await promise;
  if (result === false || result === null) {
    throw new Error(`${label}: ${doc._error || 'the mutation reported failure'}`);
  }
  return result;
}

const idOf = (res) => res?.id ?? res?.ids?.[0] ?? res;

/** A word in a loaded document by its surface text (the nth occurrence). */
function word(doc, surface, nth = 0) {
  const found = doc.sentences.flatMap((s) => s.tokens).filter((t) => t.content === surface);
  if (!found[nth]) throw new Error(`no word "${surface}" #${nth} in ${doc.document?.name}`);
  return found[nth];
}

const sentenceAt = (doc, i) => {
  const s = doc.sortedSentences[i];
  if (!s) throw new Error(`no sentence ${i} in ${doc.document?.name}`);
  return s;
};

/** The code-point range of the nth occurrence of `needle` in the body. */
function rangeOf(body, needle, nth = 0) {
  const cps = [...body];
  const target = [...needle];
  let seen = 0;
  for (let i = 0; i + target.length <= cps.length; i++) {
    if (target.every((c, j) => cps[i + j] === c)) {
      if (seen === nth) return { begin: i, end: i + target.length };
      seen++;
    }
  }
  throw new Error(`"${needle}" not found in the baseline`);
}

async function reload(client, projectId, documentId, user = null) {
  return IgtDocument.load(client, { projectId, documentId, user });
}

function layerIds(project) {
  const text = project.textLayers.find((l) => l.config?.plaid?.role === 'baseline');
  const byRole = (role) => text.tokenLayers.find((l) => l.config?.plaid?.role === role);
  const span = (role, name) => byRole(role).spanLayers.find((l) => l.name === name);
  return { text, byRole, span };
}

async function ensureContributor(admin) {
  const rows = (await admin.users.list({ q: CONTRIBUTOR.email })) || [];
  let user = rows.find((u) => u.id === CONTRIBUTOR.email);
  if (!user) {
    user = await admin.users.create(
      CONTRIBUTOR.email,
      CONTRIBUTOR.password,
      false,
      CONTRIBUTOR.displayName,
    );
  }
  const client = await PlaidClient.login(admin.baseUrl, CONTRIBUTOR.email, CONTRIBUTOR.password);
  return { id: CONTRIBUTOR.email, client };
}

// ---- the main project ---------------------------------------------------------------

const MAIN_BODY = [
  'El perro ladra, y los perros corren.',
  // ā and an acute: a mark with no composed letter, so it is stored as a
  // mark (the server stores text composed)
  'Dio la vuelta "r\u0101\u0301pido" & <sin> parar∅ ʼya.',
  '',
  "El gato 𐌰 mira medio-día 'n.\tFin",
].join('\n');

const RTL_BODY = 'الكلب ينبح.';

async function setupMain(client, name) {
  const setup = await executeProjectSetup({
    client,
    isNewProject: true,
    resumeProjectId: null,
    setupData: {
      basicInfo: { projectName: name },
      orthographies: {
        orthographies: [{ name: 'Baseline', isBaseline: true }, { name: 'Translit' }],
      },
      fields: {
        fields: [
          { name: 'Translation', scope: 'Sentence' },
          { name: 'Free translation', scope: 'Sentence', lang: 'en' },
          { name: 'Notes', scope: 'Sentence' },
          { name: 'Literal translation', scope: 'Sentence' },
          { name: 'Gloss', scope: 'Word', lexiconField: 'gloss' },
          { name: 'POS', scope: 'Word', lexiconField: 'pos' },
          { name: 'Gloss', scope: 'Morpheme', lexiconField: 'gloss' },
        ],
        ignoredTokens: {
          mode: 'unicode-punctuation',
          unicodePunctuationExceptions: ['ʼ', "'"],
          explicitIgnoredTokens: [],
        },
      },
      vocabulary: {
        vocabularies: [
          { id: 'new-lexicon', name: `${name} Lexicon`, enabled: true, isCustom: true },
          { id: 'new-affixes', name: `${name} Affixes`, enabled: true, isCustom: true },
        ],
      },
      documentMetadata: {
        enabledFields: [
          { name: 'Date', enabled: true },
          { name: 'Speakers', enabled: true },
          { name: 'Genre', enabled: true },
        ],
      },
    },
  });
  if (setup.failures.length) throw new Error(`setup of ${name}: ${setup.failures.join('; ')}`);
  return setup.projectId;
}

// What the settings screens write, key by key.
async function configureMain(client, projectId, contributorId) {
  const set = (key, value) => client.projects.setConfig(projectId, IGT_NAMESPACE, key, value);
  await set('tagsets', {
    POS: {
      delimiters: '',
      mode: 'closed',
      ordered: true,
      values: [
        { value: 'N', description: 'noun' },
        { value: 'V', description: 'verb' },
        { value: 'DET' },
      ],
    },
    Glosses: {
      delimiters: '-.=',
      mode: 'mixed',
      values: [{ value: 'PL' }, { value: '3' }, { value: 'PRS' }, { value: 'SG' }],
    },
    Genre: { delimiters: '', mode: 'suggest', values: [{ value: 'narrative' }] },
  });
  await set('documentMetadata', [
    { name: 'Date' },
    { name: 'Speakers' },
    { name: 'Genre', tagset: 'Genre' },
  ]);
  await set('languages', {
    object: {
      name: 'Kitchen Spanish',
      glottocode: 'stan1288',
      iso639P3: 'spa',
      tag: 'es-x-kitchen',
      latitude: 40.4,
      longitude: -3.7,
    },
    meta: { name: 'English', glottocode: 'stan1293', iso639P3: 'eng', tag: 'en' },
  });
  await set('speakers', ['Ada', 'Bo']);
  await set('serviceDefaults', {
    tokenize: { service: { builtin: 'rule-based-punctuation' }, params: {} },
    analyze: { service: { serviceId: 'polygloss' }, params: { depth: 2 } },
  });
  await set('autoAnalysis', {
    copyAnalyses: false,
    copySegmentation: true,
    copyLinks: false,
    copyFields: true,
  });
  await set('compose', { codes: [{ code: 'kk', char: 'ʞ', description: 'turned k' }] });

  const project = await client.projects.get(projectId);
  const { span, byRole } = layerIds(project);
  await client.tokenLayers.setConfig(byRole('word').id, IGT_NAMESPACE, 'tokenizeNewText', false);
  await client.spanLayers.setConfig(span('word', 'POS').id, IGT_NAMESPACE, 'tagset', 'POS');
  await client.spanLayers.setConfig(
    span('morpheme', 'Gloss').id,
    IGT_NAMESPACE,
    'tagset',
    'Glosses',
  );

  await client.projects.setConfig(projectId, IGT_NAMESPACE, 'export', {
    presets: [newPreset('plaid-igt-json', discoverExportLayers(project), 'Archive')],
  });

  await client.projects.addWriter(projectId, contributorId);
  await client.projects.setConfig(
    projectId,
    PLAID_NAMESPACE,
    REVIEW_KEY,
    withReviewedUser(project.config?.plaid?.[REVIEW_KEY], contributorId, true),
  );
  // The shared plaid settings plaid-ui's General page writes.
  await client.projects.setConfig(projectId, PLAID_NAMESPACE, 'tartan', false);
  await client.projects.setConfig(projectId, PLAID_NAMESPACE, 'research', { telemetry: true });
  // Another app keeping its own project settings.
  await client.projects.setConfig(projectId, 'ud', 'serviceDefaults', {
    parse: { service: { serviceId: 'stanza' }, params: {} },
  });
  // The project language plaid-ud and plaid-umr each write from General settings.
  await client.projects.setConfig(projectId, 'ud', 'language', 'es');
  await client.projects.setConfig(projectId, 'umr', 'language', 'es');
}

// plaid-ud's substrate, as udProjectSetup.js lays it out, beside plaid-igt's.
async function addForeignLayers(client, projectId) {
  const project = await client.projects.get(projectId);
  const { text, byRole } = layerIds(project);
  const words = await client.tokenLayers.create(text.id, 'Words', 'any', byRole('word').id);
  await client.tokenLayers.setConfig(words.id, PLAID_NAMESPACE, 'role', 'syntactic-word');
  const lemma = await client.spanLayers.create(words.id, 'Lemma');
  await client.spanLayers.setConfig(lemma.id, 'ud', 'lemma', true);
  const upos = await client.spanLayers.create(words.id, 'UPOS');
  await client.spanLayers.setConfig(upos.id, 'ud', 'upos', true);
  const deps = await client.relationLayers.create(lemma.id, 'Dependency Relations');
  await client.relationLayers.setConfig(deps.id, 'ud', 'dependency', true);
  return { words, lemma, upos, deps };
}

async function configureLexicon(client, vocabId) {
  const vocab = await client.vocabLayers.get(vocabId, false);
  const fields = vocab.config?.igt?.fields || {};
  await client.vocabLayers.setConfig(vocabId, IGT_NAMESPACE, 'fields', {
    ...fields,
    lexemeForm: { inline: false },
    Plural: { inline: false },
    Number: { inline: false },
    'gloss (fr)': { inline: true, lang: 'fr' },
    Source: { inline: false, lang: 'en', scope: 'sense' },
    Register: { inline: false, tagset: 'Register' },
    etymology: { inline: false, scope: 'entry' },
    variantOf: { inline: false, type: 'item' },
    seeAlso: { inline: false, type: 'item', many: true },
  });
  await client.vocabLayers.setConfig(vocabId, IGT_NAMESPACE, 'tagsets', {
    ...(vocab.config?.igt?.tagsets || {}),
    Register: { delimiters: '', mode: 'suggest', values: [{ value: 'colloquial' }] },
  });
  // plaid-dict's publication record.
  await client.vocabLayers.setConfig(vocabId, 'dict', 'title', 'Kitchen dictionary');
  await client.vocabLayers.setConfig(vocabId, 'dict', 'slug', 'kitchen');
}

async function makeEntries(client, lexiconId, affixId) {
  const create = async (vocabId, form, metadata) =>
    idOf(await client.vocabItems.create(vocabId, form, metadata));
  const e = {};
  e.perro = await create(lexiconId, 'perro', {
    gloss: 'dog',
    pos: 'N',
    morphType: 'stem',
    definition: 'a domestic canine',
    status: 'reviewed',
    lexemeForm: 'perr-',
    Plural: 'perros',
    Number: 'sg',
    'gloss (fr)': 'chien',
    Source: 'notebook 3, p. 12',
    Register: 'colloquial',
    etymology: 'of uncertain origin',
    homograph: 1,
  });
  e.perroHound = await create(lexiconId, 'perro', {
    parent: e.perro,
    senseOrder: 2,
    gloss: 'hound',
  });
  e.perroMutt = await create(lexiconId, 'perro', { parent: e.perro, senseOrder: 1, gloss: 'mutt' });
  e.perroHunting = await create(lexiconId, 'perro', { parent: e.perroHound, gloss: 'hunting dog' });
  e.perroPawl = await create(lexiconId, 'perro', {
    gloss: 'pawl',
    morphType: 'stem',
    homograph: 2,
  });
  e.gato = await create(lexiconId, 'gato', {
    gloss: 'cat',
    definition: ' a cat ',
    pos: 'N',
    morphType: 'stem',
    flexEntry: '5f1c7e0a-8f7e-4b52-9d8e-3c2a1b0f9e11',
    flexSense: '0b9d3a2c-1e4f-4a6b-8c7d-9e0f1a2b3c4d',
  });
  e.gata = await create(lexiconId, 'gata', {
    gloss: '"she" cat',
    definition: 'female\tcat',
    variantOf: e.gato,
    seeAlso: [e.gato, e.perro],
  });
  e.plural = await create(lexiconId, 's', { gloss: 'PL', morphType: 'suffix' });
  e.zero = await create(lexiconId, '∅', { gloss: 'SG', morphType: 'suffix' });
  e.vuelta = await create(lexiconId, 'dar la vuelta', {
    gloss: 'turn around',
    morphType: 'phrase',
  });
  e.darVuelta = await create(lexiconId, 'dar vuelta', { gloss: 'turn', morphType: 'phrase' });
  e.across = await create(lexiconId, 'perro dio', {
    gloss: 'a pairing across sentences',
    morphType: 'phrase',
  });
  e.saying = await create(lexiconId, 'el perro ladra', { gloss: 'proverb', morphType: 'phrase' });
  e.ladrar = await create(lexiconId, 'ladrar', {
    gloss: 'bark',
    morphType: 'stem',
    prov: 'inferred',
    provSource: 'plaid-igt-agent',
    Comment: 'left over from an old import',
  });
  e.ladrarAlt = await create(lexiconId, 'ladrar', {
    gloss: 'yelp',
    morphType: 'stem',
    homograph: 2,
  });
  e.unused = await create(lexiconId, 'nunca', { gloss: 'never', pos: 'ADV', status: 'retired' });
  e.rapidoNfc = await create(lexiconId, `r${String.fromCodePoint(0xe1)}pido`, { gloss: 'fast' });
  // A headword that only holds its senses.
  e.casa = await create(lexiconId, 'casa', { morphType: 'stem' });
  e.casaHouse = await create(lexiconId, 'casa', { parent: e.casa, gloss: 'house' });
  e.parar = await create(lexiconId, 'parar', { gloss: 'stop', morphType: 'stem' });
  e.past = await create(affixId, 'ó', { gloss: 'PST', morphType: 'suffix' });
  return e;
}

async function buildStory(ctx) {
  const { client, contributor, projectId, entries: e, foreign } = ctx;
  const created = await client.documents.create(projectId, 'Story: the dog', {
    Date: '2026-09-17',
    Speakers: 'Ada, Bo',
    Genre: 'narrative',
    Source: 'fieldwork notebook 3',
    'Title (en)': 'The dog',
  });
  const docId = created.id;
  let doc = await reload(client, projectId, docId);
  await must(doc, 'baseline', doc.saveBaselineText(MAIN_BODY));
  doc = await reload(client, projectId, docId);
  await must(doc, 'tokenize', doc.tokenize());
  doc = await reload(client, projectId, docId);
  const body = doc.body;

  // Words the app analyzes.
  await must(doc, 'link perro', doc.linkVocab(word(doc, 'perro').morphemes[0].id, e.perro));
  doc = await reload(client, projectId, docId);
  await must(
    doc,
    'gloss perro',
    doc.updateMorphemeSpan(word(doc, 'perro').morphemes[0].id, 'Gloss', 'dog'),
  );
  await must(doc, 'gloss ladra', doc.updateTokenSpan(word(doc, 'ladra').id, 'Gloss', 'barks'));
  await must(doc, 'POS ladra', doc.updateTokenSpan(word(doc, 'ladra').id, 'POS', 'V'));
  await must(
    doc,
    'POS perro off-tagset',
    doc.updateTokenSpan(word(doc, 'perro').id, 'POS', 'NOUN?'),
  );
  await must(doc, 'segment perros', doc.createMorphemes(word(doc, 'perros').id, ['perro', '-s']));
  doc = await reload(client, projectId, docId);
  const [perrosStem, perrosPl] = word(doc, 'perros').morphemes;
  await must(doc, 'gloss perros stem', doc.updateMorphemeSpan(perrosStem.id, 'Gloss', 'dog'));
  await must(doc, 'gloss perros suffix', doc.updateMorphemeSpan(perrosPl.id, 'Gloss', 'PL'));
  await must(doc, 'type -s', doc.setMorphemeType(perrosPl.id, 'suffix'));
  await must(doc, 'link perros to a sense', doc.linkVocab(perrosStem.id, e.perroMutt));
  await must(
    doc,
    'machine link -s',
    doc.linkVocab(
      perrosPl.id,
      e.plural,
      stampInferred('polygloss', { prob: 0.83, detail: { rank: 1 } }),
    ),
  );
  doc = await reload(client, projectId, docId);
  await must(doc, 'confirm the -s link', doc.confirmVocabLink(word(doc, 'perros').morphemes[1].id));

  await must(doc, 'segment corren', doc.createMorphemes(word(doc, 'corren').id, ['corr', '-en']));
  doc = await reload(client, projectId, docId);
  const [corrStem, corrSuffix] = word(doc, 'corren').morphemes;
  await must(doc, 'empty form', doc.updateMorphemeForm(corrStem.id, ''));
  await must(doc, 'delimited gloss', doc.updateMorphemeSpan(corrSuffix.id, 'Gloss', '3-PL.PRS'));
  await must(doc, 'affix link', doc.linkVocab(corrSuffix.id, ctx.entries.past));

  await must(doc, 'segment sin', doc.createMorphemes(word(doc, 'sin').id, ['s=', 'in']));
  doc = await reload(client, projectId, docId);
  await must(doc, 'proclitic', doc.setMorphemeType(word(doc, 'sin').morphemes[0].id, 'proclitic'));
  await must(doc, 'spaced gloss', doc.updateTokenSpan(word(doc, 'sin').id, 'Gloss', ' without '));

  await must(doc, 'segment parar∅', doc.createMorphemes(word(doc, 'parar∅').id, ['parar', '∅']));
  doc = await reload(client, projectId, docId);
  await must(doc, 'link zero', doc.linkVocab(word(doc, 'parar∅').morphemes[1].id, e.zero));

  // An unanalyzed word's derived morpheme, glossed: it is stored with no form.
  await must(
    doc,
    'gloss gato',
    doc.updateMorphemeSpan(word(doc, 'gato').morphemes[0].id, 'Gloss', 'cat'),
  );

  // Multi-word expressions.
  doc = await reload(client, projectId, docId);
  await must(
    doc,
    'mwe dar la vuelta',
    doc.linkMwe([word(doc, 'Dio').id, word(doc, 'la').id, word(doc, 'vuelta').id], e.vuelta),
  );
  doc = await reload(client, projectId, docId);

  // Orthographies.
  await must(
    doc,
    'orthography',
    doc.updateOrthography(word(doc, 'perro').id, 'Translit', 'pe.rro'),
  );

  // Sentence annotations.
  const s0 = sentenceAt(doc, 0).id;
  await must(
    doc,
    'translation',
    doc.updateSentenceSpan(s0, 'Translation', 'The dog barks, and the dogs run.'),
  );
  await must(
    doc,
    'free translation',
    doc.updateSentenceSpan(s0, 'Free translation', 'Dogs bark.\nDogs run.'),
  );
  await must(doc, 'notes', doc.updateSentenceSpan(s0, 'Notes', 'a, "b" <c> & d\te'));
  await must(
    doc,
    'machine translation',
    doc.updateSentenceSpan(
      sentenceAt(doc, 1).id,
      'Translation',
      'He turned around',
      stampInferred('translate-llm'),
    ),
  );

  // Document settings.
  await must(
    doc,
    'speech detection',
    doc.setMetadataKeys({ speechDetection: [0.1, 0.9, 1.2, 2.4] }),
  );

  // Media and time alignment.
  doc = await reload(client, projectId, docId);
  await must(
    doc,
    'media',
    doc.uploadMedia(new File([wavBytes(3)], 'story.wav', { type: 'audio/wav' })),
  );
  doc = await reload(client, projectId, docId);
  const s0Range = { begin: sentenceAt(doc, 0).begin, end: sentenceAt(doc, 0).end };
  await must(
    doc,
    'align sentence 1',
    doc.alignBaseline({ ...s0Range, timeBegin: 0.0, timeEnd: 1.25, speaker: 'Ada' }),
  );
  doc = await reload(client, projectId, docId);

  // ---- what no screen makes, written the way an importer, service or agent does ----
  const project = await client.projects.get(projectId);
  const { byRole, span } = layerIds(project);
  const textId = doc.layerInfo.primaryTextLayer.text.id;
  const wordId = (surface, nth) => word(doc, surface, nth).id;

  // A segment over part of a sentence whose time overlaps the first one
  // (overlapping speech, as an ELAN import brings in), with extra metadata.
  const dio = rangeOf(body, 'Dio la vuelta');
  const overlap = idOf(
    await client.tokens.bulkCreate([
      {
        tokenLayerId: byRole('time-alignment').id,
        text: textId,
        begin: dio.begin,
        end: dio.end,
        metadata: { timeBegin: 1.0, timeEnd: 2.5, speaker: 'Bo', addressee: 'Ada' },
      },
    ]),
  );

  // An annotation on a segment, in a layer on the alignment tokens.
  const segmentNotes = await client.spanLayers.create(byRole('time-alignment').id, 'Segment notes');
  await client.spans.create(segmentNotes.id, [overlap], 'laughter');

  // Tokenizer provenance, an unconfigured orthography, extra word metadata.
  await client.tokens.patchMetadata(
    wordId('El', 0),
    metadataOps({
      prov: 'inferred',
      provSource: 'tokenize-service',
    }),
  );
  await client.tokens.patchMetadata(
    wordId('gato'),
    metadataOps({
      'orthog:Old spelling': 'gatto',
      note: 'checked with Ada',
    }),
  );

  // Two segments inside the third sentence: one a transcription service made,
  // with a speaker, and one with no speaker.
  const elGato = rangeOf(body, 'El gato');
  const miraSeg = rangeOf(body, 'mira');
  await client.tokens.bulkCreate([
    {
      tokenLayerId: byRole('time-alignment').id,
      text: textId,
      begin: elGato.begin,
      end: elGato.end,
      metadata: { timeBegin: 3.0, timeEnd: 3.4, speaker: 'Ada', ...stampInferred('transcribe') },
    },
    {
      tokenLayerId: byRole('time-alignment').id,
      text: textId,
      begin: miraSeg.begin,
      end: miraSeg.end,
      metadata: { timeBegin: 3.4, timeEnd: 3.9 },
    },
  ]);

  // A sentence carrying metadata of its own, and a morpheme an analyzer stamped.
  await client.tokens.patchMetadata(
    sentenceAt(doc, 2).id,
    metadataOps({ source: 'recording 12, 03:10' }),
  );
  await client.tokens.patchMetadata(
    word(doc, 'corren').morphemes[1].id,
    metadataOps(stampInferred('polygloss')),
  );

  // Annotations: multi-token, empty, provenance extras, extra metadata.
  const wordGloss = span('word', 'Gloss').id;
  await client.spans.create(wordGloss, [wordId('los'), wordId('perros')], 'the dogs');
  await client.spans.create(wordGloss, [wordId('Dio')], 'gave', {
    prov: 'inferred',
    provSource: 'polygloss',
    provProb: 0.4,
    provDetail: { alt: 2 },
  });
  await client.spans.create(wordGloss, [wordId('y')], '');
  await client.spans.create(wordGloss, [wordId('Fin')], 'end', { reviewNote: 'check tone' });
  const verified = idOf(
    await client.spans.create(wordGloss, [wordId('mira')], 'looks', stampInferred('polygloss')),
  );
  await client.spans.setMetadata(verified, { ...stampInferred('polygloss'), provConfirmed: true });

  // Links: discontinuous and cross-sentence expressions, a link on a whole
  // sentence, a machine link with every provenance detail.
  await client.vocabLinks.create(e.darVuelta, [wordId('Dio'), wordId('vuelta')]);
  await client.vocabLinks.create(
    e.across,
    [wordId('perro'), wordId('Dio')],
    stampInferred('mwe-finder'),
  );
  await client.vocabLinks.create(e.saying, [sentenceAt(doc, 0).id]);
  await client.vocabLinks.create(e.ladrar, [wordId('ladra')], {
    prov: 'inferred',
    provSource: 'polygloss',
    provProb: 0.61,
    provDetail: { candidates: 3 },
  });
  // A link on a segment.
  await client.vocabLinks.create(e.vuelta, [overlap]);
  // An annotation and a link whose provenance names lexicon entries, as a
  // service that weighs alternatives writes them (provDetail.valueLinks).
  await client.spans.create(
    wordGloss,
    [wordId('El', 0)],
    'the',
    stampInferred('cwomp', {
      detail: { valueLinks: [{ value: 'the', item: e.saying }] },
    }),
  );
  await client.vocabLinks.create(
    e.perroHound,
    [wordId('los')],
    stampInferred('cwomp', {
      prob: 0.5,
      detail: {
        valueLinks: [
          { value: 'hound', item: e.perroHound },
          { value: 'mutt', item: e.perroMutt },
        ],
      },
    }),
  );
  // A link on a morpheme with no morph type of its own, to an entry that has
  // one, as an importer writes it.
  await client.vocabLinks.create(e.parar, [word(doc, 'parar∅').morphemes[0].id]);

  // The contributor's work: a word gloss and a link, stamped contributed.
  const asContributor = await reload(contributor.client, projectId, docId, { id: contributor.id });
  await must(
    asContributor,
    'contributed gloss',
    asContributor.updateTokenSpan(word(asContributor, 'corren').id, 'Gloss', 'run'),
  );
  await must(
    asContributor,
    'contributed link',
    asContributor.linkVocab(word(asContributor, 'gato').morphemes[0].id, e.gato),
  );

  // plaid-ud's annotations on the same words.
  const ladra = rangeOf(body, 'ladra');
  const perro = rangeOf(body, 'perro');
  const sw = (
    await client.tokens.bulkCreate([
      {
        tokenLayerId: foreign.words.id,
        text: textId,
        begin: perro.begin,
        end: perro.end,
        precedence: 1,
      },
      {
        tokenLayerId: foreign.words.id,
        text: textId,
        begin: ladra.begin,
        end: ladra.end,
        precedence: 1,
      },
    ])
  ).ids;
  const lemmaPerro = idOf(await client.spans.create(foreign.lemma.id, [sw[0]], 'perro'));
  const lemmaLadra = idOf(await client.spans.create(foreign.lemma.id, [sw[1]], 'ladrar'));
  await client.spans.create(foreign.upos.id, [sw[0]], 'NOUN');
  const nsubj = idOf(
    await client.relations.create(foreign.deps.id, lemmaLadra, lemmaPerro, 'nsubj'),
  );

  // Comments on every kind of anchor, by two people.
  doc = await reload(client, projectId, docId);
  const perroWord = word(doc, 'perro');
  const glossSpan = doc.layerInfo.spanLayers.word
    .find((l) => l.name === 'Gloss')
    .spans.find((sp) => sp.value === 'barks');
  await client.comments.create('document', docId, 'Check the speaker attribution.');
  await client.comments.create(
    'text',
    textId,
    'Line 2 has a stray character.\n\n- see the recording\n- ask Ada',
  );
  await client.comments.create('token', sentenceAt(doc, 0).id, 'Is this one sentence?', {
    anchorLabel: 'Sentence 1',
  });
  await client.comments.create('token', perroWord.id, 'Word comment', {
    anchorLabel: 'perro, sentence 1',
  });
  await client.comments.create('token', word(doc, 'perros').morphemes[1].id, 'Is this plural?');
  await client.comments.create('token', overlap, 'Two speakers here.');
  await client.comments.create('span', glossSpan.id, 'Gloss looks right.');
  await client.comments.create('relation', nsubj, 'Or is it obl?');
  const edited = await client.comments.create('vocab-item', e.perro, 'Needs a better definition.');
  await client.comments.update(idOf(edited), 'Needs a better definition, per Ada.');
  await contributor.client.comments.create(
    'token',
    word(doc, 'ladra').id,
    'A comment by the contributor.',
  );
  // A comment an earlier archive import posted, its first author and date in
  // the note at its top.
  await client.comments.create(
    'token',
    word(doc, 'corren').id,
    '> Imported from an archive. Originally posted by Old Author <old@example.com> on 2020-01-02.\n\nChecked against the recording.',
  );
  // A comment whose anchor is then deleted.
  const doomed = idOf(
    await client.spans.create(span('word', 'POS').id, [word(doc, 'mira').id], 'V'),
  );
  await client.comments.create('span', doomed, 'This annotation will be deleted.', {
    anchorLabel: 'POS of mira',
  });
  await client.spans.delete(doomed);

  // Promoted examples on the headword: one from this corpus, one as FLEx stores them.
  await client.vocabItems.patchMetadata(
    e.perro,
    metadataOps({
      examples: [
        { document: docId, token: sentenceAt(doc, 0).id },
        { text: 'El perro duerme.', translation: 'The dog sleeps.' },
      ],
    }),
  );
  return docId;
}

async function buildOtherDocuments(ctx) {
  const { client, projectId } = ctx;

  // Right to left, set to read that way, with a name a file system cannot take as is.
  const rtl = await client.documents.create(projectId, 'Story 2: "الكلب" / v2?');
  let doc = await reload(client, projectId, rtl.id);
  await must(doc, 'rtl baseline', doc.saveBaselineText(RTL_BODY));
  doc = await reload(client, projectId, rtl.id);
  await must(doc, 'rtl tokenize', doc.tokenize());
  doc = await reload(client, projectId, rtl.id);
  await must(doc, 'rtl direction', doc.setTextDirection('rtl'));
  await must(doc, 'rtl gloss', doc.updateTokenSpan(word(doc, 'الكلب').id, 'Gloss', 'the dog'));

  // No text yet.
  await client.documents.create(projectId, 'Notes');

  // Sentences but no words, under a name that becomes the other document's
  // as a file name (names are unique in a project, ignoring case, and a file
  // name drops the question mark).
  const untok = await client.documents.create(projectId, 'Notes?');
  doc = await reload(client, projectId, untok.id);
  await must(
    doc,
    'untokenized baseline',
    doc.saveBaselineText('Only sentences here.\nNo words yet.\nNor any times.'),
  );
  doc = await reload(client, projectId, untok.id);
  const notesText = doc.layerInfo.primaryTextLayer.text.id;
  const notesLayers = layerIds(await client.projects.get(projectId));
  const across = rangeOf(doc.body, 'here.\nNo');
  await client.tokens.bulkCreate([
    {
      tokenLayerId: notesLayers.byRole('time-alignment').id,
      text: notesText,
      begin: across.begin,
      end: across.end,
      metadata: { timeBegin: 0.5, timeEnd: 1.5 },
    },
  ]);
  const doomedWord = await client.tokens
    .bulkCreate([
      { tokenLayerId: notesLayers.byRole('word').id, text: notesText, begin: 0, end: 4 },
    ])
    .then(idOf);
  await client.vocabItems.patchMetadata(
    ctx.entries.unused,
    metadataOps({
      examples: [{ document: untok.id, token: doomedWord }],
    }),
  );
  await client.tokens.delete(doomedWord);
}

async function addGuidelines(client, projectId) {
  await client.guidelines.create(projectId, 'Glossing', {
    body: '# Glossing\n\nUse the *Leipzig* rules.\n\n| tag | meaning |\n|---|---|\n| PL | plural |',
    pinned: true,
  });
  await client.guidelines.create(projectId, 'Glossing', {
    body: 'The older version of the rules.',
  });
  await client.guidelines.create(projectId, 'Orthography', { body: '' });
}

// ---- the other two projects -------------------------------------------------------------

async function buildBlacklist(client, name) {
  const setup = await executeProjectSetup({
    client,
    isNewProject: true,
    resumeProjectId: null,
    setupData: {
      basicInfo: { projectName: name },
      orthographies: { orthographies: [{ name: 'Baseline', isBaseline: true }] },
      fields: {
        fields: [{ name: 'Gloss', scope: 'Word' }],
        ignoredTokens: {
          ...defaultIgnoredTokensSetup(),
          mode: IGNORED_TOKEN_MODES.explicit,
          explicitIgnoredTokens: ['--'],
        },
      },
      vocabulary: { vocabularies: [] },
      documentMetadata: { enabledFields: [] },
    },
  });
  if (setup.failures.length) throw new Error(`setup of ${name}: ${setup.failures.join('; ')}`);
  // The rule as an older screen stored it, with only the list in force.
  const { byRole } = layerIds(await client.projects.get(setup.projectId));
  await client.tokenLayers.setConfig(byRole('word').id, PLAID_NAMESPACE, 'ignoredTokens', {
    type: 'blacklist',
    blacklist: ['--'],
  });
  const created = await client.documents.create(setup.projectId, 'Dashes');
  let doc = await reload(client, setup.projectId, created.id);
  await must(doc, 'blacklist baseline', doc.saveBaselineText('uno -- dos'));
  doc = await reload(client, setup.projectId, created.id);
  await must(doc, 'blacklist tokenize', doc.tokenize());
  // The word the rule skips, which Tokenize no longer makes (8ff02fbc5) and
  // another app's tokenizer does, as plaid-ud's makes punctuation tokens.
  await client.tokens.bulkCreate([
    {
      tokenLayerId: byRole('word').id,
      text: doc.layerInfo.primaryTextLayer.text.id,
      begin: 4,
      end: 6,
    },
  ]);
  return setup.projectId;
}

async function buildTwins(client, name) {
  const setup = await executeProjectSetup({
    client,
    isNewProject: true,
    resumeProjectId: null,
    setupData: {
      basicInfo: { projectName: name },
      orthographies: { orthographies: [{ name: 'Baseline', isBaseline: true }] },
      fields: { fields: [{ name: 'Gloss', scope: 'Word' }] },
      vocabulary: {
        vocabularies: [
          { id: 'new-lexicon', name: `${name} Lexicon`, enabled: true, isCustom: true },
        ],
      },
      documentMetadata: { enabledFields: [] },
    },
  });
  if (setup.failures.length) throw new Error(`setup of ${name}: ${setup.failures.join('; ')}`);
  const twin = await client.vocabLayers.create(`${name} Lexicon`);
  await client.projects.linkVocab(setup.projectId, twin.id);
  await client.vocabItems.create(twin.id, 'uno', { gloss: 'one' });
  const created = await client.documents.create(setup.projectId, 'Uno');
  const doc = await reload(client, setup.projectId, created.id);
  await must(doc, 'twins baseline', doc.saveBaselineText('uno'));
  return setup.projectId;
}

// A project plaid-ud set up and plaid-igt never did, its layers as
// udProjectSetup.js lays them out: no igt config, no morpheme or alignment
// layer. The archive is the project's whole state, so it comes back with
// exactly these (Luke's ruling R37).
async function buildUdOnly(client, name) {
  const project = await client.projects.create(name);
  const text = await client.textLayers.create(project.id, 'Text');
  await client.textLayers.setConfig(text.id, PLAID_NAMESPACE, 'role', 'baseline');
  const sentences = await client.tokenLayers.create(text.id, 'Sentences', 'partitioning');
  await client.tokenLayers.setConfig(sentences.id, PLAID_NAMESPACE, 'role', 'sentence');
  await declarePreserveOnSplit(client, sentences.id);
  const tokens = await client.tokenLayers.create(
    text.id,
    'Tokens',
    'non-overlapping',
    sentences.id,
  );
  await client.tokenLayers.setConfig(tokens.id, PLAID_NAMESPACE, 'role', 'word');
  await declarePreserveOnSplit(client, tokens.id);
  await declareSplitOnSpace(client, tokens.id);
  const words = await client.tokenLayers.create(text.id, 'Words', 'any', tokens.id);
  await client.tokenLayers.setConfig(words.id, PLAID_NAMESPACE, 'role', 'syntactic-word');
  const lemma = await client.spanLayers.create(words.id, 'Lemma');
  await client.spanLayers.setConfig(lemma.id, 'ud', 'lemma', true);
  const upos = await client.spanLayers.create(words.id, 'UPOS');
  await client.spanLayers.setConfig(upos.id, 'ud', 'upos', true);
  const deps = await client.relationLayers.create(lemma.id, 'Dependency Relations');
  await client.relationLayers.setConfig(deps.id, 'ud', 'dependency', true);
  await client.projects.setConfig(project.id, 'ud', 'language', 'es');

  const doc = await client.documents.create(project.id, 'Sent 1', { sent_id: 'es-1' });
  const body = 'El perro ladra.';
  const t = idOf(await client.texts.create(text.id, doc.id, body));
  await client.tokens.bulkCreate([
    { tokenLayerId: sentences.id, text: t, begin: 0, end: body.length },
  ]);
  const at = [
    [0, 2],
    [3, 8],
    [9, 14],
    [14, 15],
  ];
  const tk = (
    await client.tokens.bulkCreate(
      at.map(([begin, end]) => ({ tokenLayerId: tokens.id, text: t, begin, end })),
    )
  ).ids;
  const sw = (
    await client.tokens.bulkCreate(
      at.map(([begin, end]) => ({
        tokenLayerId: words.id,
        text: t,
        begin,
        end,
        precedence: 1,
      })),
    )
  ).ids;
  const lemmas = ['el', 'perro', 'ladrar', '.'];
  const ids = [];
  for (let i = 0; i < sw.length; i++) {
    ids.push(idOf(await client.spans.create(lemma.id, [sw[i]], lemmas[i])));
  }
  await client.spans.create(upos.id, [sw[1]], 'NOUN');
  await client.relations.create(deps.id, ids[2], ids[1], 'nsubj');
  await client.tokens.patchMetadata(tk[3], metadataOps({ SpaceAfter: 'No' }));
  return project.id;
}

async function buildBare(client, name) {
  const setup = await executeProjectSetup({
    client,
    isNewProject: true,
    resumeProjectId: null,
    setupData: {
      basicInfo: { projectName: name },
      orthographies: { orthographies: [{ name: 'Baseline', isBaseline: true }] },
      fields: {
        fields: [
          { name: 'Gloss', scope: 'Word', lexiconField: 'gloss' },
          { name: 'POS', scope: 'Word', lexiconField: 'pos' },
          { name: 'Gloss', scope: 'Morpheme', lexiconField: 'gloss' },
          { name: 'POS', scope: 'Morpheme' },
          { name: 'Translation', scope: 'Sentence' },
          { name: 'Literal Translation', scope: 'Sentence' },
          { name: 'Note', scope: 'Sentence' },
        ],
        ignoredTokens: {
          mode: 'unicode-punctuation',
          unicodePunctuationExceptions: [],
          explicitIgnoredTokens: [],
        },
      },
      vocabulary: {
        vocabularies: [
          { id: 'new-lexicon', name: `${name} Lexicon`, enabled: true, isCustom: true },
        ],
      },
    },
  });
  if (setup.failures.length) throw new Error(`setup of ${name}: ${setup.failures.join('; ')}`);
  return setup.projectId;
}

// ---- entry point ------------------------------------------------------------------------------

export async function buildKitchenSink(client, { suffix = '' } = {}) {
  const contributor = await ensureContributor(client);
  const mainName = `Kitchen sink${suffix}`;
  const projectId = await setupMain(client, mainName);
  await configureMain(client, projectId, contributor.id);
  const foreign = await addForeignLayers(client, projectId);

  const project = await client.projects.get(projectId);
  const lexiconId = project.vocabs.find((v) => v.name === `${mainName} Lexicon`).id;
  const affixId = project.vocabs.find((v) => v.name === `${mainName} Affixes`).id;
  await configureLexicon(client, lexiconId);
  // A field list that leaves out morphType and lists gloss after a field of
  // its own, as a vocabulary another app or an older screen wrote it.
  await client.vocabLayers.setConfig(affixId, IGT_NAMESPACE, 'fields', {
    Allomorphs: { inline: false },
    gloss: { inline: true },
  });
  // A vocabulary made outside the wizard, through the API, so it lists none of
  // the fields setup seeds. Its entries still hold values in the built-in ones.
  const bare = await client.vocabLayers.create(`${mainName} Borrowings`);
  await client.projects.linkVocab(projectId, bare.id);
  await client.vocabItems.create(bare.id, 'aba', { gloss: 'IPFV', morphType: 'suffix' });
  const entries = await makeEntries(client, lexiconId, affixId);

  const ctx = { client, contributor, projectId, entries, lexiconId, foreign };
  await buildStory(ctx);
  await buildOtherDocuments(ctx);
  await addGuidelines(client, projectId);
  // Another app's project settings naming the project's documents and layers
  // by id, alone and inside a longer string, as plaid-umr's import manifest does.
  const listed = await client.projects.listDocuments(projectId);
  await client.projects.setConfig(projectId, 'umr', 'importManifest', {
    document_ids: Object.fromEntries(listed.map((d, i) => [`doc${i}`, d.id])),
    layer_ids: { words: foreign.words.id },
    note: `first document ${listed[0].id}`,
  });

  const blacklistId = await buildBlacklist(client, `Kitchen sink blacklist${suffix}`);
  const twinsId = await buildTwins(client, `Kitchen sink twins${suffix}`);
  const bareId = await buildBare(client, `Bare${suffix}`);
  const udOnlyId = await buildUdOnly(client, `Kitchen sink ud only${suffix}`);

  return {
    projects: [
      { role: 'main', id: projectId, name: mainName },
      { role: 'blacklist', id: blacklistId, name: `Kitchen sink blacklist${suffix}` },
      { role: 'twins', id: twinsId, name: `Kitchen sink twins${suffix}` },
      { role: 'bare', id: bareId, name: `Bare${suffix}` },
      // Read back by the native archive only: the other formats are igt's view
      // of a project, and an import through them sets igt up.
      {
        role: 'udOnly',
        id: udOnlyId,
        name: `Kitchen sink ud only${suffix}`,
        formats: ['native'],
      },
    ],
    users: { admin: client, contributor },
  };
}
