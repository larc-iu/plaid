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
// The first two lines leave the open document out of the project's rows,
// which it would otherwise count twice. The last two keep what a person just decided in one document
// counting in the next, since the project's rows predate it. Every document's
// rows are read once per project read and kept, so going back to a document
// sends nothing, and subtracting them undoes what the project's rows hold for
// it. A project read (after a save made elsewhere, see below) holds every
// saved edit, so it drops them all.
//
// Subtracting a document's rows is only right when they are the rows the
// project read holds for it. The project read lists every document's version
// first, and a document opened later whose version differs, or that the list
// did not name, reads the project again. A failed project read has no base
// at all, so the editor ranks on the document alone.
//
// A history snapshot takes no part: it is a past state, not the document
// whose rows the project holds.
//
// WHEN THE PROJECT IS COUNTED AGAIN: only after a change. The counting
// queries take seconds on a large project and hold one of the server's few
// database connections the whole time, so a tab never counts on a timer.
// Instead it asks the cheap question first: the version of every document
// in the project, which is one short list read. The rows it holds are still
// good when every document is at the version they account for:
//
//   a document left here after an edit   the version it was left at
//   every other document                 the version the project read listed
//
// The document open here is not asked about: its rows are taken out of the
// count and it is folded live, so a save to it changes nothing the count
// holds. It is held to its version again once it is left.
//
// Any other version, a document added or a document gone, is a save made
// somewhere else (another person, another tab, a script, an import), and
// the project is counted again. The question is asked when a document is
// opened and when the tab comes back into view. Every write to a document's
// content bumps its version, deleting or respelling an entry included, so
// the versions see every change the counts can show. An entry's own fields
// changing does not bump a document, and does not change the counts either.
//
// The counts and every document left after an edit are also kept in the
// browser (precedentStore.js), so a reload or a new tab starts from them and
// asks the same question before using them.

import {
  createTally,
  foldDocument,
  foldProject,
  linkPrecedentQueries,
  mergeTally,
  valuePrecedentQueries,
} from './precedent.js';
import { clearStored, loginHash, readStored, writeStored } from './precedentStore.js';

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
      // { results, versions, fetchedAt, checkedAt, promise, failed }
      project: null,
      // docId -> { results, promise, overlay, overlayVersion, failedAt,
      //            version, alongside, opened }
      docs: new Map(),
      generation: 0,
      memo: null,
      // The version question in flight, if any.
      checking: null,
      // Where the browser keeps this entry, and whose it is.
      storeKey: `${doc.client.baseUrl}\u0000${key}`,
      login: loginHash(doc.client.token),
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

// Every document of the project and its version: the cheap question.
async function listVersions(doc) {
  const listed = await doc.client.projects.listDocuments(doc.projectId);
  return new Map((listed || []).map((d) => [d.id, d.version]));
}

// The project and every document's version in it, the versions first: an
// edit landing between the two then shows as a version the rows already
// hold, which costs a needless read and never a wrong one. `listed` is a
// list the caller has just read.
async function fetchProject(doc, listed = null) {
  const versions = listed || (await listVersions(doc));
  return { versions, results: await fetchRows(doc) };
}

// Has anything been saved since `project` was counted, other than what this
// tab accounts for itself? See the header for the version each document is
// held to. `openDoc` is the document open here now, which is not asked about.
function changedSince(entry, project, listed, openDoc = null) {
  const held = project.versions;
  if (!held || listed.size !== held.size) return true;
  for (const [id, version] of listed) {
    if (!held.has(id)) return true;
    if (openDoc && id === openDoc.id) continue;
    const rec = entry.docs.get(id);
    if (version !== (rec?.overlay ? rec.overlayVersion : held.get(id))) return true;
  }
  return false;
}

// Keep the counts, and every document left after an edit, in the browser.
// Only a read that landed whole is kept.
function persist(entry) {
  const project = entry.project;
  if (!project?.results || project.failed || !project.versions) return;
  const docs = [];
  for (const [id, rec] of entry.docs) {
    if (!rec.overlay || !rec.results) continue;
    const { results, version, alongside, overlay, overlayVersion } = rec;
    docs.push([id, { results, version, alongside, overlay, overlayVersion }]);
  }
  writeStored(entry.storeKey, {
    login: entry.login,
    results: project.results,
    versions: project.versions,
    fetchedAt: project.fetchedAt,
    docs,
  });
}

// A fresh tab's first open: the counts the browser kept, when the versions
// say they are still good, else a new read. `own` is the opened document's
// record, read alongside: kept counts hold it to their versions instead.
async function restoreOrFetch(entry, next, doc, own) {
  const stored = await readStored(entry.storeKey, entry.login);
  if (stored && entry.project === next) {
    const listed = await listVersions(doc);
    // The kept documents stand beside the one being opened, whose own rows
    // are being read now.
    const kept = new Map(stored.docs.filter(([id]) => id !== doc.id));
    const trial = { docs: kept };
    if (!changedSince(trial, stored, listed, doc) && entry.project === next) {
      if (entry.docs.get(doc.id) === own) own.alongside = false;
      next.versions = stored.versions;
      next.results = stored.results;
      next.fetchedAt = stored.fetchedAt;
      for (const [id, rec] of kept) {
        if (entry.docs.has(id)) continue;
        entry.docs.set(id, {
          ...rec,
          promise: null,
          failedAt: 0,
          opened: { doc: null, dataVersion: null },
        });
      }
      return;
    }
  }
  const { versions, results } = await fetchProject(doc);
  next.versions = versions;
  next.results = results;
  if (entry.project === next) persist(entry);
}

// Read the project again, and this document's own rows beside it. Every
// other document's rows and state belong to the old read.
function readProject(entry, doc, { restore = false, listed = null } = {}) {
  entry.docs.clear();
  const now = Date.now();
  const next = {
    results: null,
    versions: null,
    fetchedAt: now,
    checkedAt: now,
    promise: null,
    failed: false,
  };
  entry.project = next;
  // Read in the same breath as the project, unless the project turns out
  // to be the one the browser kept: then it is held to the kept versions.
  const own = fetchDoc(entry, doc, { alongside: true });
  const read = restore
    ? restoreOrFetch(entry, next, doc, entry.docs.get(doc.id))
    : fetchProject(doc, listed).then(({ versions, results }) => {
        next.versions = versions;
        next.results = results;
        if (entry.project === next) persist(entry);
      });
  next.promise = read
    .catch((err) => {
      console.warn('Project precedent unavailable; using this document only:', err);
      next.failed = true;
    })
    .finally(() => {
      next.promise = null;
      entry.generation++;
    });
  return Promise.all([next.promise, own]);
}

// Ask whether anything was saved since the project was counted, and count
// it again if so. One question at a time. A question that fails keeps what
// is held: it cannot tell a change from none.
function checkProject(entry, doc) {
  if (entry.checking) return entry.checking;
  const project = entry.project;
  project.checkedAt = Date.now();
  const checking = listVersions(doc)
    .then((listed) => {
      if (entry.project !== project || !changedSince(entry, project, listed, doc)) return null;
      return readProject(entry, doc, { listed });
    })
    .catch((err) => {
      console.warn('Could not ask whether the project changed:', err);
      return null;
    })
    .finally(() => {
      if (entry.checking === checking) entry.checking = null;
    });
  entry.checking = checking;
  return checking;
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
 * there is nothing to read). Asked on every render. Opening a document asks
 * the server whether the project changed (see the header), and so does
 * `check`, which the editor passes when the tab comes back into view.
 */
export function openPrecedent(doc, { check = false } = {}) {
  if (doc?.asOf) return null;
  const entry = entryFor(doc);
  if (!entry) return null;
  if (!vocabIdsOf(doc).length && !valuePrecedentQueries(doc.layerInfo).length) return null;
  const project = entry.project;
  const rec = entry.docs.get(doc.id);
  const stale =
    !project ||
    (project.failed && !project.promise && Date.now() - project.fetchedAt > RETRY_AFTER_FAIL_MS) ||
    outOfStep(project, rec, doc.id);
  if (stale) {
    // The project and this document are read side by side, so the rows
    // subtracted are as close as they can be to the rows they come out of.
    // A tab's first read starts from what the browser kept, if it is good.
    return readProject(entry, doc, { restore: !project });
  }
  if (project.failed) return null;
  if (!rec || (rec.failedAt && Date.now() - rec.failedAt > RETRY_AFTER_FAIL_MS)) {
    // Checked against the project's versions once both have landed.
    const opened = !project.promise && checkProject(entry, doc);
    return Promise.all([project.promise, fetchDoc(entry, doc), opened]).then(() =>
      openPrecedent(doc),
    );
  }
  // Another model of the same document (opened again): changes are counted
  // from here, once the project is known not to have changed meanwhile.
  if (rec.opened.doc !== doc) {
    rec.opened = baselineOf(doc);
    if (!project.promise && !rec.promise) return checkProject(entry, doc);
  }
  if (check && !project.promise) return checkProject(entry, doc);
  return project.promise || rec.promise || entry.checking || null;
}

/** When the project's rows were last read or checked, or 0. */
export function precedentFetchedAt(doc) {
  const project = entryFor(doc, false)?.project;
  return Math.max(project?.fetchedAt || 0, project?.checkedAt || 0);
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
  // The version the overlay speaks for: any other version of this document
  // is a save made somewhere else.
  rec.overlayVersion = doc.isSaving ? null : versionOf(doc);
  entry.generation++;
  persist(entry);
}

/**
 * Forget every project read. For a write that reaches documents other than
 * the one open (Bulk Edit, deleting or merging an entry), whose rows the
 * reads held.
 */
export function dropPrecedent() {
  byLogin.clear();
  clearStored();
}
