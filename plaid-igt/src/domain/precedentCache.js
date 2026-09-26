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
//
// Subtracting a document's rows is only right when they are the rows the
// project read holds for it. The project read lists every document's version
// first, and a document opened later whose version differs, or that the list
// did not name, reads the project again. A failed project read has no base
// at all, so the editor ranks on the document alone.
//
// A history snapshot takes no part: it is a past state, not the document
// whose rows the project holds.

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
      project: null, // { results, versions, fetchedAt, promise, failed }
      // docId -> { results, promise, overlay, failedAt, version, alongside, opened }
      docs: new Map(),
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

// The version this model of the document holds: the last one a write of its
// own reported, else the one it was read at.
function versionOf(doc) {
  return doc.client?.documentVersions?.[doc.id] ?? doc.raw?.version ?? null;
}

// Where "changed while open" is counted from: this model of the document at
// this dataVersion, whichever editor instance shows it. A document with a
// write still queued is ahead of any rows read now, so it has no baseline and
// counts as changed when it is left.
function baselineOf(doc) {
  return { doc, dataVersion: doc.isSaving ? null : doc.dataVersion };
}

// `alongside`: read in the same breath as the project, so it is not held to
// the project's list of versions (it could only differ by an edit landing
// between the two, and holding it to that could read the project forever).
function fetchDoc(entry, doc, { alongside = false } = {}) {
  const rec = {
    results: null,
    promise: null,
    overlay: null,
    failedAt: 0,
    version: versionOf(doc),
    alongside,
    opened: baselineOf(doc),
  };
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

// The project and every document's version in it, the versions first: an
// edit landing between the two then shows as a version the rows already
// hold, which costs a needless read and never a wrong one.
async function fetchProject(doc) {
  const listed = await doc.client.projects.listDocuments(doc.projectId);
  const versions = new Map((listed || []).map((d) => [d.id, d.version]));
  return { versions, results: await fetchRows(doc) };
}

// A document's rows were read after the project's, and it was at another
// version then than the project read listed (or not listed at all): the
// rows subtracted would not be the rows the project holds for it.
function outOfStep(project, rec, docId) {
  if (!project?.versions || !rec?.results || rec.alongside) return false;
  const listed = project.versions.get(docId);
  return listed == null || rec.version == null || listed !== rec.version;
}

/**
 * Make sure `doc`'s precedent is read. Returns a promise that settles when
 * something new has landed, or null when everything is already here (or
 * there is nothing to read). `force` reads the project again even when its
 * rows are fresh.
 */
export function openPrecedent(doc, { force = false } = {}) {
  if (doc?.asOf) return null;
  const entry = entryFor(doc);
  if (!entry) return null;
  if (!vocabIdsOf(doc).length && !valuePrecedentQueries(doc.layerInfo).length) return null;
  const project = entry.project;
  const maxAge = project?.failed ? RETRY_AFTER_FAIL_MS : PRECEDENT_MAX_AGE_MS;
  const rec = entry.docs.get(doc.id);
  const stale =
    force ||
    !project ||
    (!project.promise && Date.now() - project.fetchedAt > maxAge) ||
    outOfStep(project, rec, doc.id);
  if (stale) {
    // The project and this document are read side by side, so the rows
    // subtracted are as close as they can be to the rows they come out of.
    // Every other document's rows and state belong to the old read.
    entry.docs.clear();
    const next = {
      results: null,
      versions: null,
      fetchedAt: Date.now(),
      promise: null,
      failed: false,
    };
    entry.project = next;
    next.promise = fetchProject(doc)
      .then(({ versions, results }) => {
        next.versions = versions;
        next.results = results;
      })
      .catch((err) => {
        console.warn('Project precedent unavailable; using this document only:', err);
        next.failed = true;
      })
      .finally(() => {
        next.promise = null;
        entry.generation++;
      });
    return Promise.all([next.promise, fetchDoc(entry, doc, { alongside: true })]);
  }
  if (!rec || (rec.failedAt && Date.now() - rec.failedAt > RETRY_AFTER_FAIL_MS)) {
    // Checked against the project's versions once both have landed.
    return Promise.all([project.promise, fetchDoc(entry, doc)]).then(() => openPrecedent(doc));
  }
  // Another model of the same document (opened again): changes are counted
  // from here.
  if (rec.opened.doc !== doc) rec.opened = baselineOf(doc);
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
  if (doc?.asOf) return null;
  const entry = entryFor(doc, false);
  if (!entry?.project?.results || entry.project.failed) return null;
  const own = entry.docs.get(doc.id);
  if (!own?.results || outOfStep(entry.project, own, doc.id)) return null;
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
 * The editor is closing `doc`. When it changed while open, what it now holds
 * stands in for its rows in the project's, until the project is read again.
 * "While open" is since this model of the document was first shown with this
 * project read, not since the editor instance closing it was made: an editor
 * rebuilt around the same document (after a look at its history, or when a
 * run makes it read-only) has not seen the edits made before it.
 */
export function leavePrecedent(doc, opts = {}) {
  if (doc?.asOf) return;
  const entry = entryFor(doc, false);
  const rec = entry?.docs.get(doc.id);
  if (!rec?.results || rec.opened.doc !== doc) return;
  if (rec.opened.dataVersion !== null && doc.dataVersion === rec.opened.dataVersion) return;
  rec.overlay = foldDocument(createTally(), doc.sentences, opts);
  entry.generation++;
}

/**
 * Forget every project read. For a write that reaches documents other than
 * the one open (Bulk Edit, deleting or merging an entry), whose rows the
 * reads held.
 */
export function dropPrecedent() {
  byLogin.clear();
}
