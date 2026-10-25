import { canManageProject } from '@ui/domain/permissions.js';
import { DocumentModel } from '@ui/domain/DocumentModel.js';
import { isPendingId, settledId } from '@ui/domain/pendingIds.js';
import { getIgtLayerInfo } from './layerInfo.js';
import { readSpeakers, IGT_NAMESPACE } from './igtConfig.js';
import { readVocabulary } from './vocabCache.js';
import { statusOf } from '@ui/lib/errors.js';
import { expectStored, isConfigConflict, sameConfig } from '@ui/domain/configCells.js';
import { validateIgtDocument } from './validate.js';
import { deriveDocumentData, deriveSentences, deriveAlignmentTokens } from './derive.js';

import { spanMutations } from './mutations/spans.js';
import { tokenMutations } from './mutations/tokens.js';
import { sentenceMutations } from './mutations/sentences.js';
import { morphemeMutations } from './mutations/morphemes.js';
import { vocabMutations } from './mutations/vocab.js';
import { documentMutations } from './mutations/document.js';
import { alignmentMutations } from './mutations/alignment.js';
import { analysisCopyMutations } from './mutations/analysisCopy.js';
import { pendingMutations } from './mutations/pending.js';
import { linkFootprint, linksUntouched, tokenIdsOf } from './linkRebase.js';
import { linkChangedTo } from '@ui/lib/cellConflict.js';
import { buildItemNumbers, itemLabel } from './vocabDictionary.js';
import { countOf } from '../../../plaid-ui/src/lib/plural.js';

// The mutation mixins whose public methods are the writes (WRITES).
// pendingMutations holds only the pending-id helpers and is not among them.
const MIXINS = [
  spanMutations,
  tokenMutations,
  sentenceMutations,
  morphemeMutations,
  vocabMutations,
  documentMutations,
  alignmentMutations,
  analysisCopyMutations,
];

// A patch's own copy of the vocabularies. Everything but the entry lists is
// copied whole: this document's links and the vocabulary's settings, which
// are small. An entry list is the whole lexicon (a JSON copy of 20,000 entries
// takes 35 to 70 ms, on every patch), so it is copied as a list of the same
// entry objects. A patch adds an entry to its copy of the list, and changes an
// entry by putting a new object in its place, never by editing the one it
// was handed (keepUnchangedLists relies on that).
const cloneVocabs = (vocabularies) => {
  const out = {};
  for (const [id, vocab] of Object.entries(vocabularies || {})) {
    const { items, ...rest } = vocab;
    out[id] = JSON.parse(JSON.stringify(rest));
    if (items !== undefined) out[id].items = Array.isArray(items) ? items.slice() : items;
  }
  return out;
};

// A list the patch left as it was goes back to being the list it was copied
// from, so an index built over it (vocabLookup.js, over a run's shared lists)
// is still the one derive finds.
const keepUnchangedLists = (next, prev) => {
  for (const [id, vocab] of Object.entries(next || {})) {
    const before = prev?.[id]?.items;
    const after = vocab.items;
    if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) continue;
    if (after.every((it, i) => it === before[i])) vocab.items = before;
  }
  return next;
};

// Whether a patch left an entry list as it was: the same entry objects in the
// same places (a patch puts a new object in place of an entry it changes).
const sameItems = (before, after) =>
  Array.isArray(before) &&
  before.length === after.length &&
  after.every((it, i) => it === before[i]);

// Single source of truth for a loaded plaid-igt document. Wraps a raw
// plaid-client document, knows the IGT layer model (sentences > words >
// morphemes, plus alignment + span layers), owns the optimistic-update
// mutations that used to live in the editor's useXxxOperations hooks, and
// exposes a version-counted subscription so React (or any other UI layer)
// can re-render on change.
//
// Framework-agnostic — no React imports here. The React bridge lives in
// useDocumentModel.js.
//
// Vocab links are scoped on the vocab layer, not the document, so the doc
// also holds the project's loaded vocabularies (`_vocabularies`) and applies
// link/unlink patches to that table in `_applyRawPatch`.

export class IgtDocument extends DocumentModel {
  // Every public method of the mutation mixins (see the end of this file).
  static WRITES = MIXINS.flatMap((mixin) => Object.keys(mixin)).filter(
    (name) => !name.startsWith('_'),
  );

  constructor({
    raw,
    project = null,
    vocabularies = {},
    client = null,
    projectId = null,
    asOf = null,
    user = null,
  }) {
    super({ raw, client, projectId, project, user, asOf });
    // Fold the document-embedded vocab-links (under raw's token layers) into the
    // separately-loaded vocabularies: `vocabLayers.get` returns items but not
    // links, so this is the only way links survive a fresh load. See
    // mergeRawVocabLinks. A reload re-folds explicitly (it bypasses the ctor).
    this._vocabularies = mergeRawVocabLinks(raw, vocabularies);
    // Transcript row edits refused because their segment was deleted or made
    // again elsewhere, with no row left to hold them (`keepUnsavedRow`).
    this._unsavedRows = [];
    this._unsavedSeq = 0;
  }

  // The refused row edits, `{ id, typed, timeBegin, timeEnd }`, listed until
  // dismissed. Kept on the document and not on the transcript's screen, so a
  // switch of view keeps them, and a reload or a closed tab asks first while
  // any is listed.
  get unsavedRows() {
    return this._unsavedRows;
  }
  get holdsUnsaved() {
    return this._unsavedRows.length > 0;
  }
  keepUnsavedRow(row) {
    this._unsavedSeq += 1;
    this._unsavedRows = [...this._unsavedRows, { ...row, id: this._unsavedSeq }];
    this._emit();
  }
  dismissUnsavedRow(id) {
    this._unsavedRows = this._unsavedRows.filter((r) => r.id !== id);
    this._emit();
  }

  // Convenience factory: fetch document + project + project vocabularies and
  // wrap them in an IgtDocument. Mirror of plaid-ud's ConlluDocument.load.
  // `asOf` (an ISO timestamp) loads a historical snapshot for time-travel /
  // read-only viewing; omit/null for the live document.
  // `project` is a read of the project the caller already started (the
  // document screen reads it beside the document), as a promise.
  static async load(
    client,
    projectId,
    documentId,
    asOf = null,
    { user = null, project: projectRead = null } = {},
  ) {
    const at = asOf || undefined;
    // A past state reads the document and its vocabularies at the same time,
    // so a gloss shows as it read then. The project has no past state (a
    // project read refuses as-of), and its layers never change.
    // The vocabularies need only the project, so they download alongside the
    // document instead of after it (a large document is seconds of transfer).
    const projectP = projectRead ?? client.projects.get(projectId);
    const [raw, project, { vocabularies }] = await Promise.all([
      client.documents.get(documentId, true, at),
      projectP,
      projectP.then((project) => loadProjectVocabularies(client, project, asOf)),
    ]);
    return new IgtDocument({ raw, project, vocabularies, client, projectId, asOf, user });
  }

  // The document as it was at `asOf`, beside its vocabularies as they were
  // then (a gloss changed since reads as it did), reusing the project already
  // in memory, since a project's layers never change. The two reads go out
  // together. Returns a NEW IgtDocument. `this` is left untouched so the
  // caller can keep rendering it until it swaps.
  //
  // A vocabulary that did not exist at `asOf` is left out: nothing in the
  // document could link to it then. One that could not be read keeps the copy
  // on screen now, and says so, rather than showing the words unlinked.
  async atAsOf(asOf) {
    if (!asOf) return super.atAsOf(asOf);
    const [raw, { vocabularies, failed }] = await Promise.all([
      this._client.documents.get(this.id, true, asOf),
      loadProjectVocabularies(this._client, this._project, asOf),
    ]);
    const now = rebaseVocabLinks(this._vocabularies);
    for (const id of failed) if (now[id]) vocabularies[id] = now[id];
    const next = this._snapshot(raw, asOf, vocabularies);
    // The error handler is the screen's, not this instance's: carry it.
    next.onError = this.onError;
    if (failed.length && next.onError) {
      next.onError(
        `${countOf(failed.length, 'vocabulary')} could not be read as of that time. Entries show as they are now.`,
        null,
        'Failed to read the vocabularies',
      );
    }
    return next;
  }

  _snapshot(raw, asOf, vocabularies = rebaseVocabLinks(this._vocabularies)) {
    return new IgtDocument({
      raw,
      project: this._project,
      // The constructor folds the document's links into whatever it is handed,
      // so it is handed the entries with no links folded in yet.
      vocabularies,
      client: this._client,
      projectId: this._projectId,
      asOf,
      user: this._user,
    });
  }

  // ----- who is writing (provenance) -----
  // DocumentModel's `writer` is the policy. The mutations and the editor read
  // it through the accessors below.

  get isContributor() {
    return this.writer.isContributor;
  }
  get createStamp() {
    return this.writer.createStamp;
  }
  editStamp(metadata) {
    return this.writer.editStamp(metadata);
  }
  valueEditStamp(metadata, opts) {
    return this.writer.valueEditStamp(metadata, opts);
  }
  reviewable(metadata) {
    return this.writer.reviewable(metadata);
  }
  reviewableState(state) {
    return this.writer.reviewableState(state);
  }
  confirmStamp(metadata) {
    return this.writer.confirmStamp(metadata);
  }
  adoptStamp(source, detail) {
    return this.writer.adoptStamp(source, detail);
  }

  // ----- read API -----
  get vocabularies() {
    return this._vocabularies;
  }

  get layerInfo() {
    return this._derived('layerInfo', () => getIgtLayerInfo(this._raw));
  }

  // The document's metadata as stored, including keys no metadata field is
  // configured for: `document.metadata` carries only the configured ones, and
  // the marks importers and the Media tab leave are not among them.
  get storedMetadata() {
    return this._raw?.metadata || {};
  }

  get document() {
    return this._derived('document', () =>
      deriveDocumentData(this._raw, this.layerInfo, this._project),
    );
  }

  get body() {
    return this.layerInfo.primaryTextLayer?.text?.body ?? '';
  }

  // The document's text, made in the batch `b` of the write that first needs
  // one, when the document has none (a New document makes none, nor does ud's
  // form or an import with no body): `text` is the text that write shows,
  // `{ id, body }`, under an id minted for it, so the rows the batch makes
  // after it can name it. A text the server has made is left alone. Answers
  // whether the create was queued, in which case the text's body is in it.
  _ensureText(b, { id, body }, { tokenizeLayer } = {}) {
    if (!isPendingId(id)) return false;
    const layerId = this.layerInfo.primaryTextLayer.id;
    b.texts.create(layerId, this.id, body, undefined, undefined, { id, tokenizeLayer });
    return true;
  }

  get alignmentTokens() {
    return this._derived('alignmentTokens', () => deriveAlignmentTokens(this.layerInfo));
  }

  // Speaker-label suggestions for the diarization autocomplete: every speaker
  // actually in use on this document's alignment tokens (live, always fresh)
  // unioned with the project-level `config.igt.speakers` cache (names used in
  // OTHER documents — see `_rememberSpeaker`). Sorted, de-duped, blanks dropped.
  get knownSpeakers() {
    const set = new Set(readSpeakers(this._project?.config));
    for (const t of this.alignmentTokens) {
      const s = t.metadata?.speaker;
      if (s) set.add(s);
    }
    return [...set].filter((s) => typeof s === 'string' && s.trim() !== '').sort();
  }

  // Best-effort append of a newly-used speaker to the project's suggestion
  // cache so it surfaces in other documents. Never throws and never fails the
  // alignment write that triggered it: the live source of truth is the token
  // metadata, this is only autocomplete sugar. A no-op when the name is blank,
  // already cached, or the user may not write project config (a maintainer's
  // or an admin's), checked here rather than left to a refused write: a
  // writer's every row edit was refused 403. A writer's suggestions still hold
  // every speaker the document's own rows use (`knownSpeakers`).
  async _rememberSpeaker(name) {
    const speaker = (name || '').trim();
    if (!speaker || !this._client || !this._projectId) return;
    if (!canManageProject(this._project, this._user)) return;
    // Added to the list as stored: a write refused because someone else
    // saved the list since is made again to what they saved.
    const append = async (project) => {
      const known = readSpeakers(project?.config);
      if (known.includes(speaker)) return;
      const next = [...known, speaker];
      await this._client.projects.setConfig(
        this._projectId,
        IGT_NAMESPACE,
        'speakers',
        next,
        undefined,
        expectStored(project, IGT_NAMESPACE, 'speakers'),
      );
      // Kept as a project read is, so what is derived from it, and the
      // screens keyed on the data version, follow.
      if (this._project) {
        const config = this._project.config || {};
        this._takeProject({
          ...this._project,
          config: {
            ...config,
            [IGT_NAMESPACE]: { ...(config[IGT_NAMESPACE] || {}), speakers: next },
          },
        });
      }
    };
    if (readSpeakers(this._project?.config).includes(speaker)) return;
    try {
      try {
        await append(this._project);
      } catch (err) {
        if (!isConfigConflict(err)) throw err;
        await append(await this._client.projects.get(this._projectId));
      }
    } catch (err) {
      console.warn('Could not record speaker in project config:', err);
    }
  }

  // Sentences + lookup maps share one derivation; expose individually for
  // ergonomic consumer access.
  _sentencesBundle() {
    return this._derived('sentences', () =>
      deriveSentences(this._raw, this.layerInfo, this._vocabularies),
    );
  }
  get sentences() {
    return this._sentencesBundle().sentences;
  }
  get sortedSentences() {
    return this._sentencesBundle().sortedSentences;
  }
  get tokenLookup() {
    return this._sentencesBundle().tokenLookup;
  }
  get sentenceLookup() {
    return this._sentencesBundle().sentenceLookup;
  }
  get tokenPositionMaps() {
    return this._sentencesBundle().tokenPositionMaps;
  }
  get sentenceIndexLookup() {
    return this._sentencesBundle().sentenceIndexLookup;
  }
  get findSentenceForToken() {
    return this._sentencesBundle().findSentenceForToken;
  }

  // ============================================================
  // Mutation infrastructure (the lifecycle itself is DocumentModel's)
  // ============================================================

  // A patch producer receives the clone of `_raw`, a freshly computed layerInfo
  // for that clone (mutating through `info.primaryTokenLayer.tokens.push(...)`
  // mutates the clone, since layerInfo references are live into raw), and a
  // mutable clone of `_vocabularies` for link and unlink patches.
  _patchContext(next) {
    return [getIgtLayerInfo(next), cloneVocabs(this._vocabularies)];
  }
  _afterPatch(next, [, nextVocabs]) {
    this._vocabularies = keepUnchangedLists(nextVocabs, this._vocabularies);
  }
  // A link, an entry or a vocabulary's settings: kept beside the document, so
  // an edit that changed one is judged after a refusal by the links' own
  // rule (`_besideUntouched`): a link sent again over another user's link on
  // the same morpheme left the morpheme with two.
  _changesBeside([, nextVocabs]) {
    const was = this._vocabularies || {};
    const now = nextVocabs || {};
    for (const id of new Set([...Object.keys(was), ...Object.keys(now)])) {
      const { items: before, ...restBefore } = was[id] || {};
      const { items: after, ...restAfter } = now[id] || {};
      if (JSON.stringify(restBefore) !== JSON.stringify(restAfter)) return true;
      if (Array.isArray(before) !== Array.isArray(after)) return true;
      if (Array.isArray(after) && !sameItems(before, after)) return true;
    }
    return false;
  }

  // Each patch puts a new vocabularies object in place (`_afterPatch`).
  _besideState() {
    return this._vocabularies;
  }

  // A link edit refused because the document moved on goes again when what
  // it changes is as it was (linkRebase.js): Accept on a proposed link while
  // an assistant wrote elsewhere in the document. A real conflict is refused
  // with what changed, which the screen says as a notice. Not judged when
  // the vocabularies could not be read again: refused as before.
  _besideUntouched(unsent, now) {
    if (this._vocabsUnread) return false;
    unsent.linkFootprint ??= linkFootprint(unsent.besideBase, unsent.besideMade);
    const current = this._vocabularies;
    const { ok, conflict } = linksUntouched(
      unsent.linkFootprint,
      unsent.besideChecked,
      current,
      tokenIdsOf(now),
      // A token named in the conflict is gone from `now`: whether it was a
      // morpheme is read in the document the edit was made on.
      (id) =>
        (getIgtLayerInfo(unsent.origin ?? unsent.base).morphemeTokenLayer?.tokens || []).some(
          (m) => settledId(m.id) === id,
        )
          ? 'morpheme'
          : 'word',
    );
    if (ok) {
      unsent.besideChecked = current;
      return true;
    }
    if (conflict) {
      // The entry it is linked to now, by its form and number, "kai 1.1",
      // as an entry is written wherever it is text: a headword and its
      // sense share a form.
      if (conflict.item) {
        for (const vocab of Object.values(current || {})) {
          const item = (vocab?.items || []).find((it) => settledId(it.id) === conflict.item);
          if (item) {
            conflict.form = itemLabel(item, buildItemNumbers(vocab.items));
            break;
          }
        }
      }
      const since = (unsent.origin ?? unsent.base)?.timeModified ?? null;
      unsent.refusal = Object.assign(new Error(linkChangedTo(null, conflict)), {
        changedElsewhere: true,
        notice: true,
        linkConflict: { ...conflict, since },
      });
    }
    return false;
  }

  /**
   * Read one vocabulary's entries again, keeping this document's links to
   * them. The editor asks when it opens the lexicon popover: two people, or
   * one person in two tabs, add entries to a shared lexicon, and a list from
   * the page load showed neither, so the same headword was made twice with
   * nothing said. Quiet on failure: the list stays as it was.
   *
   * A save still on its way is waited for first: the popover opens most often
   * right after a gloss was typed, whose blur is that save, and a read skipped
   * then offered "+ Create" for an entry someone else had made. A read that
   * lands after an edit of the list is dropped and made once more.
   */
  async refreshVocabulary(vocabId, { again = 1 } = {}) {
    if (this._asOf || !this._vocabularies?.[vocabId]) return false;
    if (this.isSaving) await this.whenSaved();
    const current = this._vocabularies?.[vocabId];
    if (!current) return false;
    try {
      const fresh = await readVocabulary(this._client, vocabId);
      // Only a read that actually brought entries back replaces them: a stub
      // or a half-answer must not empty the list the editor is showing.
      if (!fresh || !Array.isArray(fresh.items)) return false;
      // An edit made while the read was out (an entry made, a link added), or
      // still on its way, may not be in it, and replacing the list would take
      // it off the screen. The list stays as the edits left it, and a read
      // made after them brings it up to date.
      if (this._vocabularies?.[vocabId] !== current || this.isSaving) {
        return again > 0 ? this.refreshVocabulary(vocabId, { again: again - 1 }) : false;
      }
      this._vocabularies = {
        ...this._vocabularies,
        [vocabId]: { ...current, ...fresh, vocabLinks: current.vocabLinks || [] },
      };
      this._emit();
      return true;
    } catch {
      return false;
    }
  }

  // A new copy of the project (DocumentModel `refreshProject`): each layer's
  // config comes from it too. The grid draws its cells, each with the tagset
  // it checks against, again on the new data version, and `document` derives
  // its metadata fields from the project.
  _adoptProject(project) {
    this._adoptLayerConfigs(project);
  }

  // Each layer's config (which tagset a field checks against, its scope, its
  // language) comes with the document, and a maintainer can change it while
  // the document is open. The project read carries every layer with its
  // config, so the document's copy of each layer takes the config read there.
  _adoptLayerConfigs(project) {
    const configs = new Map();
    const walk = (layers, visit) => {
      for (const layer of Array.isArray(layers) ? layers : []) {
        if (!layer || typeof layer !== 'object') continue;
        visit(layer);
        for (const [key, value] of Object.entries(layer)) {
          if (key.endsWith('Layers')) walk(value, visit);
        }
      }
    };
    walk(project?.textLayers, (layer) => {
      if (layer.id && 'config' in layer) configs.set(layer.id, layer.config);
    });
    walk(this._raw?.textLayers, (layer) => {
      if (!configs.has(layer.id)) return;
      const config = configs.get(layer.id);
      if (!sameConfig(config, layer.config)) layer.config = structuredClone(config);
    });
  }

  // A reload refreshes the project and its vocabularies with the document, at
  // the same snapshot. The document itself is kept even when the vocabularies
  // cannot be: the user is told the links may be stale rather than shown old
  // ones silently.
  async _adoptReload(updated) {
    // Until read here, what is kept beside is what this page showed, not
    // what is stored: no link edit is judged on it (`_besideUntouched`).
    this._vocabsUnread = true;
    if (!this._project) return;
    const at = this._asOf || undefined;
    try {
      const [project, { vocabularies: reloaded, failedCount }] = await Promise.all([
        this._readProject(),
        loadProjectVocabularies(this._client, this._project, at),
      ]);
      // Told to the screen now: a refetch after a refusal can end without a
      // raw swap, and the minute's read would then find nothing new.
      this._takeProject(project);
      this._vocabularies = mergeRawVocabLinks(updated, reloaded);
      this._vocabsUnread = failedCount > 0;
      if (failedCount > 0 && this.onError) {
        this.onError(
          `${countOf(failedCount, 'vocabulary')} could not be refreshed. Linked entries may show old values until the page is reloaded.`,
          null,
          'Failed to refresh the vocabularies',
        );
      }
    } catch (err) {
      console.warn('Vocab reload failed:', err);
      if (this.onError)
        this.onError(
          'Linked entries may show old values until the page is reloaded.',
          null,
          'Failed to refresh the vocabularies',
        );
    }
  }

  // The check on open: nothing is written. The layer rules (igtConstraints.js)
  // are declared at setup and by the settings that change them, and the
  // server applies them inside every write, whoever writes. A linked
  // morpheme's type is read off its entry, and no copy of it is stored. What
  // is left is reading the document against the app's contract:
  // validateIgtDocument's findings come back for the caller to log and toast.
  validateOnOpen() {
    try {
      return {
        findings: validateIgtDocument(this.layerInfo, this.alignmentTokens, {
          sentences: this.sentences,
          vocabularies: this._vocabularies,
        }),
      };
    } catch (err) {
      console.error('Checking the document failed:', err);
      return { findings: [], error: err };
    }
  }
}

// ----- helper: load project vocabularies -----
// Per-vocab fetch failures don't reject — the rest of the table still loads —
// but they're COUNTED so callers can surface "your vocab data is incomplete"
// instead of silently rendering a partial table. Returns
// { vocabularies, failedCount, failed } (`failed` the ids). Exported for
// callers that construct IgtDocuments from pre-fetched parts (e.g.
// export/runExport.js).
//
// Read live, a vocabulary unchanged since the last read is the copy kept then
// (vocabCache.js). With `asOf`, every vocabulary is read as it was at that
// time, and one that did not exist then (a 404) is simply absent, not failed.
export async function loadProjectVocabularies(client, project, asOf = null) {
  const vocabIds = (project?.vocabs || []).map((v) => v.id);
  if (vocabIds.length === 0) return { vocabularies: {}, failedCount: 0, failed: [] };
  const results = await Promise.all(
    vocabIds.map(async (id) => {
      try {
        return { id, vocab: await readVocabulary(client, id, asOf) };
      } catch (err) {
        if (asOf && statusOf(err) === 404) return { id, vocab: null, absent: true };
        console.warn(`Error fetching vocab ${id}:`, err);
        return { id, vocab: null };
      }
    }),
  );
  const vocabularies = {};
  const failed = [];
  results.forEach(({ id, vocab, absent }) => {
    if (vocab) vocabularies[vocab.id] = vocab;
    else if (!absent) failed.push(id);
  });
  return { vocabularies, failedCount: failed.length, failed };
}

// ----- helper: fold document-embedded vocab-links into loaded vocabularies -----
// `loadProjectVocabularies` (via `vocabLayers.get`) returns each vocab's *items*
// but NOT its vocab-links. The document GET, however, embeds every
// document-scoped vocab-link (each carrying its `vocabItem`) under the token
// layer its tokens belong to: `raw.textLayers[].tokenLayers[].vocabs[].vocabLinks`.
// Fold those links into the matching `vocabularies[vocabId]` so they survive a
// fresh load / reload. Without this, links only ever exist as in-session
// optimistic patches and vanish on the next load — the word/morpheme renders
// unlinked, looking deleted even though the link is still on the server. A
// single vocab's links can be split across several token layers (e.g. word +
// morpheme), so accumulate and dedupe by link id.
// `vocabLayers.get` returns items but NOT links — links live on the document and
// are folded in by mergeRawVocabLinks, which mutates the object it is given.
// Strip those folded links so the same (expensive) item arrays can be re-folded
// against a different snapshot. This is why `_reload` re-fetches instead of
// re-merging: merging a second raw onto an already-merged set would keep the
// first snapshot's links.
export function rebaseVocabLinks(vocabularies) {
  const out = {};
  for (const [id, v] of Object.entries(vocabularies || {})) {
    out[id] = { ...v, vocabLinks: [] };
  }
  return out;
}

function mergeRawVocabLinks(raw, vocabularies) {
  const vocabs = vocabularies || {};
  const seenByVocab = new Map(); // vocabId -> Set<linkId>
  (raw?.textLayers || []).forEach((textLayer) => {
    (textLayer.tokenLayers || []).forEach((tokenLayer) => {
      (tokenLayer.vocabs || []).forEach((v) => {
        if (!v?.id) return;
        let entry = vocabs[v.id];
        if (!entry) entry = vocabs[v.id] = { id: v.id, name: v.name, items: [], vocabLinks: [] };
        if (!Array.isArray(entry.vocabLinks)) entry.vocabLinks = [];
        let seen = seenByVocab.get(v.id);
        if (!seen) {
          seen = new Set(entry.vocabLinks.map((l) => l.id));
          seenByVocab.set(v.id, seen);
        }
        (v.vocabLinks || []).forEach((link) => {
          if (link && link.id != null && !seen.has(link.id)) {
            seen.add(link.id);
            entry.vocabLinks.push(link);
          }
        });
      });
    });
  });
  return vocabs;
}

// ----- compose mixins onto the prototype -----
// Each mutation family lives in its own file under ./mutations/. Mixins are
// plain objects of methods; Object.assign-ing them onto the prototype lets
// every method see `this` as the IgtDocument instance and call the shared
// helpers (_queueWrite, _applyRawPatch, _reload, layerInfo, etc.).
Object.assign(IgtDocument.prototype, pendingMutations, ...MIXINS);

// The editor keeps ids on its cells and in its state, and a row it created a
// moment ago is known by a pending id until the server answers (see
// mutations/pending.js). Every public mutation takes its arguments settled
// (DocumentModel `_runWrite`), so an id held from before the answer names the
// same row after it.
IgtDocument.wrapWrites();
