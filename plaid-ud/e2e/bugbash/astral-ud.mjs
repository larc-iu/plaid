// UD astral-text integrity probe (bugbash style): drives the REAL
// ConlluDocument against a live plaid-core with non-BMP text, so every
// begin/end the app writes is checked against the server's code-point
// semantics. Token offsets are code points; JS .length is UTF-16 units, so
// any stray .length on a write path overshoots as soon as the text contains
// an astral character. The igt-focused astral fuzzers missed exactly one
// such path — createWord's "no sentences yet" branch (fixed in 2e99b51);
// scenario A is its regression probe, and B–D sweep the other token-writing
// mutations (tokenize, setWordMorphemes, toggleSentenceBoundary).
//
// Run: node e2e/bugbash/astral-ud.mjs   (server on :8085, admin a@b.com;
// needs node >= 20 — `nvm use 24.1.0`)
import { PlaidClient, ROLES, cpLength, cpSlice } from '@larc-iu/plaid-client';
import { ConlluDocument } from '../../src/domain/ConlluDocument.js';
import { basicTokenize } from '../../src/utils/basicTokenize.js';

const API = process.env.PLAID_URL || 'http://localhost:8085';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok ' : 'FAIL '}${label}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};
const ranges = (tokens) => [...tokens].sort((a, b) => a.begin - b.begin).map((t) => [t.begin, t.end]);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Build a full UD project (same 8-batch sequence as ProjectForm.jsx).
async function buildUdProject(client, name) {
  const project = await client.projects.create(name);
  const pid = project.id;
  const textLayer = await client.textLayers.create(pid, 'Text');
  client.beginBatch();
  client.textLayers.setConfig(textLayer.id, 'plaid', 'role', ROLES.BASELINE);
  client.tokenLayers.create(textLayer.id, 'Sentences', 'partitioning');
  const b3 = await client.submitBatch();
  const sentId = b3[1].body.id;
  client.beginBatch();
  client.tokenLayers.setConfig(sentId, 'plaid', 'role', ROLES.SENTENCE);
  client.tokenLayers.create(textLayer.id, 'Words', 'non-overlapping', sentId);
  const b4 = await client.submitBatch();
  const wordId = b4[1].body.id;
  client.beginBatch();
  client.tokenLayers.setConfig(wordId, 'plaid', 'role', ROLES.WORD);
  client.tokenLayers.create(textLayer.id, 'Morphemes', 'any', wordId);
  const b5 = await client.submitBatch();
  const morphId = b5[1].body.id;
  const SPANS = [['Form', 'form'], ['Lemma', 'lemma'], ['UPOS', 'upos'], ['XPOS', 'xpos'], ['Features', 'features']];
  client.beginBatch();
  client.tokenLayers.setConfig(morphId, 'plaid', 'role', ROLES.SYNTACTIC_WORD);
  SPANS.forEach(([n]) => client.spanLayers.create(morphId, n));
  const b6 = await client.submitBatch();
  const spanIds = SPANS.map((_, i) => b6[1 + i].body.id);
  client.beginBatch();
  SPANS.forEach(([, key], i) => client.spanLayers.setConfig(spanIds[i], 'ud', key, true));
  client.relationLayers.create(spanIds[1], 'Dependency Relations');
  const b7 = await client.submitBatch();
  const relId = b7[b7.length - 1].body.id;
  await client.relationLayers.setConfig(relId, 'ud', 'dependency', true);
  return project;
}

async function freshDoc(client, projectId, name) {
  const d = await client.documents.create(projectId, name);
  return ConlluDocument.load(client, projectId, d.id);
}

const client = await PlaidClient.login(API, 'a@b.com', 'password');
const project = await buildUdProject(client, `bugbash-astral-ud-${Date.now()}`);
console.log(`project ${project.id}`);

try {
  // ---- A: createWord on a virgin document (no sentences yet) ----
  // The covering sentence this branch creates must end at cpLength(text),
  // not text.length (the 2e99b51 regression: UTF-16 overshoot on astral text).
  {
    const text = '😀the 𝔡og'; // 8 code points, 10 UTF-16 units
    console.log(`A: createWord, virgin doc, text=${JSON.stringify(text)} (cp=${cpLength(text)}, utf16=${text.length})`);
    const doc = await freshDoc(client, project.id, 'astral-createWord');
    await doc.saveText(text);
    const ok1 = await doc.createWord(1, 4, text); // "the"
    check('createWord("the") succeeds', ok1 === true, doc.error);
    const v = await ConlluDocument.load(client, project.id, doc.id);
    check('covering sentence is [0, cpLength)', eq(ranges(v.layerInfo.sentenceTokenLayer.tokens), [[0, 8]]),
      JSON.stringify(ranges(v.layerInfo.sentenceTokenLayer.tokens)));
    check('word + morpheme are [1,4]',
      eq(ranges(v.layerInfo.wordTokenLayer.tokens), [[1, 4]]) && eq(ranges(v.layerInfo.morphemeTokenLayer.tokens), [[1, 4]]));
    check('default lemma is the code-point slice', v.layerInfo.lemmaLayer.spans[0]?.value === 'the',
      JSON.stringify(v.layerInfo.lemmaLayer.spans.map((s) => s.value)));

    // Second word lands inside the now-existing sentence; lemma crosses an astral char.
    const ok2 = await doc.createWord(5, 8, text); // "𝔡og"
    check('createWord("𝔡og") succeeds', ok2 === true, doc.error);
    const v2 = await ConlluDocument.load(client, project.id, doc.id);
    check('astral lemma value is "𝔡og"', v2.layerInfo.lemmaLayer.spans.some((s) => s.value === '𝔡og'),
      JSON.stringify(v2.layerInfo.lemmaLayer.spans.map((s) => s.value)));

    // ---- C: setWordMorphemes (MWT split) on the astral word ----
    console.log('C: setWordMorphemes MWT split of "𝔡og"');
    const word = v2.layerInfo.wordTokenLayer.tokens.find((w) => w.begin === 5);
    const doc2 = await ConlluDocument.load(client, project.id, doc.id);
    const okC = await doc2.setWordMorphemes(word, ['𝔡', 'og']);
    check('setWordMorphemes succeeds', okC === true, doc2.error);
    const vc = await ConlluDocument.load(client, project.id, doc.id);
    const mwtMorphs = vc.layerInfo.morphemeTokenLayer.tokens.filter((m) => m.begin === 5);
    check('both MWT morphemes are full-width [5,8]', eq(ranges(mwtMorphs), [[5, 8], [5, 8]]), JSON.stringify(ranges(mwtMorphs)));
    const forms = (vc.layerInfo.formLayer.spans || []).map((s) => s.value).sort();
    check('Form spans carry the astral split', eq(forms, ['og', '𝔡']), JSON.stringify(forms));
    const mwtWord = vc.layerInfo.wordTokenLayer.tokens.find((w) => w.begin === 5);
    check('word metadata.form is the surface substring', mwtWord?.metadata?.form === '𝔡og', JSON.stringify(mwtWord?.metadata));
  }

  // ---- B: tokenize an astral multi-sentence text ----
  {
    const text = '😀 cat 𝒞at.\nsecond 😀line';
    console.log(`B: tokenize, text=${JSON.stringify(text)} (cp=${cpLength(text)}, utf16=${text.length})`);
    const doc = await freshDoc(client, project.id, 'astral-tokenize');
    await doc.saveText(text);
    const okB = await doc.tokenize(text);
    check('tokenize succeeds', okB === true, doc.error);
    const v = await ConlluDocument.load(client, project.id, doc.id);
    const len = cpLength(text);
    const sents = ranges(v.layerInfo.sentenceTokenLayer.tokens);
    check('sentences tile [0, cpLength) gap-free', sents[0][0] === 0 && sents[sents.length - 1][1] === len
      && sents.every((s, i) => i === 0 || s[0] === sents[i - 1][1]), JSON.stringify(sents));
    const expectedWords = basicTokenize(text, 'und');
    check('word ranges match basicTokenize (code points)', eq(ranges(v.layerInfo.wordTokenLayer.tokens), expectedWords),
      `got ${JSON.stringify(ranges(v.layerInfo.wordTokenLayer.tokens))} want ${JSON.stringify(expectedWords)}`);
    check('morphemes mirror words', eq(ranges(v.layerInfo.morphemeTokenLayer.tokens), expectedWords));
    const lemmas = [...v.layerInfo.lemmaLayer.spans].map((s) => s.value).sort();
    const expectedLemmas = expectedWords.map(([b, e]) => cpSlice(text, b, e)).sort();
    check('lemmas are code-point slices', eq(lemmas, expectedLemmas), `got ${JSON.stringify(lemmas)} want ${JSON.stringify(expectedLemmas)}`);

    // ---- D: toggleSentenceBoundary at a code-point position past an astral char ----
    const splitAt = expectedWords[1][0]; // begin of "cat"
    console.log(`D: toggleSentenceBoundary at cp ${splitAt}`);
    const doc2 = await ConlluDocument.load(client, project.id, doc.id);
    const okD = await doc2.toggleSentenceBoundary(splitAt);
    check('split succeeds', okD === true, doc2.error);
    const vd = await ConlluDocument.load(client, project.id, doc.id);
    const sd = ranges(vd.layerInfo.sentenceTokenLayer.tokens);
    check('split produced a boundary at the code-point position', sd.some((s) => s[0] === splitAt) && sd.some((s) => s[1] === splitAt),
      JSON.stringify(sd));
    check('partition still tiles [0, cpLength)', sd[0][0] === 0 && sd[sd.length - 1][1] === len
      && sd.every((s, i) => i === 0 || s[0] === sd[i - 1][1]), JSON.stringify(sd));
  }
} finally {
  await client.projects.delete(project.id);
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
