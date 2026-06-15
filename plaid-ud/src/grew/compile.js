// Compile a Grew request AST (see parser.js / ast.js) into ONE Plaid query
// object suitable for `client.query()`. Pure compile-to-QL: anything that can't
// be expressed is rejected with a GrewUnsupportedError naming the feature.
//
// Data-model mapping (UD project layers, from getUdLayerInfo):
//   node  X            -> a token ?n_X on the morpheme/syntactic-word layer
//   upos/xpos/lemma    -> one span each, covering the token, on its span layer
//   FEATS Key=Value    -> one span per feature on the FEATS layer (value "Key=Value")
//   form               -> the morpheme token's surface `value`
//   edge X-[r]->Y      -> a relation on the (lemma-hosted) deprel layer, with
//                         source = X's lemma span, target = Y's lemma span
//   sentence           -> a token ?S on the Sentences layer; every node is
//                         `within ?S`, scoping the whole pattern to one sentence
//
// See docs/query.adoc for the QL clause set and its limits (no predicate clauses
// inside `not`; or/seq expansion <=128 branches; nesting <=64).

import { GrewUnsupportedError } from './errors.js';
import {
  escapeRegex, normalizeFlags, featDefinedRegex, featNeqRegex, featEqValue,
  negatedLabelRegex, subtypeRegex, notExactlyRegex, featuresLabelRegex,
} from './regex.js';

const COLUMN_FEATS = { upos: 'uposLayer', xpos: 'xposLayer', lemma: 'lemmaLayer' };
const MAX_LINEAR_DISTANCE = 50;
const MAX_BRANCHES = 128;
const MAX_DEPTH = 64;

export function compileGrew(ast, layerInfo, opts = {}) {
  const c = new Compiler(layerInfo, opts);
  return c.compile(ast);
}

class Compiler {
  constructor(layerInfo, opts) {
    this.li = layerInfo || {};
    this.opts = opts;
    this.where = [];
    this.find = ['?S'];
    this.warnings = [];
    this.impossible = false;
    this.nFresh = 0;
    this.branches = 1;
    this.boundTop = new Set();   // node ids bound at top level
    this.topLemma = new Map();   // node id -> top-level lemma span var
    this.edgesById = new Map();  // named edge id -> {srcId, tgtId}
    this.topNodeIds = new Set(); // ids that appear in pattern/with
  }

  fresh(p = 'g') { return `?${p}${++this.nFresh}`; }

  layerId(key, feature) {
    const layer = this.li[key];
    if (!layer || !layer.id) {
      throw new GrewUnsupportedError(
        `layer:${feature || key}`,
        `This project has no ${feature || key} layer, so that constraint can't be matched here.`,
      );
    }
    return layer.id;
  }

  compile(ast) {
    const SENT = this.layerId('sentenceTokenLayer', 'Sentences');
    this.where.push(['token', '?S', { layer: SENT }]);

    // First pass: discover top-level nodes and named edges across pattern/with.
    for (const block of ast.blocks) {
      if (block.type === 'pattern' || block.type === 'with') {
        for (const item of block.items) this.discover(item);
      }
    }
    // Bind every top-level node token up front (so find vars are bound, and
    // local scopes can reference them as outer variables).
    for (const id of this.topNodeIds) {
      this.bindTopNode(id);
    }

    // Second pass: compile clauses block by block.
    for (const block of ast.blocks) {
      if (block.type === 'pattern' || block.type === 'with') {
        for (const item of block.items) this.emitClause(item, this.topCtx());
      } else if (block.type === 'without') {
        const sub = [];
        const ctx = this.notCtx(sub, 1);
        for (const item of block.items) this.emitClause(item, ctx);
        if (sub.length) this.where.push(['not', ...sub]);
      } else if (block.type === 'global') {
        for (const item of block.items) this.emitGlobal(item);
      }
    }

    // Injective matching: distinct named non-`$` nodes map to distinct tokens.
    const nonInj = new Set(ast.nonInjective || []);
    const injIds = [...this.topNodeIds].filter(id => !nonInj.has(id)).sort();
    for (let i = 0; i < injIds.length; i++) {
      for (let j = i + 1; j < injIds.length; j++) {
        this.where.push(['!=', `?n_${injIds[i]}`, `?n_${injIds[j]}`]);
      }
    }

    if (this.branches > MAX_BRANCHES) {
      throw new GrewUnsupportedError('branch-explosion',
        `This query expands to too many alternatives (${this.branches} > ${MAX_BRANCHES}). ` +
        `Prefer value lists (a|b) over disjoint feature structures, or split the query.`);
    }

    const query = {
      find: this.find,
      where: this.where,
      return: 'entities',
      orderBy: [['?S', 'doc'], ['?S', 'begin']],
      limit: this.opts.limit || 200,
    };
    if (this.opts.projectId) query.scope = { projectIds: [this.opts.projectId] };
    return { query, warnings: this.warnings, impossible: this.impossible };
  }

  topCtx() { return { scope: 'top', list: this.where, inNot: false, depth: 0, localBound: new Set(), localLemma: new Map() }; }
  notCtx(list, depth) { return { scope: 'local', list, inNot: true, depth, localBound: new Set(), localLemma: new Map() }; }

  // --- discovery pass ---

  discover(item) {
    const addNode = (id) => { if (id) this.topNodeIds.add(id); };
    switch (item.kind) {
      case 'node': addNode(item.id); break;
      case 'nodefeat': addNode(item.node); break;
      case 'featcmp': addNode(item.left.node); addNode(item.right.node); break;
      case 'order': addNode(item.left); addNode(item.right); break;
      case 'dist': addNode(item.a); addNode(item.b); break;
      case 'dominates':
        if (!item.left.wild) addNode(item.left.id);
        if (!item.right.wild) addNode(item.right.id);
        break;
      case 'edge':
        if (!item.src.wild) addNode(item.src.id);
        if (!item.tgt.wild) addNode(item.tgt.id);
        if (item.id) this.edgesById.set(item.id, { srcId: item.src.wild ? null : item.src.id, tgtId: item.tgt.wild ? null : item.tgt.id });
        break;
      case 'cross': break; // operands are edge ids; endpoints discovered via their edges
      default: break;
    }
  }

  bindTopNode(id) {
    if (this.boundTop.has(id)) return;
    this.boundTop.add(id);
    const MORPH = this.layerId('morphemeTokenLayer', 'word');
    this.where.push(['token', `?n_${id}`, { layer: MORPH }]);
    this.where.push(['within', `?n_${id}`, '?S']);
    this.find.push(`?n_${id}`);
    // Node feature structures are applied in the second pass (emitClause), so
    // multiple declarations of the same node compose rather than overwrite.
  }

  // --- ensure a node token / lemma span is bound in a given scope ---

  nodeTok(id, ctx) {
    if (this.boundTop.has(id)) return `?n_${id}`;
    if (!ctx.localBound.has(id)) {
      const MORPH = this.layerId('morphemeTokenLayer', 'word');
      ctx.list.push(['token', `?n_${id}`, { layer: MORPH }]);
      ctx.list.push(['within', `?n_${id}`, '?S']);
      ctx.localBound.add(id);
    }
    return `?n_${id}`;
  }

  lemmaSpan(id, ctx) {
    const LEMMA = this.layerId('lemmaLayer', 'Lemma');
    if (this.topLemma.has(id)) return this.topLemma.get(id);
    if (ctx.scope === 'top') {
      const v = `?lem_${id}`;
      this.where.push(['span', v, { layer: LEMMA }]);
      this.where.push(['covers', v, this.nodeTok(id, ctx)]);
      this.topLemma.set(id, v);
      return v;
    }
    if (ctx.localLemma.has(id)) return ctx.localLemma.get(id);
    const v = this.fresh('lem');
    ctx.list.push(['span', v, { layer: LEMMA }]);
    ctx.list.push(['covers', v, this.nodeTok(id, ctx)]);
    ctx.localLemma.set(id, v);
    return v;
  }

  // --- clause emitters ---

  emitClause(item, ctx) {
    switch (item.kind) {
      case 'node':
        this.nodeTok(item.id, ctx); // ensure bound (no-op for an already-bound top node)
        this.emitNodeFeatures(item, ctx);
        break;
      case 'nodefeat': this.emitNodeFeat(item.node, { name: item.feat, op: item.op, value: item.value }, ctx); break;
      case 'featcmp': this.emitFeatCmp(item, ctx); break;
      case 'edge': this.emitEdge(item, ctx); break;
      case 'dominates': this.emitDominates(item, ctx); break;
      case 'order': this.emitOrder(item, ctx); break;
      case 'dist': this.emitDist(item, ctx); break;
      case 'cross': this.emitCross(item, ctx); break;
      default: throw new GrewUnsupportedError(item.kind, `Unsupported clause: ${item.kind}`);
    }
  }

  emitNodeFeatures(node, ctx) {
    const tv = this.nodeTok(node.id, ctx);
    if (node.alts.length === 1) {
      for (const fi of node.alts[0]) this.emitFeatItem(tv, node.id, fi, ctx);
      return;
    }
    // Disjunction of feature structures -> `or` with the token re-bound per group.
    this.branches *= node.alts.length;
    const MORPH = this.layerId('morphemeTokenLayer', 'word');
    const groups = node.alts.map(alt => {
      const sub = [];
      const gctx = { ...ctx, list: sub, depth: ctx.depth + 1, localBound: new Set([node.id]), localLemma: new Map() };
      this.checkDepth(gctx.depth);
      sub.push(['token', tv, { layer: MORPH }]);
      for (const fi of alt) this.emitFeatItem(tv, node.id, fi, gctx);
      return sub;
    });
    ctx.list.push(['or', ...groups]);
  }

  emitFeatItem(tv, nodeId, fi, ctx) {
    this.emitNodeFeat(nodeId, fi, ctx, tv);
  }

  emitNodeFeat(nodeId, fi, ctx, tvIn) {
    const tv = tvIn || this.nodeTok(nodeId, ctx);
    const name = fi.name;
    const lower = name.toLowerCase();

    if (lower === 'form') return this.emitFormFeat(tv, fi, ctx);

    if (COLUMN_FEATS[lower]) {
      const layer = this.layerId(COLUMN_FEATS[lower], lower);
      const av = this.fresh('s');
      if (fi.op === 'undefined') {
        ctx.list.push(['not', ['span', av, { layer }], ['covers', av, tv]]);
        return;
      }
      const cm = { layer };
      if (fi.op === '=') { const vc = this.valueConstraint(fi.value, ctx); if (vc !== undefined) cm.value = vc; }
      else if (fi.op === '<>') cm.value = { regex: notExactlyRegex(this.litValue(fi.value)) };
      // op 'defined' (and `=*`) -> just require the span to exist (no value)
      ctx.list.push(['span', av, cm]);
      ctx.list.push(['covers', av, tv]);
      return;
    }

    // FEATS feature (Key=Value spans on the features layer).
    const FEATS = this.layerId('featuresLayer', 'Features');
    const av = this.fresh('f');
    if (fi.op === 'undefined') {
      ctx.list.push(['not', ['span', av, { layer: FEATS, value: { regex: featDefinedRegex(name) } }], ['covers', av, tv]]);
      return;
    }
    let value;
    if (fi.op === 'defined') value = { regex: featDefinedRegex(name) };
    else if (fi.op === '<>') value = { regex: featNeqRegex(name, this.litValue(fi.value)) };
    else value = this.featValueConstraint(name, fi.value);
    ctx.list.push(['span', av, { layer: FEATS, value }]);
    ctx.list.push(['covers', av, tv]);
  }

  emitFormFeat(tv, fi, ctx) {
    if (fi.op === 'defined') return; // every token has a surface value
    if (fi.op === 'undefined') {
      throw new GrewUnsupportedError('!form', 'Matching tokens with no surface form is not supported.');
    }
    if (fi.op === '<>') {
      this.warnFormMwt();
      ctx.list.push(['token', tv, { value: { regex: notExactlyRegex(this.litValue(fi.value)) } }]);
      return;
    }
    this.warnFormMwt();
    ctx.list.push(['token', tv, { value: this.valueConstraint(fi.value, ctx) }]);
  }

  warnFormMwt() {
    if (this._formWarned) return;
    this._formWarned = true;
    this.warnings.push('`form` matches the token\'s text slice; for multiword tokens the surface form may differ.');
  }

  emitFeatCmp(item, ctx) {
    // X.lemma = Y.lemma  /  X.upos <> Y.upos  — shared/compared value variables.
    const { left, op, right } = item;
    const lLayer = this.featLayerForCmp(left.feat);
    const rLayer = this.featLayerForCmp(right.feat);
    if (op === '=') {
      const vv = this.fresh('v');
      this.bindFeatValueVar(left, lLayer, vv, ctx);
      this.bindFeatValueVar(right, rLayer, vv, ctx);
    } else {
      if (ctx.inNot) {
        throw new GrewUnsupportedError('featcmp-neq-in-without',
          'A feature inequality (X.f <> Y.f) cannot appear inside a `without` block.');
      }
      const v1 = this.fresh('v'), v2 = this.fresh('v');
      this.bindFeatValueVar(left, lLayer, v1, ctx);
      this.bindFeatValueVar(right, rLayer, v2, ctx);
      ctx.list.push(['!=', v1, v2]);
    }
  }

  featLayerForCmp(feat) {
    const lower = feat.toLowerCase();
    if (lower === 'form') {
      throw new GrewUnsupportedError('form-cmp', 'Comparing `form` across nodes is not supported; compare `lemma` instead.');
    }
    if (COLUMN_FEATS[lower]) return { kind: 'column', layer: this.layerId(COLUMN_FEATS[lower], lower) };
    return { kind: 'feats', name: feat, layer: this.layerId('featuresLayer', 'Features') };
  }

  bindFeatValueVar(side, layerSpec, vv, ctx) {
    const tv = this.nodeTok(side.node, ctx);
    const av = this.fresh('s');
    if (layerSpec.kind === 'column') {
      ctx.list.push(['span', av, { layer: layerSpec.layer, value: { var: vv } }]);
    } else {
      // value var binds the whole "Key=Value"; require it be this feature's key.
      // The `~` is a predicate, which is illegal inside a `without`/`not`.
      if (ctx.inNot) {
        throw new GrewUnsupportedError('feats-cmp-in-without',
          'Comparing FEATS values across nodes is not supported inside a `without` block.');
      }
      ctx.list.push(['span', av, { layer: layerSpec.layer, value: { var: vv } }]);
      ctx.list.push(['~', `${av}.value`, featDefinedRegex(layerSpec.name)]);
    }
    ctx.list.push(['covers', av, tv]);
  }

  emitEdge(item, ctx) {
    const REL = this.layerId('relationLayer', 'Dependency');
    const rv = item.id ? `?e_${item.id}` : this.fresh('r');
    // A named edge is returnable only when bound at top level (a find variable
    // can't live inside a `without`/`not`).
    if (item.id && ctx.scope === 'top' && !this.find.includes(rv)) this.find.push(rv);
    const cm = { layer: REL };
    const v = this.edgeValueConstraint(item.label, ctx);
    if (v !== undefined) cm.value = v;
    if (!item.src.wild) cm.source = this.lemmaSpan(item.src.id, ctx);
    if (!item.tgt.wild) cm.target = this.lemmaSpan(item.tgt.id, ctx);
    ctx.list.push(['relation', rv, cm]);
  }

  emitDominates(item, ctx) {
    if (item.left.wild || item.right.wild) {
      throw new GrewUnsupportedError('dominates-wildcard', 'Transitive dominance (->>) requires named endpoints.');
    }
    const REL = this.layerId('relationLayer', 'Dependency');
    const a = this.lemmaSpan(item.left.id, ctx);
    const b = this.lemmaSpan(item.right.id, ctx);
    const m = { layer: REL };
    if (item.label && item.label.type !== 'any') {
      if (item.label.type === 'list' && !item.label.negated) {
        m.value = item.label.labels.length === 1 ? item.label.labels[0] : item.label.labels;
      } else {
        throw new GrewUnsupportedError('dominates-label',
          'A transitive edge (->>) may only carry a plain label or label list, not a regex/negation/subtype.');
      }
    }
    ctx.list.push(['related*', a, b, m]);
  }

  emitOrder(item, ctx) {
    const a = this.nodeTok(item.left, ctx);
    const b = this.nodeTok(item.right, ctx);
    ctx.list.push([item.op === '<<' ? 'precedes*' : 'precedes', a, b]);
  }

  emitDist(item, ctx) {
    const a = this.nodeTok(item.a, ctx);
    const b = this.nodeTok(item.b, ctx);
    const { fn, op, n } = item;
    if (fn === 'delta') return this.emitDelta(a, b, op, n, ctx);
    return this.emitLength(a, b, op, n, ctx);
  }

  // delta(a,b) = posB - posA. Positive chains via immediate `precedes`.
  emitDelta(a, b, op, k, ctx) {
    const chainAtLeast = (list, from, to, m) => {
      // posTo - posFrom >= m, for m >= 1
      let prev = from;
      for (let i = 1; i <= m - 1; i++) { prev = this.chainStep(list, prev); }
      list.push(['precedes*', prev, to]);
    };
    const chainExactPos = (list, from, to, m) => {
      // posTo - posFrom == m, for m >= 1
      let prev = from;
      for (let i = 1; i <= m - 1; i++) { prev = this.chainStep(list, prev); }
      list.push(['precedes', prev, to]);
    };
    const notBlock = (build) => { const sub = []; build(sub); this.checkDepth(ctx.depth + 1); ctx.list.push(['not', ...sub]); };

    this.checkDistBound(k);
    if (op === '=') {
      if (k === 0) { this.impossible = true; return; }
      if (k > 0) chainExactPos(ctx.list, a, b, k); else chainExactPos(ctx.list, b, a, -k);
      return;
    }
    // comparisons supported for k >= 0
    if (k < 0) throw new GrewUnsupportedError('delta-negative-threshold',
      `delta(X,Y) ${op} ${k} with a negative threshold is not supported; use an exact delta or a non-negative threshold.`);
    if (op === '>') { if (k === 0) ctx.list.push(['precedes*', a, b]); else chainAtLeast(ctx.list, a, b, k + 1); return; }
    if (op === '>=') { if (k === 0) ctx.list.push(['precedes*', a, b]); else chainAtLeast(ctx.list, a, b, k); return; }
    if (op === '<') { notBlock(sub => chainAtLeast(sub, a, b, k)); return; }
    if (op === '<=') { notBlock(sub => chainAtLeast(sub, a, b, k + 1)); return; }
  }

  emitLength(a, b, op, k, ctx) {
    this.checkDistBound(k);
    if (k < 0) throw new GrewUnsupportedError('length-negative', 'length(X,Y) requires a non-negative number.');
    // length = |delta|. Express via delta in both directions.
    if (op === '=') {
      this.branches *= 2;
      const g1 = []; this.emitDelta(a, b, '=', k, { ...ctx, list: g1 });
      const g2 = []; this.emitDelta(a, b, '=', -k, { ...ctx, list: g2 });
      ctx.list.push(['or', g1, g2]);
      return;
    }
    if (op === '>' || op === '>=') {
      this.branches *= 2;
      const g1 = []; this.emitDelta(a, b, op, k, { ...ctx, list: g1 });
      const g2 = []; this.emitDelta(b, a, op, k, { ...ctx, list: g2 });
      ctx.list.push(['or', g1, g2]);
      return;
    }
    // length < k  /  length <= k  ==  -k (<|<=) delta (<|<=) k  ==  NOT(length >|>= ...)
    const strictOp = op === '<' ? '>=' : '>';
    const sub = [];
    this.emitLength(a, b, strictOp, k, { ...ctx, list: sub, depth: ctx.depth + 1, inNot: true });
    this.checkDepth(ctx.depth + 1);
    ctx.list.push(['not', ...sub]);
  }

  chainStep(list, prev) {
    const MORPH = this.layerId('morphemeTokenLayer', 'word');
    const cur = this.fresh('t');
    list.push(['token', cur, { layer: MORPH }]);
    list.push(['precedes', prev, cur]);
    return cur;
  }

  checkDistBound(k) {
    if (Math.abs(k) > MAX_LINEAR_DISTANCE) {
      throw new GrewUnsupportedError('distance-too-large',
        `delta/length distances above ${MAX_LINEAR_DISTANCE} are not supported.`);
    }
  }

  emitCross(item, ctx) {
    const e1 = this.edgesById.get(item.left);
    const e2 = this.edgesById.get(item.right);
    if (!e1 || !e2) throw new GrewUnsupportedError('cross-unknown-edge',
      `Edge crossing (><) needs two named edges declared in the pattern.`);
    if (!e1.srcId || !e1.tgtId || !e2.srcId || !e2.tgtId) {
      throw new GrewUnsupportedError('cross-wildcard', 'Edge crossing (><) requires both edges to have named endpoints.');
    }
    const ts = (id) => this.nodeTok(id, ctx);
    const groups = this.interleavings(ts(e1.srcId), ts(e1.tgtId), ts(e2.srcId), ts(e2.tgtId));
    this.branches *= groups.length;
    ctx.list.push(['or', ...groups]);
  }

  // The orderings in which arcs {a1,a2} and {b1,b2} interleave (cross). Each
  // group is a strict-precedence chain over the four endpoint tokens.
  interleavings(a1, a2, b1, b2) {
    const chain = (w, x, y, z) => [['precedes*', w, x], ['precedes*', x, y], ['precedes*', y, z]];
    // a-endpoint before/after, b likewise; crossing = alternating a,b,a,b.
    return [
      chain(a1, b1, a2, b2), chain(a1, b2, a2, b1),
      chain(a2, b1, a1, b2), chain(a2, b2, a1, b1),
      chain(b1, a1, b2, a2), chain(b1, a2, b2, a1),
      chain(b2, a1, b1, a2), chain(b2, a2, b1, a1),
    ];
  }

  // --- global block ---

  emitGlobal(item) {
    if (item.kind === 'globalflag') return this.emitGlobalFlag(item);
    return this.emitGlobalMeta(item);
  }

  emitGlobalFlag(item) {
    const name = item.name;
    // Tree/forest/acyclicity: constant-folded against the UD tree invariant
    // (one head per word, root self-loop, acyclic by construction).
    const TRUE = new Set(['is_tree', 'is_forest', 'is_not_cyclic']);
    const FALSE = new Set(['is_not_tree', 'is_not_forest', 'is_cyclic']);
    if (TRUE.has(name)) { this.warnTreeInvariant(); return; }
    if (FALSE.has(name)) { this.warnTreeInvariant(); this.impossible = true; return; }
    if (name === 'is_projective' || name === 'is_not_projective') {
      // Pin the arcs to the sentence's document: a crossing is sentence-internal,
      // so this changes no results but lets the engine use idx_relations_layer_doc
      // instead of scanning every relation for each candidate sentence.
      this.sdocVar = this.fresh('sdoc');
      this.where.push(['token', '?S', { doc: { var: this.sdocVar } }]);
      // non-projective(S) = two arcs cross OR an arc covers the root word.
      const nonProj = ['or', this.crossingGroup(), this.rootCoverGroup()];
      this.branches *= 10;
      this.checkDepth(3);
      if (name === 'is_projective') this.where.push(['not', nonProj]);
      else this.where.push(nonProj);
      return;
    }
    throw new GrewUnsupportedError(name, `Unsupported global constraint: ${name}`);
  }

  warnTreeInvariant() {
    if (this._treeWarned) return;
    this._treeWarned = true;
    this.warnings.push('Tree/cyclicity globals assume well-formed UD trees (one head per word, acyclic); partially-annotated sentences may not satisfy that assumption.');
  }

  // Projectivity test, in two non-recursive halves (both pure precedence over
  // endpoint tokens — no recursive `related*`, so both are fast AND legal inside
  // `not`). For a dependency tree, non-projective ⟺ two arcs cross OR an arc
  // covers the root word; either half alone misses cases the other catches.

  // "Two dependency arcs in ?S cross" — their four endpoint tokens interleave.
  crossingGroup() {
    const REL = this.layerId('relationLayer', 'Dependency');
    const doc = { var: this.sdocVar };
    const e1 = this.fresh('pe'), e2 = this.fresh('pe');
    const h1 = this.fresh('ph'), d1 = this.fresh('pd'), h2 = this.fresh('ph'), d2 = this.fresh('pd');
    const h1t = this.fresh('pt'), d1t = this.fresh('pt'), h2t = this.fresh('pt'), d2t = this.fresh('pt');
    return [
      ['relation', e1, { layer: REL, doc, source: h1, target: d1 }],
      ['relation', e2, { layer: REL, doc, source: h2, target: d2 }],
      ['covers', h1, h1t], ['covers', d1, d1t], ['covers', h2, h2t], ['covers', d2, d2t],
      ['within', h1t, '?S'], ['within', d1t, '?S'], ['within', h2t, '?S'], ['within', d2t, '?S'],
      ['or', ...this.interleavings(h1t, d1t, h2t, d2t)],
    ];
  }

  // "A dependency arc covers the root word of ?S" — the root word (dependent of
  // the `root`-labelled relation) sits strictly between some arc's endpoints.
  rootCoverGroup() {
    const REL = this.layerId('relationLayer', 'Dependency');
    const doc = { var: this.sdocVar };
    const rr = this.fresh('prr'), rl = this.fresh('prl'), rt = this.fresh('prt');
    const e = this.fresh('pe'), h = this.fresh('ph'), d = this.fresh('pd'), ht = this.fresh('pt'), dt = this.fresh('pt');
    return [
      ['relation', rr, { layer: REL, doc, value: 'root', target: rl }],
      ['covers', rl, rt], ['within', rt, '?S'],
      ['relation', e, { layer: REL, doc, source: h, target: d }],
      ['covers', h, ht], ['covers', d, dt], ['within', ht, '?S'], ['within', dt, '?S'],
      ['or',
        [['precedes*', ht, rt], ['precedes*', rt, dt]],
        [['precedes*', dt, rt], ['precedes*', rt, ht]]],
    ];
  }

  emitGlobalMeta(item) {
    const { key, op, value } = item;
    const lower = key.toLowerCase();
    if (lower === 'text') {
      if (op === 'undefined') throw new GrewUnsupportedError('!text', 'Matching sentences without text is not supported.');
      const cm = op === '<>'
        ? { value: { regex: notExactlyRegex(this.litValue(value)) } }
        : { value: this.valueConstraint(value, this.topCtx()) };
      this.where.push(['token', '?S', cm]);
      return;
    }
    if (lower === 'sent_id') {
      this.warnings.push('`sent_id` is not stored on import, so this constraint will not match imported data.');
    }
    if (op === 'undefined') {
      throw new GrewUnsupportedError('global-meta-undefined', `Matching the absence of metadata (${key}) is not supported.`);
    }
    const inner = op === '<>'
      ? { regex: notExactlyRegex(this.litValue(value)) }
      : this.valueConstraint(value, this.topCtx());
    this.where.push(['token', '?S', { metadata: { [key]: inner } }]);
  }

  // --- value/label constraint builders ---

  valueConstraint(v, ctx) {
    if (!v) return undefined;
    if (v.type === 'lit') return v.value;
    if (v.type === 'any') return undefined; // 'defined' handled by caller
    if (v.type === 'regex') return this.regexConstraint(v);
    if (v.type === 'disj') {
      if (v.items.every(it => it.type === 'lit')) return v.items.map(it => it.value);
      throw new GrewUnsupportedError('regex-disjunction',
        'A disjunction mixing regexes is not supported; use separate clauses or a single regex.');
    }
    return undefined;
  }

  featValueConstraint(name, v) {
    if (v.type === 'lit') return featEqValue(name, v.value);
    if (v.type === 'disj' && v.items.every(it => it.type === 'lit')) return v.items.map(it => featEqValue(name, it.value));
    if (v.type === 'regex') {
      const r = this.regexConstraint(v);
      return { regex: `${featDefinedRegex(name)}(?:${r.regex})`, flags: r.flags };
    }
    if (v.type === 'any') return { regex: featDefinedRegex(name) };
    throw new GrewUnsupportedError('feature-value', `Unsupported feature value for ${name}.`);
  }

  regexConstraint(v) {
    const flags = normalizeFlags(v.flags);
    const c = { regex: v.pattern };
    if (flags) c.flags = flags;
    return c;
  }

  litValue(v) {
    if (v && v.type === 'lit') return v.value;
    if (v && v.type === 'regex') {
      throw new GrewUnsupportedError('regex-inequality', 'A "<>" (not-equal) constraint must compare against a literal, not a regex.');
    }
    throw new GrewUnsupportedError('value', 'Expected a literal value.');
  }

  edgeValueConstraint(label, ctx) {
    if (!label || label.type === 'any') return undefined;
    if (label.type === 'list') {
      if (label.negated) return { regex: negatedLabelRegex(label.labels) };
      return label.labels.length === 1 ? label.labels[0] : label.labels;
    }
    if (label.type === 'regex') return this.regexConstraint(label);
    if (label.type === 'features') {
      if (!label.feats.every(f => /^[0-9]+$/.test(f.key) && !f.neg)) {
        throw new GrewUnsupportedError('edge-feature', 'Only positive numbered edge features (1=, 2=, …) are supported.');
      }
      return { regex: featuresLabelRegex(label.feats) };
    }
    return undefined;
  }

  checkDepth(depth) {
    if (depth > MAX_DEPTH) {
      throw new GrewUnsupportedError('nesting-too-deep', `Query nesting exceeds ${MAX_DEPTH} levels.`);
    }
  }
}
