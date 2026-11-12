import PlaidClient, { ROLES } from '@larc-iu/plaid-client';
import { CORE, readToken, signInAdmin, seedAuth } from './fixtures.js';
import { createScratchProject, roleOf } from './fixtureProject.js';

// A vocabulary has a home project, and the specs about it share one world:
//
//   - project A, the home, owns the vocabulary V (entries "kat", a stem glossed
//     "cat", and "gato"). A's document reads "kat perro", "kat" linked to V's kat.
//   - project B reads "kat zorro". With `borrowed`, B links V and its "kat" is
//     linked to V's kat too.
//
// The admin (the e2e token's account) builds it and maintains both projects.
// Everyone else is an account made here, with a role in A, in B, or in both,
// as `roles` says: `{ hw: { A: 'writer' }, bm: { B: 'maintainer' } }`.

const PASSWORD = 'vh-pass-1';
export const emailOf = (key) => `vh-${key}@x.com`;

export const adminClient = () => new PlaidClient(CORE, readToken().token);

// The account for `key`, made when the database lacks it, and a signed-in
// session as it. The create is refused to a named token, so the admin signs in.
const sessions = new Map();
export async function person(key) {
  if (!sessions.has(key)) {
    sessions.set(
      key,
      (async () => {
        const email = emailOf(key);
        const exists = await adminClient()
          .users.get(email)
          .then(
            () => true,
            () => false,
          );
        if (!exists) await (await signInAdmin(CORE)).users.create(email, PASSWORD, false);
        const client = await PlaidClient.login(CORE, email, PASSWORD);
        return {
          email,
          client,
          auth: { token: client.token, userId: email, displayName: email, isAdmin: false },
        };
      })(),
    );
  }
  return sessions.get(key);
}

// Sign `page` in as `key` (an account of `person`), or as the admin when null.
export async function signInAs(page, key = null) {
  if (page.url() !== 'about:blank') await page.goto('about:blank');
  await seedAuth(page, key ? (await person(key)).auth : undefined);
}

const ADD_ROLE = { maintainer: 'addMaintainer', writer: 'addWriter', reader: 'addReader' };

// The morpheme tokens of a scratch project's one document, by their text.
async function morphemesOf(client, documentId) {
  const raw = await client.documents.get(documentId, true);
  const tl = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const ml = tl.tokenLayers.find((l) => roleOf(l) === ROLES.MORPHEME);
  return Object.fromEntries(ml.tokens.map((t) => [tl.text.body.slice(t.begin, t.end), t.id]));
}

export async function buildWorld({ borrowed = true, roles = {} } = {}) {
  const client = adminClient();
  const stamp = `${Date.now() % 1e7}`;
  const A = await createScratchProject({
    name: `VH home ${stamp}`,
    docName: 'Home text',
    body: 'kat perro',
  });
  const B = await createScratchProject({
    name: `VH borrower ${stamp}`,
    docName: 'Borrower text',
    body: 'kat zorro',
  });
  const world = {
    stamp,
    A: { id: A.projectId, documentId: A.documentId, name: `VH home ${stamp}` },
    B: { id: B.projectId, documentId: B.documentId, name: `VH borrower ${stamp}` },
  };
  const vocabName = `VH lexicon ${stamp}`;
  const { id: vocabId } = await client.vocabLayers.create(world.A.id, vocabName);
  world.V = { id: vocabId, name: vocabName };
  world.entries = {
    kat: (await client.vocabItems.create(vocabId, 'kat', { gloss: 'cat', morphType: 'stem' })).id,
    gato: (await client.vocabItems.create(vocabId, 'gato', { gloss: 'cat' })).id,
  };
  world.A.morphemes = await morphemesOf(client, world.A.documentId);
  world.B.morphemes = await morphemesOf(client, world.B.documentId);
  await client.vocabLinks.create(world.entries.kat, [world.A.morphemes.kat]);
  if (borrowed) {
    await client.projects.linkVocab(world.B.id, vocabId);
    await client.vocabLinks.create(world.entries.kat, [world.B.morphemes.kat]);
  }
  for (const [key, where] of Object.entries(roles)) {
    const { email } = await person(key);
    for (const [project, role] of Object.entries(where)) {
      await client.projects[ADD_ROLE[role]](world[project].id, email);
    }
  }
  return world;
}

// The borrower first: core refuses to delete a project while another project
// uses one of its vocabularies. Projects a test made beside the world go
// first of all.
export async function dropWorld(world, ...more) {
  if (!world) return;
  const client = adminClient();
  for (const id of [...more, world.B.id, world.A.id]) {
    if (id)
      await client.projects.delete(id).catch((e) => console.error('cleanup failed:', e.message));
  }
}

// Every request the page sends that is not a GET, as "METHOD /path?query",
// from now on.
export function writesOf(page) {
  const seen = [];
  page.on('request', (r) => {
    if (r.method() === 'GET' || !r.url().includes('/api/v1/')) return;
    const u = new URL(r.url());
    // The audit message and the operation ride in the query of a write: they
    // are not what is asserted.
    for (const key of ['audit-message', 'group-id', 'group-message']) u.searchParams.delete(key);
    seen.push(`${r.method()} ${u.pathname}${u.search}`);
  });
  return seen;
}
