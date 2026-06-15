// Recursive-descent parser for Grew request syntax → AST (see ast.js).
//
// Hand-written to match house style (src/utils/conlluParser.js is also
// hand-written) and to keep precise line/col on every error. The parser is a
// pure grammar recognizer: it accepts the full surface syntax and never decides
// what is "supported" — that judgement belongs to compile.js, which walks this
// AST and throws GrewUnsupportedError for the residue. So e.g. labeled
// transitive edges or edge-feature labels parse fine here and may be rejected
// later.

import { lex, TT } from './lexer.js';
import { GrewParseError } from './errors.js';
import { BLOCK_TYPES } from './ast.js';

export function parse(src) {
  const tokens = lex(src);
  let pos = 0;
  const nonInjective = new Set();

  const peek = (k = 0) => tokens[pos + k];
  const at = (type, k = 0) => peek(k).type === type;
  const next = () => tokens[pos++];
  const fail = (msg, tok = peek()) => {
    const lines = src.split('\n');
    throw new GrewParseError(msg, tok.line, tok.col, lines[tok.line - 1] ?? '');
  };
  const expect = (type, what) => {
    if (!at(type)) fail(`Expected ${what || type} but found ${describe(peek())}`);
    return next();
  };

  const blocks = [];
  while (!at(TT.EOF)) {
    blocks.push(parseBlock());
  }
  if (blocks.length === 0) fail('Empty query — expected a `pattern { … }` block');

  return { blocks, nonInjective: [...nonInjective] };

  // --- blocks ---

  function parseBlock() {
    if (!at(TT.IDENT) || !BLOCK_TYPES.has(peek().value)) {
      fail('Expected a block keyword: pattern, with, without, or global');
    }
    const kw = next();
    expect(TT.LBRACE, "'{'");
    const items = [];
    while (!at(TT.RBRACE) && !at(TT.EOF)) {
      items.push(kw.value === 'global' ? parseGlobalItem() : parseClause());
      while (at(TT.SEMI)) next(); // optional clause separators
    }
    expect(TT.RBRACE, "'}'");
    return { type: kw.value, items, line: kw.line };
  }

  // --- pattern/with/without clauses ---

  function parseClause() {
    // delta(X,Y) / length(X,Y)
    if (at(TT.IDENT) && (peek().value === 'delta' || peek().value === 'length') && at(TT.LPAREN, 1)) {
      return parseDist();
    }

    // Wildcard-source edge: * -[..]-> Y
    if (at(TT.STAR)) {
      next();
      return parseEdgeRest(null, { wild: true });
    }

    const idTok = expect(TT.IDENT, 'a node/edge identifier');
    const id = idTok.value;

    // Named edge:  e: X -[..]-> Y
    if (at(TT.COLON)) {
      next();
      const src = parseRef();
      return parseEdgeRest(id, src);
    }

    // Non-injective marker on a bare reference (e.g. `X$ -> Y`).
    if (at(TT.DOLLAR) && !at(TT.LBRACK, 1)) {
      next();
      nonInjective.add(id);
    }

    switch (peek().type) {
      case TT.DOLLAR: // X$ [..]  (non-injective node declaration)
        next();
        nonInjective.add(id);
        return parseNodeDecl(id, idTok.line);
      case TT.LBRACK:
        return parseNodeDecl(id, idTok.line);
      case TT.DOT:
        return parseNodeDotConstraint(id, idTok.line);
      case TT.LT:
      case TT.LTLT:
        return parseOrder(id);
      case TT.ARROW:
      case TT.DOMINATES:
      case TT.EDGE_OPEN:
        return parseEdgeRest(null, { wild: false, id });
      case TT.CROSS: {
        next();
        const right = expect(TT.IDENT, 'an edge identifier').value;
        return { kind: 'cross', left: id, right, line: idTok.line };
      }
      default:
        // bare node declaration: `X` with no feature structure
        return { kind: 'node', id, alts: [[]], line: idTok.line };
    }
  }

  function parseRef() {
    if (at(TT.STAR)) { next(); return { wild: true }; }
    const id = expect(TT.IDENT, 'a node identifier').value;
    if (at(TT.DOLLAR)) { next(); nonInjective.add(id); }
    return { wild: false, id };
  }

  function parseNodeDecl(id, line) {
    const alts = [parseFeatureStruct()];
    while (at(TT.PIPE)) { next(); alts.push(parseFeatureStruct()); }
    return { kind: 'node', id, alts, line };
  }

  function parseFeatureStruct() {
    expect(TT.LBRACK, "'['");
    const items = [];
    if (!at(TT.RBRACK)) {
      items.push(parseFeatItem());
      while (at(TT.COMMA)) { next(); items.push(parseFeatItem()); }
    }
    expect(TT.RBRACK, "']'");
    return items;
  }

  function parseFeatItem() {
    if (at(TT.BANG)) {
      next();
      const name = expect(TT.IDENT, 'a feature name').value;
      return { name, op: 'undefined', value: null };
    }
    const name = expect(TT.IDENT, 'a feature name').value;
    if (at(TT.EQ)) { next(); return { name, op: '=', value: parseValueExpr() }; }
    if (at(TT.NEQ)) { next(); return { name, op: '<>', value: parseValueExpr() }; }
    return { name, op: 'defined', value: null };
  }

  function parseValueExpr() {
    const items = [parseValueAtom()];
    while (at(TT.PIPE)) { next(); items.push(parseValueAtom()); }
    return items.length === 1 ? items[0] : { type: 'disj', items };
  }

  function parseValueAtom() {
    if (at(TT.STAR)) { next(); return { type: 'any' }; }
    if (at(TT.STRING)) return { type: 'lit', value: next().value };
    if (at(TT.REGEX)) {
      const r = next().value;
      return { type: 'regex', pattern: r.pattern, flavor: r.flavor, flags: r.flags };
    }
    if (at(TT.IDENT) || at(TT.NUMBER)) {
      // allow subtyped values like Number=Sing[psor]? — keep simple: ident/number
      return { type: 'lit', value: next().value };
    }
    fail(`Expected a value but found ${describe(peek())}`);
  }

  function parseNodeDotConstraint(id, line) {
    expect(TT.DOT, "'.'");
    const feat = expect(TT.IDENT, 'a feature name').value;
    const op = at(TT.NEQ) ? '<>' : (expect(TT.EQ, "'=' or '<>'"), '=');
    if (op === '<>') next();
    // Right side: Y.feat (cross-node) or a value.
    if (at(TT.IDENT) && at(TT.DOT, 1)) {
      const rnode = next().value;
      next(); // '.'
      const rfeat = expect(TT.IDENT, 'a feature name').value;
      return { kind: 'featcmp', left: { node: id, feat }, op, right: { node: rnode, feat: rfeat }, line };
    }
    return { kind: 'nodefeat', node: id, feat, op, value: parseValueExpr(), line };
  }

  function parseOrder(id) {
    const op = at(TT.LTLT) ? '<<' : '<';
    next();
    const right = expect(TT.IDENT, 'a node identifier').value;
    return { kind: 'order', op, left: id, right };
  }

  function parseEdgeRest(edgeId, src) {
    let label = { type: 'any' };
    if (at(TT.EDGE_OPEN)) {
      next();
      label = parseLabelExpr();
      expect(TT.RBRACK, "']'");
    }
    let transitive;
    if (at(TT.ARROW)) { next(); transitive = false; }
    else if (at(TT.DOMINATES)) { next(); transitive = true; }
    else fail(`Expected '->' or '->>' but found ${describe(peek())}`);
    const tgt = parseRef();
    if (transitive) return { kind: 'dominates', id: edgeId, left: src, right: tgt, label };
    return { kind: 'edge', id: edgeId, src, tgt, label };
  }

  function parseLabelExpr() {
    if (at(TT.REGEX)) {
      const r = next().value;
      return { type: 'regex', pattern: r.pattern, flavor: r.flavor, flags: r.flags };
    }
    let negated = false;
    if (at(TT.CARET)) { next(); negated = true; }

    // Edge-feature form: `1=nsubj, 2=pass, !deep` (key=val or !key, comma-sep).
    const looksFeature = at(TT.BANG) || ((at(TT.IDENT) || at(TT.NUMBER)) && at(TT.EQ, 1));
    if (!negated && looksFeature) {
      const feats = [];
      do {
        if (at(TT.BANG)) { next(); feats.push({ key: expect(TT.IDENT, 'a feature name').value, neg: true }); }
        else { const key = next().value; expect(TT.EQ, "'='"); feats.push({ key, val: parseLabelAtom() }); }
      } while (at(TT.COMMA) && (next(), true));
      return { type: 'features', feats };
    }

    // Label list: `nsubj | obj | nsubj:pass`
    const labels = [parseLabelAtom()];
    while (at(TT.PIPE)) { next(); labels.push(parseLabelAtom()); }
    return { type: 'list', labels, negated };
  }

  // A label atom can be subtyped with ':' (e.g. nsubj:pass), which the lexer
  // splits into IDENT COLON IDENT — reassemble it here.
  function parseLabelAtom() {
    if (at(TT.STRING)) return next().value;
    let s = String(expect(TT.IDENT, 'an edge label').value);
    while (at(TT.COLON)) { next(); s += ':' + expect(TT.IDENT, 'a label subtype').value; }
    return s;
  }

  function parseDist() {
    const fn = next().value; // delta | length
    expect(TT.LPAREN, "'('");
    const a = expect(TT.IDENT, 'a node identifier').value;
    expect(TT.COMMA, "','");
    const b = expect(TT.IDENT, 'a node identifier').value;
    expect(TT.RPAREN, "')'");
    const opTok = next();
    const op = { [TT.EQ]: '=', [TT.LT]: '<', [TT.LE]: '<=', [TT.GT]: '>', [TT.GE]: '>=' }[opTok.type];
    if (!op) fail(`Expected a comparison operator after ${fn}(…)`, opTok);
    const nTok = expect(TT.NUMBER, 'a number');
    return { kind: 'dist', fn, a, b, op, n: parseInt(nTok.value, 10) };
  }

  // --- global items ---

  function parseGlobalItem() {
    // Optional `meta.` / `global.` prefix (Grew v1.18 in-pattern globals).
    if (at(TT.IDENT) && (peek().value === 'meta' || peek().value === 'global') && at(TT.DOT, 1)) {
      next(); next();
    }
    if (at(TT.BANG)) {
      next();
      const key = expect(TT.IDENT, 'a metadata key').value;
      return { kind: 'globalmeta', key, op: 'undefined', value: null };
    }
    const idTok = expect(TT.IDENT, 'a global constraint');
    if (/^is_/.test(idTok.value) && !at(TT.EQ) && !at(TT.NEQ)) {
      return { kind: 'globalflag', name: idTok.value, line: idTok.line };
    }
    const op = at(TT.NEQ) ? '<>' : (expect(TT.EQ, "'=' or '<>'"), '=');
    if (op === '<>') next();
    return { kind: 'globalmeta', key: idTok.value, op, value: parseValueExpr(), line: idTok.line };
  }
}

function describe(tok) {
  if (tok.type === TT.EOF) return 'end of input';
  if (tok.type === TT.STRING) return `string "${tok.value}"`;
  if (tok.type === TT.REGEX) return 'a regex literal';
  if (tok.type === TT.IDENT || tok.type === TT.NUMBER) return `'${tok.value}'`;
  return `'${tok.value ?? tok.type}'`;
}
