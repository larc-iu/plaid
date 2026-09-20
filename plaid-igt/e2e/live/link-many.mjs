// Live e2e for the two link-MANY paths, on a throwaway project of its own:
// `linkVocabMany` (the editor's "link every ‹roa› in this text") and
// `bulkLinkVocab`'s REPLACEMENT half (auto-link pointing machine links at a new
// precedent). Neither had any coverage against a real core.
//
//   cd plaid-igt && node --import ./e2e/live/aliases.mjs e2e/live/link-many.mjs
//
// Both write through the bulk endpoints now, which changed how the new link ids
// come back: one `{ids: [...]}` in the order sent, rather than one result per
// op. Read that wrong and the optimistic state draws every link with an
// `undefined` id — the document looks right, and the next write to one of those
// links goes nowhere. So the load-bearing check here is that the ids the editor
// drew are the ids the server actually made.
import PlaidClient, { ROLES, cpLength, stampInferred } from '@larc-iu/plaid-client';
import { IgtDocument } from '../../src/domain/IgtDocument.js';
import { executeProjectSetup } from '../../src/components/projects/setup/executeSetup.js';
import { readToken } from '../fixtures.js';

const client = new PlaidClient('http://localhost:8085', readToken().token);
const roleOf = (l) => l?.config?.plaid?.role;
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${label}${ok || !detail ? '' : `  ${detail}`}`);
  if (!ok) failures++;
};

const name = `linkmany ${Date.now()}`;
const setup = await executeProjectSetup({
  client,
  isNewProject: true,
  resumeProjectId: null,
  setupData: {
    basicInfo: { projectName: name },
    orthographies: { orthographies: [{ name: 'Baseline', isBaseline: true }] },
    fields: {
      fields: [{ name: 'Gloss', scope: 'Morpheme', isCustom: true }],
      ignoredTokens: {
        mode: 'unicode-punctuation',
        unicodePunctuationExceptions: [],
        explicitIgnoredTokens: [],
      },
    },
    vocabulary: {
      vocabularies: [{ id: 'new-1', name: `${name} Lexicon`, enabled: true, isCustom: true }],
    },
    documentMetadata: { enabledFields: [] },
  },
});
if (setup.failures.length) throw new Error(setup.failures.join('; '));
const PID = setup.projectId;
const VID = setup.resources.vocabularies[0].id;
try {
  const project = await client.projects.get(PID);
  const tl = project.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const L = Object.fromEntries(
    ['SENTENCE', 'WORD', 'MORPHEME'].map((k) => [
      k,
      tl.tokenLayers.find((l) => roleOf(l) === ROLES[k]).id,
    ]),
  );
  const body = 'roa roa roa';
  const d = await client.documents.create(PID, 'Doc');
  await client.texts.create(tl.id, d.id, body);
  const raw0 = await client.documents.get(d.id, true);
  const textId = raw0.textLayers.find((l) => roleOf(l) === ROLES.BASELINE).text.id;
  const words = [
    { begin: 0, end: 3 },
    { begin: 4, end: 7 },
    { begin: 8, end: 11 },
  ];
  await client.tokens.bulkCreate([
    { tokenLayerId: L.SENTENCE, text: textId, begin: 0, end: cpLength(body) },
  ]);
  await client.tokens.bulkCreate(words.map((w) => ({ tokenLayerId: L.WORD, text: textId, ...w })));
  const morphIds = (
    await client.tokens.bulkCreate(
      words.map((w) => ({ tokenLayerId: L.MORPHEME, text: textId, ...w, precedence: 1 })),
    )
  ).ids;
  const a = (await client.vocabItems.create(VID, 'roa', { morphType: 'stem' })).id;
  const b = (await client.vocabItems.create(VID, 'roa', { morphType: 'root' })).id;

  // ---- linkVocabMany: one bulk create, ids read out of {ids: [...]} ----
  let doc = await IgtDocument.load(client, PID, d.id);
  const ok = await doc.linkVocabMany(morphIds, a);
  check(ok === true, 'linkVocabMany reports success', String(ok));
  const localLinks = doc.sentences
    .flatMap((s) => s.tokens)
    .flatMap((t) => t.morphemes)
    .map((m) => m.vocabItem?.linkId);
  check(
    localLinks.length === 3 && localLinks.every((id) => typeof id === 'string' && id.length > 10),
    'every optimistic link carries a REAL id from the bulk create',
    JSON.stringify(localLinks),
  );
  // And the server agrees, id for id.
  const fresh = await IgtDocument.load(client, PID, d.id);
  const serverLinks = fresh.sentences
    .flatMap((s) => s.tokens)
    .flatMap((t) => t.morphemes)
    .map((m) => m.vocabItem?.linkId);
  check(
    JSON.stringify(localLinks.slice().sort()) === JSON.stringify(serverLinks.slice().sort()),
    'the ids it drew are the ids the server made',
    `${JSON.stringify(localLinks)} vs ${JSON.stringify(serverLinks)}`,
  );
  check(
    fresh.sentences
      .flatMap((s) => s.tokens)
      .flatMap((t) => t.morphemes)
      .every((m) => m.vocabItem?.id === a),
    'every morpheme is linked to the entry on the server',
  );
  check(
    fresh.sentences
      .flatMap((s) => s.tokens)
      .flatMap((t) => t.morphemes)
      .every((m) => m.metadata?.morphType === 'stem'),
    'and took the entry type through the bulk token update',
  );

  // ---- bulkLinkVocab: the REPLACEMENT path (bulk delete + bulk create) ----
  // Make the existing links machine-made so auto-link is allowed to replace them.
  doc = await IgtDocument.load(client, PID, d.id);
  const linkIds = doc.sentences
    .flatMap((s) => s.tokens)
    .flatMap((t) => t.morphemes)
    .map((m) => m.vocabItem.linkId);
  for (const id of linkIds) await client.vocabLinks.setMetadata(id, stampInferred('test'));
  doc = await IgtDocument.load(client, PID, d.id);
  const n = await doc.bulkLinkVocab(
    morphIds.map((id) => ({ tokenId: id, vocabItemId: b })),
    'test:replace',
  );
  check(n === 3, 'bulkLinkVocab replaced every machine link', String(n));
  const after = await IgtDocument.load(client, PID, d.id);
  const ms = after.sentences.flatMap((s) => s.tokens).flatMap((t) => t.morphemes);
  check(
    ms.every((m) => m.vocabItem?.id === b),
    'each token now points at the new entry',
    JSON.stringify(ms.map((m) => m.vocabItem?.id)),
  );
  check(
    ms.every((m) => m.vocabItem?.linkId && !linkIds.includes(m.vocabItem.linkId)),
    'on NEW links, with the stale ones deleted',
  );
  check(
    ms.every((m) => m.metadata?.morphType === 'root'),
    'and the morph-type cache followed',
  );
  const all = (await client.vocabLayers.get(VID, true)).items;
  check(all.length === 2, 'no entries were created or lost', String(all.length));
} finally {
  await client.projects.delete(PID).catch(() => {});
  await client.vocabLayers.delete(VID).catch(() => {});
}
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
