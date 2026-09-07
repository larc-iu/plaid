// Rewrite one sentence graph with a rule set, the way Grew does: a rule
// application is one match and its commands, and a strategy says how rule
// applications chain. Every strategy here yields ONE graph (Grew's `Pick`
// everywhere), with the first match in the matcher's deterministic order
// where Grew would choose arbitrarily.
//
//   rule R      first match of R, or fails when R does not match
//   Seq(S, T)   T on the result of S; fails when either fails
//   Alt(S, T)   S, or T when S fails
//   Pick(S)     S
//   Try(S)      S, or the input graph when S fails
//   Empty       the input graph
//   Iter(S)     S again and again until it fails; never fails
//   Onf(S)      Pick(Iter(S)), the same thing here
//
// With no `strat main`, the rule set runs as Onf(Alt(rules in order)), which
// is what a corpus rewrite with Grew does. Grew relies on the author's
// `without` clauses for termination and stops at a hard cap; here a rule that
// matches but changes nothing stops at once with an error, since it could
// only ever loop, and the cap is the backstop.

import { GrewRuntimeError } from '../errors.js';
import { cloneGraph } from './graph.js';
import { firstMatch } from './match.js';
import { applyCommands } from './commands.js';

const MAX_APPLICATIONS = 1000;

// The strategy the rule set runs under: `main`, else the first declared, else
// Onf(Alt(rules)).
export function mainStrategy(grs) {
  const main = grs.strats.find((s) => s.name === 'main') || grs.strats[0];
  if (main) return main.expr;
  return {
    op: 'Onf',
    args: [{ op: 'Alt', args: grs.rules.map((r) => ({ op: 'rule', name: r.name })) }],
  };
}

// Returns { graph, applications } — the rewritten copy and one entry per rule
// application ({ rule, nodes }) — or throws a GrewRuntimeError / GrewUnsupportedError.
export function rewriteSentence(grs, graph, { maxApplications = MAX_APPLICATIONS } = {}) {
  const rules = new Map(grs.rules.map((r) => [r.name, r]));
  const strats = new Map(grs.strats.map((s) => [s.name, s.expr]));
  const applications = [];

  const applyRule = (rule, g) => {
    const m = firstMatch(rule, g);
    if (!m) return null;
    if (applications.length >= maxApplications) {
      throw new GrewRuntimeError(
        `Rule '${rule.name}' did not terminate after ${maxApplications} applications; add a \`without\` clause that stops it.`,
        { rule: rule.name, line: rule.line },
      );
    }
    const next = cloneGraph(g);
    applyCommands(rule, m, next);
    applications.push({ rule: rule.name, nodes: m.nodes });
    return next;
  };

  const run = (expr, g, depth = 0) => {
    if (depth > 64) throw new GrewRuntimeError('Strategy nesting is too deep.');
    switch (expr.op) {
      case 'rule': {
        const rule = rules.get(expr.name);
        if (rule) return applyRule(rule, g);
        if (strats.has(expr.name)) return run(strats.get(expr.name), g, depth + 1);
        throw new GrewRuntimeError(`Unknown rule or strategy '${expr.name}'.`);
      }
      case 'Empty':
        return g;
      case 'Pick':
        return run(expr.args[0], g, depth + 1);
      case 'Try':
        return run(expr.args[0], g, depth + 1) ?? g;
      case 'Seq': {
        let cur = g;
        for (const a of expr.args) {
          cur = run(a, cur, depth + 1);
          if (cur == null) return null;
        }
        return cur;
      }
      case 'Alt': {
        for (const a of expr.args) {
          const r = run(a, g, depth + 1);
          if (r != null) return r;
        }
        return null;
      }
      case 'Iter':
      case 'Onf': {
        let cur = g;
        for (;;) {
          const r = run(expr.args[0], cur, depth + 1);
          if (r == null) return cur;
          if (fingerprint(r) === fingerprint(cur)) {
            const last = applications[applications.length - 1];
            throw new GrewRuntimeError(
              `Rule '${last.rule}' matched but changed nothing, so it would match forever; add a \`without\` clause that stops it.`,
              { rule: last.rule, line: rules.get(last.rule)?.line ?? null },
            );
          }
          cur = r;
        }
      }
      default:
        throw new GrewRuntimeError(`Unknown strategy '${expr.op}'.`);
    }
  };

  const result = run(mainStrategy(grs), graph) ?? graph;
  return { graph: result, applications };
}

// Everything a command can change, as one string.
export function fingerprint(g) {
  const nodes = g.order.map((id) => {
    const n = g.nodes.get(id);
    if (n.deleted) return [id, 'deleted'];
    return [id, n.form, n.lemma, n.upos, n.xpos, [...n.feats].sort()];
  });
  const edges = [...g.edges.values()].map((e) => [e.src, e.tgt, e.label]).sort();
  return JSON.stringify([nodes, edges]);
}
