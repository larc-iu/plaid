import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, readToken, CORE } from './fixtures.js';
import { createScratchProject } from './fixtureProject.js';

// H2-14-2, REV-G4-9: what the link precedent query RETURNS on a real core. A
// multi-word expression linked to an entry with no type is no precedent for
// any of its words, and a word's own link still is. The query is the app's
// own (`linkPrecedentQueries`, loaded through the dev server) and is asked of
// core as the app asks it.

const BODY = 'we met at the well';

let projectId;
let documentId;
let vocabId;

const client = () => new PlaidClient(CORE, readToken().token);
const byRole = (raw, role) =>
  raw.textLayers[0].tokenLayers.find((l) => l.config?.plaid?.role === role);

test.beforeAll(async () => {
  ({ projectId, documentId } = await createScratchProject({
    name: `E2E Precedent ${Date.now()}`,
    docName: 'Precedent Document',
    body: BODY,
  }));
  const c = client();
  const raw = await c.documents.get(documentId, true);
  const words = [...byRole(raw, 'word').tokens].sort((a, b) => a.begin - b.begin);
  expect(words.map((w) => BODY.slice(w.begin, w.end))).toEqual(['we', 'met', 'at', 'the', 'well']);
  const vocab = await c.vocabLayers.create(projectId, `E2E Precedent Lexicon ${Date.now()}`);
  vocabId = vocab.id;
  const met = await c.vocabItems.create(vocabId, 'met', { morphType: 'stem' });
  // No type: the gather popover may link an expression to such an entry.
  const phrase = await c.vocabItems.create(vocabId, 'at the well');
  await c.vocabLinks.create(met.id, [words[1].id]);
  await c.vocabLinks.create(phrase.id, [words[2].id, words[3].id, words[4].id]);
});

test.afterAll(async () => {
  if (!projectId) return;
  await client()
    .projects.delete(projectId)
    .catch((e) => console.error('cleanup failed:', e.message));
});

test('a multi-word link is no precedent for its words, a single-word link still is', async ({
  page,
}) => {
  await page.goto('/');
  const queries = await page.evaluate(
    async ({ vocabId, projectId, documentId }) => {
      const { linkPrecedentQueries } = await import('/src/domain/precedent.js');
      return [
        ...linkPrecedentQueries([vocabId], { projectId }),
        ...linkPrecedentQueries([vocabId], { projectId, docId: documentId }),
      ];
    },
    { vocabId, projectId, documentId },
  );
  const c = client();
  for (const q of queries) {
    const { results } = await c.query(q);
    // [itemId, tokenValue, morphForm, role, morphType, prov, provConfirmed, count]
    expect(results.map((r) => [r[1], r[3], r[7]])).toEqual([['met', 'word', 1]]);
  }
});
