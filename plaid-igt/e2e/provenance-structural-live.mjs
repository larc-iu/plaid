// Live e2e for the data-level [auto] rows of TEST_PLAN A2/A3/A4 (provenance
// write contract) and B10 (vocab links under structural token ops). Drives the
// real IgtDocument mutations against the dev core in a THROWAWAY document
// inside the "E2E IGT Fixture" project, then re-loads a fresh copy after every
// step so the assertions read what the server persisted, not the optimistic
// patch. Net-neutral: the document (and with it its links and spans) is
// deleted at the end. The UI-only parts of those rows (dialog counts, focus,
// styling) live in the Playwright specs.
//   cd plaid-igt && node e2e/provenance-structural-live.mjs
import PlaidClient, { ROLES, stampInferred, cpLength } from '@larc-iu/plaid-client';
import { IgtDocument } from '../src/domain/IgtDocument.js';
import { readToken } from './fixtures.js';

const CORE = process.env.PLAID_CORE_URL || 'http://localhost:8085';
const client = new PlaidClient(CORE, readToken().token);
const roleOf = (l) => l?.config?.plaid?.role;
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${label}${ok || !detail ? '' : `  ${detail}`}`);
  if (!ok) failures++;
};
const section = (s) => console.log(`\n== ${s}`);

const project = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
if (!project) throw new Error('run node e2e/fixture.js first');
const full = await client.projects.get(project.id);
const textLayer = full.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
const L = Object.fromEntries(
  ['SENTENCE', 'WORD', 'MORPHEME'].map((k) => [
    k,
    textLayer.tokenLayers.find((l) => roleOf(l) === ROLES[k]).id,
  ]),
);
const vocab = full.vocabs.find((v) => v.name === 'IGT Lexicon');
// Throwaway entries: never linked elsewhere, so the level rule (an entry is
// word-level or morpheme-level, never both) can't interfere; deleted at the end.
const stamp = Date.now();
const items = {};
for (const form of ['all', 'the', 'human', 'be.born', 'free', 'equal']) {
  const it = await client.vocabItems.create(vocab.id, `${form}-${stamp}`);
  items[form] = { id: it.id, form: `${form}-${stamp}` };
}
const item = (form) => items[form];

// ---- throwaway document: 6 words, one full-width morpheme each ----
const BODY = 'alpha beta gamma delta epsilon zeta';
const created = await client.documents.create(project.id, `prov-struct ${Date.now()}`);
const DOC = created.id;
try {
  await client.texts.create(textLayer.id, DOC, BODY);
  const raw = await client.documents.get(DOC, true);
  const TEXT = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE).text.id;
  const bodyWords = [];
  for (const m of BODY.matchAll(/\S+/g))
    bodyWords.push({ begin: m.index, end: m.index + m[0].length });
  await client.tokens.bulkCreate([
    { tokenLayerId: L.SENTENCE, text: TEXT, begin: 0, end: cpLength(BODY) },
  ]);
  await client.tokens.bulkCreate(
    bodyWords.map((w) => ({ tokenLayerId: L.WORD, text: TEXT, ...w })),
  );
  await client.tokens.bulkCreate(
    bodyWords.map((w) => ({ tokenLayerId: L.MORPHEME, text: TEXT, ...w, precedence: 1 })),
  );

  const load = () => IgtDocument.load(client, project.id, DOC);
  // Fresh-from-server view of a word by its (current) content, morphemes sorted.
  const words = (d) => d.sentences.flatMap((s) => s.tokens);
  const fresh = async () => {
    const d = await load();
    const W = (content) => d.sentences[0].tokens.find((t) => t.content === content) || null;
    return { d, W };
  };
  const linksOf = async (tokenId) => {
    const d = await load();
    return Object.values(d._vocabularies).flatMap((v) =>
      (v.vocabLinks || []).filter((l) => l.tokens.length === 1 && l.tokens[0] === tokenId),
    );
  };
  const gloss = (t) => t?.annotations?.Gloss ?? null;
  const pos = (t) => t?.annotations?.['Part of Speech'] ?? null;

  // ================= A2: machine spans =================
  section('A2 machine spans');
  let { d, W } = await fresh();
  const m1 = W('alpha').morphemes[0];
  const m2 = W('beta').morphemes[0];
  const m3 = W('gamma').morphemes[0];
  const gl = d.layerInfo.spanLayers.morpheme.find((s) => s.name === 'Gloss');
  const posLayer = d.layerInfo.spanLayers.word.find((s) => s.name === 'Part of Speech');
  await client.spans.create(
    gl.id,
    [m1.id],
    'MACH',
    stampInferred('service:test', { prob: 0.42, detail: { alts: ['a', 'b'] } }),
  );
  await client.spans.create(gl.id, [m2.id], 'HI', stampInferred('service:test'));
  await client.spans.create(gl.id, [m3.id], 'HUM');

  // A2-03 edit a machine span: verified, value replaced, prob/detail kept
  d = await load();
  check(await d.updateMorphemeSpan(m1.id, 'Gloss', 'FIX'), 'A2-03 edit returns true');
  ({ d, W } = await fresh());
  let s = gloss(W('alpha').morphemes[0]);
  check(s?.value === 'FIX', 'A2-03 value is FIX', JSON.stringify(s));
  check(
    s?.metadata?.provConfirmed === true && s.metadata.provSource === 'service:test',
    'A2-03 provConfirmed added, provSource kept',
    JSON.stringify(s?.metadata),
  );
  check(
    s?.metadata?.provProb === 0.42 && s.metadata.provDetail?.alts?.[1] === 'b',
    'A2-14 provProb/provDetail survive the edit',
    JSON.stringify(s?.metadata),
  );
  const fixId = s.id;

  // A2-04 retyping the same value on a fresh machine span does not confirm
  d = await load();
  await d.updateMorphemeSpan(m2.id, 'Gloss', 'HI');
  ({ d, W } = await fresh());
  s = gloss(W('beta').morphemes[0]);
  check(
    s?.value === 'HI' && !('provConfirmed' in (s.metadata || {})),
    'A2-04 retype same value: still machine-unverified',
    JSON.stringify(s?.metadata),
  );

  // A2-05 clearing deletes the span (no verified-empty residue)
  d = await load();
  await d.updateMorphemeSpan(m1.id, 'Gloss', '');
  ({ d, W } = await fresh());
  check(gloss(W('alpha').morphemes[0]) === null, 'A2-05 clearing a machine span deletes it');
  check(!(await client.spans.get(fixId).catch(() => null)), 'A2-05 span row is gone server-side');

  // A2-06 clearing an already-empty cell writes nothing
  d = await load();
  const before06 = (await client.documents.get(DOC, true)).textLayers[0].tokenLayers
    .find((l) => l.id === L.MORPHEME)
    .spanLayers.find((x) => x.id === gl.id).spans.length;
  await d.updateMorphemeSpan(m1.id, 'Gloss', '');
  const after06 = (await client.documents.get(DOC, true)).textLayers[0].tokenLayers
    .find((l) => l.id === L.MORPHEME)
    .spanLayers.find((x) => x.id === gl.id).spans.length;
  check(
    before06 === after06,
    'A2-06 clearing an empty cell creates nothing',
    `${before06} -> ${after06}`,
  );

  // A2-07 clearing a human span deletes it too
  d = await load();
  await d.updateMorphemeSpan(m3.id, 'Gloss', '');
  ({ d, W } = await fresh());
  check(gloss(W('gamma').morphemes[0]) === null, 'A2-07 clearing a human span deletes it');

  // A2-08 / A4-11 Ctrl+Enter confirms the whole word in one go
  // delta: machine POS on the word, machine segmentation del-ta with a machine
  // link on `del`, human gloss on `ta`.
  ({ d, W } = await fresh());
  const delta = W('delta');
  await client.spans.create(
    posLayer.id,
    [delta.id],
    'N',
    stampInferred('service:test', { prob: 0.9 }),
  );
  await client.tokens.patchMetadata(delta.morphemes[0].id, {
    form: 'del',
    ...stampInferred('rule:analysis-precedent'),
  });
  const ta = await client.tokens.create(L.MORPHEME, TEXT, delta.begin, delta.end, 2, {
    form: 'ta',
  });
  await client.spans.create(gl.id, [ta.id], 'HUMAN-GLOSS');
  const delLink = await client.vocabLinks.create(
    item('the').id,
    [delta.morphemes[0].id],
    stampInferred('rule:precedent-or-unique'),
  );
  d = await load();
  check(await d.confirmWordAnalysis(delta.id), 'A2-08 confirmWordAnalysis returns true');
  ({ d, W } = await fresh());
  const dl = W('delta');
  check(
    pos(dl)?.metadata?.provConfirmed === true && pos(dl).metadata.provProb === 0.9,
    'A2-08 word POS span confirmed, provProb kept',
    JSON.stringify(pos(dl)?.metadata),
  );
  check(
    dl.morphemes[0].metadata.provConfirmed === true && dl.morphemes[0].metadata.form === 'del',
    'A2-08 machine morpheme metadata confirmed',
  );
  check(
    dl.morphemes[0].vocabItem?.prov === 'verified' &&
      dl.morphemes[0].vocabItem.linkId === delLink.id,
    'A2-08 / A4-11 machine link confirmed in place (same link id)',
    JSON.stringify(dl.morphemes[0].vocabItem),
  );
  check(
    !('provConfirmed' in (dl.morphemes[1].metadata || {})) &&
      !('provConfirmed' in (gloss(dl.morphemes[1])?.metadata || {})),
    'A2-08 human morpheme + human gloss untouched',
  );
  d = await load();
  check(
    (await d.confirmWordAnalysis(delta.id)) === true,
    'A2-09 confirm with nothing unverified is a no-op true',
  );

  // ================= A3: machine segmentation =================
  section('A3 machine segmentation');
  ({ d, W } = await fresh());
  const eps = W('epsilon');
  await client.tokens.patchMetadata(eps.morphemes[0].id, {
    form: 'epsi',
    ...stampInferred('rule:analysis-precedent'),
  });
  const lon = await client.tokens.create(L.MORPHEME, TEXT, eps.begin, eps.end, 2, {
    form: 'lon',
    morphType: 'suffix',
    ...stampInferred('rule:analysis-precedent'),
  });
  // A3-02 edit the first form: that morpheme verified, sibling untouched
  d = await load();
  await d.updateMorphemeForm(eps.morphemes[0].id, 'epsii');
  ({ d, W } = await fresh());
  let e = W('epsilon');
  check(
    e.morphemes[0].metadata.form === 'epsii' && e.morphemes[0].metadata.provConfirmed === true,
    'A3-02 edited form verified',
    JSON.stringify(e.morphemes[0].metadata),
  );
  check(!('provConfirmed' in e.morphemes[1].metadata), 'A3-02 sibling untouched');
  // A3-05 morph type change on a machine morpheme verifies it
  d = await load();
  await d.setMorphemeType(lon.id, 'enclitic');
  ({ d, W } = await fresh());
  e = W('epsilon');
  check(
    e.morphemes[1].metadata.morphType === 'enclitic' &&
      e.morphemes[1].metadata.provConfirmed === true,
    'A3-05 type set + verified',
    JSON.stringify(e.morphemes[1].metadata),
  );
  // A3-03 split a (re-stamped) machine morpheme: left verified, right human, precedences contiguous
  await client.tokens.patchMetadata(e.morphemes[0].id, {
    form: 'epsii',
    prov: 'inferred',
    provSource: 'rule:analysis-precedent',
    provConfirmed: null,
  });
  d = await load();
  await d.splitMorpheme(e.morphemes[0].id, 'ep', 'sii');
  ({ d, W } = await fresh());
  e = W('epsilon');
  check(
    e.morphemes.map((m) => m.metadata.form).join('-') === 'ep-sii-lon',
    'A3-03 forms after split',
    e.morphemes.map((m) => m.metadata.form).join('-'),
  );
  check(
    e.morphemes.map((m) => m.precedence).join(',') === '1,2,3',
    'A3-03 precedences contiguous',
    e.morphemes.map((m) => m.precedence).join(','),
  );
  check(e.morphemes[0].metadata.provConfirmed === true, 'A3-03 left morpheme verified');
  check(
    !('prov' in e.morphemes[1].metadata) && !('provSource' in e.morphemes[1].metadata),
    'A3-03 new right morpheme is human',
    JSON.stringify(e.morphemes[1].metadata),
  );
  // A3-04 backspace-merge the second into the first: joined form, verified survivor, merged-away link/spans gone
  await client.vocabLinks.create(
    item('free').id,
    [e.morphemes[1].id],
    stampInferred('rule:precedent-or-unique'),
  );
  await client.spans.create(gl.id, [e.morphemes[1].id], 'GONE');
  const siiId = e.morphemes[1].id;
  d = await load();
  await d.mergeMorphemes(siiId);
  ({ d, W } = await fresh());
  e = W('epsilon');
  check(
    e.morphemes.map((m) => m.metadata.form).join('-') === 'epsii-lon',
    'A3-04 merged form',
    e.morphemes.map((m) => m.metadata.form).join('-'),
  );
  check(e.morphemes[0].metadata.provConfirmed === true, 'A3-04 survivor verified');
  check(
    !e.morphemes[0].vocabItem && (await linksOf(siiId)).length === 0,
    'A3-04 merged-away link gone, survivor unlinked',
  );
  check(gloss(e.morphemes[0]) === null, 'A3-04 merged-away gloss gone');
  // A3-06 paste a-b-c into a machine morpheme: first verified, rest human
  await client.tokens.patchMetadata(e.morphemes[0].id, {
    form: 'epsii',
    prov: 'inferred',
    provSource: 'rule:analysis-precedent',
    provConfirmed: null,
  });
  d = await load();
  await d.splitMorphemeMulti(e.morphemes[0].id, ['a', 'b', 'c']);
  ({ d, W } = await fresh());
  e = W('epsilon');
  check(
    e.morphemes.map((m) => m.metadata.form).join('-') === 'a-b-c-lon',
    'A3-06 n-way split forms',
    e.morphemes.map((m) => m.metadata.form).join('-'),
  );
  check(
    e.morphemes[0].metadata.provConfirmed === true &&
      !('prov' in e.morphemes[1].metadata) &&
      !('prov' in e.morphemes[2].metadata),
    'A3-06 first verified, rest human',
  );
  // A3-07 delete a middle morpheme: precedences renumbered
  d = await load();
  await d.deleteMorpheme(e.morphemes[1].id);
  ({ d, W } = await fresh());
  e = W('epsilon');
  check(
    e.morphemes.map((m) => m.metadata.form).join('-') === 'a-c-lon' &&
      e.morphemes.map((m) => m.precedence).join(',') === '1,2,3',
    'A3-07 deleted + renumbered',
    `${e.morphemes.map((m) => m.metadata.form).join('-')} ${e.morphemes.map((m) => m.precedence).join(',')}`,
  );

  // ================= A4: link provenance =================
  section('A4 link provenance');
  ({ d, W } = await fresh());
  const zeta = W('zeta');
  const zLink = await client.vocabLinks.create(
    item('equal').id,
    [zeta.id],
    stampInferred('rule:precedent-or-unique'),
  );
  d = await load();
  await d.confirmVocabLink(zeta.id);
  ({ d, W } = await fresh());
  check(
    W('zeta').vocabItem?.prov === 'verified' && W('zeta').vocabItem.linkId === zLink.id,
    'A4-03 confirm patches provConfirmed on the same link',
    JSON.stringify(W('zeta').vocabItem),
  );
  // A4-09 pick a different item for a machine-linked token: old link deleted, new link human
  await client.vocabLinks.delete(zLink.id);
  const zLink2 = await client.vocabLinks.create(
    item('equal').id,
    [zeta.id],
    stampInferred('rule:precedent-or-unique'),
  );
  d = await load();
  check(await d.linkVocab(zeta.id, item('all').id), 'A4-09 linkVocab returns true', d._error);
  ({ d, W } = await fresh());
  let zl = await linksOf(zeta.id);
  check(
    zl.length === 1 && zl[0].id !== zLink2.id && W('zeta').vocabItem?.form === item('all').form,
    'A4-09 relink: one new link to the new item',
    JSON.stringify(zl.map((l) => l.id)),
  );
  check(
    W('zeta').vocabItem?.prov === 'human',
    'A4-09 new link is human',
    W('zeta').vocabItem?.prov,
  );
  // A4-10 unlink a machine link then re-link the same item by hand: human
  await client.vocabLinks.delete(zl[0].id);
  await client.vocabLinks.create(
    item('equal').id,
    [zeta.id],
    stampInferred('rule:precedent-or-unique'),
  );
  d = await load();
  await d.unlinkVocab(zeta.id);
  check((await linksOf(zeta.id)).length === 0, 'A4-10 unlink removed the machine link');
  d = await load();
  check(await d.linkVocab(zeta.id, item('equal').id), 'A4-10 linkVocab returns true', d._error);
  ({ d, W } = await fresh());
  check(
    W('zeta').vocabItem?.form === item('equal').form && W('zeta').vocabItem.prov === 'human',
    'A4-10 hand re-link of the same item is human',
  );

  // ================= B10: links under structural ops =================
  section('B10 links under structural ops');
  // B10-01 split a word with a word-level link: link stays on the left part
  ({ d, W } = await fresh());
  const alpha = W('alpha');
  const aLink = await client.vocabLinks.create(item('all').id, [alpha.id]);
  d = await load();
  await d.splitToken(alpha.id, 1); // "al" | "pha"
  ({ d, W } = await fresh());
  check(
    W('al')?.vocabItem?.linkId === aLink.id && !W('pha')?.vocabItem,
    'B10-01 word link stays on the left part',
  );
  // B10-02 split a word whose morpheme has a link: the morpheme link is gone
  const beta = W('beta');
  await client.vocabLinks.create(item('be.born').id, [beta.morphemes[0].id]);
  const betaMorph = beta.morphemes[0].id;
  d = await load();
  await d.splitToken(beta.id, 1); // "be" | "ta"
  ({ d, W } = await fresh());
  check(
    W('be') && W('ta') && (await linksOf(betaMorph)).length === 0,
    'B10-02 morpheme link gone after the word split',
  );
  // B10-03 merge two word-linked words: survivor keeps its own link, one link total
  const be = W('be');
  const taW = W('ta');
  const beLink = await client.vocabLinks.create(item('free').id, [be.id]);
  await client.vocabLinks.create(item('human').id, [taW.id]);
  d = await load();
  await d.mergeTokens([be.id, taW.id]);
  ({ d, W } = await fresh());
  let merged = W('beta');
  let ml = await linksOf(merged.id);
  check(
    merged &&
      ml.length === 1 &&
      ml[0].id === beLink.id &&
      merged.vocabItem.form === item('free').form,
    'B10-03 survivor keeps exactly its own link',
    JSON.stringify(ml.map((l) => l.id)),
  );
  // B10-04 morpheme merge where the merged-away morpheme is linked
  merged = W('gamma');
  await client.tokens.patchMetadata(merged.morphemes[0].id, { form: 'gam' });
  const maM = await client.tokens.create(L.MORPHEME, TEXT, merged.begin, merged.end, 2, {
    form: 'ma',
  });
  await client.vocabLinks.create(item('human').id, [maM.id]);
  await client.vocabLinks.create(item('the').id, [merged.morphemes[0].id]);
  d = await load();
  await d.mergeMorphemes(maM.id);
  ({ d, W } = await fresh());
  merged = W('gamma');
  check(
    merged.morphemes.length === 1 &&
      merged.morphemes[0].metadata.form === 'gamma' &&
      merged.morphemes[0].vocabItem?.form === item('the').form &&
      (await linksOf(maM.id)).length === 0,
    'B10-04 merged-away morpheme link gone, survivor link untouched',
    JSON.stringify(merged.morphemes.map((m) => [m.metadata.form, m.vocabItem?.form])),
  );
  // B10-08 morpheme split of a linked morpheme: left keeps the link, right unlinked
  const gm = merged.morphemes[0].id;
  d = await load();
  await d.splitMorpheme(gm, 'gam', 'ma');
  ({ d, W } = await fresh());
  merged = W('gamma');
  check(
    merged.morphemes[0].vocabItem?.form === item('the').form && !merged.morphemes[1].vocabItem,
    'B10-08 left keeps the link, right unlinked',
  );
  // A8-01 merge where the merged-away word carries a VERIFIED word-level link
  // and a word span: the survivor's own link wins; the reparented link's
  // metadata is not what survives (dedup keeps the survivor's), word spans dedup.
  ({ d, W } = await fresh());
  const dl1 = W('delta');
  const ep1 = W('epsilon');
  const epLink = await client.vocabLinks.create(item('be.born').id, [ep1.id], {
    ...stampInferred('rule:precedent-or-unique'),
    provConfirmed: true,
  });
  await client.spans.create(posLayer.id, [ep1.id], 'ADJ');
  d = await load();
  await d.mergeTokens([dl1.id, ep1.id]);
  ({ d, W } = await fresh());
  const dm = W('delta epsilon');
  check(
    !!dm,
    'A8-01 merged word exists',
    words(d)
      .map((t) => t.content)
      .join('|'),
  );
  const dmLinks = dm ? await linksOf(dm.id) : [];
  check(
    dmLinks.length <= 1,
    'A8-01 at most one word link after the merge',
    JSON.stringify(dmLinks.map((l) => l.id)),
  );
  check(!(await linksOf(ep1.id)).length, 'A8-01 nothing left on the merged-away token');
  check(
    dm && Object.values(dm.annotations).filter(Boolean).length >= 1,
    'A8-01 word span survives on the merged word',
  );
  check(
    !dm || !dmLinks.some((l) => l.id === epLink.id) || dmLinks[0].metadata?.provConfirmed === true,
    'A8-01 a reparented link keeps its metadata',
  );

  // B10-05 delete a word with links: links cascade
  const zz = W('zeta');
  const zm = zz.morphemes[0].id;
  await client.vocabLinks.create(item('the').id, [zm]);
  d = await load();
  await d.deleteToken(zz.id);
  ({ d, W } = await fresh());
  check(
    !W('zeta') && (await linksOf(zz.id)).length === 0 && (await linksOf(zm)).length === 0,
    'B10-05 word delete cascades its word + morpheme links',
  );
} finally {
  await client.documents.delete(DOC).catch(() => {});
  for (const it of Object.values(items)) await client.vocabItems.delete(it.id).catch(() => {});
}
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
