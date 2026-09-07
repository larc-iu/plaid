import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, parseGrs, looksLikeGrs } from '../src/grew/parser.js';
import { lex, TT } from '../src/grew/lexer.js';
import { GrewParseError, GrewUnsupportedError } from '../src/grew/errors.js';

const types = (s) =>
  lex(s)
    .map((t) => t.type)
    .filter((t) => t !== TT.EOF);

test('lexes the command operators greedily', () => {
  assert.deepEqual(types('X ==> Y'), [TT.IDENT, TT.SHIFT, TT.IDENT]);
  assert.deepEqual(types('X =[a|b]=> Y'), [
    TT.IDENT,
    TT.SHIFT_OPEN,
    TT.IDENT,
    TT.PIPE,
    TT.IDENT,
    TT.SHIFT_CLOSE,
    TT.IDENT,
  ]);
  assert.deepEqual(types('N :< X'), [TT.IDENT, TT.BEFORE, TT.IDENT]);
  assert.deepEqual(types('N :> X'), [TT.IDENT, TT.AFTER, TT.IDENT]);
  assert.deepEqual(types('a + "b"'), [TT.IDENT, TT.PLUS, TT.STRING]);
  // Requests still lex the same way (no `=[` false positive inside a node).
  assert.deepEqual(types('X [upos=VERB]'), [
    TT.IDENT,
    TT.LBRACK,
    TT.IDENT,
    TT.EQ,
    TT.IDENT,
    TT.RBRACK,
  ]);
});

test('looksLikeGrs spots rules, strats, and a bare commands block', () => {
  assert.equal(looksLikeGrs('pattern { X [upos=VERB] }'), false);
  assert.equal(looksLikeGrs('pattern { X [] } commands { X.upos = VERB }'), true);
  assert.equal(looksLikeGrs('rule r { pattern { X [] } commands { X.upos = VERB } }'), true);
  assert.equal(looksLikeGrs('strat main { Onf(r) }'), true);
  assert.equal(looksLikeGrs('pattern { X [commands=1] }'), false);
  assert.equal(looksLikeGrs('pattern { X [ '), false);
});

test('a request refuses rewriting keywords with a parse error', () => {
  assert.throws(
    () => parse('pattern { X [] } commands { X.upos = VERB }'),
    (e) => e instanceof GrewParseError && /rewriting keyword/.test(e.message),
  );
});

test('anonymous rule: blocks then commands', () => {
  const grs = parseGrs(`
    pattern { X [upos=NOUN]; Y [upos=DET]; e: X -[det]-> Y }
    without { X -[amod]-> * }
    commands { X.upos = PROPN; del_edge e }
  `);
  assert.equal(grs.rules.length, 1);
  const [r] = grs.rules;
  assert.equal(r.name, 'rule');
  assert.deepEqual(
    r.blocks.map((b) => b.type),
    ['pattern', 'without'],
  );
  assert.deepEqual(r.commands, [
    {
      kind: 'set_feat',
      node: 'X',
      feat: 'upos',
      expr: [{ type: 'lit', value: 'PROPN' }],
      line: 4,
    },
    { kind: 'del_edge', edge: 'e', line: 4 },
  ]);
  assert.deepEqual(grs.strats, []);
});

test('named rules, a strategy, and non-injective ids scoped per rule', () => {
  const grs = parseGrs(`
    rule a { pattern { X$ []; Y [] } commands { X.f = "1" } }
    rule b { pattern { Y [] } commands { del_node Y } }
    strat main { Onf(Alt(a, Seq(b, Empty), Try(Pick(Iter(a))))) }
  `);
  assert.deepEqual(
    grs.rules.map((r) => r.name),
    ['a', 'b'],
  );
  assert.deepEqual(grs.rules[0].nonInjective, ['X']);
  assert.deepEqual(grs.rules[1].nonInjective, []);
  assert.deepEqual(grs.strats[0].expr, {
    op: 'Onf',
    args: [
      {
        op: 'Alt',
        args: [
          { op: 'rule', name: 'a' },
          { op: 'Seq', args: [{ op: 'rule', name: 'b' }, { op: 'Empty' }] },
          {
            op: 'Try',
            args: [{ op: 'Pick', args: [{ op: 'Iter', args: [{ op: 'rule', name: 'a' }] }] }],
          },
        ],
      },
    ],
  });
});

test('every command shape parses', () => {
  const cmds = (s) =>
    parseGrs(`pattern { X []; Y []; e: X -> Y } commands { ${s} }`).rules[0].commands;
  assert.deepEqual(cmds('del_edge X -[obj]-> Y')[0], {
    kind: 'del_edge',
    src: 'X',
    tgt: 'Y',
    label: { type: 'list', labels: ['obj'], negated: false },
    line: 1,
  });
  assert.deepEqual(cmds('add_edge X -[nsubj:pass]-> Y')[0], {
    kind: 'add_edge',
    id: null,
    src: 'X',
    tgt: 'Y',
    label: { type: 'list', labels: ['nsubj:pass'], negated: false },
    line: 1,
  });
  assert.deepEqual(cmds('add_edge e: Y -> X')[0], {
    kind: 'add_edge',
    id: 'e',
    src: 'Y',
    tgt: 'X',
    label: null,
    line: 1,
  });
  assert.deepEqual(cmds('add_edge f: X -[1=obj, 2=lvc]-> Y')[0].label, {
    type: 'features',
    feats: [
      { key: '1', val: 'obj' },
      { key: '2', val: 'lvc' },
    ],
  });
  assert.deepEqual(cmds('del_node X')[0], { kind: 'del_node', node: 'X', line: 1 });
  assert.deepEqual(cmds('add_node N :< X')[0], {
    kind: 'add_node',
    node: 'N',
    pos: { side: '<', ref: 'X' },
    line: 1,
  });
  assert.deepEqual(cmds('shift X ==> Y')[0], {
    kind: 'shift',
    mode: 'all',
    src: 'X',
    tgt: 'Y',
    filter: { type: 'any' },
    line: 1,
  });
  assert.deepEqual(cmds('shift_in X =[^nsubj|obj]=> Y')[0], {
    kind: 'shift',
    mode: 'in',
    src: 'X',
    tgt: 'Y',
    filter: { type: 'list', labels: ['nsubj', 'obj'], negated: true },
    line: 1,
  });
  assert.equal(cmds('shift_out X =[re"^n"]=> Y')[0].filter.type, 'regex');
  assert.deepEqual(cmds('del_feat X.Number')[0], {
    kind: 'del_feat',
    node: 'X',
    feat: 'Number',
    line: 1,
  });
  assert.deepEqual(cmds('e.2 = pass')[0], {
    kind: 'set_feat',
    node: 'e',
    feat: '2',
    expr: [{ type: 'lit', value: 'pass' }],
    line: 1,
  });
  assert.deepEqual(cmds('X.lemma = Y.lemma + "/" + Y.form[1:-1] + 3')[0].expr, [
    { type: 'ref', node: 'Y', feat: 'lemma', slice: null },
    { type: 'lit', value: '/' },
    { type: 'ref', node: 'Y', feat: 'form', slice: [1, -1] },
    { type: 'lit', value: '3' },
  ]);
  assert.deepEqual(cmds('X.f = Y.f[:2]')[0].expr[0].slice, [null, 2]);
  assert.deepEqual(cmds('append_feats X ==> Y')[0], {
    kind: 'append_feats',
    src: 'X',
    tgt: 'Y',
    sep: '',
    filter: null,
    line: 1,
  });
  assert.equal(cmds('prepend_feats X ==> Y')[0].kind, 'prepend_feats');
  const ap = cmds('append_feats "/" X =[re"Number|Gender"]=> Y')[0];
  assert.equal(ap.sep, '/');
  assert.equal(ap.filter.type, 'regex');
  // Semicolons and newlines both separate commands; comments are skipped.
  assert.equal(cmds('del_node X; % gone\n del_node Y').length, 2);
});

test('errors: unknown command, missing commands, duplicate names, unsupported keywords', () => {
  const parseErr = (src, re) =>
    assert.throws(
      () => parseGrs(src),
      (e) => e instanceof GrewParseError && re.test(e.message),
    );
  parseErr('pattern { X [] } commands { frobnicate X }', /Unknown command 'frobnicate'/);
  parseErr('pattern { X [] }', /commands/);
  parseErr('commands { X.upos = VERB }', /pattern/);
  parseErr('rule r { commands { X.upos = VERB } }', /no `pattern`/);
  parseErr(
    'rule r { pattern { X [] } commands { del_node X } } rule r { pattern { X [] } commands { del_node X } }',
    /declared twice/,
  );
  parseErr('pattern { X [] } commands { add_edge X -> Y }', /needs a label/);
  parseErr('strat main { Onf(a, b) }', /exactly one/);
  assert.throws(
    () => parseGrs('pattern { X [] } commands { unorder X }'),
    (e) => e instanceof GrewUnsupportedError && e.feature === 'unorder',
  );
  assert.throws(
    () => parseGrs('package p { rule r { pattern { X [] } commands { del_node X } } }'),
    (e) => e instanceof GrewUnsupportedError && e.feature === 'package',
  );
});

test('X > Y and X >> Y are Y < X and Y << X', () => {
  const items = (s) => parse(s).blocks[0].items;
  assert.deepEqual(items('pattern { X > Y }')[0], {
    kind: 'order',
    op: '<',
    left: 'Y',
    right: 'X',
  });
  assert.deepEqual(items('pattern { X >> Y }')[0], {
    kind: 'order',
    op: '<<',
    left: 'Y',
    right: 'X',
  });
  assert.deepEqual(items('pattern { X << Y }')[0], {
    kind: 'order',
    op: '<<',
    left: 'X',
    right: 'Y',
  });
});

test('lexicon references parse in brackets and dot constraints; the search box refuses them', async () => {
  const { parseAndCompile } = await import('../src/grew/index.js');
  const grs = parseGrs(
    'pattern { X [lemma=lex.noun]; X.upos = lex.pos } commands { X.Gender = lex.g }\n#BEGIN lex\nnoun\tpos\tg\na\tb\tc\n#END',
  );
  const [node, dot] = grs.rules[0].blocks[0].items;
  assert.deepEqual(node.alts[0][0].value, { type: 'lexref', lex: 'lex', field: 'noun' });
  assert.equal(dot.kind, 'nodefeat');
  assert.deepEqual(dot.value, { type: 'lexref', lex: 'lex', field: 'pos' });
  assert.deepEqual(grs.rules[0].lexicons.lex, {
    fields: ['noun', 'pos', 'g'],
    entries: [{ noun: 'a', pos: 'b', g: 'c' }],
  });
  assert.throws(
    () =>
      parseAndCompile('pattern { X [lemma=lex.noun] }', {
        sentenceTokenLayer: { id: 'S' },
        morphemeTokenLayer: { id: 'M' },
        lemmaLayer: { id: 'L' },
      }),
    (e) => e instanceof GrewUnsupportedError && e.feature === 'lexicon',
  );
});
