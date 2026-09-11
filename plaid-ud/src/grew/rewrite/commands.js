// Apply one rule's commands to a sentence graph under a match. Mutates the
// graph in place (the engine hands it a clone). Semantics follow Grew's
// default mode: an ineffective `add_edge` (the edge is already there) or
// `del_edge e` (already gone) is ignored; `del_edge X -[lab]-> Y` on a missing
// edge, a read of an undefined feature, or a command on a deleted word stops
// the rule with a GrewRuntimeError. Grew never enforces a tree, so neither
// does this: an `add_edge` may give a word a second head.
//
// The root is an edge from the anchor node (graph.js), so shifting a word's
// incoming edges moves its root status like any other head. One UD-model
// point Grew has no equivalent for: dependencies hang on the lemma span, so a
// lemma cannot be removed while the word still has one. Features set on the
// anchor are kept in the graph (Grew allows them) and never written.

import { GrewRuntimeError, GrewUnsupportedError } from '../errors.js';
import {
  getFeat,
  setFeat,
  delFeat,
  freshEdgeId,
  labelParts,
  joinLabel,
  columnOf,
} from './graph.js';
import { labelMatches } from './match.js';

export function applyCommands(rule, match, graph) {
  const ctx = {
    rule: rule.name,
    graph,
    nodes: new Map(match.nodes),
    edges: new Map([...match.edges].filter(([k]) => typeof k === 'string')),
    lexicons: match.lexicons || {},
  };
  for (const cmd of rule.commands) applyCommand(ctx, cmd);
}

const fail = (ctx, cmd, msg) => {
  throw new GrewRuntimeError(msg, { rule: ctx.rule, line: cmd.line });
};

function nodeOf(ctx, cmd, v) {
  const id = ctx.nodes.get(v);
  if (!id) {
    if (ctx.edges.has(v)) return null; // an edge variable
    fail(ctx, cmd, `'${v}' is not a node of the pattern.`);
  }
  const n = ctx.graph.nodes.get(id);
  if (!n || n.deleted) fail(ctx, cmd, `'${v}' was deleted by an earlier command.`);
  return n;
}

function edgeOf(ctx, cmd, v) {
  if (!ctx.edges.has(v)) fail(ctx, cmd, `'${v}' is not an edge of the pattern.`);
  return ctx.graph.edges.get(ctx.edges.get(v)) || null; // null: already deleted
}

// The one label a command names: `-[obj]->` or `-[1=obj, 2=lvc]->`.
function literalLabel(ctx, cmd, label) {
  if (label.type === 'list' && !label.negated && label.labels.length === 1) return label.labels[0];
  if (label.type === 'features' && label.feats.every((f) => /^[0-9]+$/.test(f.key) && !f.neg)) {
    return [...label.feats]
      .sort((a, b) => Number(a.key) - Number(b.key))
      .map((f) => f.val)
      .join(':');
  }
  throw new GrewUnsupportedError(
    'command-label',
    'A command names one label: add_edge X -[obj]-> Y.',
    cmd.line,
  );
}

const sameEdge = (g, src, tgt, label) =>
  [...g.edges.values()].find((e) => e.src === src && e.tgt === tgt && e.label === label);

function applyCommand(ctx, cmd) {
  const g = ctx.graph;
  switch (cmd.kind) {
    case 'del_edge': {
      if (cmd.edge) {
        const e = edgeOf(ctx, cmd, cmd.edge);
        if (e) g.edges.delete(e.id);
        return;
      }
      const src = nodeOf(ctx, cmd, cmd.src);
      const tgt = nodeOf(ctx, cmd, cmd.tgt);
      const hits = [...g.edges.values()].filter(
        (e) => e.src === src.id && e.tgt === tgt.id && labelMatches(cmd.label, e.label),
      );
      if (!hits.length) fail(ctx, cmd, `No edge ${cmd.src} -> ${cmd.tgt} to delete.`);
      hits.forEach((e) => g.edges.delete(e.id));
      return;
    }
    case 'add_edge': {
      const src = nodeOf(ctx, cmd, cmd.src);
      const tgt = nodeOf(ctx, cmd, cmd.tgt);
      let label;
      if (cmd.label) label = literalLabel(ctx, cmd, cmd.label);
      else {
        const e = edgeOf(ctx, cmd, cmd.id);
        if (!e) fail(ctx, cmd, `Edge '${cmd.id}' was deleted; its label is gone.`);
        label = e.label;
      }
      if (sameEdge(g, src.id, tgt.id, label)) return; // ineffective
      const id = freshEdgeId(g);
      g.edges.set(id, { id, src: src.id, tgt: tgt.id, label, metadata: null });
      if (cmd.id && cmd.label) ctx.edges.set(cmd.id, id);
      return;
    }
    case 'del_node': {
      const n = nodeOf(ctx, cmd, cmd.node);
      if (n.anchor) fail(ctx, cmd, `'${cmd.node}' is the root anchor; it cannot be deleted.`);
      n.deleted = true;
      for (const e of [...g.edges.values()])
        if (e.src === n.id || e.tgt === n.id) g.edges.delete(e.id);
      return;
    }
    case 'add_node':
      throw new GrewUnsupportedError(
        'add_node',
        'Adding words is not supported: words come from the text.',
        cmd.line,
      );
    case 'shift': {
      const src = nodeOf(ctx, cmd, cmd.src);
      const tgt = nodeOf(ctx, cmd, cmd.tgt);
      // Edges between the two words stay where they are.
      for (const e of [...g.edges.values()]) {
        if (!labelMatches(cmd.filter, e.label)) continue;
        if (e.tgt === src.id && e.src !== tgt.id && cmd.mode !== 'out') {
          e.tgt = tgt.id;
        } else if (e.src === src.id && e.tgt !== tgt.id && cmd.mode !== 'in') {
          e.src = tgt.id;
        } else continue;
        const dup = sameEdge(g, e.src, e.tgt, e.label);
        if (dup && dup.id !== e.id) g.edges.delete(e.id);
      }
      return;
    }
    case 'set_feat': {
      const value = evalExpr(ctx, cmd, cmd.expr);
      const n = nodeOf(ctx, cmd, cmd.node);
      if (n) {
        setFeat(n, cmd.feat, value);
        return;
      }
      const e = edgeOf(ctx, cmd, cmd.node);
      if (!e) fail(ctx, cmd, `Edge '${cmd.node}' was deleted.`);
      e.label = setLabelPart(e.label, cmd.feat, value);
      return;
    }
    case 'del_feat': {
      const n = nodeOf(ctx, cmd, cmd.node);
      if (n) {
        if (
          columnOf(cmd.feat) === 'lemma' &&
          [...g.edges.values()].some((e) => e.src === n.id || e.tgt === n.id)
        ) {
          fail(ctx, cmd, `${cmd.node}.lemma cannot be removed while the word has dependencies.`);
        }
        if (columnOf(cmd.feat) === 'form')
          fail(ctx, cmd, 'form cannot be removed: every word has one.');
        delFeat(n, cmd.feat);
        return;
      }
      const e = edgeOf(ctx, cmd, cmd.node);
      if (!e) fail(ctx, cmd, `Edge '${cmd.node}' was deleted.`);
      e.label = setLabelPart(e.label, cmd.feat, null);
      return;
    }
    case 'append_feats':
    case 'prepend_feats': {
      // Every FEATS key of X (never form/lemma/upos/xpos), optionally only
      // those the filter names, onto Y; joined with the separator where Y
      // already has the key.
      const src = nodeOf(ctx, cmd, cmd.src);
      const tgt = nodeOf(ctx, cmd, cmd.tgt);
      for (const [name, v] of src.feats) {
        if (cmd.filter && !labelMatches(cmd.filter, name)) continue;
        const cur = tgt.feats.get(name);
        if (cur === undefined) tgt.feats.set(name, v);
        else
          tgt.feats.set(
            name,
            cmd.kind === 'append_feats' ? `${cur}${cmd.sep}${v}` : `${v}${cmd.sep}${cur}`,
          );
      }
      return;
    }
    default:
      throw new GrewUnsupportedError(cmd.kind, `Unsupported command: ${cmd.kind}`, cmd.line);
  }
}

// `e.label` is the whole deprel; `e.1`, `e.2`, … are its ':'-separated parts.
function setLabelPart(label, feat, value) {
  if (feat === 'label') return value ?? '';
  const i = Number(feat);
  if (!Number.isInteger(i) || i < 1) {
    throw new GrewUnsupportedError(
      'edge-feature',
      `Edge feature '${feat}' is not supported. Use e.label, e.1, e.2.`,
    );
  }
  const parts = labelParts(label);
  if (value == null) parts.splice(i - 1, 1);
  else {
    while (parts.length < i - 1) parts.push('');
    parts[i - 1] = value;
  }
  return joinLabel(parts);
}

function evalExpr(ctx, cmd, atoms) {
  return atoms
    .map((a) => {
      if (a.type === 'lit') return String(a.value);
      if (!ctx.nodes.has(a.node) && !ctx.edges.has(a.node) && ctx.lexicons[a.node]) {
        return lexValue(ctx, cmd, a);
      }
      const n = nodeOf(ctx, cmd, a.node);
      let v;
      if (n) v = getFeat(n, a.feat);
      else {
        const e = edgeOf(ctx, cmd, a.node);
        if (!e) fail(ctx, cmd, `Edge '${a.node}' was deleted.`);
        v = a.feat === 'label' ? e.label : labelParts(e.label)[Number(a.feat) - 1];
      }
      if (v === undefined) fail(ctx, cmd, `${a.node}.${a.feat} is undefined.`);
      if (!a.slice) return String(v);
      const chars = Array.from(String(v));
      const [s, e] = a.slice;
      return chars.slice(s ?? 0, e ?? chars.length).join('');
    })
    .join('');
}

// `lex.field` in a command: the one value the entries the pattern left agree
// on. Several different values is an error, as Grew reports it.
function lexValue(ctx, cmd, a) {
  const lex = ctx.lexicons[a.node];
  if (!lex.fields.includes(a.feat)) fail(ctx, cmd, `Lexicon '${a.node}' has no field '${a.feat}'.`);
  const values = [...new Set(lex.entries.map((e) => e[a.feat]))];
  if (values.length !== 1) {
    fail(
      ctx,
      cmd,
      `${a.node}.${a.feat} is ambiguous: ${lex.entries.length} entries match, with ${values.length} different values.`,
    );
  }
  const v = values[0];
  if (!a.slice) return v;
  const chars = Array.from(v);
  const [s, e] = a.slice;
  return chars.slice(s ?? 0, e ?? chars.length).join('');
}
