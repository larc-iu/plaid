// Recursive-descent parser for Grew syntax → AST (see ast.js).
//
// Hand-written to match house style (src/utils/conlluParser.js is also
// hand-written) and to keep precise line/col on every error. The parser is a
// pure grammar recognizer: it accepts the full surface syntax and never decides
// what is "supported" — that judgement belongs to compile.js (search) and the
// rewrite engine (rules), which walk this AST and throw GrewUnsupportedError
// for the residue. So e.g. labeled transitive edges, edge-feature labels, or
// an `add_node` command parse fine here and may be rejected later. The one
// exception is a regex, which is read here (parseRegex) so its error has a line.
//
// Two entry points share one grammar:
//   parse(src)    — a REQUEST: pattern/with/without/global blocks (the search box)
//   parseGrs(src) — a REWRITING SYSTEM: `rule` blocks (a request plus a
//                   `commands` block each), optional `strat` declarations, or a
//                   bare anonymous rule (blocks followed by `commands { … }`).

import { lex, TT } from './lexer.js';
import { GrewParseError, GrewUnsupportedError } from './errors.js';
import { BLOCK_TYPES } from './ast.js';
import { regexError } from './userRegex.js';
import { splitLabel } from './edgeLabel.js';
import { t, msg } from '../../../plaid-ui/src/lib/i18n.js';

const STRAT_OPS = new Set(['Onf', 'Iter', 'Seq', 'Alt', 'Pick', 'Try', 'Empty']);
const FIELD_SEP = '\t';
const GRS_KEYWORDS = new Set(['rule', 'strat', 'commands', 'package', 'include', 'import']);
// Refused: see parseGlobalItem.
const TREE_FLAGS = new Set(['is_tree', 'is_not_tree']);
// Two expectations more than one place names.
const NODE_ID = msg('Expected a node identifier but found {found}');
const FEATURE_NAME = msg('Expected a feature name but found {found}');

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
      const tok = toks[i];
      if (tok.type !== TT.IDENT) continue;
      const brace = (k) => toks[i + k]?.type === TT.LBRACE;
      if (tok.value === 'commands' && brace(1)) return true;
      if (
        (tok.value === 'rule' || tok.value === 'strat') &&
        toks[i + 1]?.type === TT.IDENT &&
        brace(2)
      )
        return true;
      if (tok.value === 'package' || tok.value === 'include' || tok.value === 'import') return true;
      if (tok.type === TT.LEXICON) return true;
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
  // `expected` is the whole message, a msg() taking `found`.
  const expect = (type, expected) => {
    if (!at(type)) fail(t(expected, { found: describe(peek()) }));
    return next();
  };
  // `token` is code, as the person writes it: "'{'".
  const expectToken = (type, token) => {
    if (!at(type))
      fail(t('Expected {token} but found {found}', { token, found: describe(peek()) }));
    return next();
  };
  const expectNode = () => expect(TT.IDENT, NODE_ID).value;

  // --- entry points ---

  function request() {
    const blocks = [];
    while (!at(TT.EOF)) {
      if (at(TT.IDENT) && GRS_KEYWORDS.has(peek().value)) {
        fail(
          t('`{keyword}` is a rewriting keyword. A search takes only pattern blocks.', {
            keyword: peek().value,
          }),
        );
      }
      blocks.push(parseBlock());
    }
    if (blocks.length === 0)
      fail(t('Empty query. Expected a `{block}` block.', { block: 'pattern { … }' }));
    refuseEdgeConstraints(blocks);
    return { blocks, nonInjective: [...nonInjective] };
  }

  function grs() {
    const rules = [];
    const strats = [];
    const names = new Set();
    let anon = null; // blocks of an anonymous rule, until its `commands`
    const addRule = (rule) => {
      if (names.has(rule.name))
        fail(t("Rule ''{name}'' is declared twice", { name: rule.name }), peek(-1));
      names.add(rule.name);
      rules.push(rule);
    };
    while (!at(TT.EOF)) {
      if (atKw('rule')) {
        if (anon)
          fail(
            t('Expected a `{block}` block to close the pattern above', { block: 'commands { … }' }),
          );
        addRule(parseRule());
      } else if (at(TT.LEXICON)) {
        // A lexicon goes with the anonymous rule around it: the one being
        // written, or the one just closed.
        const last = rules[rules.length - 1];
        const owner = anon || (last?.name === 'rule' ? last : null);
        if (!owner) fail(t('A lexicon belongs inside a rule'));
        addLexicon(owner, next());
      } else if (atKw('strat')) {
        strats.push(parseStrat());
      } else if (atKw('package') || atKw('include') || atKw('import')) {
        throw new GrewUnsupportedError(
          peek().value,
          t('`{keyword}` is not supported. Put every rule in this one box.', {
            keyword: peek().value,
          }),
          peek().line,
        );
      } else if (at(TT.IDENT) && BLOCK_TYPES.has(peek().value)) {
        if (!anon) anon = { blocks: [], lexicons: {}, line: peek().line };
        anon.blocks.push(parseBlock());
      } else if (atKw('commands')) {
        if (!anon)
          fail(t('`commands` needs a `{block}` block before it', { block: 'pattern { … }' }));
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
        fail(t('Expected `rule`, `strat`, or a pattern block'));
      }
    }
    if (anon) fail(t('Expected a `{block}` block after the pattern', { block: 'commands { … }' }));
    if (rules.length === 0)
      fail(t('Empty rule set. Expected a `rule` or a pattern with `commands`.'));
    rules.forEach(resolveLexiconRefs);
    rules.forEach((rule) => refuseEdgeConstraints(rule.blocks));
    return { rules, strats };
  }

  // --- lexicons ---

  // `#BEGIN name … #END`: tab-separated, first line the field names, blank
  // lines and `%` lines ignored, every row as wide as the header.
  function addLexicon(rule, tok) {
    const { name, body, bodyLine } = tok.value;
    if (rule.lexicons[name]) fail(t("Lexicon ''{name}'' is declared twice", { name }), tok);
    const lines = body.split('\n');
    let fields = null;
    const entries = [];
    lines.forEach((raw, k) => {
      const text = raw.replace(/\r$/, '');
      if (!text.trim() || text.trimStart().startsWith('%')) return;
      const cells = text.split(FIELD_SEP).map((c) => c.trim());
      const sourceLine = () => src.split('\n')[bodyLine + k - 1] ?? '';
      if (!fields) {
        // A field name never holds a space: a header that does was pasted
        // with spaces for tabs.
        if (cells.some((c) => /\s/.test(c))) {
          throw new GrewParseError(
            t("Lexicon ''{name}'': fields are separated by tabs, not spaces", { name }),
            bodyLine + k,
            1,
            sourceLine(),
          );
        }
        fields = cells;
        return;
      }
      if (cells.length !== fields.length) {
        throw new GrewParseError(
          t(
            "Lexicon ''{name}'': {n} fields on a line, {header} in the header (fields are tab-separated)",
            { name, n: cells.length, header: fields.length },
          ),
          bodyLine + k,
          1,
          sourceLine(),
        );
      }
      entries.push(Object.fromEntries(fields.map((f, i) => [f, cells[i]])));
    });
    if (!fields) fail(t("Lexicon ''{name}'' has no header line", { name }), tok);
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
            t('Comparing two lexicon fields is not supported.'),
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

  // `e.label = nsubj` on a named edge reads as a feature of a node called e,
  // which matched nothing and said nothing. A pattern names an edge's label in
  // the edge (commands and Count by do take `e.label`).
  function refuseEdgeConstraints(blocks) {
    const edges = new Set();
    for (const block of blocks) {
      for (const item of block.items) {
        if ((item.kind === 'edge' || item.kind === 'dominates') && item.id) edges.add(item.id);
      }
    }
    for (const block of blocks) {
      for (const item of block.items) {
        let sides = [];
        if (item.kind === 'nodefeat') sides = [{ node: item.node, feat: item.feat }];
        if (item.kind === 'featcmp') sides = [item.left, item.right];
        const side = sides.find((x) => edges.has(x.node));
        if (side) {
          throw new GrewUnsupportedError(
            'edge-constraint',
            t(
              '`{node}.{feat}` is not supported in a pattern. Name the label in the edge: e: X -[nsubj]-> Y.',
              { node: side.node, feat: side.feat },
            ),
            item.line,
          );
        }
      }
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
    const nameTok = expect(TT.IDENT, msg('Expected a rule name but found {found}'));
    const name = nameTok.value;
    // `rule` is what the parser calls a rule written without a name.
    if (name === 'rule') fail(t("A rule cannot be named 'rule'"), nameTok);
    if (at(TT.LPAREN)) {
      // `rule r (lex from "file.lex")`: lexicon files.
      throw new GrewUnsupportedError(
        'lexicon-file',
        t(
          'Lexicon files are not supported. Put the lexicon in the rule between #BEGIN name and #END.',
        ),
        peek().line,
      );
    }
    expectToken(TT.LBRACE, "'{'");
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
        if (rule.commands) fail(t('Pattern blocks go before `commands`'));
        rule.blocks.push(parseBlock());
      } else if (atKw('commands')) {
        if (rule.commands) fail(t('A rule has one `commands` block'));
        rule.commands = parseCommands();
      } else if (at(TT.LEXICON)) {
        addLexicon(rule, next());
      } else {
        fail(t('Expected pattern, with, without, global, commands, or a #BEGIN lexicon'));
      }
    }
    expectToken(TT.RBRACE, "'}'");
    if (rule.blocks.length === 0) fail(t("Rule ''{name}'' has no `pattern` block", { name }), kw);
    if (!rule.commands) fail(t("Rule ''{name}'' has no `commands` block", { name }), kw);
    rule.nonInjective = takeNonInjective();
    return rule;
  }

  function parseStrat() {
    const kw = next(); // 'strat'
    const name = expect(TT.IDENT, msg('Expected a strategy name but found {found}')).value;
    expectToken(TT.LBRACE, "'{'");
    const expr = parseStratExpr();
    expectToken(TT.RBRACE, "'}'");
    return { name, expr, line: kw.line };
  }

  function parseStratExpr() {
    const tok = expect(TT.IDENT, msg('Expected a strategy but found {found}'));
    const op = tok.value;
    if (!STRAT_OPS.has(op)) return { op: 'rule', name: op };
    if (op === 'Empty') return { op };
    expectToken(TT.LPAREN, "'('");
    const args = [parseStratExpr()];
    while (at(TT.COMMA)) {
      next();
      args.push(parseStratExpr());
    }
    expectToken(TT.RPAREN, "')'");
    if ((op === 'Seq' || op === 'Alt') === false && args.length !== 1) {
      fail(t('{op} takes exactly one strategy', { op }), tok);
    }
    return { op, args };
  }

  // --- commands ---

  function parseCommands() {
    next(); // 'commands'
    expectToken(TT.LBRACE, "'{'");
    const items = [];
    while (!at(TT.RBRACE) && !at(TT.EOF)) {
      items.push(parseCommand());
      while (at(TT.SEMI)) next();
    }
    expectToken(TT.RBRACE, "'}'");
    return items;
  }

  function parseCommand() {
    const tok = expect(TT.IDENT, msg('Expected a command but found {found}'));
    const kw = tok.value;
    const line = tok.line;
    switch (kw) {
      case 'del_edge': {
        // `del_edge e` (a bound edge) or `del_edge X -[obj]-> Y` (by description).
        if (at(TT.IDENT) && (at(TT.SEMI, 1) || at(TT.RBRACE, 1))) {
          return { kind: 'del_edge', edge: next().value, line };
        }
        const src = expectNode();
        expectToken(TT.EDGE_OPEN, "'-['");
        const label = parseLabelExpr();
        expectToken(TT.RBRACK, "']'");
        expectToken(TT.ARROW, "'->'");
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
          expectToken(TT.RBRACK, "']'");
        }
        expectToken(TT.ARROW, "'->'");
        const tgt = expectNode();
        if (!label && !id) fail(t('add_edge needs a label: add_edge X -[label]-> Y'), tok);
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
          expectToken(TT.SHIFT_OPEN, "'==>' or '=['");
          filter = parseLabelExpr();
          expectToken(TT.SHIFT_CLOSE, "']=>'");
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
          expectToken(TT.SHIFT_OPEN, "'==>' or '=['");
          filter = parseLabelExpr();
          expectToken(TT.SHIFT_CLOSE, "']=>'");
        }
        const tgt = expectNode();
        return { kind: kw, src, tgt, sep, filter, line };
      }
      case 'unorder':
      case 'insert':
        throw new GrewUnsupportedError(
          kw,
          t('`{keyword}` is not supported: word order follows the text.', { keyword: kw }),
          line,
        );
      default: {
        // `X.upos = VERB`, `X.lemma = Y.lemma + "s"`, `e.2 = pass`
        if (!at(TT.DOT)) fail(t("Unknown command ''{command}''", { command: kw }), tok);
        next();
        const feat = expectFeatName();
        expectToken(TT.EQ, "'='");
        const expr = parseExpr();
        return { kind: 'set_feat', node: kw, feat, expr, line };
      }
    }
  }

  function expectFeatName() {
    if (at(TT.IDENT) || at(TT.NUMBER)) return String(next().value);
    fail(t(FEATURE_NAME, { found: describe(peek()) }));
  }

  function parseFeatRef() {
    const node = expectNode();
    expectToken(TT.DOT, "'.'");
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
        expectToken(TT.COLON, "':'");
        const end = at(TT.NUMBER) ? parseInt(next().value, 10) : null;
        expectToken(TT.RBRACK, "']'");
        slice = [start, end];
      }
      return { type: 'ref', node, feat, slice };
    }
    fail(t('Expected a value but found {found}', { found: describe(peek()) }));
  }

  // --- blocks ---

  function parseBlock() {
    if (!at(TT.IDENT) || !BLOCK_TYPES.has(peek().value)) {
      fail(t('Expected a block keyword: pattern, with, without, or global'));
    }
    const kw = next();
    expectToken(TT.LBRACE, "'{'");
    const items = [];
    while (!at(TT.RBRACE) && !at(TT.EOF)) {
      items.push(kw.value === 'global' ? parseGlobalItem() : parseClause());
      while (at(TT.SEMI)) next(); // optional clause separators
    }
    expectToken(TT.RBRACE, "'}'");
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

    const idTok = expect(TT.IDENT, msg('Expected a node/edge identifier but found {found}'));
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
        const right = expect(TT.IDENT, msg('Expected an edge identifier but found {found}')).value;
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
    const id = expect(TT.IDENT, NODE_ID).value;
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
    expectToken(TT.LBRACK, "'['");
    const items = [];
    if (!at(TT.RBRACK)) {
      items.push(parseFeatItem());
      while (at(TT.COMMA)) {
        next();
        items.push(parseFeatItem());
      }
    }
    expectToken(TT.RBRACK, "']'");
    return items;
  }

  function parseFeatItem() {
    if (at(TT.BANG)) {
      next();
      const name = expect(TT.IDENT, FEATURE_NAME).value;
      return { name, op: 'undefined', value: null };
    }
    const name = expect(TT.IDENT, FEATURE_NAME).value;
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

  // A regex is read here, where its line is known, by the one reading the
  // search and the rewrite share (userRegex.js), so a pattern neither can read
  // stops with a caret under it.
  function parseRegex() {
    const tok = peek();
    const r = next().value;
    const value = { type: 'regex', pattern: r.pattern, flavor: r.flavor, flags: r.flags };
    const error = regexError(value);
    if (error) fail(error, tok);
    return value;
  }

  // An edge label regex opening with `E:` (or `^E:`) asks the enhanced graph,
  // and the search and the rewrite match what follows the prefix
  // (edgeLabel.js splitLabel). That cut pattern is read here too, so its error
  // has the label's caret.
  function parseLabelRegex() {
    const tok = peek();
    const value = parseRegex();
    const { enhanced } = splitLabel(value);
    if (enhanced && enhanced !== value) {
      const error = regexError(enhanced);
      if (error)
        fail(
          t('After the E: prefix, {reason}', {
            reason: error.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase()),
          }),
          tok,
        );
    }
    return value;
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
    if (at(TT.REGEX)) return parseRegex();
    if (at(TT.IDENT) && at(TT.DOT, 1)) {
      // `lex.field`: a lexicon reference (only meaningful in a rule).
      const lex = next().value;
      next();
      return {
        type: 'lexref',
        lex,
        field: expect(TT.IDENT, msg('Expected a lexicon field but found {found}')).value,
      };
    }
    if (at(TT.IDENT) || at(TT.NUMBER)) {
      // allow subtyped values like Number=Sing[psor]? — keep simple: ident/number
      return { type: 'lit', value: next().value };
    }
    fail(t('Expected a value but found {found}', { found: describe(peek()) }));
  }

  function parseNodeDotConstraint(id, line) {
    expectToken(TT.DOT, "'.'");
    const feat = expect(TT.IDENT, FEATURE_NAME).value;
    const op = at(TT.NEQ) ? '<>' : (expectToken(TT.EQ, "'=' or '<>'"), '=');
    if (op === '<>') next();
    // Right side: Y.feat (cross-node) or a value.
    if (at(TT.IDENT) && at(TT.DOT, 1)) {
      const rnode = next().value;
      next(); // '.'
      const rfeat = expect(TT.IDENT, FEATURE_NAME).value;
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
    const other = expect(TT.IDENT, NODE_ID).value;
    if (tok.type === TT.GT || tok.type === TT.GTGT)
      return { kind: 'order', op, left: other, right: id };
    return { kind: 'order', op, left: id, right: other };
  }

  function parseEdgeRest(edgeId, src) {
    let label = { type: 'any' };
    if (at(TT.EDGE_OPEN)) {
      next();
      label = parseLabelExpr();
      expectToken(TT.RBRACK, "']'");
    }
    let transitive;
    if (at(TT.ARROW)) {
      next();
      transitive = false;
    } else if (at(TT.DOMINATES)) {
      next();
      transitive = true;
    } else
      fail(
        t('Expected {token} but found {found}', {
          token: "'->' or '->>'",
          found: describe(peek()),
        }),
      );
    const tgt = parseRef();
    if (transitive) return { kind: 'dominates', id: edgeId, left: src, right: tgt, label };
    return { kind: 'edge', id: edgeId, src, tgt, label };
  }

  function parseLabelExpr() {
    if (at(TT.REGEX)) return parseLabelRegex();
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
          feats.push({ key: expect(TT.IDENT, FEATURE_NAME).value, neg: true });
        } else {
          const key = next().value;
          expectToken(TT.EQ, "'='");
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
    let s = String(expect(TT.IDENT, msg('Expected an edge label but found {found}')).value);
    while (at(TT.COLON)) {
      next();
      s += ':' + expect(TT.IDENT, msg('Expected a label subtype but found {found}')).value;
    }
    return s;
  }

  function parseDist() {
    const fn = next().value; // delta | length
    expectToken(TT.LPAREN, "'('");
    const a = expect(TT.IDENT, NODE_ID).value;
    expectToken(TT.COMMA, "','");
    const b = expect(TT.IDENT, NODE_ID).value;
    expectToken(TT.RPAREN, "')'");
    const opTok = next();
    const op = { [TT.EQ]: '=', [TT.LT]: '<', [TT.LE]: '<=', [TT.GT]: '>', [TT.GE]: '>=' }[
      opTok.type
    ];
    if (!op) fail(t('Expected a comparison operator after {fn}(…)', { fn }), opTok);
    const nTok = expect(TT.NUMBER, msg('Expected a number but found {found}'));
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
      const key = expect(TT.IDENT, msg('Expected a metadata key but found {found}')).value;
      return { kind: 'globalmeta', key, op: 'undefined', value: null };
    }
    const idTok = expect(TT.IDENT, msg('Expected a global constraint but found {found}'));
    if (/^is_/.test(idTok.value) && !at(TT.EQ) && !at(TT.NEQ)) {
      // An import keeps words with no head, so whether a sentence is one tree
      // is a question the search cannot answer from the invariant.
      if (TREE_FLAGS.has(idTok.value)) {
        throw new GrewUnsupportedError(
          idTok.value,
          t('`{keyword}` is not supported.', { keyword: idTok.value }),
          idTok.line,
        );
      }
      return { kind: 'globalflag', name: idTok.value, line: idTok.line };
    }
    const op = at(TT.NEQ) ? '<>' : (expectToken(TT.EQ, "'=' or '<>'"), '=');
    if (op === '<>') next();
    return { kind: 'globalmeta', key: idTok.value, op, value: parseValueExpr(), line: idTok.line };
  }

  return { request, grs };
}

// What was found instead, as it stands after "but found".
function describe(tok) {
  if (tok.type === TT.EOF) return t('end of input');
  if (tok.type === TT.STRING) return t('string "{value}"', { value: tok.value });
  if (tok.type === TT.REGEX) return t('a regex literal');
  if (tok.type === TT.IDENT || tok.type === TT.NUMBER) return `'${tok.value}'`;
  return `'${tok.value ?? tok.type}'`;
}
