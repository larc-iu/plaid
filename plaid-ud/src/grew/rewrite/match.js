// Match a Grew request against one sentence graph (graph.js), clause for
// clause the way compile.js reads the same AST for the server. This is the
// matcher the rewriting engine needs: after each rule application the graph
// has changed and must be matched again before anything is written, which no
// server query can do.
//
// A match binds every top-level node id to a node and every edge clause to an
// edge (named or not, so two parallel edges give two matches, as in Grew).
// Matches come out in one deterministic order — nodes are tried in linear
// order, edges in sortedEdges order — so "the first match" is well defined
// where Grew's is arbitrary.

import { GrewUnsupportedError } from '../errors.js';
import { getFeat, liveNodes, sortedEdges } from './graph.js';

const analysed = new WeakMap();

// Pre-digest a rule/request AST once: positive clauses, without blocks,
// globals, top-level node ids in declaration order.
function analyse(rule) {
  let a = analysed.get(rule);
  if (a) return a;
  const positive = [];
  const withouts = [];
  const globals = [];
  for (const block of rule.blocks) {
    if (block.type === 'pattern' || block.type === 'with') positive.push(...block.items);
    else if (block.type === 'without') withouts.push(block.items);
    else if (block.type === 'global') globals.push(...block.items);
  }
  a = {
    positive,
    withouts,
    globals,
    topNodes: nodeIdsOf(positive),
    nonInjective: new Set(rule.nonInjective || []),
  };
  analysed.set(rule, a);
  return a;
}

// Node ids a clause list mentions, in first-mention order.
function nodeIdsOf(items) {
  const ids = [];
  const add = (id) => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  for (const item of items) {
    switch (item.kind) {
      case 'node':
        add(item.id);
        break;
      case 'nodefeat':
        add(item.node);
        break;
      case 'featcmp':
        add(item.left.node);
        add(item.right.node);
        break;
      case 'order':
        add(item.left);
        add(item.right);
        break;
      case 'dist':
        add(item.a);
        add(item.b);
        break;
      case 'edge':
      case 'dominates': {
        const l = item.kind === 'edge' ? item.src : item.left;
        const r = item.kind === 'edge' ? item.tgt : item.right;
        if (!l.wild) add(l.id);
        if (!r.wild) add(r.id);
        break;
      }
      default:
        break;
    }
  }
  return ids;
}

const nodeRefsOf = (item) => {
  switch (item.kind) {
    case 'node':
      return [item.id];
    case 'nodefeat':
      return [item.node];
    case 'featcmp':
      return [item.left.node, item.right.node];
    case 'order':
      return [item.left, item.right];
    case 'dist':
      return [item.a, item.b];
    case 'edge':
      return [item.src, item.tgt].filter((r) => !r.wild).map((r) => r.id);
    case 'dominates':
      return [item.left, item.right].filter((r) => !r.wild).map((r) => r.id);
    default:
      return [];
  }
};

// --- public API ---

// Every match of `rule` in `graph`, in deterministic order. `limit` caps the
// enumeration (the engine only ever needs the first).
export function findMatches(rule, graph, { limit = Infinity } = {}) {
  const a = analyse(rule);
  const out = [];
  if (!checkGlobals(a.globals, graph)) return out;
  const ctx = { graph, nonInjective: a.nonInjective };
  solve(ctx, a.positive, a.topNodes, new Map(), new Map(), (nodes, edges) => {
    if (a.withouts.some((items) => hasExtension(ctx, items, nodes, edges))) return true;
    out.push({ nodes: new Map(nodes), edges: new Map(edges) });
    return out.length < limit;
  });
  return out;
}

export function firstMatch(rule, graph) {
  return findMatches(rule, graph, { limit: 1 })[0] || null;
}

// --- backtracking search ---

// Bind the node variables of `items` one at a time (outer bindings fixed),
// checking each clause as soon as everything it mentions is bound. Edge
// clauses bind an edge id per qualifying edge (a branch each). `emit` is
// called per complete assignment and returns false to stop the search.
function solve(ctx, items, nodeVars, nodes, edges, emit) {
  const localVars = nodeVars.filter((v) => !nodes.has(v));
  // Clauses that mention no unbound node can be checked right away.
  const pending = items.filter((it) => it.kind !== 'cross');
  const crosses = items.filter((it) => it.kind === 'cross');
  let stopped = false;

  const step = (i, nodesB, edgesB, remaining) => {
    if (stopped) return;
    // Check every clause whose nodes are now all bound; edge clauses branch.
    const ready = remaining.filter((it) => nodeRefsOf(it).every((v) => nodesB.has(v)));
    const later = remaining.filter((it) => !ready.includes(it));
    runClauses(ctx, ready, nodesB, edgesB, (edgesC) => {
      if (stopped) return;
      if (i === localVars.length) {
        if (!crosses.every((c) => checkCross(ctx, c, edgesC))) return;
        if (emit(nodesB, edgesC) === false) stopped = true;
        return;
      }
      const v = localVars[i];
      for (const n of candidates(ctx, v, later, nodesB)) {
        if (stopped) return;
        if (!ctx.nonInjective.has(v) && isBoundNode(nodesB, n.id, ctx.nonInjective)) continue;
        nodesB.set(v, n.id);
        step(i + 1, nodesB, edgesC, later);
        nodesB.delete(v);
      }
    });
  };
  step(0, nodes, edges, pending);
}

// Is `nodeId` already the value of some injective variable?
function isBoundNode(nodes, nodeId, nonInjective) {
  for (const [v, id] of nodes) if (id === nodeId && !nonInjective.has(v)) return true;
  return false;
}

// Candidate nodes for variable `v`: the neighbours across an edge clause whose
// other endpoint is already bound, else every live node, in linear order.
function candidates(ctx, v, remaining, nodes) {
  const g = ctx.graph;
  for (const it of remaining) {
    if (it.kind !== 'edge') continue;
    const s = it.src.wild ? null : it.src.id;
    const t = it.tgt.wild ? null : it.tgt.id;
    if (s === v && t && nodes.has(t)) {
      const tid = nodes.get(t);
      return uniq(
        sortedEdges(g)
          .filter((e) => e.tgt === tid && labelMatches(it.label, e.label))
          .map((e) => g.nodes.get(e.src)),
      );
    }
    if (t === v && s && nodes.has(s)) {
      const sid = nodes.get(s);
      return uniq(
        sortedEdges(g)
          .filter((e) => e.src === sid && labelMatches(it.label, e.label))
          .map((e) => g.nodes.get(e.tgt)),
      );
    }
  }
  return liveNodes(g);
}

const uniq = (arr) => {
  const seen = new Set();
  return arr
    .filter((n) => n && !n.deleted && !seen.has(n.id) && seen.add(n.id))
    .sort((a, b) => a.pos - b.pos);
};

// Check the ready clauses against the bindings. Non-edge clauses are plain
// predicates; each edge clause multiplies the continuation by its qualifying
// edges. `k(edges)` runs once per consistent edge assignment.
function runClauses(ctx, ready, nodes, edges, k) {
  const plain = ready.filter((it) => it.kind !== 'edge');
  const edgeClauses = ready.filter((it) => it.kind === 'edge');
  for (const it of plain) if (!checkClause(ctx, it, nodes)) return;
  const go = (j, edgesB) => {
    if (j === edgeClauses.length) return k(edgesB);
    const it = edgeClauses[j];
    const key = it.id || it; // anonymous clauses key on their own AST node
    for (const e of qualifyingEdges(ctx.graph, it, nodes)) {
      if ([...edgesB.values()].includes(e.id) && !it.id) continue; // distinct edges per clause
      edgesB.set(key, e.id);
      go(j + 1, edgesB);
      edgesB.delete(key);
    }
  };
  go(0, edges);
}

function qualifyingEdges(g, it, nodes) {
  const s = it.src.wild ? null : nodes.get(it.src.id);
  const t = it.tgt.wild ? null : nodes.get(it.tgt.id);
  return sortedEdges(g).filter(
    (e) =>
      (s == null || e.src === s) && (t == null || e.tgt === t) && labelMatches(it.label, e.label),
  );
}

// True when the `without` items can be satisfied on top of the match.
function hasExtension(ctx, items, nodes, edges) {
  let found = false;
  const localVars = nodeIdsOf(items).filter((v) => !nodes.has(v));
  solve(ctx, items, [...nodes.keys(), ...localVars], new Map(nodes), new Map(edges), () => {
    found = true;
    return false;
  });
  return found;
}

// --- clause predicates ---

function checkClause(ctx, item, nodes) {
  const g = ctx.graph;
  const node = (v) => g.nodes.get(nodes.get(v));
  switch (item.kind) {
    case 'node':
      return item.alts.some((alt) => alt.every((fi) => checkFeatItem(node(item.id), fi)));
    case 'nodefeat':
      return checkFeatItem(node(item.node), { name: item.feat, op: item.op, value: item.value });
    case 'featcmp': {
      const l = getFeat(node(item.left.node), item.left.feat);
      const r = getFeat(node(item.right.node), item.right.feat);
      if (l === undefined || r === undefined) return false;
      return item.op === '=' ? l === r : l !== r;
    }
    case 'order': {
      const a = node(item.left).pos;
      const b = node(item.right).pos;
      return item.op === '<' ? isNextLive(g, item.left, item.right, nodes) : a < b;
    }
    case 'dist': {
      const d = node(item.b).pos - node(item.a).pos;
      const x = item.fn === 'delta' ? d : Math.abs(d);
      return compare(x, item.op, item.n);
    }
    case 'dominates':
      return checkDominates(g, item, nodes);
    default:
      throw new GrewUnsupportedError(item.kind, `Unsupported clause: ${item.kind}`);
  }
}

// X < Y: Y is the live node right after X.
function isNextLive(g, l, r, nodes) {
  const live = liveNodes(g);
  const i = live.findIndex((n) => n.id === nodes.get(l));
  return i !== -1 && live[i + 1]?.id === nodes.get(r);
}

const compare = (x, op, n) =>
  ({ '=': x === n, '<': x < n, '<=': x <= n, '>': x > n, '>=': x >= n })[op];

function checkFeatItem(node, fi) {
  const v = getFeat(node, fi.name);
  switch (fi.op) {
    case 'defined':
      return v !== undefined;
    case 'undefined':
      return v === undefined;
    case '=':
      return v !== undefined && matchValue(v, fi.value);
    case '<>':
      return v !== undefined && !matchValue(v, fi.value);
    default:
      return false;
  }
}

export function matchValue(actual, value) {
  switch (value.type) {
    case 'lit':
      return String(actual) === String(value.value);
    case 'any':
      return true;
    case 'regex':
      return toRegExp(value).test(String(actual));
    case 'disj':
      return value.items.some((it) => matchValue(actual, it));
    default:
      return false;
  }
}

const regexCache = new Map();
// A user regex is a substring search, case-insensitive on the `i` flag only:
// the same reading the server gives the search box (compile.js passes the
// pattern through, and Plaid runs it as a find), so a rule matches what the
// search that found the sentence matched.
function toRegExp(v) {
  const flags = v.flags && v.flags.includes('i') ? 'i' : '';
  const key = `${flags}/${v.pattern}`;
  let re = regexCache.get(key);
  if (!re) {
    re = new RegExp(v.pattern, flags);
    regexCache.set(key, re);
  }
  return re;
}

// Does an edge label satisfy a Label AST? `-[nsubj]->` is the exact label;
// `-[1=nsubj]->` is the main type, any subtype.
export function labelMatches(label, actual) {
  if (!label || label.type === 'any') return true;
  if (label.type === 'list') {
    const hit = label.labels.includes(actual);
    return label.negated ? !hit : hit;
  }
  if (label.type === 'regex') return toRegExp(label).test(actual);
  if (label.type === 'features') {
    if (!label.feats.every((f) => /^[0-9]+$/.test(f.key) && !f.neg)) {
      throw new GrewUnsupportedError(
        'edge-feature',
        'Only positive numbered edge features (1=, 2=, …) are supported.',
      );
    }
    const joined = [...label.feats]
      .sort((a, b) => Number(a.key) - Number(b.key))
      .map((f) => f.val)
      .join(':');
    return actual === joined || actual.startsWith(joined + ':');
  }
  return false;
}

// X ->> Y: Y is reachable from X along non-loop edges (optionally with one
// of the listed labels).
function checkDominates(g, item, nodes) {
  if (item.left.wild || item.right.wild) {
    throw new GrewUnsupportedError(
      'dominates-wildcard',
      'Transitive dominance (->>) requires named endpoints.',
    );
  }
  let allowed = null;
  if (item.label && item.label.type !== 'any') {
    if (item.label.type === 'list' && !item.label.negated) allowed = new Set(item.label.labels);
    else
      throw new GrewUnsupportedError(
        'dominates-label',
        'A transitive edge (->>) may only carry a plain label or label list, not a regex/negation/subtype.',
      );
  }
  const start = nodes.get(item.left.id);
  const goal = nodes.get(item.right.id);
  return descendants(g, start, allowed).has(goal);
}

// Nodes strictly below `start` (self-loops ignored).
export function descendants(g, start, allowed = null) {
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    for (const e of g.edges.values()) {
      if (e.src !== cur || e.tgt === e.src || seen.has(e.tgt)) continue;
      if (allowed && !allowed.has(e.label)) continue;
      seen.add(e.tgt);
      queue.push(e.tgt);
    }
  }
  return seen;
}

// e1 >< e2: the two edges' endpoints interleave.
function checkCross(ctx, item, edges) {
  const g = ctx.graph;
  const e1 = g.edges.get(edges.get(item.left));
  const e2 = g.edges.get(edges.get(item.right));
  if (!e1 || !e2) {
    throw new GrewUnsupportedError(
      'cross-unknown-edge',
      'Edge crossing (><) needs two named edges declared in the pattern.',
    );
  }
  const span = (e) => [g.nodes.get(e.src).pos, g.nodes.get(e.tgt).pos].sort((a, b) => a - b);
  const [a1, a2] = span(e1);
  const [b1, b2] = span(e2);
  return (a1 < b1 && b1 < a2 && a2 < b2) || (b1 < a1 && a1 < b2 && b2 < a2);
}

// --- global block ---

function checkGlobals(globals, g) {
  return globals.every((item) =>
    item.kind === 'globalflag' ? checkFlag(item.name, g) : checkMeta(item, g),
  );
}

function checkFlag(name, g) {
  switch (name) {
    case 'is_projective':
      return isProjective(g);
    case 'is_not_projective':
      return !isProjective(g);
    case 'is_tree':
      return isForest(g) && rootCount(g) === 1;
    case 'is_not_tree':
      return !(isForest(g) && rootCount(g) === 1);
    case 'is_forest':
      return isForest(g);
    case 'is_not_forest':
      return !isForest(g);
    case 'is_cyclic':
      return hasCycle(g);
    case 'is_not_cyclic':
      return !hasCycle(g);
    default:
      throw new GrewUnsupportedError(name, `Unsupported global constraint: ${name}`);
  }
}

const nonLoopEdges = (g) => [...g.edges.values()].filter((e) => e.src !== e.tgt);

function rootCount(g) {
  const withHead = new Set(nonLoopEdges(g).map((e) => e.tgt));
  return liveNodes(g).filter((n) => !withHead.has(n.id)).length;
}

function isForest(g) {
  const heads = new Map();
  for (const e of nonLoopEdges(g)) heads.set(e.tgt, (heads.get(e.tgt) || 0) + 1);
  if ([...heads.values()].some((n) => n > 1)) return false;
  return !hasCycle(g);
}

function hasCycle(g) {
  const out = new Map();
  for (const e of nonLoopEdges(g)) {
    if (!out.has(e.src)) out.set(e.src, []);
    out.get(e.src).push(e.tgt);
  }
  const state = new Map(); // 1 = on stack, 2 = done
  const visit = (id) => {
    state.set(id, 1);
    for (const nxt of out.get(id) || []) {
      const s = state.get(nxt);
      if (s === 1) return true;
      if (!s && visit(nxt)) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const id of g.nodes.keys()) if (!state.get(id) && visit(id)) return true;
  return false;
}

// Every node strictly between an edge's endpoints is dominated by its head.
export function isProjective(g) {
  const live = liveNodes(g);
  for (const e of nonLoopEdges(g)) {
    const h = g.nodes.get(e.src);
    const d = g.nodes.get(e.tgt);
    if (!h || !d || h.deleted || d.deleted) continue;
    const lo = Math.min(h.pos, d.pos);
    const hi = Math.max(h.pos, d.pos);
    const below = descendants(g, h.id);
    for (const n of live) {
      if (n.pos > lo && n.pos < hi && n.id !== h.id && !below.has(n.id)) return false;
    }
  }
  return true;
}

function checkMeta(item, g) {
  const { key, op, value } = item;
  const actual = key.toLowerCase() === 'text' ? g.sentence.text : g.sentence.metadata?.[key];
  if (op === 'undefined') return actual === undefined;
  if (actual === undefined) return false;
  const hit = matchValue(actual, value);
  return op === '=' ? hit : !hit;
}
