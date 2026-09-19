// A UMR document: the lifecycle is plaid-ui's DocumentModel, what the layers
// mean is here. Reads through `graph` (sentenceGraph.js) and every edit is
// one audited operation that patches the raw document once the server has
// answered, since a node, an edge and an anchor all need server ids.
//
// By their real paths rather than through `@ui`: the node suite has no alias.
import { DocumentModel } from '../../../plaid-ui/src/domain/DocumentModel.js';
import { vocabLinksByToken } from './vocabLexicon.js';
import { getUmrLayerInfo, UMR_NAMESPACE, readIlgConfig } from '../utils/umrLayerUtils.js';
import { resolveIlg, ilgLinesFor } from './ilg.js';
import {
  buildDocumentGraph,
  toUmrSentences,
  nextVariable,
  CYCLE_ROLES,
  crossSentenceEdges,
  unreachedByRoot,
  groupOf,
} from './sentenceGraph.js';
import { DOC_CONSTANTS } from './format/inventory.js';
import { describeUmrReconcile, planUnalignedHeal } from './umrReconcile.js';
import { serializeUmrFile, readAlignment } from './format/umrFile.js';
import {
  conceptProblem,
  relationProblem,
  attrValueProblem,
  parsePenman,
  serializePenman,
} from './format/penman.js';
import { validateDocument } from './format/validate.js';

const VARIABLE = /^s[0-9]+\p{Ll}+[0-9]*$/u;

const umrOf = (entity) => entity?.metadata?.[UMR_NAMESPACE] || {};

// A metadata patch that restates the whole `umr` namespace: a document
// metadata PATCH replaces a nested namespace wholesale.
const umrPatch = (entity, changes) => ({ [UMR_NAMESPACE]: { ...umrOf(entity), ...changes } });

export class UmrDocument extends DocumentModel {
  constructor({ raw, client = null, projectId = null, project = null, user = null, asOf = null }) {
    super({ raw, client, projectId, project, user, asOf });
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
    });
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
  // triples, plus the constants. Cached per data version.
  get graph() {
    return this._derived('graph', () => {
      const info = this.layerInfo;
      const mapping = resolveIlg(readIlgConfig(this._project), info);
      return buildDocumentGraph(info, { ilg: (s) => ilgLinesFor(s, info, mapping) });
    });
  }

  get sentences() {
    return this.graph.sentences;
  }

  // The document in the .umr file format.
  toUmr() {
    return this._derived('umr', () => serializeUmrFile({ sentences: toUmrSentences(this.graph) }));
  }

  // What the official checks find, over the same sentences the export writes,
  // and the edges the export has to leave out.
  get problems() {
    return this._derived('problems', () => [
      ...validateDocument(toUmrSentences(this.graph)),
      ...crossSentenceEdges(this.graph),
      ...unreachedByRoot(this.graph),
    ]);
  }

  // The same, by sentence index.
  get problemsBySentence() {
    return this._derived('problemsBySentence', () => {
      const map = new Map();
      this.problems.forEach((p) => {
        if (!map.has(p.sentence)) map.set(p.sentence, []);
        map.get(p.sentence).push(p);
      });
      return map;
    });
  }

  _patchContext(next) {
    return [getUmrLayerInfo(next)];
  }

  // ----- reconcile on open -----

  // What another app's edit to the sentences left of an unaligned node
  // (umrReconcile.js): the stray a deleted sentence leaves goes, with its
  // edges and triples, and a node whose sentence was merged away is bound to
  // the one it was merged into. One batch, so the audit entry names one
  // repair. History keeps what was removed.
  async _reconcile() {
    const { remove, rebind, move } = planUnalignedHeal(this.graph, UMR_NAMESPACE);
    if (!remove.length && !rebind.length && !move.length) return { findings: [] };
    try {
      const tokenIds = remove.flatMap((id) => this.node(id).pieces.map((p) => p.id));
      const spans = this._layers(this.layerInfo).spans;
      await this._client.batched(async (b) => {
        if (tokenIds.length) b.tokens.bulkDelete(tokenIds);
        rebind.forEach(({ nodeId, sentenceTokenId }) => {
          const span = spans.find((x) => x.id === nodeId);
          b.spans.patchMetadata(nodeId, umrPatch(span, { sentence: sentenceTokenId }));
        });
        move.forEach(({ pieceId, to }) => b.tokens.update(pieceId, to, to));
      });
      await this._reload();
      return {
        findings: [],
        removed: remove.length,
        rebound: rebind.length,
        moved: move.length,
      };
    } catch (error) {
      return { findings: [], error };
    }
  }

  describeReconcile(result) {
    return describeUmrReconcile(result);
  }

  // ----- reading helpers -----

  node(id) {
    return this.graph.nodesById.get(id) || null;
  }

  sentence(index) {
    return this.graph.sentences[index - 1] || null;
  }

  edge(id) {
    for (const s of this.graph.sentences) {
      const e = s.edges.find((x) => x.id === id);
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
  // of adjacent words, none for no words (a zero-width piece at the
  // sentence's start stands for unaligned).
  piecesFor(sentence, wordIds) {
    const chosen = sentence.words
      .filter((w) => wordIds.includes(w.id))
      .sort((a, b) => a.index - b.index);
    if (!chosen.length) return [{ begin: sentence.begin, end: sentence.begin }];
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

  /**
   * A new node in a sentence: anchored to `wordIds` (none for an abstract
   * concept), under `parentId` with `role` when given. Resolves to
   * `{ nodeId, edgeId }`, or false on failure.
   */
  async createNode({
    sentenceIndex,
    concept,
    wordIds = [],
    parentId = null,
    role = null,
    attrs = [],
  }) {
    const info = this.layerInfo;
    const sentence = this.sentence(sentenceIndex);
    if (!sentence || !concept) return false;
    if (parentId && !role) return false;
    const refused = conceptProblem(concept);
    if (refused) {
      this.setError(refused);
      return false;
    }
    const pieces = this.piecesFor(sentence, wordIds);
    const variable = nextVariable(sentenceIndex, concept, this.takenVariables());
    const parent = parentId ? this.node(parentId) : null;
    const order = parent ? this.nextOrder(parent) : 0;
    // The first node of a sentence is its root. A later parentless node is a
    // fragment until it is connected, and the graph keeps its root.
    const meta = { var: variable, attrs };
    if (!parent && sentence.nodes.length === 0) meta.root = true;
    // An unaligned node records its sentence: its anchor is a point, and a
    // point at a sentence's start outlives the sentence (see _reconcile).
    if (!wordIds.length) meta.sentence = sentence.tokenId;
    const textId = info.textLayer.text.id;
    let result = null;
    const ok = await this._withSaving(
      'Failed to add the node',
      async () => {
        const tokenIds = (
          await this._client.tokens.bulkCreate(
            pieces.map((p) => ({
              tokenLayerId: info.nodeTokenLayer.id,
              text: textId,
              begin: p.begin,
              end: p.end,
            })),
          )
        ).ids;
        const span = await this._client.spans.create(info.conceptLayer.id, tokenIds, concept, {
          [UMR_NAMESPACE]: meta,
        });
        const spanId = span?.id || span;
        let edgeId = null;
        if (parent) {
          const rel = await this._client.relations.create(
            info.relationLayer.id,
            parent.id,
            spanId,
            role,
            { [UMR_NAMESPACE]: { order } },
          );
          edgeId = rel?.id || rel;
        }
        result = { nodeId: spanId, edgeId };
        this._applyRawPatch((next, infoNext) => {
          const L = this._layers(infoNext);
          pieces.forEach((p, i) => L.tokens.push({ id: tokenIds[i], begin: p.begin, end: p.end }));
          L.spans.push({
            id: spanId,
            tokens: tokenIds,
            value: concept,
            metadata: { [UMR_NAMESPACE]: meta },
          });
          if (edgeId) {
            L.relations.push({
              id: edgeId,
              source: parent.id,
              target: spanId,
              value: role,
              metadata: { [UMR_NAMESPACE]: { order } },
            });
          }
        });
      },
      parent ? `Add ${role} ${concept} under ${parent.concept}` : `Add ${concept}`,
    );
    return ok ? result : false;
  }

  async setConcept(nodeId, concept) {
    const node = this.node(nodeId);
    if (!node || !concept || node.concept === concept) return false;
    const refused = conceptProblem(concept);
    if (refused) {
      this.setError(refused);
      return false;
    }
    return this._withSaving(
      'Failed to change the concept',
      async () => {
        this._applyRawPatch((next, infoNext) => {
          const span = this._layers(infoNext).spans.find((s) => s.id === nodeId);
          if (span) span.value = concept;
        });
        await this._client.spans.update(nodeId, concept);
      },
      `Change ${node.var} from ${node.concept} to ${concept}`,
    );
  }

  // `from s1e to s1l2`, for an audit label: the relation's two ends, since a
  // role alone names one of many.
  _ends({ source, target }) {
    return `from ${this.node(source)?.var || source} to ${this.node(target)?.var || target}`;
  }

  /** Why `variable` cannot name the node, or null when it can. */
  variableProblem(nodeId, variable) {
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
    if (this.takenVariables().has(variable)) return `${variable} is already in use.`;
    return null;
  }

  async setVariable(nodeId, variable) {
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
    const node = this.node(nodeId);
    if (!node) return false;
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

  async _patchNodeMeta(nodeId, changes, label) {
    return this._withSaving(
      'Failed to save the node',
      async () => {
        let patch = null;
        this._applyRawPatch((next, infoNext) => {
          const span = this._layers(infoNext).spans.find((s) => s.id === nodeId);
          if (!span) return;
          patch = umrPatch(span, changes);
          span.metadata = { ...(span.metadata || {}), ...patch };
        });
        if (patch) await this._client.spans.patchMetadata(nodeId, patch);
      },
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
    const pieces = this.piecesFor(sentence, wordIds);
    const oldIds = node.pieces.map((p) => p.id);
    const textId = info.textLayer.text.id;
    const words = sentence.words.filter((w) => wordIds.includes(w.id)).map((w) => w.text);
    // The sentence an unaligned node records (see _reconcile), set when it
    // loses its words and dropped when it gains some.
    const span = this._layers(info).spans.find((s) => s.id === nodeId);
    const { sentence: home, ...rest } = umrOf(span);
    const meta = wordIds.length ? rest : { ...rest, sentence: sentence.tokenId };
    // Written only when it changes: dropped when words come, set when they go.
    const recordChanges = wordIds.length ? home !== undefined : home !== sentence.tokenId;
    return this._withSaving(
      'Failed to change the anchor',
      async () => {
        const tokenIds = (
          await this._client.tokens.bulkCreate(
            pieces.map((p) => ({
              tokenLayerId: info.nodeTokenLayer.id,
              text: textId,
              begin: p.begin,
              end: p.end,
            })),
          )
        ).ids;
        await this._client.batched(async (b) => {
          b.spans.setTokens(nodeId, tokenIds);
          if (recordChanges) b.spans.patchMetadata(nodeId, { [UMR_NAMESPACE]: meta });
          b.tokens.bulkDelete(oldIds);
        });
        this._applyRawPatch((next, infoNext) => {
          const L = this._layers(infoNext);
          const old = new Set(oldIds);
          infoNext.nodeTokenLayer.tokens = L.tokens.filter((t) => !old.has(t.id));
          pieces.forEach((p, i) =>
            infoNext.nodeTokenLayer.tokens.push({ id: tokenIds[i], begin: p.begin, end: p.end }),
          );
          const span = L.spans.find((s) => s.id === nodeId);
          if (span) {
            span.tokens = tokenIds;
            if (recordChanges) span.metadata = { ...(span.metadata || {}), [UMR_NAMESPACE]: meta };
          }
        });
      },
      words.length ? `Anchor ${node.var} to ${words.join(' ')}` : `Unanchor ${node.var}`,
    );
  }

  // An edge from one node to another of the same sentence. A second edge into
  // a node is a re-entrancy. Resolves to the edge id, or false.
  async createEdge(sourceId, targetId, role) {
    const info = this.layerInfo;
    const source = this.node(sourceId);
    const target = this.node(targetId);
    if (!source || !target || !role) return false;
    if (source.sentence !== target.sentence) {
      this.setError('An edge joins two nodes of one sentence.');
      return false;
    }
    if (this.wouldCycle(sourceId, targetId, role)) {
      this.setError(`${role} from ${source.var} to ${target.var} would close a cycle.`);
      return false;
    }
    const order = this.nextOrder(source);
    let edgeId = null;
    const ok = await this._withSaving(
      'Failed to add the edge',
      async () => {
        const rel = await this._client.relations.create(
          info.relationLayer.id,
          sourceId,
          targetId,
          role,
          { [UMR_NAMESPACE]: { order } },
        );
        edgeId = rel?.id || rel;
        this._applyRawPatch((next, infoNext) => {
          this._layers(infoNext).relations.push({
            id: edgeId,
            source: sourceId,
            target: targetId,
            value: role,
            metadata: { [UMR_NAMESPACE]: { order } },
          });
        });
      },
      `Add ${role} from ${source.var} to ${target.var}`,
    );
    return ok ? edgeId : false;
  }

  async setRole(edgeId, role) {
    const edge = this.edge(edgeId);
    if (!edge || !role || edge.role === role) return false;
    return this._withSaving(
      'Failed to change the relation',
      async () => {
        this._applyRawPatch((next, infoNext) => {
          const rel = this._layers(infoNext).relations.find((r) => r.id === edgeId);
          if (rel) rel.value = role;
        });
        await this._client.relations.update(edgeId, role);
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
    const at = siblings.findIndex((e) => e.id === edgeId);
    const other = siblings[at + dir];
    if (at < 0 || !other) return false;
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
    return this._withSaving(
      'Failed to reorder the edge',
      async () => {
        const patches = [];
        this._applyRawPatch((next, infoNext) => {
          this._layers(infoNext).relations.forEach((rel) => {
            if (!swapped.has(rel.id)) return;
            const patch = umrPatch(rel, { order: swapped.get(rel.id) });
            rel.metadata = { ...(rel.metadata || {}), ...patch };
            patches.push([rel.id, patch]);
          });
        });
        await this._client.batched(async (b) => {
          patches.forEach(([id, patch]) => b.relations.patchMetadata(id, patch));
        });
      },
      `Move ${edge.role} ${target?.var || ''} ${dir < 0 ? 'earlier' : 'later'} under ${source.var}`,
    );
  }

  // Delete an edge. With `subtree`, the nodes only it kept reachable go too
  // (their anchors are deleted and the server's cascade takes the rest).
  // Resolves to the number of nodes deleted, or false.
  async deleteEdge(edgeId, { subtree = true } = {}) {
    const edge = this.edge(edgeId);
    if (!edge) return false;
    const doomed = subtree ? this.exclusiveDescendants(edgeId) : [];
    const tokenIds = doomed.flatMap((n) => n.pieces.map((p) => p.id));
    const spanIds = doomed.map((n) => n.id);
    const ok = await this._withSaving(
      'Failed to delete the edge',
      async () => {
        await this._client.batched(async (b) => {
          b.relations.delete(edgeId);
          if (tokenIds.length) b.tokens.bulkDelete(tokenIds);
        });
        this._applyRawPatch((next, infoNext) => {
          const L = this._layers(infoNext);
          infoNext.relationLayer.relations = L.relations.filter((r) => r.id !== edgeId);
          if (spanIds.length) this._dropSpans(infoNext, spanIds);
        });
      },
      doomed.length
        ? `Delete ${edge.role} ${this._ends(edge)} and ${doomed.length} node${doomed.length === 1 ? '' : 's'} under it`
        : `Delete ${edge.role} ${this._ends(edge)}`,
    );
    return ok ? doomed.length : false;
  }

  // Re-parent: the edge is deleted and remade from the new source, in one
  // batch, keeping its role.
  async moveEdge(edgeId, newSourceId) {
    const info = this.layerInfo;
    const edge = this.edge(edgeId);
    const source = this.node(newSourceId);
    if (!edge || !source || edge.source === newSourceId) return false;
    const target = this.node(edge.target);
    if (source.sentence !== target.sentence) {
      this.setError('An edge joins two nodes of one sentence.');
      return false;
    }
    if (this.wouldCycle(newSourceId, edge.target, edge.role)) {
      this.setError(`Moving ${edge.role} under ${source.var} would close a cycle.`);
      return false;
    }
    const order = this.nextOrder(source);
    return this._withSaving(
      'Failed to move the edge',
      async () => {
        const results = await this._client.batched(async (b) => {
          b.relations.delete(edgeId);
          b.relations.create(info.relationLayer.id, newSourceId, edge.target, edge.role, {
            [UMR_NAMESPACE]: { order },
          });
        });
        const newId = results.at(-1)?.body?.id;
        this._applyRawPatch((next, infoNext) => {
          const L = this._layers(infoNext);
          infoNext.relationLayer.relations = L.relations.filter((r) => r.id !== edgeId);
          infoNext.relationLayer.relations.push({
            id: newId,
            source: newSourceId,
            target: edge.target,
            value: edge.role,
            metadata: { [UMR_NAMESPACE]: { order } },
          });
        });
      },
      `Move ${edge.role} ${target.var} under ${source.var}`,
    );
  }

  // Delete a node and everything that hangs off it. Its children stay where
  // they are (as fragments) unless `subtree`.
  async deleteNode(nodeId, { subtree = true } = {}) {
    const node = this.node(nodeId);
    if (!node) return false;
    const below = subtree ? this.orphanedBy(nodeId) : [];
    const doomed = [node, ...below];
    const tokenIds = doomed.flatMap((n) => n.pieces.map((p) => p.id));
    const spanIds = doomed.map((n) => n.id);
    return this._withSaving(
      'Failed to delete the node',
      async () => {
        await this._client.tokens.bulkDelete(tokenIds);
        this._applyRawPatch((next, infoNext) => this._dropSpans(infoNext, spanIds));
      },
      below.length ? `Delete ${node.var} and ${below.length} below it` : `Delete ${node.var}`,
    );
  }

  // Make a node its sentence's root: the mark moves from the old roots.
  async setRoot(nodeId) {
    const node = this.node(nodeId);
    const sentence = node ? this.sentence(node.sentence) : null;
    if (!sentence || node.root) return false;
    const old = sentence.nodes.filter((n) => n.root);
    return this._withSaving(
      'Failed to set the root',
      async () => {
        const patches = [];
        this._applyRawPatch((next, infoNext) => {
          const spans = this._layers(infoNext).spans;
          old.forEach((o) => {
            const span = spans.find((s) => s.id === o.id);
            if (!span) return;
            const { root: _root, ...rest } = umrOf(span);
            const patch = { [UMR_NAMESPACE]: rest };
            span.metadata = { ...(span.metadata || {}), ...patch };
            patches.push([o.id, patch]);
          });
          const span = spans.find((s) => s.id === nodeId);
          if (span) {
            const patch = umrPatch(span, { root: true });
            span.metadata = { ...(span.metadata || {}), ...patch };
            patches.push([nodeId, patch]);
          }
        });
        await this._client.batched(async (b) => {
          patches.forEach(([id, patch]) => b.spans.patchMetadata(id, patch));
        });
      },
      `Make ${node.var} the root`,
    );
  }

  // ----- the document graph -----

  // A constant's node (`author`, `root`, `document-creation-time`, ...), or
  // null when no triple has used it yet.
  constantNode(name) {
    return this.graph.constants.find((c) => c.var === name) || null;
  }

  triple(id) {
    const rel = (this.layerInfo.documentGraphLayer?.relations || []).find((r) => r.id === id);
    if (!rel) return null;
    const source = this.node(rel.source);
    const target = this.node(rel.target);
    return source && target
      ? { id, source: rel.source, target: rel.target, rel: rel.value, group: umrOf(rel).group }
      : null;
  }

  // Make a constant's node, the way the importer does: a zero-width token at
  // the text's start and a span marked constant. Inside a running
  // operation; resolves to the span id.
  async _makeConstant(name) {
    const info = this.layerInfo;
    const { ids } = await this._client.tokens.bulkCreate([
      { tokenLayerId: info.nodeTokenLayer.id, text: info.textLayer.text.id, begin: 0, end: 0 },
    ]);
    const span = await this._client.spans.create(info.conceptLayer.id, ids, name, {
      [UMR_NAMESPACE]: { var: name, constant: true },
    });
    const spanId = span?.id || span;
    this._applyRawPatch((next, infoNext) => {
      const L = this._layers(infoNext);
      L.tokens.push({ id: ids[0], begin: 0, end: 0 });
      L.spans.push({
        id: spanId,
        tokens: ids,
        value: name,
        metadata: { [UMR_NAMESPACE]: { var: name, constant: true } },
      });
    });
    return spanId;
  }

  /**
   * A document-level triple: temporal, modal or coreference. Either end is a
   * node id or a constant's name. `sentenceIndex` says whose block writes a
   * triple between two constants. Resolves to the triple's id, or false.
   */
  async createTriple({ source, target, rel, group = null, sentenceIndex = null }) {
    const info = this.layerInfo;
    if (!source || !target || !rel) return false;
    const isConst = (x) => DOC_CONSTANTS.includes(x);
    const nodeOf = (x) => (isConst(x) ? this.constantNode(x) : this.node(x));
    const s = nodeOf(source);
    const t = nodeOf(target);
    if (source === target) return false;
    if (!isConst(source) && !s) return false;
    if (!isConst(target) && !t) return false;
    const g = group || groupOf(rel);
    // Already there, in this direction, or in either for a coreference.
    const same = (x, from, to) => x.rel === rel && x.target === to && x.source === from;
    const there =
      (s && t && s.docOut.some((x) => same(x, s.id, t.id))) ||
      (g === 'coref' && s && t && t.docOut.some((x) => same(x, t.id, s.id)));
    if (there) {
      this.setError(`${s?.var || source} ${rel} ${t?.var || target} is already there.`);
      return false;
    }
    const meta = { group: g };
    // A triple between two constants belongs to no sentence by itself: the
    // one whose block it was made from writes it.
    if (isConst(source) && isConst(target)) meta.sentences = [sentenceIndex ?? 1];
    let tripleId = null;
    const label = `Add ${rel} from ${s?.var || source} to ${t?.var || target}`;
    const ok = await this._withSaving(
      'Failed to add the document-level relation',
      async () => {
        const sourceId = s ? s.id : await this._makeConstant(source);
        const targetId = t ? t.id : await this._makeConstant(target);
        const rel1 = await this._client.relations.create(
          info.documentGraphLayer.id,
          sourceId,
          targetId,
          rel,
          { [UMR_NAMESPACE]: meta },
        );
        tripleId = rel1?.id || rel1;
        this._applyRawPatch((next, infoNext) => {
          this._layers(infoNext).triples.push({
            id: tripleId,
            source: sourceId,
            target: targetId,
            value: rel,
            metadata: { [UMR_NAMESPACE]: meta },
          });
        });
      },
      label,
    );
    return ok ? tripleId : false;
  }

  async setTripleRelation(id, rel) {
    const t = this.triple(id);
    if (!t || !rel || t.rel === rel) return false;
    // The same pair under the same relation, as createTriple refuses it: the
    // node wore the tag twice and the file wrote the triple twice.
    const source = this.node(t.source) || this.constantNode(t.source);
    const twin = (source?.docOut || []).find(
      (x) => x.id !== id && x.rel === rel && x.target === t.target,
    );
    if (twin) {
      const name = (x) => this.node(x)?.var || x;
      this.setError(`${name(t.source)} ${rel} ${name(t.target)} is already there.`);
      return false;
    }
    return this._withSaving(
      'Failed to change the document-level relation',
      async () => {
        this._applyRawPatch((next, infoNext) => {
          const r = this._layers(infoNext).triples.find((x) => x.id === id);
          if (r) r.value = rel;
        });
        await this._client.relations.update(id, rel);
      },
      `Relabel ${t.rel} ${this._ends(t)} as ${rel}`,
    );
  }

  async deleteTriple(id) {
    const t = this.triple(id);
    if (!t) return false;
    return this._withSaving(
      'Failed to delete the document-level relation',
      async () => {
        await this._client.relations.delete(id);
        this._applyRawPatch((next, infoNext) => {
          infoNext.documentGraphLayer.relations = this._layers(infoNext).triples.filter(
            (x) => x.id !== id,
          );
        });
      },
      `Delete ${t.rel} ${this._ends(t)}`,
    );
  }

  // ----- text mode -----

  // The sentence's graph as PENMAN, the text mode's starting point.
  penmanOf(sentenceIndex) {
    const sent = toUmrSentences(this.graph)[sentenceIndex - 1];
    if (sent?.graph) return serializePenman(sent.graph);
    // A graph the import could not read, kept as text: text mode opens on it
    // so it can be mended and applied, where it opened empty.
    return typeof sent?.rawGraph === 'string' ? sent.rawGraph : '';
  }

  /**
   * What applying a PENMAN text to a sentence would change: nodes matched by
   * variable, so a renamed variable is a new node and the old one goes.
   * Returns `{ errors }` when the text does not parse, else the plan.
   */
  planPenman(sentenceIndex, text) {
    const sentence = this.sentence(sentenceIndex);
    if (!sentence) return { errors: [{ message: 'No such sentence.' }] };
    const parsed = parsePenman(text);
    if (parsed.errors.length) return { errors: parsed.errors };
    if (!parsed.root) return { errors: [{ message: 'The text has no graph.' }] };
    const oldByVar = new Map(sentence.nodes.map((n) => [n.var, n]));
    const newVars = new Set(parsed.nodes.keys());
    const plan = {
      create: [],
      delete: [],
      concept: [],
      attrs: [],
      edgesAdd: [],
      edgesDelete: [],
      orders: [],
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
        plan.concept.push({ nodeId: old.id, concept: node.concept });
      // With their places among the children: an attribute moved past an edge
      // is a change, and was once counted as applied without being stored.
      const attrKey = (a) => `${a.rel} ${a.value} @${a.order ?? 0}`;
      const oldAttrs = old.attrs.map(attrKey).join('\n');
      const nextAttrs = attrs.map(attrKey).join('\n');
      if (oldAttrs !== nextAttrs) plan.attrs.push({ nodeId: old.id, attrs });
      // Edges by (role, target variable): an edge with a new target or role
      // is a new edge, and the old one goes.
      const oldEdges = old.out
        .filter((e) => this.node(e.target)?.sentence === sentenceIndex)
        .map((e) => ({ id: e.id, key: `${e.role} ${this.node(e.target).var}`, order: e.order }));
      const nextKeys = new Map(edges.map((e) => [`${e.role} ${e.target}`, e]));
      oldEdges.forEach((e) => {
        if (!nextKeys.has(e.key)) plan.edgesDelete.push(e.id);
        else if (nextKeys.get(e.key).order !== e.order) {
          plan.orders.push({ edgeId: e.id, order: nextKeys.get(e.key).order });
        }
      });
      const oldKeys = new Set(oldEdges.map((e) => e.key));
      edges.forEach((e) => {
        if (!oldKeys.has(`${e.role} ${e.target}`)) {
          plan.edgesAdd.push({ sourceVar: v, role: e.role, targetVar: e.target, order: e.order });
        }
      });
    });
    // The text is the root's graph, so only what the root reaches is the
    // text's to delete: a fragment the text never showed stays.
    const written = new Set();
    const stack = [...sentence.roots.slice(0, 1)];
    while (stack.length) {
      const n = stack.pop();
      if (!n || written.has(n.id)) continue;
      written.add(n.id);
      n.out.forEach((e) => {
        if (this.node(e.target)?.sentence === sentenceIndex) stack.push(this.node(e.target));
      });
    }
    sentence.nodes.forEach((n) => {
      if (written.has(n.id) && !newVars.has(n.var)) plan.delete.push(n.id);
    });
    // An edge into or out of a deleted node goes with it (the server's
    // cascade), and a second delete would be a 404.
    const gone = new Set(plan.delete);
    plan.edgesDelete = plan.edgesDelete.filter((id) => {
      const e = this.edge(id);
      return e && !gone.has(e.source) && !gone.has(e.target);
    });
    const oldRoot = sentence.roots[0]?.var;
    if (parsed.root !== oldRoot) plan.root = parsed.root;

    // What the canvas refuses, text mode refuses too: a new node's variable
    // malformed or taken elsewhere in the document, a concept, relation or
    // value the file cannot hold, and a new edge closing a cycle through
    // anything but a quote.
    const errors = [];
    plan.create.forEach((c) => {
      const why = this._newVariableProblem(c.var, sentenceIndex);
      if (why) errors.push({ message: why });
    });
    parsed.nodes.forEach((node, v) => {
      const why = conceptProblem(node.concept);
      if (why) errors.push({ message: `${v}: ${why}` });
      node.children.forEach((child) => {
        const bad =
          relationProblem(child.rel) ||
          (child.kind === 'node' ? null : attrValueProblem(child.value));
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
      plan.concept.length +
      plan.attrs.length +
      plan.edgesAdd.length +
      plan.edgesDelete.length +
      plan.orders.length +
      (plan.root ? 1 : 0);
    return { ...plan, changes };
  }

  /**
   * Apply a PENMAN text to a sentence as ONE operation: the plan's writes in
   * dependency order, then a reload, since a dozen ids come back along the
   * way. A new node is unaligned until anchored on the canvas. Resolves to
   * the number of changes, or false.
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
    const textId = info.textLayer.text.id;
    const client = this._client;
    return this._withSaving(
      'Failed to apply the text',
      async () => {
        const idByVar = new Map(sentence.nodes.map((n) => [n.var, n.id]));
        // Each span's umr namespace as written so far. A patch replaces the
        // namespace whole, so one built from the state read before any write
        // put back what an earlier patch took off: the old root's attribute
        // change restored its root mark, and the new root's mark reverted its
        // attributes.
        const written = new Map();
        const patchUmr = async (spanId, changes) => {
          const span = this._layers(info).spans.find((x) => x.id === spanId);
          const next = { ...(written.get(spanId) ?? umrOf(span)), ...changes };
          Object.keys(next).forEach((k) => next[k] === undefined && delete next[k]);
          written.set(spanId, next);
          await client.spans.patchMetadata(spanId, { [UMR_NAMESPACE]: next });
        };
        const gone = new Set(plan.delete);
        // Deletes first, so a variable given to a new node is free.
        if (plan.delete.length) {
          const tokenIds = plan.delete.flatMap((id) => this.node(id).pieces.map((p) => p.id));
          await client.tokens.bulkDelete(tokenIds);
          plan.delete.forEach((id) => {
            const n = this.node(id);
            if (n) idByVar.delete(n.var);
          });
        }
        for (const edgeId of plan.edgesDelete) await client.relations.delete(edgeId);
        // The root moves: the old marks come off first, so no two nodes wear
        // one, whether the new root is made below or was there already.
        if (plan.root) {
          const olds = sentence.nodes.filter(
            (n) => n.root && n.var !== plan.root && !gone.has(n.id),
          );
          for (const o of olds) await patchUmr(o.id, { root: undefined });
        }
        // A sentence the import kept as text keeps its alignment block too.
        // Mending the graph here is the first time anything can be anchored
        // to it, and the block is written no longer once the sentence has
        // nodes, so its words would be lost with it.
        const kept = sentence.nodes.length ? null : sentence.rawAlignment;
        const keptWords = kept ? readAlignment(kept) : null;
        const anchorFor = (v) => {
          const ranges = keptWords?.get(v) || [];
          const pieces = [];
          ranges.forEach(([a, b]) => {
            const first = sentence.words[a - 1];
            const last = sentence.words[b - 1];
            if (first && last && a <= b) pieces.push({ begin: first.begin, end: last.end });
          });
          return pieces.length ? pieces : [{ begin: sentence.begin, end: sentence.begin }];
        };
        for (const c of plan.create) {
          const { ids } = await client.tokens.bulkCreate(
            anchorFor(c.var).map((piece) => ({
              tokenLayerId: info.nodeTokenLayer.id,
              text: textId,
              begin: piece.begin,
              end: piece.end,
            })),
          );
          // Unaligned, like every node text mode makes unless the file it is
          // mending said which words it covers: it records its sentence (see
          // _reconcile).
          const meta = { var: c.var, attrs: c.attrs, sentence: sentence.tokenId };
          if (plan.root === c.var) meta.root = true;
          const span = await client.spans.create(info.conceptLayer.id, ids, c.concept, {
            [UMR_NAMESPACE]: meta,
          });
          idByVar.set(c.var, span?.id || span);
        }
        for (const c of plan.concept) await client.spans.update(c.nodeId, c.concept);
        for (const a of plan.attrs) await patchUmr(a.nodeId, { attrs: a.attrs });
        const edgesAdd = [
          ...plan.edgesAdd,
          ...plan.create.flatMap((c) =>
            c.edges.map((e) => ({
              sourceVar: c.var,
              role: e.role,
              targetVar: e.target,
              order: e.order,
            })),
          ),
        ];
        for (const e of edgesAdd) {
          const source = idByVar.get(e.sourceVar);
          const target = idByVar.get(e.targetVar);
          if (!source || !target) {
            console.warn('applyPenman: an edge lost its end', e);
            continue;
          }
          await client.relations.create(info.relationLayer.id, source, target, e.role, {
            [UMR_NAMESPACE]: { order: e.order },
          });
        }
        for (const o of plan.orders) {
          await client.relations.patchMetadata(o.edgeId, { [UMR_NAMESPACE]: { order: o.order } });
        }
        if (plan.root && !plan.create.some((c) => c.var === plan.root)) {
          const newId = idByVar.get(plan.root);
          if (newId) await patchUmr(newId, { root: true });
        }
        await this._reload();
      },
      `Apply text to sentence ${sentenceIndex} (${plan.changes} change${plan.changes === 1 ? '' : 's'})`,
    ).then((ok) => (ok ? plan.changes : false));
  }
}
