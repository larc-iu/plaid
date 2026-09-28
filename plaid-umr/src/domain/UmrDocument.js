// A UMR document: the lifecycle is plaid-ui's DocumentModel, what the layers
// mean is here. Reads through `graph` (sentenceGraph.js), and every edit is
// one audited operation that shows at once, creates included (see the
// mutations section).
//
// By their real paths rather than through `@ui`: the node suite has no alias.
import {
  applyMetadataOps,
  createdId,
  createdIds,
  isReviewed,
  mergeMetadata,
  metadataOps,
  provState,
  PROV_STATES,
  writerPolicy,
} from '@larc-iu/plaid-client';
import { DocumentModel } from '../../../plaid-ui/src/domain/DocumentModel.js';
import { pendingId, settledId } from '../../../plaid-ui/src/domain/pendingIds.js';
import { buildLexicon, vocabLinksByToken } from './vocabLexicon.js';
import { getUmrLayerInfo, UMR_NAMESPACE, readIlgConfig } from '../utils/umrLayerUtils.js';
import { resolveIlg, ilgLinesFor } from './ilg.js';
import {
  buildDocumentGraph,
  toUmrSentences,
  sentencePenman,
  nextVariable,
  CYCLE_ROLES,
  crossSentenceEdges,
  unreachedByRoot,
  groupOf,
  variablesSharedInSentence,
  keepUnchangedSentences,
} from './sentenceGraph.js';
import { DOC_CONSTANTS } from './format/inventory.js';
import {
  describeUmrReconcile,
  planEntryUnlink,
  planRenumber,
  planStrayTokens,
  planUnalignedHeal,
} from './umrReconcile.js';
import {
  serializeUmrFile,
  readAlignment,
  umrFileProblems,
  UnwritableUmrError,
} from './format/umrFile.js';
import {
  conceptProblem,
  relationProblem as relationFormProblem,
  attrValueProblem as valueFormProblem,
  nfc,
  parsePenman,
} from './format/penman.js';
import {
  validateDocument,
  unknownRelationProblem,
  unknownDocRelationProblem,
  valueGrammarProblem,
} from './format/validate.js';

const VARIABLE = /^s[0-9]+\p{Ll}+[0-9]*$/u;
// What the export calls a sentence's document-level block.
const DOC_GRAPH_VARIABLE = /^s[0-9]+s0$/;

const umrOf = (entity) => entity?.metadata?.[UMR_NAMESPACE] || {};

/**
 * The project's vocabularies as the lexicon buildLexicon makes, and whether
 * every one of them was read. A vocabulary that cannot be read is left out
 * of the lexicon, and `complete` says so: an entry missing from an
 * incomplete read may only be unread, so nothing is judged gone on one.
 * Null when the project does not say which vocabularies it has.
 */
export async function readEntryLexicon(client, project) {
  if (!client || !Array.isArray(project?.vocabs)) return null;
  const ids = project.vocabs.map((v) => v.id);
  const got = await Promise.all(
    ids.map((id) =>
      client.vocabLayers.get(id, true).catch((err) => {
        console.warn(`Could not read vocabulary ${id}:`, err);
        return null;
      }),
    ),
  );
  return { lexicon: buildLexicon(got.filter(Boolean)), complete: got.every(Boolean) };
}

/**
 * What changed in the entry a node was picked from, or null: the entry's
 * current concept (its roleset, else its headword) when that is no longer
 * the node's. A node that names no entry, or an entry the lexicon does not
 * hold, has nothing to compare.
 */
export function entryChangeOf(node, lexicon) {
  const id = node?.metadata?.[UMR_NAMESPACE]?.entry;
  const entry = id && lexicon ? lexicon.byId.get(id) : null;
  if (!entry || node.constant || entry.concept === node.concept) return null;
  return { entryId: id, form: entry.form, from: node.concept, to: entry.concept };
}

// The warning an entry change is reported with: "s2v was picked from ver,
// now ver-02." An entry renamed to its own new concept (kitap to kitab) is
// named by the concept the node took from it.
const entryChangeMessage = (v, { form, from, to }) =>
  `${v} was picked from ${form === to ? from : form}, now ${to}.`;

// Every string the model takes is in NFC, as the format requires of the file
// (penman.js `nfc`): a concept, variable, relation or value typed with a
// combining accent is stored as the one character, so it compares equal to
// the same text typed precomposed and exports as the file must hold it. Text
// mode's PENMAN is normalized where it is parsed.
const nfcAttrs = (attrs) =>
  (attrs || []).map((a) => ({ ...a, rel: nfc(a.rel), value: nfc(a.value) }));

// The metadata ops that write each key of `changes` into the `umr`
// namespace, an undefined value deleting its key. The namespace's other keys
// stay as they are.
const umrOps = (changes) =>
  Object.entries(changes).map(([k, v]) =>
    v === undefined
      ? { op: 'delete', path: [UMR_NAMESPACE, k] }
      : { op: 'set', path: [UMR_NAMESPACE, k], value: v },
  );

// Findings the Validation tab reports and a sentence's own badge does not.
// See problemsBySentence.
const QUIET_ON_CANVAS = new Set(['unaligned-token']);

export class UmrDocument extends DocumentModel {
  constructor({
    raw,
    client = null,
    projectId = null,
    project = null,
    user = null,
    asOf = null,
    lexicon = null,
  }) {
    super({ raw, client, projectId, project, user, asOf });
    this._writer = null;
    // The project's vocabularies (readEntryLexicon), once read: what the
    // entry check compares a node picked from an entry with.
    this._lexicon = lexicon;
    this._lexiconRead = null;
    // The graph and the per-sentence problems of the last version read, kept
    // so the next version can hand back what an edit left as it was.
    this._lastGraph = null;
    this._lastProblems = null;
  }

  static async load({ client, documentId, projectId, project = null, user = null }) {
    const raw = await client.documents.get(documentId, true);
    return new UmrDocument({ raw, client, projectId, project, user });
  }

  _snapshot(raw, asOf) {
    return new UmrDocument({
      raw,
      client: this._client,
      projectId: this._projectId,
      project: this._project,
      user: this._user,
      asOf,
      lexicon: this._lexicon,
    });
  }

  // ----- the vocabulary the nodes were picked from -----

  /** The project's vocabularies as a lexicon, or null until read. */
  get lexicon() {
    return this._lexicon;
  }

  /** Take a lexicon read elsewhere: the entry checks are read again. */
  setLexicon(lexicon) {
    if (this._lexicon === lexicon) return;
    this._lexicon = lexicon;
    this._derivedCache.delete('problems');
    this._derivedCache.delete('problemsBySentence');
    this._emit();
  }

  /**
   * Read the project's vocabularies, once per document, and take them as
   * the lexicon. Resolves to readEntryLexicon's answer, or null.
   */
  loadLexicon() {
    if (!this._lexiconRead) {
      this._lexiconRead = readEntryLexicon(this._client, this._project).then((read) => {
        if (read) this.setLexicon(read.lexicon);
        return read;
      });
    }
    return this._lexiconRead;
  }

  /** What changed in the entry the node was picked from (entryChangeOf). */
  entryChange(nodeId) {
    return entryChangeOf(this.node(nodeId), this._lexicon);
  }

  // The nodes `takeEntryValue` changes: the node alone, or every node of
  // the document picked from the same entry and not reading its value.
  _entryTargets(nodeId, everywhere) {
    const change = this.entryChange(nodeId);
    if (!change) return [];
    if (!everywhere) return [this.node(nodeId)];
    return [...this.graph.nodesById.values()].filter(
      (n) =>
        n.sentence != null &&
        umrOf(n).entry === change.entryId &&
        entryChangeOf(n, this._lexicon) !== null,
    );
  }

  /**
   * How many nodes of the document take the entry's new value with
   * `takeEntryValue(nodeId, { everywhere: true })`: 0 when the node's entry
   * has not changed.
   */
  entryChangeCount(nodeId) {
    return this._entryTargets(nodeId, true).length;
  }

  /**
   * The node takes the current concept of the vocabulary entry it was picked
   * from, which changed since (see `entryChange`). With `everywhere`, every
   * node of the document picked from that entry and not reading it does.
   * A person's edit, so it carries the writer's stamp. One operation.
   * Resolves false when there was nothing to take.
   */
  takeEntryValue(nodeId, { everywhere = false } = {}) {
    const change = this.entryChange(nodeId);
    const targets = this._entryTargets(nodeId, everywhere);
    if (!change || !targets.length) return Promise.resolve(false);
    const concept = nfc(change.to);
    if (this._refused(conceptProblem(concept))) return Promise.resolve(false);
    const label = 'Failed to change the concept';
    if (!this._canWrite(label)) return Promise.resolve(false);
    const writes = targets.map((n) => [n.id, this._editStampOps(n.metadata)]);
    this._applyRawPatch((next, infoNext) => {
      const spans = this._layers(infoNext).spans;
      writes.forEach(([id, ops]) => {
        const span = spans.find((x) => x.id === id);
        if (!span) return;
        span.value = concept;
        if (ops.length) span.metadata = applyMetadataOps(span.metadata, ops);
      });
    });
    const who = targets.length === 1 ? targets[0].var : `${targets.length} nodes`;
    return this._queueWrite(
      label,
      () =>
        this._client.batched(async (b) => {
          writes.forEach(([id, ops]) => {
            b.spans.update(settledId(id), concept);
            if (ops.length) b.spans.patchMetadata(settledId(id), ops);
          });
        }),
      `Take ${concept} from the entry ${change.form} for ${who}`,
    );
  }

  // The entry check, over every node: a warning where the entry a node was
  // picked from now reads something else.
  _entryProblems() {
    const lexicon = this._lexicon;
    if (!lexicon) return [];
    const out = [];
    this.graph.nodesById.forEach((node) => {
      if (node.sentence == null) return;
      const change = entryChangeOf(node, lexicon);
      if (!change) return;
      out.push({
        level: 'warning',
        code: 'entry-changed',
        sentence: node.sentence,
        var: node.var,
        message: entryChangeMessage(node.var, change),
      });
    });
    return out;
  }

  // ----- who is writing (provenance) -----
  // The cross-app convention, as plaid-ud's ConlluDocument has it. Whose work
  // is reviewed is the project's call, under the `plaid.review` config
  // (isReviewed). A reviewed person is a CONTRIBUTOR, whose creates and edits
  // are stamped contributed until a verifier confirms them; everyone else,
  // and a document with no user, is a VERIFIER, whose edits and confirmations
  // settle machine or contributed material. Every mutation below reads the
  // policy: a create carries `createStamp`, an edit merges `editStamp`.
  //
  // It matters most in this app, where the Draft button writes whole
  // sentences a person then corrects node by node: without the stamp a
  // corrected graph still reads as machine output to the query language and
  // to the review sweep, and the canvas goes on tinting it.

  /** The contributor's user id, or null when the writer is a verifier. */
  get contributorId() {
    const user = this._user;
    if (!user?.id || !this._project) return null;
    return isReviewed(this._project, user.id, { isAdmin: !!user.isAdmin }) ? user.id : null;
  }

  /** The writer's policy (plaid-client's writerPolicy) for the current user. */
  get writer() {
    const id = this.contributorId;
    if (!this._writer || this._writer.contributorId !== id) this._writer = writerPolicy(id);
    return this._writer;
  }

  // The metadata ops that carry the writer's edit stamp onto a node, edge or
  // relation holding `metadata`, empty when the edit leaves who made it as it
  // was. An edit sends them beside its own changes and applies the same ops
  // to the row it shows, so the two cannot disagree.
  _editStampOps(metadata) {
    return metadataOps(this.writer.editStamp(metadata));
  }

  get layerInfo() {
    return this._derived('layerInfo', () => getUmrLayerInfo(this._raw));
  }

  // The vocabulary entries the document's words and morphemes are linked
  // to, by token id. The concept picker offers them first.
  get vocabLinks() {
    return this._derived('vocabLinks', () => vocabLinksByToken(this.layerInfo));
  }

  get body() {
    return this.layerInfo.textLayer?.text?.body ?? '';
  }

  // The whole document as graphs: sentences with words, nodes, edges and
  // triples, plus the constants. Cached per data version. A sentence an edit
  // left as it was keeps its object from the version before, so the canvas's
  // memoized blocks can skip it (keepUnchangedSentences).
  get graph() {
    return this._derived('graph', () => {
      const info = this.layerInfo;
      const mapping = resolveIlg(readIlgConfig(this._project), info);
      const built = buildDocumentGraph(info, { ilg: (s) => ilgLinesFor(s, info, mapping) });
      const graph = keepUnchangedSentences(this._lastGraph, built);
      this._lastGraph = graph;
      return graph;
    });
  }

  get sentences() {
    return this.graph.sentences;
  }

  // The document in the .umr file format. Throws UnwritableUmrError when
  // `exportProblems` lists anything.
  toUmr() {
    return this._derived('umr', () => {
      const problems = this.exportProblems;
      if (problems.length) throw new UnwritableUmrError(problems);
      return serializeUmrFile({ sentences: toUmrSentences(this.graph) });
    });
  }

  // Each stored value the .umr file cannot hold as it is, by sentence and
  // variable: a concept with a space, a relation or value with a bracket or a
  // line break. Only the API and older writers store such a value, since every
  // editor path refuses it. The export refuses the document while any is left.
  //
  // And a variable two nodes of one sentence share, which the file would
  // write as one re-entrant node. (Two sentences sharing one read back as
  // they were, and a released corpus has them.)
  get exportProblems() {
    return this._derived('exportProblems', () => [
      ...umrFileProblems(toUmrSentences(this.graph)),
      ...variablesSharedInSentence(this.graph).map(({ sentence, var: v, message }) => ({
        sentence,
        var: v,
        message,
      })),
    ]);
  }

  // What the official checks find, over the same sentences the export writes,
  // and the edges the export has to leave out.
  get problems() {
    return this._derived('problems', () => [
      ...validateDocument(toUmrSentences(this.graph)),
      ...crossSentenceEdges(this.graph),
      ...unreachedByRoot(this.graph),
      ...variablesSharedInSentence(this.graph),
      ...this._entryProblems(),
    ]);
  }

  // The same, by sentence index, MINUS the checks that are for the Validation
  // tab rather than for the canvas.
  //
  // `unaligned-token` warns about every word with no node on it, which in a
  // normally annotated sentence is every determiner, auxiliary, preposition
  // and case marker: on the walkthrough project it was eight warnings across
  // four sentences, and every warning there was this one. Beside a sentence
  // that reads as noise and buries the count of things to act on. It is a
  // real umrtools/validate.py test, so `problems` keeps it and the Validation
  // tab still answers "what would the official validator say".
  //
  // A sentence's list is the one of the version before when it reads the
  // same, as its sentence object is (see `graph`).
  get problemsBySentence() {
    return this._derived('problemsBySentence', () => {
      const map = new Map();
      this.problems.forEach((p) => {
        if (QUIET_ON_CANVAS.has(p.code)) return;
        if (!map.has(p.sentence)) map.set(p.sentence, []);
        map.get(p.sentence).push(p);
      });
      const last = this._lastProblems;
      if (last) {
        map.forEach((list, sentence) => {
          const old = last.get(sentence);
          if (old && JSON.stringify(old) === JSON.stringify(list)) map.set(sentence, old);
        });
      }
      this._lastProblems = map;
      return map;
    });
  }

  _patchContext(next) {
    return [getUmrLayerInfo(next)];
  }

  // ----- reconcile on open -----

  // What another app's edit, or an edit cut off, left in the document
  // (umrReconcile.js), put right in ONE batch, so the audit entry names one
  // repair. History keeps what was removed.
  //
  // - A node aligned to no word: a node whose sentence token is gone is bound
  //   to the sentence it stands in, an anchor that no longer covers its
  //   sentence is put back over it, and a node left outside every sentence
  //   goes.
  // - A node whose words were deleted (in IGT) becomes an ordinary unaligned
  //   node, named in the entry.
  // - An anchor token no node stands on, what an add cut off after its first
  //   request left, is removed.
  // - A variable whose sentence number no longer matches its sentence (IGT
  //   added or removed a sentence before it) is renumbered.
  // - A node picked from a vocabulary entry that was deleted forgets it.
  //
  // NOT stamped, deliberately: a repair that runs on open decides nothing
  // and vouches for nothing, so it leaves provenance exactly as it found it
  // (the same rule igt's morpheme heal follows).
  async _reconcile() {
    const graph = this.graph;
    const { remove, rebind, resize, unanchor } = planUnalignedHeal(graph, UMR_NAMESPACE);
    const strays = planStrayTokens(this.layerInfo);
    const removed = new Set(remove);
    const renumber = planRenumber(graph, removed);
    // Only on a complete read of the vocabularies: an entry missing from a
    // read that skipped one may only be unread.
    const read = await this.loadLexicon().catch(() => null);
    const unlink = read?.complete
      ? planEntryUnlink(graph, UMR_NAMESPACE, read.lexicon).filter((id) => !removed.has(id))
      : [];
    const nothing =
      !remove.length &&
      !rebind.length &&
      !resize.length &&
      !unanchor.length &&
      !strays.length &&
      !renumber.length &&
      !unlink.length;
    if (nothing) return { findings: [] };
    try {
      const tokenIds = [
        ...strays,
        ...remove.flatMap((id) => this.node(id).pieces.map((p) => p.id)),
      ];
      // Every metadata change of one node in one patch.
      const metaOf = new Map();
      const change = (id, changes) => metaOf.set(id, { ...metaOf.get(id), ...changes });
      rebind.forEach(({ nodeId, sentenceTokenId }) =>
        change(nodeId, { sentence: sentenceTokenId }),
      );
      unanchor.forEach(({ nodeId, sentenceTokenId }) =>
        change(nodeId, { sentence: sentenceTokenId }),
      );
      renumber.forEach(({ nodeId, to }) => change(nodeId, { var: to }));
      unlink.forEach((nodeId) => change(nodeId, { entry: undefined }));
      await this._client.batched(async (b) => {
        if (tokenIds.length) b.tokens.bulkDelete(tokenIds);
        metaOf.forEach((changes, nodeId) => b.spans.patchMetadata(nodeId, umrOps(changes)));
        resize.forEach(({ nodeId, pieceId, begin, end, extra }) => {
          b.tokens.update(pieceId, begin, end);
          if (extra) {
            b.spans.setTokens(nodeId, [pieceId]);
            b.tokens.bulkDelete(extra);
          }
        });
      });
      await this._reload();
      const unanchored = new Set(unanchor.map((u) => u.nodeId));
      return {
        findings: [],
        removed: remove.length,
        rebound: rebind.length,
        resized: resize.filter((r) => !unanchored.has(r.nodeId)).length,
        strays: strays.length,
        unanchored: unanchor.map((u) => u.var),
        renumbered: renumber.length,
        unlinked: unlink.length,
      };
    } catch (error) {
      return { findings: [], error };
    }
  }

  describeReconcile(result) {
    return describeUmrReconcile(result);
  }

  // ----- reading helpers -----

  // Ids the canvas hands in may be pending ones the server has since
  // answered for (see the mutations below), so lookups settle them first.
  node(id) {
    return this.graph.nodesById.get(settledId(id)) || null;
  }

  sentence(index) {
    return this.graph.sentences[index - 1] || null;
  }

  edge(id) {
    const settled = settledId(id);
    for (const s of this.graph.sentences) {
      const e = s.edges.find((x) => x.id === settled);
      if (e) return e;
    }
    return null;
  }

  // Every variable in use, so a new one is unique per document.
  takenVariables() {
    const taken = new Set();
    this.graph.nodesById.forEach((n) => {
      if (n.var) taken.add(n.var);
    });
    return taken;
  }

  // The anchor pieces for a set of words of one sentence: one piece per run
  // of adjacent words, and the whole sentence for no words. A node aligned to
  // nothing still has to stand somewhere, and standing over its sentence is
  // what keeps it alive: an edit anywhere in the text resizes the anchor
  // instead of destroying it, and the node goes only when its sentence's text
  // does, which is when it should. It stood on a POINT at the sentence's
  // start before, and core deletes a zero-width token a deletion spans, so
  // joining two sentences by deleting across the boundary took the node with
  // it. What says the node is aligned to nothing is its sentence record, not
  // the anchor (sentenceGraph.js).
  piecesFor(sentence, wordIds) {
    const chosen = sentence.words
      .filter((w) => wordIds.includes(w.id))
      .sort((a, b) => a.index - b.index);
    if (!chosen.length) return [{ begin: sentence.begin, end: sentence.end }];
    const pieces = [];
    chosen.forEach((w) => {
      const last = pieces[pieces.length - 1];
      if (last && last.lastIndex === w.index - 1) {
        last.end = w.end;
        last.lastIndex = w.index;
      } else {
        pieces.push({ begin: w.begin, end: w.end, lastIndex: w.index });
      }
    });
    return pieces.map(({ begin, end }) => ({ begin, end }));
  }

  // Nodes that only the edge keeps reachable from the sentence's roots: what
  // deleting it as a subtree takes with it. Empty when the target has another
  // way in.
  exclusiveDescendants(edgeId) {
    const edge = this.edge(edgeId);
    if (!edge) return [];
    const target = this.node(edge.target);
    const sentence = this.sentence(target.sentence);
    if (!sentence) return [];
    const inSentence = (id) => this.node(id)?.sentence === sentence.index;
    const reachFrom = (starts, skipEdgeId) => {
      const seen = new Set();
      const stack = [...starts];
      while (stack.length) {
        const n = stack.pop();
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        n.out.forEach((e) => {
          if (e.id !== skipEdgeId && inSentence(e.target)) stack.push(this.node(e.target));
        });
      }
      return seen;
    };
    // Every root stays, the edge's own target included: the edge into a root
    // (the :quote back into a reported-speech root, an edge a sentence split
    // left crossing) takes no node with it.
    const stillReachable = reachFrom(sentence.roots, edgeId);
    const below = reachFrom([target], edgeId);
    return [...below].filter((id) => !stillReachable.has(id)).map((id) => this.node(id));
  }

  // Nodes only `nodeId` keeps reachable from the sentence's roots: what its
  // deletion takes with it, the node itself aside. Computed with the node
  // gone, so a grandchild reachable through two of its children counts.
  orphanedBy(nodeId) {
    const node = this.node(nodeId);
    const sentence = node ? this.sentence(node.sentence) : null;
    if (!sentence) return [];
    const inSentence = (id) => this.node(id)?.sentence === sentence.index;
    const reach = (starts) => {
      const seen = new Set();
      const stack = [...starts];
      while (stack.length) {
        const n = stack.pop();
        if (!n || n.id === nodeId || seen.has(n.id)) continue;
        seen.add(n.id);
        n.out.forEach((e) => {
          if (inSentence(e.target)) stack.push(this.node(e.target));
        });
      }
      return seen;
    };
    const still = reach(sentence.roots.filter((r) => r.id !== nodeId));
    const below = reach(node.out.map((e) => this.node(e.target)));
    return [...below].filter((id) => !still.has(id)).map((id) => this.node(id));
  }

  // Would an edge from `sourceId` to `targetId` close a cycle the format does
  // not allow (one through anything but a quote)? True when the target
  // reaches the source.
  wouldCycle(sourceId, targetId, role) {
    if (sourceId === targetId) return true;
    if (CYCLE_ROLES.has(role)) return false;
    const seen = new Set();
    const stack = [this.node(targetId)];
    while (stack.length) {
      const n = stack.pop();
      if (!n || seen.has(n.id)) continue;
      seen.add(n.id);
      if (n.id === sourceId) return true;
      n.out.forEach((e) => {
        if (!CYCLE_ROLES.has(e.role)) stack.push(this.node(e.target));
      });
    }
    return false;
  }

  // The next free position among a node's children: attributes and edges
  // share one order, the file's child order.
  nextOrder(node) {
    const orders = [...node.out.map((e) => e.order), ...node.attrs.map((a) => a.order ?? 0)];
    return Math.max(-1, ...orders) + 1;
  }

  // ----- raw patch helpers -----

  _layers(info) {
    return {
      tokens: (info.nodeTokenLayer.tokens ||= []),
      spans: (info.conceptLayer.spans ||= []),
      relations: (info.relationLayer.relations ||= []),
      triples: (info.documentGraphLayer.relations ||= []),
    };
  }

  // Remove spans and everything that hangs off them, the way the server's
  // cascade does when their tokens go.
  _dropSpans(info, spanIds) {
    const gone = new Set(spanIds);
    const L = this._layers(info);
    const tokenIds = new Set(L.spans.filter((s) => gone.has(s.id)).flatMap((s) => s.tokens || []));
    info.nodeTokenLayer.tokens = L.tokens.filter((t) => !tokenIds.has(t.id));
    info.conceptLayer.spans = L.spans.filter((s) => !gone.has(s.id));
    info.relationLayer.relations = L.relations.filter(
      (r) => !gone.has(r.source) && !gone.has(r.target),
    );
    info.documentGraphLayer.relations = L.triples.filter(
      (r) => !gone.has(r.source) && !gone.has(r.target),
    );
  }

  // ----- mutations -----
  //
  // Every edit shows at once and is sent in its turn (DocumentModel's
  // `_queueWrite`): validate, `_canWrite`, patch, queue the send. What an
  // edit creates goes in under a pending id, and `_settle` puts the server's
  // ids in its place once it answers. A send names every id through
  // `settledId`, since an edit made while an earlier one was still queued can
  // hold that one's pending ids. Ids handed in by the canvas are settled on
  // the way in for the same reason.

  // New anchor tokens for `pieces`, under pending ids.
  _pendingPieces(pieces) {
    return pieces.map((p) => ({ id: pendingId(), begin: p.begin, end: p.end }));
  }

  // Create `tokens` (from `_pendingPieces`) on the server, recording each
  // one's id in `ids`.
  async _createPieces(tokens, ids) {
    if (!tokens.length) return;
    const info = this.layerInfo;
    const created = await this._client.tokens.bulkCreate(
      tokens.map((t) => ({
        tokenLayerId: info.nodeTokenLayer.id,
        text: info.textLayer.text.id,
        begin: t.begin,
        end: t.end,
      })),
    );
    tokens.forEach((t, i) => ids.set(t.id, createdIds(created)[i]));
  }

  // A send that makes anchor pieces and then needs more requests to stand a
  // node on them (core cannot name an id made earlier in its own batch). When
  // a later step fails, the pieces it made are deleted again, and a node
  // already on them with them (the server's cascade), inside the same
  // operation, so no token nobody can see is left and History holds no add
  // that half happened. Best effort: a connection that is gone takes this
  // request too, and reconcile on the next open removes what is left
  // (planStrayTokens). `ids` is where `_createPieces` records the pieces.
  async _undoPiecesOnFailure(tokens, ids, work) {
    try {
      return await work();
    } catch (error) {
      const made = tokens.map((t) => ids.get(t.id)).filter(Boolean);
      if (made.length) {
        await this._client.tokens.bulkDelete(made).catch((err) => {
          console.warn('Could not remove the anchors of an edit that failed:', err);
        });
      }
      throw error;
    }
  }

  /**
   * A new node in a sentence: anchored to `wordIds` (none for an abstract
   * concept), under `parentId` with `role` when given. `entry` is the
   * vocabulary entry the concept was picked from, kept on the node so the
   * role picker offers that entry's arguments. `onShown` is called
   * with the node's (pending) ids the moment it is on the canvas, so focus
   * can go to it before the server answers. Resolves to `{ nodeId, edgeId }`
   * with the server's ids once it has, or false on failure.
   */
  async createNode({
    sentenceIndex,
    concept,
    wordIds = [],
    parentId = null,
    role = null,
    attrs = [],
    entry = null,
    onShown = null,
  }) {
    concept = nfc(concept);
    role = nfc(role);
    attrs = nfcAttrs(attrs);
    const sentence = this.sentence(sentenceIndex);
    if (!sentence || !concept) return false;
    if (parentId && !role) return false;
    const refused = this._refused(
      conceptProblem(concept),
      parentId ? this.relationProblem(role) : null,
      ...attrs.map((a) => this.relationProblem(a.rel) || this.attrValueProblem(a.rel, a.value)),
    );
    if (refused) return false;
    const parent = parentId ? this.node(parentId) : null;
    const label = 'Failed to add the node';
    if (!this._canWrite(label)) return false;
    const pieces = this._pendingPieces(this.piecesFor(sentence, wordIds));
    const variable = nextVariable(sentenceIndex, concept, this.takenVariables());
    const order = parent ? this.nextOrder(parent) : 0;
    // The first node of a sentence is its root. A later parentless node is a
    // fragment until it is connected, and the graph keeps its root.
    const meta = { var: variable, attrs };
    if (entry) meta.entry = entry;
    if (!parent && sentence.nodes.length === 0) meta.root = true;
    // A node aligned to no word records its sentence, which is what says so
    // (see _reconcile): its anchor covers the whole sentence.
    if (!wordIds.length) meta.sentence = sentence.tokenId;
    // The node and its edge are this writer's work: their create stamp, flat
    // beside the app's own `umr` namespace (null for a verifier).
    const stamp = this.writer.createStamp;
    const spanId = pendingId();
    const edgeId = parent ? pendingId() : null;
    this._applyRawPatch((next, infoNext) => {
      const L = this._layers(infoNext);
      pieces.forEach((p) => L.tokens.push({ ...p }));
      L.spans.push({
        id: spanId,
        tokens: pieces.map((p) => p.id),
        value: concept,
        metadata: { ...stamp, [UMR_NAMESPACE]: meta },
      });
      if (edgeId) {
        L.relations.push({
          id: edgeId,
          source: parent.id,
          target: spanId,
          value: role,
          metadata: { ...stamp, [UMR_NAMESPACE]: { order } },
        });
      }
    });
    onShown?.({ nodeId: spanId, edgeId });
    const ids = new Map();
    const ok = await this._queueWrite(
      label,
      async () => {
        const info = this.layerInfo;
        await this._undoPiecesOnFailure(pieces, ids, async () => {
          await this._createPieces(pieces, ids);
          const span = await this._client.spans.create(
            info.conceptLayer.id,
            pieces.map((p) => ids.get(p.id)),
            concept,
            { ...stamp, [UMR_NAMESPACE]: meta },
          );
          ids.set(spanId, createdId(span));
          if (parent) {
            const rel = await this._client.relations.create(
              info.relationLayer.id,
              settledId(parent.id),
              ids.get(spanId),
              role,
              { ...stamp, [UMR_NAMESPACE]: { order } },
            );
            ids.set(edgeId, createdId(rel));
          }
        });
        this._settle(ids);
      },
      parent ? `Add ${role} ${concept} under ${parent.concept}` : `Add ${concept}`,
    );
    return ok ? { nodeId: settledId(spanId), edgeId: edgeId ? settledId(edgeId) : null } : false;
  }

  /**
   * The node's concept. `entry` is the vocabulary entry it was picked from,
   * or null for a concept typed or picked from anywhere else, which takes
   * back the entry the node had: two senses of one headword offer the same
   * concept with different arguments, so picking the other one is a change.
   */
  async setConcept(nodeId, concept, { entry = null } = {}) {
    concept = nfc(concept);
    const node = this.node(nodeId);
    if (!node || !concept) return false;
    const had = node.metadata?.[UMR_NAMESPACE]?.entry ?? null;
    const entryChanges = had !== entry && (node.concept !== concept || entry !== null);
    if (node.concept === concept && !entryChanges) return false;
    const refused = conceptProblem(concept);
    if (refused) {
      this.setError(refused);
      return false;
    }
    const label = 'Failed to change the concept';
    if (!this._canWrite(label)) return false;
    // A person's edit carries the writer's stamp (write-contract rule 3): a
    // verifier's confirms a drafted node, a contributor's marks it
    // contributed. Value and stamp land in ONE optimistic patch and ONE
    // batch, as ud's cell edit does, so the tint clears with the value and
    // the document's version bumps once.
    const ops = [
      ...(entryChanges ? umrOps({ entry: entry ?? undefined }) : []),
      ...this._editStampOps(node.metadata),
    ];
    this._applyRawPatch((next, infoNext) => {
      const span = this._layers(infoNext).spans.find((s) => s.id === node.id);
      if (!span) return;
      span.value = concept;
      if (ops.length) span.metadata = applyMetadataOps(span.metadata, ops);
    });
    return this._queueWrite(
      label,
      async () => {
        const id = settledId(node.id);
        if (ops.length) {
          await this._client.batched(async (b) => {
            if (node.concept !== concept) b.spans.update(id, concept);
            b.spans.patchMetadata(id, ops);
          });
        } else {
          await this._client.spans.update(id, concept);
        }
      },
      node.concept === concept
        ? `Change the entry of ${node.var} ${concept}`
        : `Change ${node.var} from ${node.concept} to ${concept}`,
    );
  }

  // `from s1e to s1l2`, for an audit label: the relation's two ends, since a
  // role alone names one of many.
  _ends({ source, target }) {
    return `from ${this.node(source)?.var || source} to ${this.node(target)?.var || target}`;
  }

  /**
   * Why `rel` cannot be written at `at`, or null when it can: a relation the
   * file cannot hold, or one UMR does not have. `at` names the place:
   * `{ nodeId }` among that node's attributes, `{ edgeId }` as that edge's
   * role, `{ tripleId }` as that document-level relation, `{ group }` as a
   * new one of that group, and nothing for a new edge or a new node's
   * attribute. A relation already stored at that very place is kept (an
   * imported file may carry one UMR does not have), never one stored on
   * another node or edge: only a relation the write brings there is refused.
   * Every write method asks this, and so do the screens and text mode.
   */
  relationProblem(rel, { nodeId = null, edgeId = null, tripleId = null, group = null } = {}) {
    rel = nfc(rel);
    const why = relationFormProblem(rel);
    if (why) return why;
    const text = String(rel).trim();
    const r = text.startsWith(':') ? text : `:${text}`;
    const triple = tripleId ? this.triple(tripleId) : null;
    const stored = edgeId
      ? [this.edge(edgeId)?.role]
      : tripleId
        ? [triple?.rel]
        : nodeId
          ? (this.node(nodeId)?.attrs ?? []).map((a) => a.rel)
          : [];
    if (stored.includes(r)) return null;
    const g = triple ? triple.group || groupOf(triple.rel) : group;
    return g ? unknownDocRelationProblem(g, r) : unknownRelationProblem(r);
  }

  /**
   * Why `value` cannot be written as the value of `rel`, or null when it can.
   * With `{ nodeId }`, a value already stored under that very relation on
   * that node is kept, as `relationProblem` keeps a relation: an imported
   * file may carry a value no editor would take, and an edit of the node's
   * other attributes sends it back unchanged.
   */
  attrValueProblem(rel, value, { nodeId = null } = {}) {
    rel = nfc(rel);
    value = nfc(value);
    const text = String(rel ?? '').trim();
    const r = text.startsWith(':') ? text : `:${text}`;
    // What the file cannot hold, then what validate.py cannot read (the
    // owner's ruling: new input is refused with the reason, and a value an
    // import brought is only reported, by the Validation tab).
    const why = valueFormProblem(value) || valueGrammarProblem(value, r)?.message || null;
    if (!why || !nodeId) return why;
    const stored = (this.node(nodeId)?.attrs ?? []).some((a) => a.rel === r && a.value === value);
    return stored ? null : why;
  }

  // The first of `problems` that is not null, shown, and whether there was
  // one: a write method refuses with it.
  _refused(...problems) {
    const why = problems.find(Boolean);
    if (why) this.setError(why);
    return !!why;
  }

  /** Why `variable` cannot name the node, or null when it can. */
  variableProblem(nodeId, variable) {
    variable = nfc(variable);
    const node = this.node(nodeId);
    if (!node || node.var === variable) return null;
    return this._newVariableProblem(variable, node.sentence);
  }

  // Why `variable` cannot name a new node of sentence `sentenceIndex`, or null
  // when it can: the canvas's rename and text mode's new nodes ask the same.
  _newVariableProblem(variable, sentenceIndex) {
    if (!VARIABLE.test(variable)) {
      return `${variable} is not a variable: s, the sentence number, letters, a number.`;
    }
    const n = Number(variable.match(/^s([0-9]+)/)[1]);
    if (sentenceIndex != null && n !== sentenceIndex) {
      return `${variable} names sentence ${n}, and the node is in sentence ${sentenceIndex}.`;
    }
    // The file names each sentence's document-level block `s<n>s0`
    // (toUmrSentences), so a node called that is a second definition of it.
    if (DOC_GRAPH_VARIABLE.test(variable))
      return `${variable} names the sentence's document graph.`;
    if (this.takenVariables().has(variable)) return `${variable} is already in use.`;
    return null;
  }

  async setVariable(nodeId, variable) {
    variable = nfc(variable);
    const node = this.node(nodeId);
    if (!node || node.var === variable) return false;
    const problem = this.variableProblem(nodeId, variable);
    if (problem) {
      this.setError(problem);
      return false;
    }
    return this._patchNodeMeta(nodeId, { var: variable }, `Rename ${node.var} to ${variable}`);
  }

  // The node's attributes, whole: `[{ rel, value }]` in the order to write.
  async setAttrs(nodeId, attrs) {
    attrs = nfcAttrs(attrs);
    const node = this.node(nodeId);
    if (!node) return false;
    const refused = this._refused(
      ...attrs.map(
        (a) =>
          this.relationProblem(a.rel, { nodeId }) ||
          this.attrValueProblem(a.rel, a.value, { nodeId }),
      ),
    );
    if (refused) return false;
    // An attribute keeps its place among the node's children when one with
    // its relation was there before; a new one goes after everything.
    const free = node.attrs.map((a) => ({ rel: a.rel, order: a.order ?? 0 }));
    let tail = this.nextOrder(node);
    const next = attrs.map((a) => {
      const i = free.findIndex((f) => f.rel === a.rel);
      const order = i >= 0 ? free.splice(i, 1)[0].order : tail++;
      return { rel: a.rel, value: a.value, order };
    });
    return this._patchNodeMeta(nodeId, { attrs: next }, `Set attributes of ${node.var}`);
  }

  // Every edit of a node's `umr` namespace: a rename, its attributes, its
  // root mark. The writer's edit stamp rides in the same patch, flat beside
  // the namespace, so one request both changes the node and settles it.
  async _patchNodeMeta(nodeId, changes, label) {
    const node = this.node(nodeId);
    if (!node) return false;
    const failed = 'Failed to save the node';
    if (!this._canWrite(failed)) return false;
    const ops = [...umrOps(changes), ...this._editStampOps(node.metadata)];
    this._applyRawPatch((next, infoNext) => {
      const span = this._layers(infoNext).spans.find((s) => s.id === node.id);
      if (span) span.metadata = applyMetadataOps(span.metadata, ops);
    });
    return this._queueWrite(
      failed,
      () => this._client.spans.patchMetadata(settledId(node.id), ops),
      label,
    );
  }

  // Re-anchor a node to a set of its sentence's words (none for unaligned).
  // New pieces first, then the span takes them and the old ones go: an op
  // cannot use an id made in its own batch.
  async setAnchor(nodeId, wordIds) {
    const info = this.layerInfo;
    const node = this.node(nodeId);
    const sentence = node ? this.sentence(node.sentence) : null;
    if (!sentence) return false;
    const same =
      wordIds.length === (node.wordIds || []).length &&
      wordIds.every((id) => node.wordIds.includes(id));
    if (same) return false;
    const label = 'Failed to change the anchor';
    if (!this._canWrite(label)) return false;
    const pieces = this._pendingPieces(this.piecesFor(sentence, wordIds));
    const oldIds = node.pieces.map((p) => p.id);
    const words = sentence.words.filter((w) => wordIds.includes(w.id)).map((w) => w.text);
    // The sentence an unaligned node records (see _reconcile), set when it
    // loses its words and dropped when it gains some.
    const span = this._layers(info).spans.find((s) => s.id === node.id);
    const home = umrOf(span).sentence;
    const recorded = wordIds.length ? undefined : sentence.tokenId;
    // Anchoring a drafted node is a person's decision about it, so it
    // carries the writer's edit stamp like any other edit. The sentence is
    // written only when it changes: dropped when words come, set when they go.
    const metaOps = [
      ...(home !== recorded ? umrOps({ sentence: recorded }) : []),
      ...this._editStampOps(node.metadata),
    ];
    const patchMeta = metaOps.length > 0;
    this._applyRawPatch((next, infoNext) => {
      const L = this._layers(infoNext);
      const old = new Set(oldIds);
      infoNext.nodeTokenLayer.tokens = L.tokens.filter((t) => !old.has(t.id));
      pieces.forEach((p) => infoNext.nodeTokenLayer.tokens.push({ ...p }));
      const s = L.spans.find((x) => x.id === node.id);
      if (s) {
        s.tokens = pieces.map((p) => p.id);
        if (patchMeta) s.metadata = applyMetadataOps(s.metadata, metaOps);
      }
    });
    // New pieces first, then the span takes them and the old ones go: an op
    // cannot use an id made in its own batch.
    return this._queueWrite(
      label,
      async () => {
        const ids = new Map();
        const id = settledId(node.id);
        await this._undoPiecesOnFailure(pieces, ids, async () => {
          await this._createPieces(pieces, ids);
          await this._client.batched(async (b) => {
            b.spans.setTokens(
              id,
              pieces.map((p) => ids.get(p.id)),
            );
            if (patchMeta) b.spans.patchMetadata(id, metaOps);
            b.tokens.bulkDelete(oldIds.map(settledId));
          });
        });
        this._settle(ids);
      },
      words.length ? `Anchor ${node.var} to ${words.join(' ')}` : `Unanchor ${node.var}`,
    );
  }

  // An edge from one node to another of the same sentence. A second edge into
  // a node is a re-entrancy. Resolves to the edge id, or false.
  async createEdge(sourceId, targetId, role) {
    role = nfc(role);
    const source = this.node(sourceId);
    const target = this.node(targetId);
    if (!source || !target || !role) return false;
    if (this._refused(this.relationProblem(role))) return false;
    if (source.sentence !== target.sentence) {
      this.setError('An edge joins two nodes of one sentence.');
      return false;
    }
    if (this.wouldCycle(source.id, target.id, role)) {
      this.setError(`${role} from ${source.var} to ${target.var} would close a cycle.`);
      return false;
    }
    const label = 'Failed to add the edge';
    if (!this._canWrite(label)) return false;
    const order = this.nextOrder(source);
    const stamp = this.writer.createStamp;
    const edgeId = pendingId();
    this._applyRawPatch((next, infoNext) => {
      this._layers(infoNext).relations.push({
        id: edgeId,
        source: source.id,
        target: target.id,
        value: role,
        metadata: { ...stamp, [UMR_NAMESPACE]: { order } },
      });
    });
    const ok = await this._queueWrite(
      label,
      async () => {
        const rel = await this._client.relations.create(
          this.layerInfo.relationLayer.id,
          settledId(source.id),
          settledId(target.id),
          role,
          { ...stamp, [UMR_NAMESPACE]: { order } },
        );
        this._settle(new Map([[edgeId, createdId(rel)]]));
      },
      `Add ${role} from ${source.var} to ${target.var}`,
    );
    return ok ? settledId(edgeId) : false;
  }

  async setRole(edgeId, role) {
    role = nfc(role);
    const edge = this.edge(edgeId);
    if (!edge || !role || edge.role === role) return false;
    if (this._refused(this.relationProblem(role, { edgeId }))) return false;
    const label = 'Failed to change the relation';
    if (!this._canWrite(label)) return false;
    // Relabelling a drafted edge settles it, as re-typing a cell does in ud.
    const stampOps = this._editStampOps(edge.metadata);
    this._applyRawPatch((next, infoNext) => {
      const rel = this._layers(infoNext).relations.find((r) => r.id === edge.id);
      if (!rel) return;
      rel.value = role;
      if (stampOps.length) rel.metadata = applyMetadataOps(rel.metadata, stampOps);
    });
    return this._queueWrite(
      label,
      async () => {
        const id = settledId(edge.id);
        if (stampOps.length) {
          await this._client.batched(async (b) => {
            b.relations.update(id, role);
            b.relations.patchMetadata(id, stampOps);
          });
        } else {
          await this._client.relations.update(id, role);
        }
      },
      `Relabel ${edge.role} ${this._ends(edge)} as ${role}`,
    );
  }

  // Move an edge one place earlier (dir -1) or later (+1) among its head's
  // edges, in the written order: the two swap their orders, and an
  // attribute between them stays between them. The canvas draws children by
  // anchor, so this shows on the export, in text mode, and where siblings
  // have no anchor to draw by. False at either end.
  async shiftEdge(edgeId, dir) {
    const edge = this.edge(edgeId);
    const source = edge ? this.node(edge.source) : null;
    if (!source) return false;
    const siblings = [...source.out].sort((a, b) => a.order - b.order);
    const at = siblings.findIndex((e) => e.id === edge.id);
    const other = siblings[at + dir];
    if (at < 0 || !other) return false;
    const label = 'Failed to reorder the edge';
    if (!this._canWrite(label)) return false;
    // Two edges written with one order would not swap: give the pair
    // distinct places, keeping their neighbours where they are.
    const [lo, hi] =
      edge.order === other.order
        ? [edge.order, edge.order + 1]
        : [Math.min(edge.order, other.order), Math.max(edge.order, other.order)];
    const swapped = new Map(
      dir < 0
        ? [
            [edge.id, lo],
            [other.id, hi],
          ]
        : [
            [edge.id, hi],
            [other.id, lo],
          ],
    );
    const target = this.node(edge.target);
    const patches = [];
    this._applyRawPatch((next, infoNext) => {
      this._layers(infoNext).relations.forEach((rel) => {
        if (!swapped.has(rel.id)) return;
        // BOTH edges: the pair's written order is now this person's, not
        // the draft's, since the swap moved each of them.
        const ops = [
          ...umrOps({ order: swapped.get(rel.id) }),
          ...this._editStampOps(rel.metadata),
        ];
        rel.metadata = applyMetadataOps(rel.metadata, ops);
        patches.push([rel.id, ops]);
      });
    });
    return this._queueWrite(
      label,
      () =>
        this._client.batched(async (b) => {
          patches.forEach(([id, patch]) => b.relations.patchMetadata(settledId(id), patch));
        }),
      `Move ${edge.role} ${target?.var || ''} ${dir < 0 ? 'earlier' : 'later'} under ${source.var}`,
    );
  }

  // Delete an edge. With `subtree`, the nodes only it kept reachable go too
  // (their anchors are deleted and the server's cascade takes the rest).
  // Resolves to the number of nodes deleted, or false.
  //
  // Nothing to stamp: a deletion leaves no entity to carry provenance, and
  // history records who removed what. The same for deleteNode and
  // deleteTriple.
  async deleteEdge(edgeId, { subtree = true } = {}) {
    const edge = this.edge(edgeId);
    if (!edge) return false;
    const label = 'Failed to delete the edge';
    if (!this._canWrite(label)) return false;
    const doomed = subtree ? this.exclusiveDescendants(edge.id) : [];
    const tokenIds = doomed.flatMap((n) => n.pieces.map((p) => p.id));
    const spanIds = doomed.map((n) => n.id);
    // Named BEFORE the patch, which takes the doomed nodes and with them the
    // target's variable: the label printed its id. What goes with the target
    // is counted as deleteNode counts it, the target aside.
    const below = doomed.filter((n) => n.id !== edge.target).length;
    const operation = `Delete ${edge.role} ${this._ends(edge)}${below ? ` and ${below} below it` : ''}`;
    this._applyRawPatch((next, infoNext) => {
      const L = this._layers(infoNext);
      infoNext.relationLayer.relations = L.relations.filter((r) => r.id !== edge.id);
      if (spanIds.length) this._dropSpans(infoNext, spanIds);
    });
    const ok = await this._queueWrite(
      label,
      () =>
        this._client.batched(async (b) => {
          b.relations.delete(settledId(edge.id));
          if (tokenIds.length) b.tokens.bulkDelete(tokenIds.map(settledId));
        }),
      operation,
    );
    return ok ? doomed.length : false;
  }

  // Re-parent: the edge is deleted and remade from the new source, in one
  // batch, keeping its role.
  async moveEdge(edgeId, newSourceId) {
    const edge = this.edge(edgeId);
    const source = this.node(newSourceId);
    if (!edge || !source || edge.source === source.id) return false;
    const target = this.node(edge.target);
    if (source.sentence !== target.sentence) {
      this.setError('An edge joins two nodes of one sentence.');
      return false;
    }
    if (this.wouldCycle(source.id, edge.target, edge.role)) {
      this.setError(`Moving ${edge.role} under ${source.var} would close a cycle.`);
      return false;
    }
    const label = 'Failed to move the edge';
    if (!this._canWrite(label)) return false;
    const order = this.nextOrder(source);
    // The re-parented edge is a NEW relation, hung where this person put it:
    // their create stamp, not the old edge's provenance. (ud's re-pointed
    // head is written the same way.)
    const stamp = this.writer.createStamp;
    const newId = pendingId();
    this._applyRawPatch((next, infoNext) => {
      const L = this._layers(infoNext);
      infoNext.relationLayer.relations = L.relations.filter((r) => r.id !== edge.id);
      infoNext.relationLayer.relations.push({
        id: newId,
        source: source.id,
        target: edge.target,
        value: edge.role,
        metadata: { ...stamp, [UMR_NAMESPACE]: { order } },
      });
    });
    return this._queueWrite(
      label,
      async () => {
        const results = await this._client.batched(async (b) => {
          b.relations.delete(settledId(edge.id));
          b.relations.create(
            this.layerInfo.relationLayer.id,
            settledId(source.id),
            settledId(edge.target),
            edge.role,
            { ...stamp, [UMR_NAMESPACE]: { order } },
          );
        });
        this._settle(new Map([[newId, createdId(results.at(-1))]]));
      },
      `Move ${edge.role} ${target.var} under ${source.var}`,
    );
  }

  // Delete a node and everything that hangs off it. Its children stay where
  // they are (as fragments) unless `subtree`.
  async deleteNode(nodeId, { subtree = true } = {}) {
    const node = this.node(nodeId);
    if (!node) return false;
    const label = 'Failed to delete the node';
    if (!this._canWrite(label)) return false;
    const below = subtree ? this.orphanedBy(node.id) : [];
    const doomed = [node, ...below];
    const tokenIds = doomed.flatMap((n) => n.pieces.map((p) => p.id));
    const spanIds = doomed.map((n) => n.id);
    this._applyRawPatch((next, infoNext) => this._dropSpans(infoNext, spanIds));
    return this._queueWrite(
      label,
      () => this._client.tokens.bulkDelete(tokenIds.map(settledId)),
      below.length ? `Delete ${node.var} and ${below.length} below it` : `Delete ${node.var}`,
    );
  }

  // Make a node its sentence's root: the mark moves from the old roots.
  async setRoot(nodeId) {
    const node = this.node(nodeId);
    const sentence = node ? this.sentence(node.sentence) : null;
    if (!sentence || node.root) return false;
    const label = 'Failed to set the root';
    if (!this._canWrite(label)) return false;
    const old = sentence.nodes.filter((n) => n.root);
    const patches = [];
    this._applyRawPatch((next, infoNext) => {
      const spans = this._layers(infoNext).spans;
      // BOTH ends of the move: the node that loses the mark and the one
      // that takes it are each edited by this person's hand.
      old.forEach((o) => {
        const span = spans.find((s) => s.id === o.id);
        if (!span) return;
        const ops = [...umrOps({ root: undefined }), ...this._editStampOps(span.metadata)];
        span.metadata = applyMetadataOps(span.metadata, ops);
        patches.push([o.id, ops]);
      });
      const span = spans.find((s) => s.id === node.id);
      if (span) {
        const ops = [...umrOps({ root: true }), ...this._editStampOps(span.metadata)];
        span.metadata = applyMetadataOps(span.metadata, ops);
        patches.push([node.id, ops]);
      }
    });
    return this._queueWrite(
      label,
      () =>
        this._client.batched(async (b) => {
          patches.forEach(([id, patch]) => b.spans.patchMetadata(settledId(id), patch));
        }),
      `Make ${node.var} the root`,
    );
  }

  // ----- review -----

  // What confirming `nodes` stamps, as `[kind, id, fragment]`: each node and
  // every in-sentence edge into it, since a node's relation to its parent is
  // read with the node. Only what this writer may confirm (the writer
  // policy's `confirmStamp`): a verifier's machine and contributed material,
  // a contributor's machine material.
  _confirmations(nodes) {
    const out = [];
    const seen = new Set();
    nodes.forEach((node) => {
      const stamp = this.writer.confirmStamp(node.metadata);
      if (stamp) out.push(['span', node.id, stamp]);
      node.in.forEach((edge) => {
        if (seen.has(edge.id) || this.node(edge.source)?.sentence !== node.sentence) return;
        seen.add(edge.id);
        const edgeStamp = this.writer.confirmStamp(edge.metadata);
        if (edgeStamp) out.push(['relation', edge.id, edgeStamp]);
      });
    });
    return out;
  }

  /** Whether confirming this node would confirm anything. */
  canConfirm(nodeId) {
    const node = this.node(nodeId);
    return !!node && !node.constant && this._confirmations([node]).length > 0;
  }

  /** Whether confirming this sentence's graph would confirm anything. */
  canConfirmSentence(sentenceIndex) {
    const sentence = this.sentence(sentenceIndex);
    return !!sentence && this._confirmations(sentence.nodes).length > 0;
  }

  _confirm(nodes, label, operation) {
    const stamps = this._confirmations(nodes);
    if (!stamps.length) return Promise.resolve(false);
    if (!this._canWrite(label)) return Promise.resolve(false);
    this._applyRawPatch((next, infoNext) => {
      const L = this._layers(infoNext);
      stamps.forEach(([kind, id, stamp]) => {
        const item = (kind === 'span' ? L.spans : L.relations).find((x) => x.id === id);
        if (item) item.metadata = mergeMetadata(item.metadata, stamp);
      });
    });
    return this._queueWrite(
      label,
      () =>
        this._client.batched(async (b) => {
          stamps.forEach(([kind, id, stamp]) => {
            const api = kind === 'span' ? b.spans : b.relations;
            api.patchMetadata(settledId(id), metadataOps(stamp));
          });
        }),
      operation,
    );
  }

  /**
   * A person looked at a drafted node and vouches for it as it stands: the
   * node and its relations to its parents are confirmed, which settles the
   * tint and keeps them from a Draft that overwrites. Resolves false when
   * there was nothing to confirm.
   */
  confirmNode(nodeId) {
    const node = this.node(nodeId);
    if (!node || node.constant) return Promise.resolve(false);
    return this._confirm([node], 'Failed to accept the node', `Accept ${node.var}`);
  }

  /** Every node and edge of a sentence's graph, as `confirmNode` does one. */
  confirmSentence(sentenceIndex) {
    const sentence = this.sentence(sentenceIndex);
    if (!sentence) return Promise.resolve(false);
    return this._confirm(
      sentence.nodes,
      'Failed to accept the graph',
      `Accept the graph of sentence ${sentenceIndex}`,
    );
  }

  // What discarding a sentence's draft removes. Drafted means machine-made
  // and not accepted (provState MACHINE): a person's own work, a
  // contributor's, and anything accepted all stay. The sentence's drafted
  // edges and the drafted triples its block writes go. A drafted node goes
  // unless a relation that stays is on it: a person's edge or triple onto
  // it, from this sentence or another, keeps the node it needs. The
  // relations on a node that goes are then all drafted ones, another
  // sentence's included, and the server's cascade takes them with it.
  //
  // A drafted edge whose child a person made or corrected stays, still a
  // draft (the owner's ruling): editing a node stamps the node and not the
  // edge into it, and cutting that edge left the corrected node an
  // unconnected graph. Its parent then stays too, since a kept relation is
  // on it.
  _discardPlan(sentence) {
    const machine = (x) => provState(x.metadata) === PROV_STATES.MACHINE;
    const keptEdges = new Set(
      sentence.edges
        .filter((e) => {
          const child = this.node(e.target);
          return machine(e) && child && !child.constant && !machine(child);
        })
        .map((e) => e.id),
    );
    const drafted = (x) => machine(x) && !keptEdges.has(x.id);
    const others = this.sentences.filter((s) => s !== sentence);
    // By id: a sentence an edit left as it was keeps its objects from the
    // version before (see `graph`), so a triple two blocks write is not one
    // object in both.
    const ownTriples = sentence.triples.filter(
      (t) => !others.some((s) => s.triples.some((x) => x.id === t.id)),
    );
    const relations = new Map();
    [...sentence.edges, ...ownTriples].filter(drafted).forEach((r) => relations.set(r.id, r));
    const nodes = sentence.nodes.filter(
      (n) =>
        !n.constant && drafted(n) && [...n.in, ...n.out, ...n.docIn, ...n.docOut].every(drafted),
    );
    const doomed = new Set(nodes.map((n) => n.id));
    nodes.forEach((n) =>
      [...n.in, ...n.out, ...n.docIn, ...n.docOut].forEach((r) => relations.set(r.id, r)),
    );
    // Deleted one by one only where both ends stay. The rest go with a node.
    const explicit = [...relations.values()].filter(
      (r) => !doomed.has(r.source) && !doomed.has(r.target),
    );
    // The relations that go and are not this sentence's own: another
    // sentence's edge or triple onto a node that goes.
    const own = new Set([...sentence.edges, ...ownTriples].map((r) => r.id));
    const otherRelations = [...relations.keys()].filter((id) => !own.has(id)).length;
    return { nodes, relations: [...relations.values()], explicit, otherRelations };
  }

  /**
   * What Discard graph would remove from a sentence: `{ nodes, relations,
   * otherRelations }`, where `otherRelations` counts the relations in
   * `relations` that belong to other sentences. All empty when there is
   * nothing drafted to discard.
   */
  discardPlan(sentenceIndex) {
    const sentence = this.sentence(sentenceIndex);
    if (!sentence) return { nodes: [], relations: [], otherRelations: 0 };
    const { nodes, relations, otherRelations } = this._discardPlan(sentence);
    return { nodes, relations, otherRelations };
  }

  /** Whether discarding this sentence's draft would remove anything. */
  canDiscardSentence(sentenceIndex) {
    const { nodes, relations } = this.discardPlan(sentenceIndex);
    return nodes.length > 0 || relations.length > 0;
  }

  /**
   * Remove a sentence's drafted graph, keeping what a person made or
   * accepted (see `_discardPlan`). One operation. Resolves false when there
   * was nothing to discard.
   */
  discardSentence(sentenceIndex) {
    const sentence = this.sentence(sentenceIndex);
    if (!sentence) return Promise.resolve(false);
    const { nodes, relations, explicit } = this._discardPlan(sentence);
    if (!nodes.length && !relations.length) return Promise.resolve(false);
    const label = 'Failed to discard the drafted graph';
    if (!this._canWrite(label)) return Promise.resolve(false);
    const spanIds = nodes.map((n) => n.id);
    const tokenIds = nodes.flatMap((n) => n.pieces.map((p) => p.id));
    const relationIds = new Set(explicit.map((r) => r.id));
    this._applyRawPatch((next, infoNext) => {
      const L = this._layers(infoNext);
      infoNext.relationLayer.relations = L.relations.filter((r) => !relationIds.has(r.id));
      infoNext.documentGraphLayer.relations = L.triples.filter((r) => !relationIds.has(r.id));
      if (spanIds.length) this._dropSpans(infoNext, spanIds);
    });
    return this._queueWrite(
      label,
      () =>
        this._client.batched(async (b) => {
          explicit.forEach((r) => b.relations.delete(settledId(r.id)));
          if (tokenIds.length) b.tokens.bulkDelete(tokenIds.map(settledId));
        }),
      `Discard the drafted graph of sentence ${sentenceIndex}`,
    );
  }

  // ----- the document graph -----

  // A constant's node (`author`, `root`, `document-creation-time`, ...), or
  // null when no triple has used it yet.
  constantNode(name) {
    return this.graph.constants.find((c) => c.var === name) || null;
  }

  triple(id) {
    const settled = settledId(id);
    const rel = (this.layerInfo.documentGraphLayer?.relations || []).find((r) => r.id === settled);
    if (!rel) return null;
    const source = this.node(rel.source);
    const target = this.node(rel.target);
    return source && target
      ? {
          id: rel.id,
          source: rel.source,
          target: rel.target,
          rel: rel.value,
          group: umrOf(rel).group,
        }
      : null;
  }

  // A constant's node (`author`, `document-creation-time`, ...) for a triple
  // to hang on, the way the importer makes one: a zero-width token at the
  // text's start and a span marked constant. Shown at once under pending
  // ids; `_createConstant` makes it on the server inside the send.
  _pendingConstant(name) {
    const stamp = this.writer.createStamp;
    return {
      name,
      token: { id: pendingId(), begin: 0, end: 0 },
      span: {
        id: pendingId(),
        value: name,
        metadata: { ...stamp, [UMR_NAMESPACE]: { var: name, constant: true } },
      },
    };
  }

  _addConstant(infoNext, c) {
    const L = this._layers(infoNext);
    L.tokens.push({ ...c.token });
    L.spans.push({ ...c.span, tokens: [c.token.id] });
  }

  async _createConstant(c, ids) {
    await this._createPieces([c.token], ids);
    const span = await this._client.spans.create(
      this.layerInfo.conceptLayer.id,
      [ids.get(c.token.id)],
      c.name,
      c.span.metadata,
    );
    ids.set(c.span.id, createdId(span));
  }

  /**
   * A document-level triple: temporal, modal or coreference. Either end is a
   * node id or a constant's name. `sentenceIndex` says whose block writes a
   * triple between two constants. Resolves to the triple's id, or false.
   */
  async createTriple({ source, target, rel, group = null, sentenceIndex = null }) {
    rel = nfc(rel);
    if (!source || !target || !rel) return false;
    const isConst = (x) => DOC_CONSTANTS.includes(x);
    const nodeOf = (x) => (isConst(x) ? this.constantNode(x) : this.node(x));
    const s = nodeOf(source);
    const t = nodeOf(target);
    if (source === target) return false;
    if (!isConst(source) && !s) return false;
    if (!isConst(target) && !t) return false;
    const g = group || groupOf(rel);
    if (this._refused(this.relationProblem(rel, { group: g }))) return false;
    // Already there, in this direction, or in either for a coreference.
    const same = (x, from, to) => x.rel === rel && x.target === to && x.source === from;
    const there =
      (s && t && s.docOut.some((x) => same(x, s.id, t.id))) ||
      (g === 'coref' && s && t && t.docOut.some((x) => same(x, t.id, s.id)));
    if (there) {
      this.setError(`${s?.var || source} ${rel} ${t?.var || target} is already there.`);
      return false;
    }
    const failed = 'Failed to add the document-level relation';
    if (!this._canWrite(failed)) return false;
    const meta = { group: g };
    // A triple between two constants belongs to no sentence by itself: the
    // one whose block it was made from writes it.
    if (isConst(source) && isConst(target)) meta.sentences = [sentenceIndex ?? 1];
    const stamp = this.writer.createStamp;
    // A constant no triple has used yet is made here, the way the importer
    // makes one: a zero-width token at the text's start and a span marked
    // constant. Made on this writer's behalf to hang their triple on, so it
    // carries their create stamp (ud's lemma span for a relation does the
    // same).
    const newSource = s ? null : this._pendingConstant(source);
    const newTarget = t ? null : this._pendingConstant(target);
    const sourceId = s ? s.id : newSource.span.id;
    const targetId = t ? t.id : newTarget.span.id;
    const tripleId = pendingId();
    this._applyRawPatch((next, infoNext) => {
      if (newSource) this._addConstant(infoNext, newSource);
      if (newTarget) this._addConstant(infoNext, newTarget);
      this._layers(infoNext).triples.push({
        id: tripleId,
        source: sourceId,
        target: targetId,
        value: rel,
        metadata: { ...stamp, [UMR_NAMESPACE]: meta },
      });
    });
    const ids = new Map();
    const ok = await this._queueWrite(
      failed,
      async () => {
        const made = [newSource, newTarget].filter(Boolean).map((c) => c.token);
        await this._undoPiecesOnFailure(made, ids, async () => {
          if (newSource) await this._createConstant(newSource, ids);
          if (newTarget) await this._createConstant(newTarget, ids);
          const serverId = (id) => ids.get(id) || settledId(id);
          const created = await this._client.relations.create(
            this.layerInfo.documentGraphLayer.id,
            serverId(sourceId),
            serverId(targetId),
            rel,
            { ...stamp, [UMR_NAMESPACE]: meta },
          );
          ids.set(tripleId, createdId(created));
        });
        this._settle(ids);
      },
      `Add ${rel} from ${s?.var || source} to ${t?.var || target}`,
    );
    return ok ? settledId(tripleId) : false;
  }

  async setTripleRelation(id, rel) {
    rel = nfc(rel);
    const t = this.triple(id);
    if (!t || !rel || t.rel === rel) return false;
    if (this._refused(this.relationProblem(rel, { tripleId: id }))) return false;
    // The same pair under the same relation, as createTriple refuses it: the
    // node wore the tag twice and the file wrote the triple twice.
    const source = this.node(t.source) || this.constantNode(t.source);
    const twin = (source?.docOut || []).find(
      (x) => x.id !== t.id && x.rel === rel && x.target === t.target,
    );
    if (twin) {
      const name = (x) => this.node(x)?.var || x;
      this.setError(`${name(t.source)} ${rel} ${name(t.target)} is already there.`);
      return false;
    }
    const label = 'Failed to change the document-level relation';
    if (!this._canWrite(label)) return false;
    const raw = this._layers(this.layerInfo).triples.find((x) => x.id === t.id);
    const stampOps = this._editStampOps(raw?.metadata);
    this._applyRawPatch((next, infoNext) => {
      const r = this._layers(infoNext).triples.find((x) => x.id === t.id);
      if (!r) return;
      r.value = rel;
      if (stampOps.length) r.metadata = applyMetadataOps(r.metadata, stampOps);
    });
    return this._queueWrite(
      label,
      async () => {
        const serverId = settledId(t.id);
        if (stampOps.length) {
          await this._client.batched(async (b) => {
            b.relations.update(serverId, rel);
            b.relations.patchMetadata(serverId, stampOps);
          });
        } else {
          await this._client.relations.update(serverId, rel);
        }
      },
      `Relabel ${t.rel} ${this._ends(t)} as ${rel}`,
    );
  }

  async deleteTriple(id) {
    const t = this.triple(id);
    if (!t) return false;
    const label = 'Failed to delete the document-level relation';
    if (!this._canWrite(label)) return false;
    this._applyRawPatch((next, infoNext) => {
      infoNext.documentGraphLayer.relations = this._layers(infoNext).triples.filter(
        (x) => x.id !== t.id,
      );
    });
    return this._queueWrite(
      label,
      () => this._client.relations.delete(settledId(t.id)),
      `Delete ${t.rel} ${this._ends(t)}`,
    );
  }

  // ----- text mode -----

  // The sentence's graph as PENMAN, the text mode's starting point: every
  // node of it, the parts the root does not reach as further graphs after
  // the root's (`sentencePenman`), so what Apply deletes is what the text
  // left out and nothing on the canvas is out of its reach.
  penmanOf(sentenceIndex) {
    const sentence = this.sentence(sentenceIndex);
    if (sentence?.nodes.length) return sentencePenman(sentence, this.graph.nodesById);
    // A graph the import could not read, kept as text: text mode opens on it
    // so it can be mended and applied, where it opened empty.
    const sent = toUmrSentences(this.graph)[sentenceIndex - 1];
    return typeof sent?.rawGraph === 'string' ? sent.rawGraph : '';
  }

  /**
   * One node renamed in the text, or null. A variable typed over is a rename
   * when exactly one goes and one arrives and they are plainly the same node:
   * the same concept, hanging under the same parents by the same relations,
   * or both the sentence's root. Anything less clear-cut stays a delete and a
   * create, which is what the status line warns about.
   */
  _renameIn(sentence, parsed, written) {
    const gone = sentence.nodes.filter((n) => written.has(n.id) && !parsed.nodes.has(n.var));
    const fresh = [...parsed.nodes.keys()].filter((v) => !sentence.nodes.some((n) => n.var === v));
    if (gone.length !== 1 || fresh.length !== 1) return null;
    const node = gone[0];
    const to = fresh[0];
    if (parsed.nodes.get(to)?.concept !== node.concept) return null;
    const oldParents = new Set(
      node.in
        .filter((e) => this.node(e.source)?.sentence === sentence.index)
        .map((e) => `${e.role} ${this.node(e.source).var}`),
    );
    const newParents = new Set();
    parsed.nodes.forEach((parent, v) => {
      parent.children.forEach((child) => {
        if (child.kind === 'node' && child.value === to) newParents.add(`${child.rel} ${v}`);
      });
    });
    const same =
      oldParents.size === newParents.size && [...oldParents].every((k) => newParents.has(k));
    if (!same) return null;
    // A parentless node is the root or nothing: renaming the root is a
    // rename, renaming a loose fragment's head is a guess.
    if (!oldParents.size && !(node.root && parsed.root === to)) return null;
    return { nodeId: node.id, from: node.var, to };
  }

  /**
   * What applying a PENMAN text to a sentence would change: nodes matched by
   * variable, and one variable typed over read as a rename (`_renameIn`).
   * Returns `{ errors }` when the text does not parse, else the plan.
   */
  planPenman(sentenceIndex, text) {
    const sentence = this.sentence(sentenceIndex);
    if (!sentence) return { errors: [{ message: 'No such sentence.' }] };
    const parsed = parsePenman(text, { several: true });
    if (parsed.errors.length) return { errors: parsed.errors };
    // An empty text names no node, so every node goes, as any node missing
    // from the text does (the owner's ruling). Text that is not empty and
    // holds no graph is a mistake, not a deletion.
    if (!parsed.root && String(text).trim()) {
      return { errors: [{ message: 'The text has no graph.' }] };
    }
    // The text shows every node of the sentence, so every one is its to keep
    // or delete.
    const written = new Set(sentence.nodes.map((n) => n.id));
    const rename = this._renameIn(sentence, parsed, written);
    // The renamed node answers to its new name everywhere below, so the rest
    // of the plan reads as though it had always been called that.
    const nameOf = (node) => (node && rename && node.id === rename.nodeId ? rename.to : node?.var);
    const oldByVar = new Map(sentence.nodes.map((n) => [nameOf(n), n]));
    const newVars = new Set(parsed.nodes.keys());
    const plan = {
      create: [],
      delete: [],
      concept: [],
      attrs: [],
      edgesAdd: [],
      edgesDelete: [],
      orders: [],
      rename: rename ? [rename] : [],
      root: null,
    };
    parsed.nodes.forEach((node, v) => {
      const attrs = [];
      const edges = [];
      node.children.forEach((child, order) => {
        if (child.kind === 'node') edges.push({ role: child.rel, target: child.value, order });
        else attrs.push({ rel: child.rel, value: child.value, order });
      });
      const old = oldByVar.get(v);
      if (!old) {
        plan.create.push({ var: v, concept: node.concept, attrs, edges });
        return;
      }
      if (old.concept !== node.concept)
        plan.concept.push({ nodeId: old.id, var: v, from: old.concept, concept: node.concept });
      // With their places among the children: an attribute moved past an edge
      // is a change, and was once counted as applied without being stored.
      const attrKey = (a) => `${a.rel} ${a.value} @${a.order ?? 0}`;
      const oldAttrs = old.attrs.map(attrKey).join('\n');
      const nextAttrs = attrs.map(attrKey).join('\n');
      // Edges by (role, target variable): an edge with a new target or role
      // is a new edge, and the old one goes.
      const oldEdges = old.out
        .filter((e) => this.node(e.target)?.sentence === sentenceIndex)
        .map((e) => ({
          id: e.id,
          key: `${e.role} ${nameOf(this.node(e.target))}`,
          order: e.order,
        }));
      const nextKeys = new Map(edges.map((e) => [`${e.role} ${e.target}`, e]));
      // A place that changed only because a child before it went, or came,
      // is a renumber, which is no one's edit. One that changed because the
      // children kept on both sides now stand in another order is a move,
      // and the person's, as a move on the canvas is.
      const bare = (list) => list.map((a) => `${a.rel} ${a.value}`).join('\n');
      const attrWord = (a) => `attr ${a.rel} ${a.value}`;
      const oldSeq = [
        ...oldEdges.map((e) => ({ word: `edge ${e.key}`, order: e.order })),
        ...old.attrs.map((a) => ({ word: attrWord(a), order: a.order ?? 0 })),
      ].sort((a, b) => a.order - b.order);
      const nextSeq = [
        ...edges.map((e) => ({ word: `edge ${e.role} ${e.target}`, order: e.order })),
        ...attrs.map((a) => ({ word: attrWord(a), order: a.order })),
      ].sort((a, b) => a.order - b.order);
      const inBoth = (seq, other) => {
        const words = new Set(other.map((c) => c.word));
        return seq.filter((c) => words.has(c.word)).map((c) => c.word);
      };
      const keptOld = inBoth(oldSeq, nextSeq);
      const keptNext = inBoth(nextSeq, oldSeq);
      const movedChild = (word) => keptOld.indexOf(word) !== keptNext.indexOf(word);
      const attrMoved = old.attrs.some((a) => movedChild(attrWord(a)));
      if (oldAttrs !== nextAttrs) {
        plan.attrs.push({
          nodeId: old.id,
          attrs,
          renumber: bare(old.attrs) === bare(attrs) && !attrMoved,
        });
      }
      oldEdges.forEach((e) => {
        if (!nextKeys.has(e.key)) plan.edgesDelete.push(e.id);
        else if (nextKeys.get(e.key).order !== e.order) {
          plan.orders.push({
            edgeId: e.id,
            order: nextKeys.get(e.key).order,
            moved: movedChild(`edge ${e.key}`),
          });
        }
      });
      const oldKeys = new Set(oldEdges.map((e) => e.key));
      edges.forEach((e) => {
        if (!oldKeys.has(`${e.role} ${e.target}`)) {
          plan.edgesAdd.push({ sourceVar: v, role: e.role, targetVar: e.target, order: e.order });
        }
      });
    });
    // A node the text no longer names goes.
    sentence.nodes.forEach((n) => {
      if (written.has(n.id) && !newVars.has(nameOf(n))) plan.delete.push(n.id);
    });
    // An edge into or out of a deleted node goes with it (the server's
    // cascade), and a second delete would be a 404.
    const gone = new Set(plan.delete);
    plan.edgesDelete = plan.edgesDelete.filter((id) => {
      const e = this.edge(id);
      return e && !gone.has(e.source) && !gone.has(e.target);
    });
    const oldRoot = nameOf(sentence.roots[0]);
    if (parsed.root !== oldRoot) plan.root = parsed.root;

    // What the canvas refuses, text mode refuses too: a new node's variable
    // malformed or taken elsewhere in the document, a concept, relation or
    // value the file cannot hold, a relation UMR does not have, and a new
    // edge closing a cycle through anything but a quote.
    const errors = [];
    [...plan.create.map((c) => c.var), ...plan.rename.map((r) => r.to)].forEach((v) => {
      const why = this._newVariableProblem(v, sentenceIndex);
      if (why) errors.push({ message: why });
    });
    // A relation is judged where it is written, as the canvas judges it: one
    // already stored on that node's attributes, or on that very edge, is
    // kept (an imported file may carry one UMR does not have), and one stored
    // only elsewhere in the sentence is not.
    parsed.nodes.forEach((node, v) => {
      const why = conceptProblem(node.concept);
      if (why) errors.push({ message: `${v}: ${why}` });
      const old = oldByVar.get(v);
      node.children.forEach((child) => {
        const edge =
          child.kind === 'node'
            ? old?.out.find(
                (e) => e.role === child.rel && nameOf(this.node(e.target)) === child.value,
              )
            : null;
        const at = edge
          ? { edgeId: edge.id }
          : child.kind !== 'node' && old
            ? { nodeId: old.id }
            : {};
        const bad =
          this.relationProblem(child.rel, at) ||
          (child.kind === 'node' ? null : this.attrValueProblem(child.rel, child.value, at));
        if (bad) errors.push({ message: `${v}: ${bad}` });
      });
    });
    const reaches = (from, to) => {
      const seen = new Set();
      const stack = [from];
      while (stack.length) {
        const v = stack.pop();
        if (v === to) return true;
        if (seen.has(v)) continue;
        seen.add(v);
        parsed.nodes.get(v)?.children.forEach((c) => {
          if (c.kind === 'node' && !CYCLE_ROLES.has(c.rel)) stack.push(c.value);
        });
      }
      return false;
    };
    const added = [
      ...plan.edgesAdd,
      ...plan.create.flatMap((c) =>
        c.edges.map((e) => ({ sourceVar: c.var, role: e.role, targetVar: e.target })),
      ),
    ];
    added.forEach((e) => {
      if (!CYCLE_ROLES.has(e.role) && reaches(e.targetVar, e.sourceVar)) {
        errors.push({
          message: `${e.role} from ${e.sourceVar} to ${e.targetVar} would close a cycle.`,
        });
      }
    });
    if (errors.length) return { errors };

    // What a deletion takes that the text does not show: a node's anchor and
    // its document-level relations. A variable renamed in the text is a new
    // node, so it loses them too.
    plan.losses = plan.delete
      .map((id) => this.node(id))
      .filter((n) => n && (n.aligned || n.docOut?.length || n.docIn?.length))
      .map((n) => ({
        var: n.var,
        anchored: !!n.aligned,
        relations: (n.docOut?.length || 0) + (n.docIn?.length || 0),
      }));

    const changes =
      plan.create.length +
      plan.delete.length +
      plan.rename.length +
      plan.concept.length +
      plan.attrs.length +
      plan.edgesAdd.length +
      plan.edgesDelete.length +
      plan.orders.length +
      (plan.root ? 1 : 0);
    return { ...plan, changes };
  }

  // What an apply to `sentence` does to the held relations (see applyPenman):
  // `heldTriples`, the rows to create, under pending ids, and `sentenceOps`,
  // the metadata ops on the sentence tokens that held them. `idByVar` is the
  // sentence's names after the apply, new nodes included.
  _heldResolved(sentence, plan, idByVar) {
    const fresh = new Set(plan.create.map((c) => c.var));
    const gone = new Set(plan.delete);
    const elsewhere = new Map();
    this.graph.nodesById.forEach((n) => {
      if (n.constant || n.sentence === sentence.index || gone.has(n.id)) return;
      if (n.var && !elsewhere.has(n.var)) elsewhere.set(n.var, n.id);
    });
    const idOf = (name) =>
      idByVar.get(name) || elsewhere.get(name) || this.constantNode(name)?.id || null;
    const heldTriples = [];
    const opsByToken = new Map();
    const add = (tokenId, changes) =>
      opsByToken.set(tokenId, { ...opsByToken.get(tokenId), ...changes });
    if (fresh.size) {
      this.sentences.forEach((s) => {
        if (!s.held.length) return;
        const keep = s.held.filter((h) => {
          const source = idOf(h.source);
          const target = idOf(h.target);
          if (!source || !target || !(fresh.has(h.source) || fresh.has(h.target))) return true;
          heldTriples.push({
            id: pendingId(),
            source,
            target,
            value: h.rel,
            metadata: { [UMR_NAMESPACE]: { group: h.group } },
          });
          return false;
        });
        if (keep.length !== s.held.length) add(s.tokenId, { held: keep.length ? keep : undefined });
      });
    }
    // The graph kept as text, mended: its text is no longer what is kept.
    if (fresh.size && !sentence.nodes.length && typeof sentence.rawGraph === 'string') {
      add(sentence.tokenId, { rawGraph: undefined, rawAlignment: undefined });
    }
    return { heldTriples, sentenceOps: [...opsByToken].map(([id, c]) => [id, umrOps(c)]) };
  }

  /**
   * Apply a PENMAN text to a sentence as ONE operation. The whole plan shows
   * at once, new nodes and edges under pending ids, and is sent in THREE
   * requests: everything that needs no id made along the way (the renames,
   * the deletions, the concept, attribute, order and root changes, and the
   * new nodes' anchors), then the new nodes, then the new edges. The importer
   * writes in the same three passes, and for the same reason: an op cannot
   * use an id made in its own batch. A new node is unaligned until anchored
   * on the canvas. Resolves to the number of changes, or false.
   *
   * It was a round trip per node, edge and patch, in series, under the
   * write lock: a 30-node graph pasted into text mode was about 90 of them.
   */
  async applyPenman(sentenceIndex, text) {
    const info = this.layerInfo;
    const sentence = this.sentence(sentenceIndex);
    const plan = this.planPenman(sentenceIndex, text);
    if (plan.errors) {
      this.setError(plan.errors[0].message);
      return false;
    }
    if (!plan.changes) return 0;
    const label = 'Failed to apply the text';
    if (!this._canWrite(label)) return false;

    const idByVar = new Map(sentence.nodes.map((n) => [n.var, n.id]));
    const L = this._layers(info);
    // Text mode is a person writing the graph, so it stamps like the
    // canvas: what it makes carries the create stamp, what it changes
    // carries the edit stamp (write-contract rule 3).
    const stamp = this.writer.createStamp;
    const editSpan = (spanId) => this._editStampOps(L.spans.find((x) => x.id === spanId)?.metadata);
    // Each patch writes only the keys of the `umr` namespace it changes, so
    // two patches of one node (an old root's attributes and its root mark)
    // cannot undo each other.
    const umrPatchFor = (spanId, changes) => [...umrOps(changes), ...editSpan(spanId)];
    const gone = new Set(plan.delete);

    // Every change to what is already there, as the metadata ops, value
    // updates and deletes pass 1 sends, in the order it sends them.
    const spanOps = []; // [spanId, ops]
    const spanValues = []; // [spanId, value, stamp ops]
    const relationOps = []; // [relationId, ops]
    // A variable typed over: the node keeps its anchor, its edges and its
    // document-level relations, and answers to the new name from here on.
    for (const r of plan.rename) {
      spanOps.push([r.nodeId, umrPatchFor(r.nodeId, { var: r.to })]);
      idByVar.delete(r.from);
      idByVar.set(r.to, r.nodeId);
    }
    // Deletes next, so a variable given to a new node is free.
    const deletedTokens = plan.delete.flatMap((id) => this.node(id).pieces.map((p) => p.id));
    plan.delete.forEach((id) => {
      const n = this.node(id);
      if (n) idByVar.delete(n.var);
    });
    // The root moves: the old marks come off first, so no two nodes wear
    // one, whether the new root is made below or was there already.
    if (plan.root) {
      const renamed = new Map(plan.rename.map((r) => [r.nodeId, r.to]));
      sentence.nodes
        .filter((n) => n.root && (renamed.get(n.id) ?? n.var) !== plan.root && !gone.has(n.id))
        .forEach((o) => spanOps.push([o.id, umrPatchFor(o.id, { root: undefined })]));
    }
    for (const c of plan.concept) spanValues.push([c.nodeId, c.concept, editSpan(c.nodeId)]);
    // A renumber moves a child's place and nothing else, so it carries no
    // stamp: an untouched machine edge or attribute stays unverified.
    for (const a of plan.attrs) {
      spanOps.push([
        a.nodeId,
        a.renumber ? umrOps({ attrs: a.attrs }) : umrPatchFor(a.nodeId, { attrs: a.attrs }),
      ]);
    }
    // An edge's place likewise: a renumber carries no stamp, a move does.
    for (const o of plan.orders) {
      const stamp = o.moved ? this._editStampOps(this.edge(o.edgeId)?.metadata) : [];
      relationOps.push([o.edgeId, [...umrOps({ order: o.order }), ...stamp]]);
    }
    // The root the text names, when it is a node that was already there: a
    // new one carries the mark in its own metadata.
    if (plan.root && !plan.create.some((c) => c.var === plan.root)) {
      const rootId = idByVar.get(plan.root);
      if (rootId) spanOps.push([rootId, umrPatchFor(rootId, { root: true })]);
    }

    // A sentence the import kept as text keeps its alignment block too.
    // Mending the graph here is the first time anything can be anchored to
    // it, and the block is written no longer once the sentence has nodes, so
    // its words would be lost with it.
    const kept = sentence.nodes.length ? null : sentence.rawAlignment;
    const keptWords = kept ? readAlignment(kept) : null;
    // The words the kept block gives a variable, as anchor pieces: none for
    // a variable it aligns to nothing (`0-0`) or does not name.
    const keptPieces = (v) => {
      const ranges = keptWords?.get(v) || [];
      const pieces = [];
      ranges.forEach(([a, b]) => {
        const first = sentence.words[a - 1];
        const last = sentence.words[b - 1];
        if (first && last && a <= b) pieces.push({ begin: first.begin, end: last.end });
      });
      return pieces;
    };
    // The new nodes, each on its own new anchor pieces.
    const newNodes = plan.create.map((c) => {
      // Unaligned, like every node text mode makes unless the file it is
      // mending said which words it covers: only then does it record its
      // sentence (see _reconcile), since the record is what says a node is
      // aligned to nothing, whatever its anchor covers.
      const words = keptPieces(c.var);
      const meta = { var: c.var, attrs: c.attrs };
      if (!words.length) meta.sentence = sentence.tokenId;
      if (plan.root === c.var) meta.root = true;
      const node = {
        id: pendingId(),
        pieces: this._pendingPieces(words.length ? words : this.piecesFor(sentence, [])),
        value: c.concept,
        metadata: { ...stamp, [UMR_NAMESPACE]: meta },
      };
      idByVar.set(c.var, node.id);
      return node;
    });
    // The new edges, now that both ends have ids.
    const newEdges = [];
    [
      ...plan.edgesAdd,
      ...plan.create.flatMap((c) =>
        c.edges.map((e) => ({
          sourceVar: c.var,
          role: e.role,
          targetVar: e.target,
          order: e.order,
        })),
      ),
    ].forEach((e) => {
      const source = idByVar.get(e.sourceVar);
      const target = idByVar.get(e.targetVar);
      if (!source || !target) {
        console.warn('applyPenman: an edge lost its end', e);
        return;
      }
      newEdges.push({
        id: pendingId(),
        source,
        target,
        value: e.role,
        metadata: { ...stamp, [UMR_NAMESPACE]: { order: e.order } },
      });
    });

    // The relations the import held for a graph kept as text (sentenceGraph
    // `held`), made real now that this apply defines a name they wait for,
    // and taken off the sentence that held them. Stored as the import stores
    // a triple: they are the file's, not this writer's. A graph mended here
    // also stops keeping its old text, which would otherwise come back if
    // the graph were emptied.
    const { heldTriples, sentenceOps } = this._heldResolved(sentence, plan, idByVar);

    this._applyRawPatch((next, infoNext) => {
      const layers = this._layers(infoNext);
      heldTriples.forEach((t) => layers.triples.push({ ...t }));
      const sentenceTokens = infoNext.sentenceTokenLayer?.tokens || [];
      sentenceOps.forEach(([id, ops]) => {
        const token = sentenceTokens.find((x) => x.id === id);
        if (token) token.metadata = applyMetadataOps(token.metadata, ops);
      });
      spanOps.forEach(([id, ops]) => {
        const span = layers.spans.find((x) => x.id === id);
        if (span) span.metadata = applyMetadataOps(span.metadata, ops);
      });
      spanValues.forEach(([id, value, stampOps]) => {
        const span = layers.spans.find((x) => x.id === id);
        if (!span) return;
        span.value = value;
        if (stampOps.length) span.metadata = applyMetadataOps(span.metadata, stampOps);
      });
      relationOps.forEach(([id, ops]) => {
        const rel = layers.relations.find((x) => x.id === id);
        if (rel) rel.metadata = applyMetadataOps(rel.metadata, ops);
      });
      const edgesGone = new Set(plan.edgesDelete);
      infoNext.relationLayer.relations = layers.relations.filter((r) => !edgesGone.has(r.id));
      if (plan.delete.length) this._dropSpans(infoNext, plan.delete);
      const after = this._layers(infoNext);
      newNodes.forEach((n) => {
        n.pieces.forEach((p) => after.tokens.push({ ...p }));
        after.spans.push({
          id: n.id,
          tokens: n.pieces.map((p) => p.id),
          value: n.value,
          metadata: n.metadata,
        });
      });
      newEdges.forEach((e) => after.relations.push({ ...e }));
    });

    const client = this._client;
    return this._queueWrite(
      label,
      async () => {
        const ids = new Map();
        const serverId = (id) => ids.get(id) || settledId(id);
        const pieces = newNodes.flatMap((n) => n.pieces);
        // Pass 1. The anchors go LAST in it, so their ids are the batch's
        // last result.
        const firstPass = await client.batched(async (b) => {
          spanOps.forEach(([id, ops]) => b.spans.patchMetadata(settledId(id), ops));
          if (deletedTokens.length) b.tokens.bulkDelete(deletedTokens.map(settledId));
          for (const edgeId of plan.edgesDelete) b.relations.delete(settledId(edgeId));
          spanValues.forEach(([id, value, stampOps]) => {
            b.spans.update(settledId(id), value);
            if (stampOps.length) b.spans.patchMetadata(settledId(id), stampOps);
          });
          relationOps.forEach(([id, ops]) => b.relations.patchMetadata(settledId(id), ops));
          if (pieces.length) {
            b.tokens.bulkCreate(
              pieces.map((p) => ({
                tokenLayerId: info.nodeTokenLayer.id,
                text: info.textLayer.text.id,
                begin: p.begin,
                end: p.end,
              })),
            );
          }
        });
        const pieceIds = pieces.length ? createdIds(firstPass.at(-1)) : [];
        if (pieceIds.length !== pieces.length) {
          throw new Error(
            `The server returned ${pieceIds.length} anchor ids for ${pieces.length} anchors.`,
          );
        }
        pieces.forEach((p, i) => ids.set(p.id, pieceIds[i]));

        // Pass 2. The new nodes, on the anchors pass 1 made. Should it fail,
        // those anchors are removed again: nobody could see or delete them.
        if (newNodes.length) {
          const secondPass = await this._undoPiecesOnFailure(pieces, ids, () =>
            client.batched(async (b) => {
              b.spans.bulkCreate(
                newNodes.map((n) => ({
                  spanLayerId: info.conceptLayer.id,
                  tokens: n.pieces.map((p) => ids.get(p.id)),
                  value: n.value,
                  metadata: n.metadata,
                })),
              );
            }),
          );
          const spanIds = createdIds(secondPass.at(-1));
          if (spanIds.length !== newNodes.length) {
            throw new Error(
              `The server returned ${spanIds.length} node ids for ${newNodes.length} nodes.`,
            );
          }
          newNodes.forEach((n, i) => ids.set(n.id, spanIds[i]));
        }

        // Pass 3. The new edges, the held relations made real, and the
        // sentences that held them, together: a held relation leaves its
        // sentence only as it is made.
        if (newEdges.length || heldTriples.length || sentenceOps.length) {
          const thirdPass = await client.batched(async (b) => {
            const bulk = (list, layerId) =>
              b.relations.bulkCreate(
                list.map((e) => ({
                  relationLayerId: layerId,
                  source: serverId(e.source),
                  target: serverId(e.target),
                  value: e.value,
                  metadata: e.metadata,
                })),
              );
            if (newEdges.length) bulk(newEdges, info.relationLayer.id);
            if (heldTriples.length) bulk(heldTriples, info.documentGraphLayer.id);
            sentenceOps.forEach(([id, ops]) => b.tokens.patchMetadata(settledId(id), ops));
          });
          const edgeIds = newEdges.length ? createdIds(thirdPass[0]) : [];
          newEdges.forEach((e, i) => edgeIds[i] && ids.set(e.id, edgeIds[i]));
          const tripleIds = heldTriples.length
            ? createdIds(thirdPass[newEdges.length ? 1 : 0])
            : [];
          heldTriples.forEach((t, i) => tripleIds[i] && ids.set(t.id, tripleIds[i]));
        }
        this._settle(ids);
      },
      `Apply text to sentence ${sentenceIndex} (${plan.changes} change${plan.changes === 1 ? '' : 's'})`,
    ).then((ok) => (ok ? plan.changes : false));
  }
}
