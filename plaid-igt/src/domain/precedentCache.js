// Project precedent (precedent.js), read once per project and shared by every
// document opened in it. The project-wide queries take seconds on a large
// corpus. Keyed per document, as they were, every move to the next document
// sent them all again, so they are keyed per project here.
//
// The tally a document sees:
//
//   the project's rows                  (read once, every document in them)
//   − this document's rows              (the same queries scoped to it, cheap)
//   + this document, live               (the editor folds it: precedent.js)
//   − the rows of each document edited earlier in this session
//   + that document as it was left      (a local fold, taken on the way out)
//
// The first two lines make up for the `!= doc` the project queries used to
// carry. The last two keep what a person just decided in one document
// counting in the next, since the project's rows predate it. Every document's
// rows are read once per project read and kept, so going back to a document
// sends nothing, and subtracting them undoes what the project's rows hold for
// it. A project read (the refresh on returning to the tab, or an old one on
// opening a document) holds every saved edit, so it drops them all.

import {
  createTally,
  foldDocument,
  foldProject,
  linkPrecedentQueries,
  mergeTally,
  valuePrecedentQueries,
} from './precedent.js';

// A project read older than this is read again when a document opens, so
// other people's decisions reach a session that never leaves the tab.
const PRECEDENT_MAX_AGE_MS = 10 * 60_000;

// A read that failed is asked again after this, and not before: the editor
// asks on every render, and a server that is failing should not hear about
// every keystroke.
const RETRY_AFTER_FAIL_MS = 60_000;

// login -> Map(key -> entry). Keyed by server and token, not by the client
// object: the editor builds a client per document (StrictModeContext), and
// the rows are what this login may read.
const byLogin = new Map();
const loginOf = (client) => `${client.baseUrl}\u0000${client.token}`;

const EMPTY = Object.freeze({ links: [], values: [] });

function vocabIdsOf(doc) {
  return Object.keys(doc?.vocabularies || {}).sort();
}

// The project, and the queries it asks. Two documents share an entry only
// when they would ask the same queries.
function keyOf(doc) {
  const layers = valuePrecedentQueries(doc.layerInfo).map((q) => q.query.where[0][2].layer);
  return `${doc.projectId}|${vocabIdsOf(doc).join(',')}|${layers.join(',')}`;
}

function entryFor(doc, create = true) {
  if (!doc?.client || !doc.projectId || !doc.layerInfo) return null;
  let entries = byLogin.get(loginOf(doc.client));
  if (!entries) {
    if (!create) return null;
    byLogin.set(loginOf(doc.client), (entries = new Map()));
  }
  const key = keyOf(doc);
  let entry = entries.get(key);
  if (!entry && create) {
    entry = {
      project: null, // { results, fetchedAt, promise, failed }
      docs: new Map(), // docId -> { results, promise, overlay, failedAt }
      generation: 0,
      memo: null,
    };
    entries.set(key, entry);
  }
  return entry;
}

// Both query families, run together. `docId` scopes them to one document.
async function fetchRows(doc, docId = null) {
  const client = doc.client;
  const [links, values] = await Promise.all([
    Promise.all(linkPrecedentQueries(vocabIdsOf(doc), { docId }).map((q) => client.query(q))),
    Promise.all(
      valuePrecedentQueries(doc.layerInfo, { docId }).map(({ kind, field, query }) =>
        client.query(query).then((results) => ({ kind, field, results })),
      ),
    ),
  ]);
  return { links, values };
}

function fetchDoc(entry, doc) {
  const rec = { results: null, promise: null, overlay: null, failedAt: 0 };
  entry.docs.set(doc.id, rec);
  rec.promise = fetchRows(doc, doc.id)
    .then((results) => {
      rec.results = results;
    })
    .catch((err) => {
      // Without its own rows the document cannot be taken out of the
      // project's, so it goes on the document alone until asked again.
      console.warn('Precedent for this document unavailable:', err);
      rec.failedAt = Date.now();
    })
    .finally(() => {
      rec.promise = null;
      entry.generation++;
    });
  return rec.promise;
}

/**
 * Make sure `doc`'s precedent is read. Returns a promise that settles when
 * something new has landed, or null when everything is already here (or
 * there is nothing to read). `force` reads the project again even when its
 * rows are fresh.
 */
export function openPrecedent(doc, { force = false } = {}) {
  const entry = entryFor(doc);
  if (!entry) return null;
  if (!vocabIdsOf(doc).length && !valuePrecedentQueries(doc.layerInfo).length) return null;
  const project = entry.project;
  const maxAge = project?.failed ? RETRY_AFTER_FAIL_MS : PRECEDENT_MAX_AGE_MS;
  const stale = force || !project || (!project.promise && Date.now() - project.fetchedAt > maxAge);
  if (stale) {
    // The project and this document are read side by side, so the rows
    // subtracted are as close as they can be to the rows they come out of.
    // Every other document's rows and state belong to the old read.
    entry.docs.clear();
    const next = { results: null, fetchedAt: Date.now(), promise: null, failed: false };
    entry.project = next;
    next.promise = fetchRows(doc)
      .then((results) => {
        next.results = results;
      })
      .catch((err) => {
        console.warn('Project precedent unavailable; using this document only:', err);
        next.results = EMPTY;
        next.failed = true;
      })
      .finally(() => {
        next.promise = null;
        entry.generation++;
      });
    return Promise.all([next.promise, fetchDoc(entry, doc)]);
  }
  const rec = entry.docs.get(doc.id);
  if (!rec || (rec.failedAt && Date.now() - rec.failedAt > RETRY_AFTER_FAIL_MS)) {
    return Promise.all([project.promise, fetchDoc(entry, doc)]);
  }
  return project.promise || rec.promise || null;
}

/** When the project's rows were last asked for, or 0. */
export function precedentFetchedAt(doc) {
  return entryFor(doc, false)?.project?.fetchedAt || 0;
}

/**
 * Everything but `doc` itself: the tally the editor folds the live document
 * into. Null until the project's rows and this document's have landed. Kept
 * until something changes, so ask on every render. The caller copies it
 * before adding to it.
 */
export function precedentBase(doc, ignoredCfg = null) {
  const entry = entryFor(doc, false);
  if (!entry?.project?.results) return null;
  const own = entry.docs.get(doc.id);
  if (!own?.results) return null;
  const cfgKey = JSON.stringify(ignoredCfg ?? null);
  const m = entry.memo;
  if (m && m.generation === entry.generation && m.docId === doc.id && m.cfgKey === cfgKey) {
    return m.tally;
  }
  const tally = foldProject(createTally(), entry.project.results, ignoredCfg);
  mergeTally(tally, foldProject(createTally(), own.results, ignoredCfg), -1);
  for (const [docId, rec] of entry.docs) {
    if (docId === doc.id || !rec.overlay || !rec.results) continue;
    mergeTally(tally, foldProject(createTally(), rec.results, ignoredCfg), -1);
    mergeTally(tally, rec.overlay, 1);
  }
  entry.memo = { generation: entry.generation, docId: doc.id, cfgKey, tally };
  return tally;
}

/**
 * The editor is closing `doc`. When it changed while open (`openedAt` is the
 * dataVersion it opened at), what it now holds stands in for its rows in
 * the project's, until the project is read again.
 */
export function leavePrecedent(doc, openedAt, opts = {}) {
  const rec = entryFor(doc, false)?.docs.get(doc.id);
  if (!rec?.results || doc.dataVersion === openedAt) return;
  rec.overlay = foldDocument(createTally(), doc.sentences, opts);
  entryFor(doc, false).generation++;
}
