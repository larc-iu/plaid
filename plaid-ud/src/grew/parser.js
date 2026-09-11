// Recursive-descent parser for Grew syntax → AST (see ast.js).
//
// Hand-written to match house style (src/utils/conlluParser.js is also
// hand-written) and to keep precise line/col on every error. The parser is a
// pure grammar recognizer: it accepts the full surface syntax and never decides
// what is "supported" — that judgement belongs to compile.js (search) and the
// rewrite engine (rules), which walk this AST and throw GrewUnsupportedError
// for the residue. So e.g. labeled transitive edges, edge-feature labels, or
// an `add_node` command parse fine here and may be rejected later.
//
// Two entry points share one grammar:
//   parse(src)    — a REQUEST: pattern/with/without/global blocks (the search box)
//   parseGrs(src) — a REWRITING SYSTEM: `rule` blocks (a request plus a
//                   `commands` block each), optional `strat` declarations, or a
//                   bare anonymous rule (blocks followed by `commands { … }`).

import { lex, TT } from './lexer.js';
import { GrewParseError, GrewUnsupportedError } from './errors.js';
import { BLOCK_TYPES } from './ast.js';

const STRAT_OPS = new Set(['Onf', 'Iter', 'Seq', 'Alt', 'Pick', 'Try', 'Empty']);
const FIELD_SEP = '\t';
const GRS_KEYWORDS = new Set(['rule', 'strat', 'commands', 'package', 'include', 'import']);

export function parse(src) {
  return createParser(src).request();
}

export function parseGrs(src) {
  return createParser(src).grs();
}

// True when `src` reads as a rewriting system rather than a request: a
// `commands {` block, a `rule NAME {` / `strat NAME {` declaration, or a
// package/include/import keyword. Unlexable input is "not a GRS", so the
// caller reports the error through the request path.
export function looksLikeGrs(src) {
  try {
    const toks = lex(src);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type !== TT.IDENT) continue;
      const brace = (k) => toks[i + k]?.type === TT.LBRACE;
      if (t.value === 'commands' && brace(1)) return true;
      if ((t.value === 'rule' || t.value === 'strat') && toks[i + 1]?.type === TT.IDENT && brace(2))
        return true;
      if (t.value === 'package' || t.value === 'include' || t.value === 'import') return true;
      if (t.type === TT.LEXICON) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function createParser(src) {
  const tokens = lex(src);
  let pos = 0;
  // Node ids marked `X$` in the blocks parsed since the last snapshot.
  let nonInjective = new Set();

  const peek = (k = 0) => tokens[pos + k];
  const at = (type, k = 0) => peek(k).type === type;
  const atKw = (word, k = 0) => at(TT.IDENT, k) && peek(k).value === word;
  const next = () => tokens[pos++];
  const fail = (msg, tok = peek()) => {
    const lines = src.split('\n');
    throw new GrewParseError(msg, tok.line, tok.col, lines[tok.line - 1] ?? '');
  };
  const expect = (type, what) => {
    if (!at(type)) fail(`Expected ${what || type} but found ${describe(peek())}`);
    return next();
  };
  const expectNode = () => expect(TT.IDENT, 'a node identifier').value;

  // --- entry points ---

  function request() {
    const blocks = [];
    while (!at(TT.EOF)) {
      if (at(TT.IDENT) && GRS_KEYWORDS.has(peek().value)) {
        fail(`\`${peek().value}\` is a rewriting keyword; a search takes only pattern blocks`);
      }
      blocks.push(parseBlock());
    }
    if (blocks.length === 0) fail('Empty query. Expected a `pattern { … }` block.');
    return { blocks, nonInjective: [...nonInjective] };
  }

  function grs() {
    const rules = [];
    const strats = [];
    const names = new Set();
    let anon = null; // blocks of an anonymous rule, until its `commands`
    const addRule = (rule) => {
      if (names.has(rule.name)) fail(`Rule '${rule.name}' is declared twice`, peek(-1));
      names.add(rule.name);
      rules.push(rule);
    };
    while (!at(TT.EOF)) {
      if (atKw('rule')) {
        if (anon) fail('Expected a `commands { … }` block to close the pattern above');
        addRule(parseRule());
      } else if (at(TT.LEXICON)) {
        // A lexicon goes with the anonymous rule around it: the one being
        // written, or the one just closed.
        const last = rules[rules.length - 1];
        const owner = anon || (last?.name === 'rule' ? last : null);
        if (!owner) fail('A lexicon belongs inside a rule');
        addLexicon(owner, next());
      } else if (atKw('strat')) {
        strats.push(parseStrat());
      } else if (atKw('package') || atKw('include') || atKw('import')) {
        throw new GrewUnsupportedError(
          peek().value,
          `\`${peek().value}\` is not supported; put every rule in this one box.`,
          peek().line,
        );
      } else if (at(TT.IDENT) && BLOCK_TYPES.has(peek().value)) {
        if (!anon) anon = { blocks: [], lexicons: {}, line: peek().line };
        anon.blocks.push(parseBlock());
      } else if (atKw('commands')) {
        if (!anon) fail('`commands` needs a `pattern { … }` block before it');
        const commands = parseCommands();
        addRule({
          name: 'rule',
          blocks: anon.blocks,
          nonInjective: takeNonInjective(),
          commands,
          lexicons: anon.lexicons,
          line: anon.line,
        });
        anon = null;
      } else {
        fail('Expected `rule`, `strat`, or a pattern block');
      }
    }
    if (anon) fail('Expected a `commands { … }` block after the pattern');
    if (rules.length === 0) fail('Empty rule set. Expected a `rule` or a pattern with `commands`.');
    rules.forEach(resolveLexiconRefs);
    return { rules, strats };
  }

  // --- lexicons ---

  // `#BEGIN name … #END`: tab-separated, first line the field names, blank
  // lines and `%` lines ignored, every row as wide as the header.
  function addLexicon(rule, tok) {
    const { name, body, bodyLine } = tok.value;
    if (rule.lexicons[name]) fail(`Lexicon '${name}' is declared twice`, tok);
    const lines = body.split('\n');
    let fields = null;
    const entries = [];
    lines.forEach((raw, k) => {
      const text = raw.replace(/\r$/, '');
      if (!text.trim() || text.trimStart().startsWith('%')) return;
      const cells = text.split(FIELD_SEP).map((c) => c.trim());
      if (!fields) {
        fields = cells;
        return;
      }
      if (cells.length !== fields.length) {
        const lines2 = src.split('\n');
        throw new GrewParseError(
          `Lexicon '${name}': ${cells.length} fields on a line, ${fields.length} in the header (fields are tab-separated)`,
          bodyLine + k,
          1,
          lines2[bodyLine + k - 1] ?? '',
        );
      }
      entries.push(Object.fromEntries(fields.map((f, i) => [f, cells[i]])));
    });
    if (!fields) fail(`Lexicon '${name}' has no header line`, tok);
    rule.lexicons[name] = { fields, entries };
  }

  // `X.lemma = lex.noun` parses as a comparison between two nodes; once the
  // rule's lexicons are known, the side that names one becomes a lexicon
  // reference value.
  function resolveLexiconRefs(rule) {
    const isLex = (id) => Object.prototype.hasOwnProperty.call(rule.lexicons, id);
    for (const block of rule.blocks) {
      block.items = block.items.map((item) => {
        if (item.kind !== 'featcmp') return item;
        const lexRight = isLex(item.right.node);
        const lexLeft = isLex(item.left.node);
        if (!lexRight && !lexLeft) return item;
        if (lexRight && lexLeft) {
          throw new GrewUnsupportedError(
            'lexicon-cmp',
            'Comparing two lexicon fields is not supported.',
            item.line,
          );
        }
        const side = lexRight ? item.left : item.right;
        const lex = lexRight ? item.right : item.left;
        return {
          kind: 'nodefeat',
          node: side.node,
          feat: side.feat,
          op: item.op,
          value: { type: 'lexref', lex: lex.node, field: lex.feat },
          line: item.line,
        };
      });
    }
  }

  function takeNonInjective() {
    const out = [...nonInjective];
    nonInjective = new Set();
    return out;
  }

  // --- rules and strategies ---

  function parseRule() {
    const kw = next(); // 'rule'
    const name = expect(TT.IDENT, 'a rule name').value;
    if (at(TT.LPAREN)) {
      // `rule r (lex from "file.lex")`: lexicon files.
      throw new GrewUnsupportedError(
        'lexicon-file',
        'Lexicon files are not supported; put the lexicon in the rule between #BEGIN name and #END.',
        peek().line,
      );
    }
    expect(TT.LBRACE, "'{'");
    const rule = {
      name,
      blocks: [],
      nonInjective: [],
      commands: null,
      lexicons: {},
      line: kw.line,
    };
    while (!at(TT.RBRACE) && !at(TT.EOF)) {
      if (at(TT.IDENT) && BLOCK_TYPES.has(peek().value)) {
        if (rule.commands) fail('Pattern blocks go before `commands`');
        rule.blocks.push(parseBlock());
      } else if (atKw('commands')) {
        if (rule.commands) fail('A rule has one `commands` block');
        rule.commands = parseCommands();
      } else if (at(TT.LEXICON)) {
        addLexicon(rule, next());
      } else {
        fail('Expected pattern, with, without, global, commands, or a #BEGIN lexicon');
      }
    }
    expect(TT.RBRACE, "'}'");
    if (rule.blocks.length === 0) fail(`Rule '${name}' has no \`pattern\` block`, kw);
    if (!rule.commands) fail(`Rule '${name}' has no \`commands\` block`, kw);
    rule.nonInjective = takeNonInjective();
    return rule;
  }

  function parseStrat() {
    const kw = next(); // 'strat'
    const name = expect(TT.IDENT, 'a strategy name').value;
    expect(TT.LBRACE, "'{'");
    const expr = parseStratExpr();
    expect(TT.RBRACE, "'}'");
    return { name, expr, line: kw.line };
  }

  function parseStratExpr() {
    const tok = expect(TT.IDENT, 'a strategy');
    const op = tok.value;
    if (!STRAT_OPS.has(op)) return { op: 'rule', name: op };
    if (op === 'Empty') return { op };
    expect(TT.LPAREN, "'('");
    const args = [parseStratExpr()];
    while (at(TT.COMMA)) {
      next();
      args.push(parseStratExpr());
    }
    expect(TT.RPAREN, "')'");
    if ((op === 'Seq' || op === 'Alt') === false && args.length !== 1) {
      fail(`${op} takes exactly one strategy`, tok);
    }
    return { op, args };
  }

  // --- commands ---

  function parseCommands() {
    next(); // 'commands'
    expect(TT.LBRACE, "'{'");
    const items = [];
    while (!at(TT.RBRACE) && !at(TT.EOF)) {
      items.push(parseCommand());
      while (at(TT.SEMI)) next();
    }
    expect(TT.RBRACE, "'}'");
    return items;
  }

  function parseCommand() {
    const tok = expect(TT.IDENT, 'a command');
    const kw = tok.value;
    const line = tok.line;
    switch (kw) {
      case 'del_edge': {
        // `del_edge e` (a bound edge) or `del_edge X -[obj]-> Y` (by description).
        if (at(TT.IDENT) && (at(TT.SEMI, 1) || at(TT.RBRACE, 1))) {
          return { kind: 'del_edge', edge: next().value, line };
        }
        const src = expectNode();
        expect(TT.EDGE_OPEN, "'-['");
        const label = parseLabelExpr();
        expect(TT.RBRACK, "']'");
        expect(TT.ARROW, "'->'");
        const tgt = expectNode();
        return { kind: 'del_edge', src, tgt, label, line };
      }
      case 'add_edge': {
        // `add_edge X -[obj]-> Y`, `add_edge e: X -> Y` (the label of the bound
        // edge e), or `add_edge f: X -[obj]-> Y` (a new edge named f).
        let id = null;
        if (at(TT.IDENT) && at(TT.COLON, 1)) {
          id = next().value;
          next();
        }
        const src = expectNode();
        let label = null;
        if (at(TT.EDGE_OPEN)) {
          next();
          label = parseLabelExpr();
          expect(TT.RBRACK, "']'");
        }
        expect(TT.ARROW, "'->'");
        const tgt = expectNode();
        if (!label && !id) fail('add_edge needs a label: add_edge X -[label]-> Y', tok);
        return { kind: 'add_edge', id, src, tgt, label, line };
      }
      case 'del_node':
        return { kind: 'del_node', node: expectNode(), line };
      case 'add_node': {
        const node = expectNode();
        let pos = null;
        if (at(TT.BEFORE) || at(TT.AFTER)) {
          const side = next().type === TT.BEFORE ? '<' : '>';
          pos = { side, ref: expectNode() };
        }
        return { kind: 'add_node', node, pos, line };
      }
      case 'shift':
      case 'shift_in':
      case 'shift_out': {
        const src = expectNode();
        let filter = { type: 'any' };
        if (at(TT.SHIFT)) next();
        else {
          expect(TT.SHIFT_OPEN, "'==>' or '=['");
          filter = parseLabelExpr();
          expect(TT.SHIFT_CLOSE, "']=>'");
        }
        const tgt = expectNode();
        const mode = kw === 'shift' ? 'all' : kw === 'shift_in' ? 'in' : 'out';
        return { kind: 'shift', mode, src, tgt, filter, line };
      }
      case 'del_feat': {
        const { node, feat } = parseFeatRef();
        return { kind: 'del_feat', node, feat, line };
      }
      case 'append_feats':
      case 'prepend_feats': {
        // `append_feats "/" X ==> Y`, `append_feats X =[re"Number|Gender"]=> Y`
        const sep = at(TT.STRING) ? next().value : '';
        const src = expectNode();
        let filter = null;
        if (at(TT.SHIFT)) next();
        else {
          expect(TT.SHIFT_OPEN, "'==>' or '=['");
          filter = parseLabelExpr();
          expect(TT.SHIFT_CLOSE, "']=>'");
        }
        const tgt = expectNode();
        return { kind: kw, src, tgt, sep, filter, line };
      }
      case 'unorder':
      case 'insert':
        throw new GrewUnsupportedError(
          kw,
          `\`${kw}\` is not supported: word order follows the text.`,
          line,
        );
      default: {
        // `X.upos = VERB`, `X.lemma = Y.lemma + "s"`, `e.2 = pass`
        if (!at(TT.DOT)) fail(`Unknown command '${kw}'`, tok);
        next();
        const feat = expectFeatName();
        expect(TT.EQ, "'='");
        const expr = parseExpr();
        return { kind: 'set_feat', node: kw, feat, expr, line };
      }
    }
  }

  function expectFeatName() {
    if (at(TT.IDENT) || at(TT.NUMBER)) return String(next().value);
    fail(`Expected a feature name but found ${describe(peek())}`);
  }

  function parseFeatRef() {
    const node = expectNode();
    expect(TT.DOT, "'.'");
    return { node, feat: expectFeatName() };
  }

  // atom ('+' atom)*
  function parseExpr() {
    const atoms = [parseAtom()];
    while (at(TT.PLUS)) {
      next();
      atoms.push(parseAtom());
    }
    return atoms;
  }

  function parseAtom() {
    if (at(TT.STRING)) return { type: 'lit', value: next().value };
    if (at(TT.NUMBER)) return { type: 'lit', value: String(next().value) };
    if (at(TT.IDENT)) {
      if (!at(TT.DOT, 1)) return { type: 'lit', value: next().value };
      const { node, feat } = parseFeatRef();
      let slice = null;
      if (at(TT.LBRACK)) {
        next();
        const start = at(TT.NUMBER) ? parseInt(next().value, 10) : null;
        expect(TT.COLON, "':'");
        const end = at(TT.NUMBER) ? parseInt(next().value, 10) : null;
        expect(TT.RBRACK, "']'");
        slice = [start, end];
      }
      return { type: 'ref', node, feat, slice };
    }
    fail(`Expected a value but found ${describe(peek())}`);
  }

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
    if (
      at(TT.IDENT) &&
      (peek().value === 'delta' || peek().value === 'length') &&
      at(TT.LPAREN, 1)
    ) {
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
      case TT.GT:
      case TT.GTGT:
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
    if (at(TT.STAR)) {
      next();
      return { wild: true };
    }
    const id = expect(TT.IDENT, 'a node identifier').value;
    if (at(TT.DOLLAR)) {
      next();
      nonInjective.add(id);
    }
    return { wild: false, id };
  }

  function parseNodeDecl(id, line) {
    const alts = [parseFeatureStruct()];
    while (at(TT.PIPE)) {
      next();
      alts.push(parseFeatureStruct());
    }
    return { kind: 'node', id, alts, line };
  }

  function parseFeatureStruct() {
    expect(TT.LBRACK, "'['");
    const items = [];
    if (!at(TT.RBRACK)) {
      items.push(parseFeatItem());
      while (at(TT.COMMA)) {
        next();
        items.push(parseFeatItem());
      }
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
    if (at(TT.EQ)) {
      next();
      return { name, op: '=', value: parseValueExpr() };
    }
    if (at(TT.NEQ)) {
      next();
      return { name, op: '<>', value: parseValueExpr() };
    }
    return { name, op: 'defined', value: null };
  }

  function parseValueExpr() {
    const items = [parseValueAtom()];
    while (at(TT.PIPE)) {
      next();
      items.push(parseValueAtom());
    }
    return items.length === 1 ? items[0] : { type: 'disj', items };
  }

  function parseValueAtom() {
    if (at(TT.STAR)) {
      next();
      return { type: 'any' };
    }
    if (at(TT.STRING)) return { type: 'lit', value: next().value };
    if (at(TT.REGEX)) {
      const r = next().value;
      return { type: 'regex', pattern: r.pattern, flavor: r.flavor, flags: r.flags };
    }
    if (at(TT.IDENT) && at(TT.DOT, 1)) {
      // `lex.field`: a lexicon reference (only meaningful in a rule).
      const lex = next().value;
      next();
      return { type: 'lexref', lex, field: expect(TT.IDENT, 'a lexicon field').value };
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
      return {
        kind: 'featcmp',
        left: { node: id, feat },
        op,
        right: { node: rnode, feat: rfeat },
        line,
      };
    }
    return { kind: 'nodefeat', node: id, feat, op, value: parseValueExpr(), line };
  }

  // `X > Y` / `X >> Y` are `Y < X` / `Y << X`.
  function parseOrder(id) {
    const tok = next();
    const op = tok.type === TT.LTLT || tok.type === TT.GTGT ? '<<' : '<';
    const other = expect(TT.IDENT, 'a node identifier').value;
    if (tok.type === TT.GT || tok.type === TT.GTGT)
      return { kind: 'order', op, left: other, right: id };
    return { kind: 'order', op, left: id, right: other };
  }

  function parseEdgeRest(edgeId, src) {
    let label = { type: 'any' };
    if (at(TT.EDGE_OPEN)) {
      next();
      label = parseLabelExpr();
      expect(TT.RBRACK, "']'");
    }
    let transitive;
    if (at(TT.ARROW)) {
      next();
      transitive = false;
    } else if (at(TT.DOMINATES)) {
      next();
      transitive = true;
    } else fail(`Expected '->' or '->>' but found ${describe(peek())}`);
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
    if (at(TT.CARET)) {
      next();
      negated = true;
    }

    // Edge-feature form: `1=nsubj, 2=pass, !deep` (key=val or !key, comma-sep).
    const looksFeature = at(TT.BANG) || ((at(TT.IDENT) || at(TT.NUMBER)) && at(TT.EQ, 1));
    if (!negated && looksFeature) {
      const feats = [];
      do {
        if (at(TT.BANG)) {
          next();
          feats.push({ key: expect(TT.IDENT, 'a feature name').value, neg: true });
        } else {
          const key = next().value;
          expect(TT.EQ, "'='");
          feats.push({ key, val: parseLabelAtom() });
        }
      } while (at(TT.COMMA) && (next(), true));
      return { type: 'features', feats };
    }

    // Label list: `nsubj | obj | nsubj:pass`
    const labels = [parseLabelAtom()];
    while (at(TT.PIPE)) {
      next();
      labels.push(parseLabelAtom());
    }
    return { type: 'list', labels, negated };
  }

  // A label atom can be subtyped with ':' (e.g. nsubj:pass), which the lexer
  // splits into IDENT COLON IDENT — reassemble it here.
  function parseLabelAtom() {
    if (at(TT.STRING)) return next().value;
    let s = String(expect(TT.IDENT, 'an edge label').value);
    while (at(TT.COLON)) {
      next();
      s += ':' + expect(TT.IDENT, 'a label subtype').value;
    }
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
    const op = { [TT.EQ]: '=', [TT.LT]: '<', [TT.LE]: '<=', [TT.GT]: '>', [TT.GE]: '>=' }[
      opTok.type
    ];
    if (!op) fail(`Expected a comparison operator after ${fn}(…)`, opTok);
    const nTok = expect(TT.NUMBER, 'a number');
    return { kind: 'dist', fn, a, b, op, n: parseInt(nTok.value, 10) };
  }

  // --- global items ---

  function parseGlobalItem() {
    // Optional `meta.` / `global.` prefix (Grew v1.18 in-pattern globals).
    if (at(TT.IDENT) && (peek().value === 'meta' || peek().value === 'global') && at(TT.DOT, 1)) {
      next();
      next();
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

  return { request, grs };
}

function describe(tok) {
  if (tok.type === TT.EOF) return 'end of input';
  if (tok.type === TT.STRING) return `string "${tok.value}"`;
  if (tok.type === TT.REGEX) return 'a regex literal';
  if (tok.type === TT.IDENT || tok.type === TT.NUMBER) return `'${tok.value}'`;
  return `'${tok.value ?? tok.type}'`;
}
