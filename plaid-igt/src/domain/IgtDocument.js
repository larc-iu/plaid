import {
  applyMetadataOps,
  isReviewed,
  mergeMetadata,
  metadataOps,
  PLAID_NAMESPACE,
  PRESERVE_ON_SPLIT_KEY,
  PROVENANCE_KEYS,
  writerPolicy,
  createdId,
} from '@larc-iu/plaid-client';
import { canEditProject, canManageProject } from '@ui/domain/permissions.js';
import { DocumentModel } from '@ui/domain/DocumentModel.js';
import { followIds, pendingId, settledId } from '@ui/domain/pendingIds.js';
import { newHalfMetadata, survivorPatch } from './tokenReshape.js';
import { getIgtLayerInfo } from './layerInfo.js';
import { readSpeakers, IGT_NAMESPACE } from './igtConfig.js';
import { readVocabulary } from './vocabCache.js';
import { statusOf } from '@ui/lib/errors.js';
import { expectStored, isConfigConflict, sameConfig } from '@ui/domain/configCells.js';
import { ensureLayerConstraints } from '@ui/lib/layerConstraints.js';
import { rulesNotInForce, wantedConstraints } from './igtConstraints.js';
import {
  planMorphTypeSync,
  describeReconcile as describeIgtReconcile,
  planPreserveOnSplit,
  planFieldLangBackfill,
  planVocabFieldLangBackfill,
} from './igtReconcile.js';
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
// Audit-log label for a mutation, derived from its "Failed to <verb phrase>"
// error label: "Failed to merge morphemes" → "Merge morphemes". Keeps every
// mutation a labeled logical operation without a second string per call site.
export class IgtDocument extends DocumentModel {
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
    this._writer = null;
    // How many times a read of the project changed it (`refreshProject`).
    this._projectReads = 0;
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
  static async load(client, projectId, documentId, asOf = null, { user = null } = {}) {
    const at = asOf || undefined;
    // A past state reads the document and its vocabularies at the same time,
    // so a gloss shows as it read then. The project has no past state (a
    // project read refuses as-of), and its layers never change.
    // The vocabularies need only the project, so they download alongside the
    // document instead of after it (a large document is seconds of transfer).
    const projectP = client.projects.get(projectId);
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
        `${failed.length} ${failed.length === 1 ? 'vocabulary' : 'vocabularies'} could not be read as of that time. Entries show as they are now.`,
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
  // The provenance convention tells a VERIFIER from a CONTRIBUTOR: a
  // verifier's work stands as human-made and their edits confirm machine or
  // contributed material; a contributor's work is stamped contributed until a
  // verifier confirms it. Whose work is reviewed is the project's call, under
  // the cross-app `plaid.review` config (isReviewed); a document with no user
  // (scripts, imports, tests) writes as a verifier. The policy itself, what
  // each writer's creates, edits and confirms carry and what their review
  // gestures act on, is the client's writerPolicy; the mutations and the
  // editor read it through the accessors below.

  /** The contributor's user id, or null when the writer is a verifier. */
  get contributorId() {
    const user = this._user;
    if (!user?.id || !this._project) return null;
    return isReviewed(this._project, user.id, { isAdmin: !!user.isAdmin }) ? user.id : null;
  }

  /** The writer's policy (see plaid-client's writerPolicy), for the current user. */
  get writer() {
    const id = this.contributorId;
    if (!this._writer || this._writer.contributorId !== id) this._writer = writerPolicy(id);
    return this._writer;
  }

  get isContributor() {
    return this.writer.isContributor;
  }
  get createStamp() {
    return this.writer.createStamp;
  }
  editStamp(metadata) {
    return this.writer.editStamp(metadata);
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
  // already cached, or the user lacks project-config write access.
  async _rememberSpeaker(name) {
    const speaker = (name || '').trim();
    if (!speaker || !this._client || !this._projectId) return;
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
      if (this._project) {
        const config = this._project.config || {};
        this._project = {
          ...this._project,
          config: {
            ...config,
            [IGT_NAMESPACE]: { ...(config[IGT_NAMESPACE] || {}), speakers: next },
          },
        };
        this._emit();
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
  // an edit that changed one is never sent again by itself after a refusal.
  // Another user's link on the same morpheme is not in the document read,
  // and a link sent again over it left the morpheme with two.
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

  /**
   * Read the project again. Its tagsets, metadata fields, speakers and review
   * setting change while a document stays open, and a copy from the page load
   * let a value through a tagset closed since, or refused one opened since.
   * Every refetch reads it, and so does a return to the tab while a screen
   * holds the document (`hold`). A past state keeps the project it has, since
   * a project has no past state. Quiet on failure: the copy stays as it was.
   */
  async refreshProject() {
    const project = await this._readProject();
    if (!project || sameConfig(project, this._project)) return false;
    this._project = project;
    this._adoptLayerConfigs(project);
    // A new data version: the grid draws its cells, each with the tagset it
    // checks against, again only when that changes, and `document` derives
    // its metadata fields from the project. `_dataVersion` itself is left
    // alone, since a reload takes a bump of it during its fetch for an edit
    // and would then not show what it fetched.
    this._projectReads++;
    this._derivedCache.clear();
    this._emit();
    return true;
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

  /** The document's data version, which a new copy of the project also moves. */
  get dataVersion() {
    return this._dataVersion + this._projectReads;
  }

  async _readProject() {
    if (!this._client || !this._projectId || this._asOf) return null;
    try {
      return await this._client.projects.get(this._projectId);
    } catch (err) {
      console.warn('Could not read the project again:', err);
      return null;
    }
  }

  hold() {
    const release = super.hold();
    if (this._holds === 1 && typeof document !== 'undefined') {
      this._onVisible = () => {
        if (document.visibilityState === 'visible') this.refreshProject();
      };
      document.addEventListener('visibilitychange', this._onVisible);
    }
    return () => {
      release();
      if (this._holds === 0 && this._onVisible) {
        document.removeEventListener('visibilitychange', this._onVisible);
        this._onVisible = null;
      }
    };
  }

  // A reload refreshes the project and its vocabularies with the document, at
  // the same snapshot. The document itself is kept even when the vocabularies
  // cannot be: the user is told the links may be stale rather than shown old
  // ones silently.
  async _adoptReload(updated) {
    if (!this._project) return;
    const at = this._asOf || undefined;
    try {
      const [project, { vocabularies: reloaded, failedCount }] = await Promise.all([
        this._readProject(),
        loadProjectVocabularies(this._client, this._project, at),
      ]);
      // The raw swap that follows re-derives everything that reads it.
      if (project) this._project = project;
      this._vocabularies = mergeRawVocabLinks(updated, reloaded);
      if (failedCount > 0 && this.onError) {
        this.onError(
          `${failedCount} vocabular${failedCount === 1 ? 'y' : 'ies'} could not be refreshed. Linked entries may show old values until the page is reloaded.`,
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

  // Reconcile-on-open: make sure the server holds IGT's layer rules, repair
  // what the rules leave to an app, then validate what remains.
  //  - Layer rules (igtConstraints.js), maintainers only: a morpheme matching
  //    no word, a second annotation in one field on one token, a second
  //    vocabulary link on one token, a value outside a closed tagset. The
  //    server applies them inside every write, whoever writes, so what IGT
  //    used to heal here (an orphan morpheme, a doubled annotation or link
  //    after another app's word merge) never reaches storage. A project whose
  //    layers do not hold them yet gets the server's repair of its stored
  //    data first, then the declaration. A rule the data still breaks (an
  //    off-list value) is not put in force, and a finding says so.
  //  - Morph types cached on morphemes that drifted from their lexicon entry.
  // Then run validateIgtDocument over the healed state: residual heal failures
  // and un-healable app-contract violations come back as `findings` for the
  // caller to log + toast. Loud + recoverable. Deliberately NOT via _queueWrite
  // (a heal failure must not reload-and-revert the freshly loaded document).
  // Every heal write folds under ONE audit entry, relabelled by
  // `describeReconcile` to name the repair that ran (no entry at all when
  // nothing needed healing, since groups are created lazily by the first
  // write).
  describeReconcile(result) {
    return describeIgtReconcile(result);
  }

  // Declared on the layer so a split in ANY app preserves it, including one
  // that has never heard of these keys. Maintainers only, since it is layer
  // config; a failure is not worth interrupting anyone over, because nothing
  // is worse than it was. The write adds only the missing keys to what the
  // layer declared, and names that declaration as `expected`, so a key
  // another app declared after this page loaded is not written over: that
  // write is refused and the next open plans again.
  async _backfillPreserveOnSplit(info) {
    if (!canManageProject(this._project, this._user)) return;
    const ids = planPreserveOnSplit(info, PLAID_NAMESPACE, PRESERVE_ON_SPLIT_KEY, PROVENANCE_KEYS);
    const layers = [
      info?.sentenceTokenLayer,
      info?.primaryTokenLayer,
      info?.morphemeTokenLayer,
      info?.alignmentTokenLayer,
    ];
    for (const id of ids) {
      const layer = layers.find((l) => l?.id === id);
      const options = expectStored(layer, PLAID_NAMESPACE, PRESERVE_ON_SPLIT_KEY);
      const declared = Array.isArray(options.expected) ? options.expected : [];
      const value = [...declared, ...PROVENANCE_KEYS.filter((k) => !declared.includes(k))];
      try {
        await this._client.tokenLayers.setConfig(
          id,
          PLAID_NAMESPACE,
          PRESERVE_ON_SPLIT_KEY,
          value,
          undefined,
          options,
        );
      } catch (err) {
        if (isConfigConflict(err)) continue;
        console.error('Could not declare preserveOnSplit on a layer:', err);
        return;
      }
    }
  }

  // A field's language, recorded from its name once: "Gloss (nl)" was how the
  // FLEx importer said "nl" before fields recorded a language, and the
  // exporters read the record now, not the name. Maintainers only, and a
  // failure is not worth interrupting anyone over.
  //
  // Each write names the value this page read as `expected` (compare-and-set),
  // so it adds only the missing languages to what is stored. A maintainer's
  // settings save made after this page loaded makes the write a 409, which is
  // let go: the save stands, and the next open plans from it.
  async _backfillFieldLangs(info) {
    if (!canManageProject(this._project, this._user)) return;
    const spanLayers = Object.values(info.spanLayers || {}).flat();
    const byId = new Map(spanLayers.map((sl) => [sl?.id, sl]));
    const writes = [
      ...planFieldLangBackfill(spanLayers).map(
        ({ id, lang }) =>
          () =>
            this._client.spanLayers.setConfig(
              id,
              IGT_NAMESPACE,
              'lang',
              lang,
              undefined,
              expectStored(byId.get(id), IGT_NAMESPACE, 'lang'),
            ),
      ),
      ...Object.values(this._vocabularies || {}).flatMap((vocab) => {
        const fields = planVocabFieldLangBackfill(vocab);
        if (!fields) return [];
        return [
          () =>
            this._client.vocabLayers.setConfig(
              vocab.id,
              IGT_NAMESPACE,
              'fields',
              fields,
              undefined,
              expectStored(vocab, IGT_NAMESPACE, 'fields'),
            ),
        ];
      }),
    ];
    for (const write of writes) {
      try {
        await write();
      } catch (err) {
        if (isConfigConflict(err)) continue;
        console.error('Could not record a field language:', err);
        return;
      }
    }
  }

  async _reconcile() {
    const ZERO = {
      rulesDeclared: false,
      rulesRepaired: false,
      syncedMorphTypes: 0,
      findings: [],
    };
    // Single-flight: a concurrent re-entry (StrictMode double-invoke, a rapid
    // re-open) must not double-create morphemes.
    if (this._reconciling) return ZERO;
    this._reconciling = true;
    let tally = null;
    let landed = false;
    try {
      let info = this.layerInfo;
      // Back-fill, the reconcile contract's second step: a project made before
      // `preserveOnSplit` existed picks it up the next time a maintainer opens
      // a document. It has to be in place BEFORE a split, since provenance lost
      // that way leaves nothing for a later pass to find.
      await this._backfillPreserveOnSplit(info);
      await this._backfillFieldLangs(info);
      const rules = await ensureLayerConstraints(
        this._client,
        wantedConstraints(info, this._project?.config),
        {
          canManage: canManageProject(this._project, this._user),
          canWrite: canEditProject(this._project, this._user),
          documentId: this.id,
        },
      );
      // The server's repair changed stored rows this screen shows.
      if (rules.repaired) {
        await this._reload();
        info = this.layerInfo;
      }
      const typePlans = planMorphTypeSync(this.sentences);
      tally = {
        rulesDeclared: rules.changed,
        rulesRepaired: rules.repaired,
        syncedMorphTypes: typePlans.length,
      };

      if (typePlans.length) {
        // Cached morph types that drifted from their lexicon entry's.
        await this._client.batched(async (b) => {
          typePlans.forEach((p) => {
            b.tokens.patchMetadata(p.morphemeId, [
              { op: 'set', path: ['morphType'], value: p.morphType },
            ]);
          });
        });
      }
      // Every write has landed: the repair is whole, and a failure from here
      // on leaves only the screen behind it.
      landed = true;
      if (typePlans.length) {
        const byId = new Map(typePlans.map((p) => [p.morphemeId, p.morphType]));
        this._applyRawPatch((next, infoNext) => {
          (infoNext.morphemeTokenLayer?.tokens || []).forEach((m) => {
            if (byId.has(m.id)) m.metadata = { ...(m.metadata || {}), morphType: byId.get(m.id) };
          });
        });
      }

      // Validate AFTER healing — whether or not anything was healed — so a heal
      // that silently failed, or an un-healable app-contract violation, still
      // surfaces. validate is pure + read-only; the caller logs + toasts.
      const findings = [
        ...validateIgtDocument(this.layerInfo, this.alignmentTokens, {
          sentences: this.sentences,
          vocabularies: this._vocabularies,
        }),
        ...rulesNotInForce(rules.pending, info),
      ];

      return { ...tally, findings };
    } catch (err) {
      console.error('reconcileOnOpen failed:', err);
      // Findings read off a screen the repair did not reach would describe
      // the document as it was before it, so there are none.
      if (landed) return { ...ZERO, ...tally, refreshError: err };
      return { ...ZERO, error: err };
    } finally {
      this._reconciling = false;
    }
  }

  // ============================================================
  // Template mutations
  // ============================================================
  // These two methods serve as the canonical template for the mutation
  // mixins. Conventions to follow:
  //
  // - Every edit shows before the server answers, creates included. Validate
  //   inputs (id lookups, layer presence) first: guard failures use
  //   `setError + return false`. Then `_canWrite(label)`, the patch
  //   (`_applyRawPatch`), and `_queueWrite(label, send)` with the server
  //   calls, which runs after any write still in flight.
  // - A row the edit creates goes in under a pending id and `_settle` swaps
  //   the server's in (see mutations/pending.js). The send names every id
  //   through `settledId`: an edit made while an earlier one was queued can
  //   hold that one's pending ids. Ids handed in are settled on the way in
  //   (see the end of this file).
  // - Inside `_applyRawPatch((next, info, vocabs) => ...)`, re-resolve
  //   layers/tokens via `info` — captured outer references point into the
  //   OLD raw doc and mutating through them is a real bug.
  // - Inside `_client.batched(async (b) => ...)`, every write goes on `b`: a
  //   write made on `this._client` there leaves the transaction.
  // - For batched ops, the order matters: the server runs a batch's ops
  //   sequentially, so an op that depends on a prior shift must come AFTER it.
  //
  // updateOrthography — simplest case: single field update with metadata merge.
  // splitToken — complex case: pre-cleanup of dependent tokens, atomic batch
  //              with returned id, multi-step optimistic patch.

  // Set or update a per-orthography metadata key (`orthog:<name>`) on a word
  // token. Orthographies derive from the token's metadata at render time, so
  // the patch is the metadata entry alone.
  async updateOrthography(tokenId, orthographyName, value) {
    const info = this.layerInfo;
    const token = (info.primaryTokenLayer?.tokens || []).find((t) => t.id === tokenId);
    if (!token) {
      this.setError('Word not found');
      return false;
    }
    const label = `Failed to update ${orthographyName}`;
    if (!this._canWrite(label)) return false;
    // The one key, so the token's other metadata is never written from this copy.
    const ops = [{ op: 'set', path: [`orthog:${orthographyName}`], value }];
    this._applyRawPatch((next, infoNext) => {
      const t = (infoNext.primaryTokenLayer?.tokens || []).find((x) => x.id === tokenId);
      if (t) t.metadata = applyMetadataOps(t.metadata, ops);
    });
    return this._queueWrite(label, () =>
      this._client.tokens.patchMetadata(settledId(tokenId), ops),
    );
  }

  // Split a word token at `splitOffset` (relative to token.begin). Wipes any
  // coincident morpheme (same begin/end) in the same atomic batch — the
  // morpheme's analysis is invalidated by the new boundary and the server-
  // side cascade-split would otherwise produce two nonsense morphemes.
  // Returns true on success / false on guard failure or server error.
  async splitToken(tokenId, splitOffset) {
    const info = this.layerInfo;
    const token = (info.primaryTokenLayer?.tokens || []).find((t) => t.id === tokenId);
    if (!token) {
      this.setError('Word not found');
      return false;
    }
    const label = 'Failed to split token';
    if (!this._canWrite(label)) return false;
    // A split next to whitespace (scissors either side of the space in a word
    // merged over two) goes around the whole run of it, so neither half
    // begins or ends with a space: the right half starts after the run and
    // the left half is trimmed back to its start. Offsets are code points.
    const at = token.begin + splitOffset + 1;
    const cps = Array.from(this.body);
    const ws = (i) => /\s/u.test(cps[i] ?? '');
    let leftEnd = at;
    let rightBegin = at;
    while (leftEnd > token.begin && ws(leftEnd - 1)) leftEnd -= 1;
    while (rightBegin < token.end && ws(rightBegin)) rightBegin += 1;
    if (leftEnd === token.begin || rightBegin === token.end) {
      leftEnd = at;
      rightBegin = at;
    }
    const coincident = (info.morphemeTokenLayer?.tokens || [])
      .filter((m) => m.begin === token.begin && m.end === token.end)
      .map((m) => m.id);
    // What the two halves carry: see domain/tokenReshape.js. The server
    // leaves the left half's metadata alone and gives the right half none,
    // which would render one word as two different kinds of thing and leave
    // a transcription of the whole word on a half of it.
    const leftPatch = survivorPatch(token.metadata, {}, (m) => this.editStamp(m));
    const rightMetadata = newHalfMetadata(token.metadata, (m) => this.editStamp(m));
    const rightId = pendingId();

    this._applyRawPatch((next, infoNext) => {
      const t = (infoNext.primaryTokenLayer?.tokens || []).find((x) => x.id === tokenId);
      if (t) {
        t.end = leftEnd;
        if (leftPatch) t.metadata = mergeMetadata(t.metadata || {}, leftPatch);
      }
      if (infoNext.primaryTokenLayer) {
        if (!Array.isArray(infoNext.primaryTokenLayer.tokens))
          infoNext.primaryTokenLayer.tokens = [];
        infoNext.primaryTokenLayer.tokens.push({
          id: rightId,
          begin: rightBegin,
          end: token.end,
          metadata: rightMetadata ? { ...rightMetadata } : {},
        });
        infoNext.primaryTokenLayer.tokens.sort((a, b) => a.begin - b.begin);
      }
      if (coincident.length > 0 && infoNext.morphemeTokenLayer?.tokens) {
        const removed = new Set(coincident);
        infoNext.morphemeTokenLayer.tokens = infoNext.morphemeTokenLayer.tokens.filter(
          (m) => !removed.has(m.id),
        );
      }
    });

    return this._queueWrite(label, async () => {
      const id = settledId(tokenId);
      const results = await this._client.batched(async (b) => {
        if (coincident.length > 0) b.tokens.bulkDelete(coincident.map(settledId));
        b.tokens.split(id, rightBegin, undefined, { id: rightId });
        if (leftEnd < rightBegin) b.tokens.update(id, undefined, leftEnd);
      });
      // The body of `tokens.split` is `{ id: <new right id> }`.
      const newRightTokenId = createdId(results[coincident.length > 0 ? 1 : 0]);
      if (leftPatch || (newRightTokenId && rightMetadata)) {
        await this._client.batched(async (b) => {
          if (leftPatch) b.tokens.patchMetadata(id, metadataOps(leftPatch));
          if (newRightTokenId && rightMetadata)
            b.tokens.patchMetadata(newRightTokenId, metadataOps(rightMetadata));
        });
      }
      this._settle(new Map([[rightId, newRightTokenId]]));
    });
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
Object.assign(
  IgtDocument.prototype,
  pendingMutations,
  spanMutations,
  tokenMutations,
  sentenceMutations,
  morphemeMutations,
  vocabMutations,
  documentMutations,
  alignmentMutations,
  analysisCopyMutations,
);

// The editor keeps ids on its cells and in its state, and a row it created a
// moment ago is known by a pending id until the server answers (see
// mutations/pending.js). Every public mutation takes its arguments settled,
// so an id held from before the answer names the same row after it.
const MUTATIONS = [
  spanMutations,
  tokenMutations,
  sentenceMutations,
  morphemeMutations,
  vocabMutations,
  documentMutations,
  alignmentMutations,
  analysisCopyMutations,
].flatMap((mixin) => Object.keys(mixin));
for (const name of [...MUTATIONS, 'updateOrthography', 'splitToken']) {
  if (name.startsWith('_')) continue;
  const fn = IgtDocument.prototype[name];
  IgtDocument.prototype[name] = function (...args) {
    return fn.apply(this, args.map(followIds));
  };
}
