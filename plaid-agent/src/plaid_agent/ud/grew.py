"""A Grew request compiled to ONE Plaid query, as plaid-ud's Search tab does.

A port of plaid-ud's ``src/grew/compile.js`` and ``src/grew/regex.js``, kept
in step with them by ``tests/test_grew_mirror.py``, which compiles the same
patterns with both and compares the queries and the refusals. Anything the
query language cannot express is refused with a :class:`GrewUnsupportedError`
naming the construct, never answered with a silent mismatch. The Search tab
runs the query as it is, with no filter after it, so neither does this.

What is left out is what only the tab's other jobs need: counting by a field
(``countBy``), a rewriting rule's lexicons, and the note telling a rewrite
that a root may have been missed.

Data-model mapping (see :mod:`.project`):

* a node ``X`` is a token ``?n_X`` on the syntactic-word layer, ``within`` the
  sentence token ``?S``
* upos, xpos and lemma are one span each, covering the word
* a FEATS feature is one span per ``Key=Value`` on the features layer
* ``form`` is the word's Form span where it has one and its token's text
  otherwise
* an edge ``X -[r]-> Y`` is a relation whose source is X's LEMMA span and
  whose target is Y's, on the tree's layer or, for an ``E:`` label, the
  enhanced graph's
"""

import json
from dataclasses import dataclass, field, replace
from typing import Any, Dict, List, Optional

from .grew_syntax import (ANY, GrewError, GrewParseError, GrewUnsupportedError, bare_label,
                          parse, server_regex, split_label)

__all__ = ['GrewError', 'GrewParseError', 'GrewUnsupportedError', 'GrewLayers', 'Compiled',
           'compile_grew', 'parse_and_compile', 'layers_of']

COLUMN_FEATS = {'upos': 'upos', 'xpos': 'xpos', 'lemma': 'lemma'}

# The REGEXP UDF matches on `contains`, so "." means "at least one character":
# any span carrying a value, and no span carrying null.
ANY_VALUE = {'regex': '.'}
MAX_LINEAR_DISTANCE = 50
DEFAULT_LIMIT = 200


# --- regexes over stored values ---------------------------------------------
#
# Plaid runs java.util.regex as a substring search, so these anchor with ^ and
# $ wherever a whole value is meant. A FEATS span stores "Key=Value", which is
# why a feature constraint is an anchored pattern over that string.

_META = set('.\\+*?(){}[]^$|')


def escape_regex(s: Any) -> str:
    """A literal that matches itself inside a Java regex."""
    return ''.join('\\' + c if c in _META else c for c in str(s))


def feat_defined_regex(name: str) -> str:
    """Feature ``name`` is defined, with any value."""
    return f'^{escape_regex(name)}='


def feat_neq_regex(name: str, val: str) -> str:
    """Feature ``name`` is defined and its value is not ``val``."""
    return f'^{escape_regex(name)}=(?!{escape_regex(val)}$)'


def feat_eq_value(name: str, val: str) -> str:
    """The exact stored value for ``name=val``."""
    return f'{name}={val}'


def feat_value_regex(name: str, pattern: str) -> str:
    """A person's regex over one feature's VALUE, as a regex over the stored
    "name=value": a search anywhere in the value, where each ``^`` that is an
    anchor means the start of the value."""
    key = f'^{escape_regex(name)}='
    return f'{key}.*?(?:{_value_anchors(pattern, f"(?<={key})")})'


def _value_anchors(pattern: str, start: str) -> str:
    """``pattern`` with every ``^`` that is an anchor replaced by ``start``.
    Escapes, ``\\Q…\\E`` quoting and character classes (nested, as Java reads
    them) are copied as they are."""
    out = ''
    depth = 0
    i = 0
    n = len(pattern)
    while i < n:
        c = pattern[i]
        if c == '\\':
            quote_end = pattern.find('\\E', i + 2) if pattern[i + 1:i + 2] == 'Q' else -2
            end = i + 2
            if quote_end >= 0:
                end = quote_end + 2
            elif quote_end == -1:
                end = n
            out += pattern[i:end]
            i = end
            continue
        if depth > 0:
            if c == '[':
                depth += 1
            elif c == ']':
                depth -= 1
            out += c
        elif c == '[':
            depth = 1
            out += c
            # A `]` first in a class (after any `^`) is a literal, not its end.
            if pattern[i + 1:i + 2] == '^':
                i += 1
                out += pattern[i]
            if pattern[i + 1:i + 2] == ']':
                i += 1
                out += pattern[i]
        else:
            out += start if c == '^' else c
        i += 1
    return out


# A FEATS span that holds a feature: a name and a value either side of the
# first `=`, neither of them blank.
_FEATURE_PAIR = '[^=]*[^=\\s][^=]*=[\\s\\S]*\\S'
FEATURE_PAIR_REGEX = f'^{_FEATURE_PAIR}'


def other_feature_pair_regex(pair: str) -> str:
    """A FEATS span holding a feature other than exactly ``pair``."""
    return f'^(?!{escape_regex(pair)}$){_FEATURE_PAIR}'


def negated_label_regex(labels: List[str]) -> str:
    """A deprel that is not exactly one of ``labels`` (``-[^a|b]->``)."""
    return '^(?!(?:' + '|'.join(escape_regex(x) for x in labels) + ')$)'


def not_exactly_regex(val: str) -> str:
    """A single value that is not exactly ``val`` (``upos<>VERB``)."""
    return f'^(?!{escape_regex(val)}$)'


def features_label_regex(feats: List[Dict[str, Any]]) -> str:
    """The deprel regex for ``1=nsubj, 2=pass``: the values joined with ``:``
    in key order, matched as a subtype prefix."""
    joined = ':'.join(f['val'] for f in sorted(feats, key=lambda f: int(f['key'])))
    return f'^{escape_regex(joined)}(:|$)'


# --- the project's layers ----------------------------------------------------

@dataclass
class GrewLayers:
    """The layer ids a request is compiled against. None where the project
    has no such layer, which refuses any constraint on it."""
    sentence: Optional[str]
    word: Optional[str]
    lemma: Optional[str]
    upos: Optional[str]
    xpos: Optional[str]
    features: Optional[str]
    form: Optional[str]
    relation: Optional[str]
    enhanced: Optional[str]
    #: Every relation layer on the lemma layer, any app's.
    lemma_relations: List[str] = field(default_factory=list)


def layers_of(project) -> GrewLayers:
    """A UD project's layers (:class:`.project.UdProject`)."""
    sp = project.span_layers
    return GrewLayers(sentence=project.sentence_layer_id, word=project.word_layer_id,
                      lemma=sp.get('lemma'), upos=sp.get('upos'), xpos=sp.get('xpos'),
                      features=sp.get('features'), form=sp.get('form'),
                      relation=project.relation_layer_id,
                      enhanced=project.enhanced_relation_layer_id,
                      lemma_relations=list(project.lemma_relation_layer_ids))


#: The name a refusal gives each layer, as the Search tab's.
_LAYER_KEYS = {'sentence': 'sentenceTokenLayer', 'word': 'morphemeTokenLayer',
               'lemma': 'lemmaLayer', 'upos': 'uposLayer', 'xpos': 'xposLayer',
               'features': 'featuresLayer', 'relation': 'relationLayer',
               'enhanced': 'enhancedRelationLayer'}


@dataclass
class Compiled:
    #: The query, ready for ``client.query`` once a scope is set.
    query: Dict[str, Any]
    #: Notes for the reader that do not stop the search.
    warnings: List[str]
    #: A constraint folded to "never matches": the answer is no match, and
    #: the server need not be asked.
    impossible: bool
    #: The pattern's named nodes and edges, sorted.
    nodes: List[str]
    edges: List[str]


@dataclass
class _Ctx:
    scope: str
    list: List[Any]
    in_not: bool
    depth: int
    local_bound: set
    local_lemma: Dict[str, str]


def _mentions_lexicon(v) -> bool:
    return bool(v) and (v['type'] == 'lexref'
                        or (v['type'] == 'disj' and any(_mentions_lexicon(x) for x in v['items'])))


def _with_value(value: Any, **rest) -> Dict[str, Any]:
    """A constraint map, without ``value`` when there is none to give (the
    Search tab's ``{value: undefined}``, which JSON leaves out)."""
    return {**rest, **({} if value is None else {'value': value})}


class _Compiler:
    def __init__(self, layers: GrewLayers, limit: Optional[int],
                 limits: Optional[Dict[str, Any]] = None):
        self.li = layers
        self.limit = limit
        # Core's limits as GET /info publishes them (``client.server.limits()``).
        # Without them the query is sent and core refuses it.
        self.max_branches = (limits or {}).get('query_branches')
        self.max_depth = (limits or {}).get('query_clause_depth')
        self.where: List[Any] = []
        self.find: List[str] = ['?S']
        self.warnings: List[str] = []
        self.impossible = False
        self.n_fresh = 0
        self.branches = 1
        self.bound_top: Dict[str, None] = {}
        self.top_lemma: Dict[str, str] = {}
        self.edges_by_id: Dict[str, Dict[str, Optional[str]]] = {}
        self.top_node_ids: Dict[str, None] = {}
        self.tree_warned = False

    def fresh(self, p: str = 'g') -> str:
        self.n_fresh += 1
        return f'?{p}{self.n_fresh}'

    def layer_id(self, key: str, feature: Optional[str] = None) -> str:
        lid = getattr(self.li, key)
        if not lid:
            name = feature or _LAYER_KEYS[key]
            raise GrewUnsupportedError(
                f'layer:{name}',
                f'This project does not record {name}. That constraint cannot be matched here.')
        return lid

    def compile(self, ast: Dict[str, Any]) -> Compiled:
        sent = self.layer_id('sentence', 'Sentences')
        self.where.append(['token', '?S', {'layer': sent}])

        # First pass: the top-level nodes and the named edges.
        for block in ast['blocks']:
            if block['type'] in ('pattern', 'with'):
                for item in block['items']:
                    self.discover(item)
        # Every top-level node is bound up front, so a local scope can name it.
        for ident in self.top_node_ids:
            self.bind_top_node(ident)

        for block in ast['blocks']:
            if block['type'] in ('pattern', 'with'):
                for item in block['items']:
                    self.emit_clause(item, self.top_ctx())
            elif block['type'] == 'without':
                sub: List[Any] = []
                ctx = self.not_ctx(sub, 1)
                for item in block['items']:
                    self.emit_clause(item, ctx)
                if sub:
                    self.where.append(['not', *sub])
            elif block['type'] == 'global':
                for item in block['items']:
                    self.emit_global(item)

        # Injective matching: distinct named nodes without `$` are distinct words.
        non_inj = set(ast.get('nonInjective') or [])
        inj = sorted(i for i in self.top_node_ids if i not in non_inj)
        for a in range(len(inj)):
            for b in range(a + 1, len(inj)):
                self.where.append(['!=', f'?n_{inj[a]}', f'?n_{inj[b]}'])

        if self.max_branches is not None and self.branches > self.max_branches:
            raise GrewUnsupportedError(
                'branch-explosion',
                f'This query expands to too many alternatives ({self.branches} > {self.max_branches}). '
                'Prefer value lists (a|b) over disjoint feature structures, or split the query.')

        query = {'find': self.find, 'where': self.where, 'return': 'entities',
                 'order_by': [['?S', 'doc'], ['?S', 'begin']],
                 'limit': self.limit or DEFAULT_LIMIT}
        return Compiled(query=query, warnings=self.warnings, impossible=self.impossible,
                        nodes=sorted(self.top_node_ids), edges=sorted(self.edges_by_id))

    def top_ctx(self) -> _Ctx:
        return _Ctx('top', self.where, False, 0, set(), {})

    def not_ctx(self, lst: List[Any], depth: int) -> _Ctx:
        return _Ctx('local', lst, True, depth, set(), {})

    # --- discovery ---

    def discover(self, item: Dict[str, Any]) -> None:
        def add(ident):
            if ident:
                self.top_node_ids[ident] = None
        kind = item['kind']
        if kind == 'node':
            add(item['id'])
        elif kind == 'nodefeat':
            add(item['node'])
        elif kind == 'featcmp':
            add(item['left']['node'])
            add(item['right']['node'])
        elif kind == 'order':
            add(item['left'])
            add(item['right'])
        elif kind == 'dist':
            add(item['a'])
            add(item['b'])
        elif kind == 'dominates':
            if not item['left']['wild']:
                add(item['left']['id'])
            if not item['right']['wild']:
                add(item['right']['id'])
        elif kind == 'edge':
            if not item['src']['wild']:
                add(item['src']['id'])
            if not item['tgt']['wild']:
                add(item['tgt']['id'])
            if item['id']:
                self.edges_by_id[item['id']] = {
                    'src': None if item['src']['wild'] else item['src']['id'],
                    'tgt': None if item['tgt']['wild'] else item['tgt']['id']}

    def bind_top_node(self, ident: str) -> None:
        if ident in self.bound_top:
            return
        self.bound_top[ident] = None
        word = self.layer_id('word', 'word')
        self.where.append(['token', f'?n_{ident}', {'layer': word}])
        self.where.append(['within', f'?n_{ident}', '?S'])
        self.find.append(f'?n_{ident}')

    # --- a node token or lemma span, bound in a scope ---

    def node_tok(self, ident: str, ctx: _Ctx) -> str:
        if ident in self.bound_top:
            return f'?n_{ident}'
        if ident not in ctx.local_bound:
            word = self.layer_id('word', 'word')
            ctx.list.append(['token', f'?n_{ident}', {'layer': word}])
            ctx.list.append(['within', f'?n_{ident}', '?S'])
            ctx.local_bound.add(ident)
        return f'?n_{ident}'

    def lemma_span(self, ident: str, ctx: _Ctx) -> str:
        lemma = self.layer_id('lemma', 'Lemma')
        if ident in self.top_lemma:
            return self.top_lemma[ident]
        if ctx.scope == 'top':
            v = f'?lem_{ident}'
            self.where.append(['span', v, {'layer': lemma}])
            self.where.append(['covers', v, self.node_tok(ident, ctx)])
            self.top_lemma[ident] = v
            return v
        if ident in ctx.local_lemma:
            return ctx.local_lemma[ident]
        v = self.fresh('lem')
        ctx.list.append(['span', v, {'layer': lemma}])
        ctx.list.append(['covers', v, self.node_tok(ident, ctx)])
        ctx.local_lemma[ident] = v
        return v

    # --- clauses ---

    def emit_clause(self, item: Dict[str, Any], ctx: _Ctx) -> None:
        kind = item['kind']
        if kind == 'node':
            self.node_tok(item['id'], ctx)
            self.emit_node_features(item, ctx)
        elif kind == 'nodefeat':
            self.emit_node_feat(item['node'], {'name': item['feat'], 'op': item['op'],
                                               'value': item['value']}, ctx)
        elif kind == 'featcmp':
            self.emit_feat_cmp(item, ctx)
        elif kind == 'edge':
            self.emit_edge(item, ctx)
        elif kind == 'dominates':
            self.emit_dominates(item, ctx)
        elif kind == 'order':
            self.emit_order(item, ctx)
        elif kind == 'dist':
            self.emit_dist(item, ctx)
        elif kind == 'cross':
            self.emit_cross(item, ctx)
        else:
            raise GrewUnsupportedError(kind, f'Unsupported clause: {kind}')

    def emit_node_features(self, node: Dict[str, Any], ctx: _Ctx) -> None:
        tv = self.node_tok(node['id'], ctx)
        if len(node['alts']) == 1:
            for fi in node['alts'][0]:
                self.emit_node_feat(node['id'], fi, ctx, tv)
            return
        # A disjunction of feature structures: an `or`, the token re-bound in each.
        self.branches *= len(node['alts'])
        word = self.layer_id('word', 'word')
        groups = []
        for alt in node['alts']:
            sub: List[Any] = []
            gctx = replace(ctx, list=sub, depth=ctx.depth + 1, local_bound={node['id']},
                           local_lemma={})
            self.check_depth(gctx.depth)
            sub.append(['token', tv, {'layer': word}])
            for fi in alt:
                self.emit_node_feat(node['id'], fi, gctx, tv)
            groups.append(sub)
        ctx.list.append(['or', *groups])

    def emit_node_feat(self, node_id: str, fi: Dict[str, Any], ctx: _Ctx,
                       tv: Optional[str] = None) -> None:
        tv = tv or self.node_tok(node_id, ctx)
        name = fi['name']
        lower = name.lower()
        if lower == 'form':
            return self.emit_form_feat(tv, fi, ctx)
        if lower == 'feats':
            return self.emit_feats_whole(tv, fi, ctx)

        if lower in COLUMN_FEATS:
            layer = self.layer_id(COLUMN_FEATS[lower], lower)
            av = self.fresh('s')
            # A span with a null value is not a feature: the lemma layer holds
            # one on every word a relation touches, whatever its LEMMA said.
            if fi['op'] == 'undefined':
                ctx.list.append(['not', ['span', av, {'layer': layer, 'value': ANY_VALUE}],
                                 ['covers', av, tv]])
                return
            value = None
            if fi['op'] == '=':
                value = self.value_constraint(fi['value'])
            elif fi['op'] == '<>':
                value = {'regex': not_exactly_regex(self.lit_value(fi['value']))}
            # `defined` (and `=*`): the span must exist AND carry a value.
            if value is None:
                value = ANY_VALUE
            ctx.list.append(['span', av, {'layer': layer, 'value': value}])
            ctx.list.append(['covers', av, tv])
            return

        feats = self.layer_id('features', 'Features')
        av = self.fresh('f')
        if fi['op'] == 'undefined':
            ctx.list.append(['not', ['span', av, {'layer': feats,
                                                  'value': {'regex': feat_defined_regex(name)}}],
                             ['covers', av, tv]])
            return
        if fi['op'] == 'defined':
            value = {'regex': feat_defined_regex(name)}
        elif fi['op'] == '<>':
            value = {'regex': feat_neq_regex(name, self.lit_value(fi['value']))}
        else:
            value = self.feat_value_constraint(name, fi['value'])
        ctx.list.append(['span', av, {'layer': feats, 'value': value}])
        ctx.list.append(['covers', av, tv])

    def emit_feats_whole(self, tv: str, fi: Dict[str, Any], ctx: _Ctx) -> None:
        # `FEATS` is the word's features as a whole, each read as its stored
        # "Key=Value", and a constraint holds when one of them meets it.
        feats = self.layer_id('features', 'Features')
        av = self.fresh('f')
        if fi['op'] == 'undefined':
            ctx.list.append(['not', ['span', av, {'layer': feats,
                                                  'value': {'regex': FEATURE_PAIR_REGEX}}],
                             ['covers', av, tv]])
            return
        if _mentions_lexicon(fi['value']):
            raise GrewUnsupportedError(
                'feats-lexicon',
                'A lexicon field cannot be matched against FEATS. Match one feature '
                '(X [Number=lex.field]).')
        value = None
        if fi['op'] == '<>':
            value = {'regex': other_feature_pair_regex(self.lit_value(fi['value']))}
        elif fi['op'] == '=':
            value = self.value_constraint(fi['value'])
        if value is None:
            value = {'regex': FEATURE_PAIR_REGEX}
        ctx.list.append(['span', av, {'layer': feats, 'value': value}])
        ctx.list.append(['covers', av, tv])

    def emit_form_feat(self, tv: str, fi: Dict[str, Any], ctx: _Ctx) -> None:
        if fi['op'] == 'defined':
            return  # every token has a surface value
        if fi['op'] == 'undefined':
            raise GrewUnsupportedError('!form', 'Matching tokens with no surface form is not supported.')
        if fi['op'] == '<>':
            vc = {'value': {'regex': not_exactly_regex(self.lit_value(fi['value']))}}
        else:
            vc = _with_value(self.value_constraint(fi['value']))
        # A word's form is its Form span where it has one, and its slice of the
        # text otherwise. Both are asked, so the words inside a multi-word
        # token are found as readily as any other.
        form = self.li.form
        if not form:
            ctx.list.append(['token', tv, vc])
            return
        fv = self.fresh('fm')
        anyv = self.fresh('fm')
        ctx.list.append(['or',
                         [['span', fv, {'layer': form, **vc}], ['covers', fv, tv]],
                         [['token', tv, vc],
                          ['not', ['span', anyv, {'layer': form}], ['covers', anyv, tv]]]])

    def emit_feat_cmp(self, item: Dict[str, Any], ctx: _Ctx) -> None:
        left, op, right = item['left'], item['op'], item['right']
        l_layer = self.feat_layer_for_cmp(left['feat'])
        r_layer = self.feat_layer_for_cmp(right['feat'])
        if op == '=':
            vv = self.fresh('v')
            self.bind_feat_value_var(left, l_layer, vv, ctx)
            self.bind_feat_value_var(right, r_layer, vv, ctx)
            return
        if ctx.in_not:
            raise GrewUnsupportedError(
                'featcmp-neq-in-without',
                'A feature inequality (X.f <> Y.f) cannot appear inside a `without` block.')
        v1 = self.fresh('v')
        v2 = self.fresh('v')
        self.bind_feat_value_var(left, l_layer, v1, ctx)
        self.bind_feat_value_var(right, r_layer, v2, ctx)
        ctx.list.append(['!=', v1, v2])

    def feat_layer_for_cmp(self, feat: str) -> Dict[str, Any]:
        lower = feat.lower()
        if lower == 'form':
            raise GrewUnsupportedError(
                'form-cmp', 'Comparing `form` across nodes is not supported. Compare `lemma` instead.')
        if lower == 'feats':
            raise GrewUnsupportedError(
                'feats-cmp',
                'Comparing FEATS as a whole across nodes is not supported. Compare one feature '
                '(X.Number = Y.Number).')
        if lower in COLUMN_FEATS:
            return {'kind': 'column', 'layer': self.layer_id(COLUMN_FEATS[lower], lower)}
        return {'kind': 'feats', 'name': feat, 'layer': self.layer_id('features', 'Features')}

    def bind_feat_value_var(self, side: Dict[str, str], spec: Dict[str, Any], vv: str,
                            ctx: _Ctx) -> None:
        tv = self.node_tok(side['node'], ctx)
        av = self.fresh('s')
        if spec['kind'] == 'column':
            ctx.list.append(['span', av, {'layer': spec['layer'], 'value': {'var': vv}}])
        else:
            # The variable binds the whole "Key=Value", held to this feature's
            # key by a `~`, which is a predicate and illegal inside a `not`.
            if ctx.in_not:
                raise GrewUnsupportedError(
                    'feats-cmp-in-without',
                    'Comparing FEATS values across nodes is not supported inside a `without` block.')
            ctx.list.append(['span', av, {'layer': spec['layer'], 'value': {'var': vv}}])
            ctx.list.append(['~', f'{av}.value', feat_defined_regex(spec['name'])])
        ctx.list.append(['covers', av, tv])

    def edge_sides(self, label: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """The relation layers a label reads, each with its test on that side.
        The enhanced side always tests a value, because a suppressor is a row
        there with no value and is not an edge."""
        split = split_label(label)
        sides = []
        if split['basic']:
            sides.append(_with_value(self.edge_value_constraint(split['basic']),
                                     layer=self.layer_id('relation', 'Dependency')))
        if split['enhanced']:
            layer = self.layer_id('enhanced', 'enhanced dependency')
            v = self.edge_value_constraint(split['enhanced'])
            sides.append({'layer': layer, 'value': ANY_VALUE if v is None else v})
        if not sides:
            raise GrewUnsupportedError('edge-label', 'This edge label can match no edge.')
        return sides

    def emit_edge(self, item: Dict[str, Any], ctx: _Ctx) -> None:
        # A named head is bound to a word, and a root's head is no word, so a
        # positive list naming `root` from a named head is refused with the
        # spelling that works.
        lab = item['label']
        if (not item['src']['wild'] and lab and lab['type'] == 'list' and not lab['negated']
                and any(bare_label(x) == 'root' for x in lab['labels'])):
            roots = '|'.join(x for x in lab['labels'] if bare_label(x) == 'root')
            tgt = '*' if item['tgt']['wild'] else item['tgt']['id']
            raise GrewUnsupportedError(
                'root-source',
                f'The head of a root relation is not a word. Write * -[{roots}]-> {tgt} in a '
                'clause of its own.')
        rv = f'?e_{item["id"]}' if item['id'] else self.fresh('r')
        # A named edge is returned only when bound at top level.
        if item['id'] and ctx.scope == 'top' and rv not in self.find:
            self.find.append(rv)
        ends = {}
        if not item['src']['wild']:
            ends['source'] = self.lemma_span(item['src']['id'], ctx)
        if not item['tgt']['wild']:
            ends['target'] = self.lemma_span(item['tgt']['id'], ctx)
        sides = [{**cm, **ends} for cm in self.edge_sides(item['label'])]
        if len(sides) == 1:
            ctx.list.append(['relation', rv, sides[0]])
            return
        # Both graphs. Where the label asks the same of each, that is ONE
        # clause on "a relation layer of the lemma layer", which costs no
        # alternative. Otherwise an `or`.
        basic, enhanced = sides
        same = json.dumps(basic.get('value', ANY_VALUE)) == json.dumps(enhanced['value'])
        if same and self.lemma_holds_only_dependencies():
            lv = self.fresh('rl')
            ctx.list.append(['relation', rv, {**enhanced, 'layer': lv}])
            ctx.list.append(['relation-layer', lv, {'span-layer': self.layer_id('lemma', 'Lemma')}])
            return
        self.branches *= len(sides)
        self.check_depth(ctx.depth + 1)
        ctx.list.append(['or', *[[['relation', rv, cm]] for cm in sides]])

    def lemma_holds_only_dependencies(self) -> bool:
        known = {self.li.relation, self.li.enhanced}
        return all(lid in known for lid in self.li.lemma_relations)

    def emit_dominates(self, item: Dict[str, Any], ctx: _Ctx) -> None:
        if item['left']['wild'] or item['right']['wild']:
            raise GrewUnsupportedError('dominates-wildcard',
                                       'Transitive dominance (->>) requires named endpoints.')
        a = self.lemma_span(item['left']['id'], ctx)
        b = self.lemma_span(item['right']['id'], ctx)
        # A path runs through ONE layer: the tree unlabelled, the extras for E:.
        label = item['label']
        labelled = bool(label) and label['type'] != 'any'
        if labelled and not (label['type'] == 'list' and not label['negated']):
            raise GrewUnsupportedError(
                'dominates-label',
                'A transitive edge (->>) may only carry a plain label or label list, not a '
                'regex/negation/subtype.')
        split = split_label(label) if labelled else {'basic': None, 'enhanced': None}
        if split['basic'] and split['enhanced']:
            raise GrewUnsupportedError(
                'dominates-mixed',
                'A transitive edge (->>) follows basic labels or E: labels, not both at once.')
        if split['enhanced']:
            m = {'layer': self.layer_id('enhanced', 'enhanced dependency')}
        else:
            m = {'layer': self.layer_id('relation', 'Dependency')}
        side = split['enhanced'] or split['basic']
        labels = side.get('labels') if side else None
        if labels:
            m['value'] = labels[0] if len(labels) == 1 else labels
        ctx.list.append(['related*', a, b, m])

    def emit_order(self, item: Dict[str, Any], ctx: _Ctx) -> None:
        a = self.node_tok(item['left'], ctx)
        b = self.node_tok(item['right'], ctx)
        ctx.list.append(['precedes*' if item['op'] == '<<' else 'precedes', a, b])

    def emit_dist(self, item: Dict[str, Any], ctx: _Ctx) -> None:
        a = self.node_tok(item['a'], ctx)
        b = self.node_tok(item['b'], ctx)
        if item['fn'] == 'delta':
            return self.emit_delta(a, b, item['op'], item['n'], ctx)
        return self.emit_length(a, b, item['op'], item['n'], ctx)

    def emit_delta(self, a: str, b: str, op: str, k: int, ctx: _Ctx) -> None:
        """delta(a, b) = position of b minus position of a, as chains of
        immediate `precedes`."""
        def chain(lst, frm, to, m, last):
            prev = frm
            for _ in range(m - 1):
                prev = self.chain_step(lst, prev)
            lst.append([last, prev, to])

        def not_block(build):
            sub: List[Any] = []
            build(sub)
            self.check_depth(ctx.depth + 1)
            ctx.list.append(['not', *sub])

        self.check_dist_bound(k)
        if op == '=':
            if k == 0:
                self.impossible = True
                return
            if k > 0:
                chain(ctx.list, a, b, k, 'precedes')
            else:
                chain(ctx.list, b, a, -k, 'precedes')
            return
        if k < 0:
            raise GrewUnsupportedError(
                'delta-negative-threshold',
                f'delta(X,Y) {op} {k} with a negative threshold is not supported. Use an exact '
                'delta or a non-negative threshold.')
        if op == '>':
            if k == 0:
                ctx.list.append(['precedes*', a, b])
            else:
                chain(ctx.list, a, b, k + 1, 'precedes*')
        elif op == '>=':
            if k == 0:
                ctx.list.append(['precedes*', a, b])
            else:
                chain(ctx.list, a, b, k, 'precedes*')
        elif op == '<':
            not_block(lambda sub: chain(sub, a, b, k, 'precedes*'))
        elif op == '<=':
            not_block(lambda sub: chain(sub, a, b, k + 1, 'precedes*'))

    def emit_length(self, a: str, b: str, op: str, k: int, ctx: _Ctx) -> None:
        self.check_dist_bound(k)
        if k < 0:
            raise GrewUnsupportedError('length-negative', 'length(X,Y) requires a non-negative number.')
        # length = |delta|, as delta either way round.
        if op == '=':
            self.branches *= 2
            g1: List[Any] = []
            self.emit_delta(a, b, '=', k, replace(ctx, list=g1))
            g2: List[Any] = []
            self.emit_delta(a, b, '=', -k, replace(ctx, list=g2))
            ctx.list.append(['or', g1, g2])
            return
        if op in ('>', '>='):
            self.branches *= 2
            g1 = []
            self.emit_delta(a, b, op, k, replace(ctx, list=g1))
            g2 = []
            self.emit_delta(b, a, op, k, replace(ctx, list=g2))
            ctx.list.append(['or', g1, g2])
            return
        # length < k is NOT(length >= k), and length <= k is NOT(length > k).
        strict = '>=' if op == '<' else '>'
        sub: List[Any] = []
        self.emit_length(a, b, strict, k, replace(ctx, list=sub, depth=ctx.depth + 1, in_not=True))
        self.check_depth(ctx.depth + 1)
        ctx.list.append(['not', *sub])

    def chain_step(self, lst: List[Any], prev: str) -> str:
        word = self.layer_id('word', 'word')
        cur = self.fresh('t')
        lst.append(['token', cur, {'layer': word}])
        lst.append(['precedes', prev, cur])
        return cur

    def check_dist_bound(self, k: int) -> None:
        if abs(k) > MAX_LINEAR_DISTANCE:
            raise GrewUnsupportedError(
                'distance-too-large',
                f'delta/length distances above {MAX_LINEAR_DISTANCE} are not supported.')

    def emit_cross(self, item: Dict[str, Any], ctx: _Ctx) -> None:
        e1 = self.edges_by_id.get(item['left'])
        e2 = self.edges_by_id.get(item['right'])
        if not e1 or not e2:
            raise GrewUnsupportedError(
                'cross-unknown-edge',
                'Edge crossing (><) needs two named edges declared in the pattern.')
        if not (e1['src'] and e1['tgt'] and e2['src'] and e2['tgt']):
            raise GrewUnsupportedError(
                'cross-wildcard', 'Edge crossing (><) requires both edges to have named endpoints.')
        ts = [self.node_tok(x, ctx) for x in (e1['src'], e1['tgt'], e2['src'], e2['tgt'])]
        groups = _interleavings(*ts)
        self.branches *= len(groups)
        ctx.list.append(['or', *groups])

    # --- global block ---

    def emit_global(self, item: Dict[str, Any]) -> None:
        if item['kind'] == 'globalflag':
            return self.emit_global_flag(item)
        return self.emit_global_meta(item)

    def emit_global_flag(self, item: Dict[str, Any]) -> None:
        name = item['name']
        # Folded against the UD tree invariant: one head per word, acyclic.
        if name in ('is_tree', 'is_forest', 'is_not_cyclic'):
            self.warn_tree_invariant()
            return
        if name in ('is_not_tree', 'is_not_forest', 'is_cyclic'):
            self.warn_tree_invariant()
            self.impossible = True
            return
        if name in ('is_projective', 'is_not_projective'):
            # Non-projective: two arcs cross, or an arc covers the root word.
            non_proj = ['or', self.crossing_group(), self.root_cover_group()]
            self.branches *= 10
            self.check_depth(3)
            self.where.append(['not', non_proj] if name == 'is_projective' else non_proj)
            return
        raise GrewUnsupportedError(name, f'Unsupported global constraint: {name}')

    def warn_tree_invariant(self) -> None:
        if self.tree_warned:
            return
        self.tree_warned = True
        self.warnings.append(
            'Tree/cyclicity globals assume well-formed UD trees (one head per word, acyclic). '
            'Partially-annotated sentences may not satisfy that assumption.')

    def crossing_group(self) -> List[Any]:
        """Two dependency arcs in ?S cross: their endpoint tokens interleave."""
        rel = self.layer_id('relation', 'Dependency')
        e1, e2 = self.fresh('pe'), self.fresh('pe')
        h1, d1 = self.fresh('ph'), self.fresh('pd')
        h2, d2 = self.fresh('ph'), self.fresh('pd')
        h1t, d1t = self.fresh('pt'), self.fresh('pt')
        h2t, d2t = self.fresh('pt'), self.fresh('pt')
        return [['relation', e1, {'layer': rel, 'source': h1, 'target': d1}],
                ['relation', e2, {'layer': rel, 'source': h2, 'target': d2}],
                ['covers', h1, h1t], ['covers', d1, d1t], ['covers', h2, h2t], ['covers', d2, d2t],
                ['within', h1t, '?S'], ['within', d1t, '?S'], ['within', h2t, '?S'],
                ['within', d2t, '?S'],
                ['or', *_interleavings(h1t, d1t, h2t, d2t)]]

    def root_cover_group(self) -> List[Any]:
        """A dependency arc covers the root word of ?S."""
        rel = self.layer_id('relation', 'Dependency')
        rr, rl, rt = self.fresh('prr'), self.fresh('prl'), self.fresh('prt')
        e, h, d = self.fresh('pe'), self.fresh('ph'), self.fresh('pd')
        ht, dt = self.fresh('pt'), self.fresh('pt')
        return [['relation', rr, {'layer': rel, 'value': 'root', 'target': rl}],
                ['covers', rl, rt], ['within', rt, '?S'],
                ['relation', e, {'layer': rel, 'source': h, 'target': d}],
                ['covers', h, ht], ['covers', d, dt], ['within', ht, '?S'], ['within', dt, '?S'],
                ['or', [['precedes*', ht, rt], ['precedes*', rt, dt]],
                 [['precedes*', dt, rt], ['precedes*', rt, ht]]]]

    def emit_global_meta(self, item: Dict[str, Any]) -> None:
        key, op, value = item['key'], item['op'], item['value']
        if key.lower() == 'text':
            if op == 'undefined':
                raise GrewUnsupportedError('!text', 'Matching sentences without text is not supported.')
            if op == '<>':
                cm = {'value': {'regex': not_exactly_regex(self.lit_value(value))}}
            else:
                cm = _with_value(self.value_constraint(value))
            self.where.append(['token', '?S', cm])
            return
        if op == 'undefined':
            raise GrewUnsupportedError(
                'global-meta-undefined', f'Matching the absence of metadata ({key}) is not supported.')
        if op == '<>':
            inner = {'regex': not_exactly_regex(self.lit_value(value))}
        else:
            inner = self.value_constraint(value)
        # A bare value beginning with `?` reads as a variable, which the engine
        # refuses, so a value or a list of them goes as a literal.
        spec = {'literal': inner} if isinstance(inner, (str, list)) else inner
        self.where.append(['token', '?S', {'metadata': {} if spec is None else {key: spec}}])

    # --- values and labels ---

    def value_constraint(self, v: Optional[Dict[str, Any]]) -> Any:
        if not v:
            return None
        t = v['type']
        if t == 'lexref':
            self.refuse_lexicon()
        if t == 'lit':
            return v['value']
        if t == 'regex':
            return {'regex': server_regex(v)}
        if t == 'disj':
            if all(x['type'] == 'lit' for x in v['items']):
                return [x['value'] for x in v['items']]
            raise GrewUnsupportedError(
                'regex-disjunction',
                'A disjunction mixing regexes is not supported. Use separate clauses or a single regex.')
        return None

    def feat_value_constraint(self, name: str, v: Dict[str, Any]) -> Any:
        t = v['type']
        if t == 'lexref':
            self.refuse_lexicon()
        if t == 'lit':
            return feat_eq_value(name, v['value'])
        if t == 'disj' and all(x['type'] == 'lit' for x in v['items']):
            return [feat_eq_value(name, x['value']) for x in v['items']]
        if t == 'regex':
            return {'regex': feat_value_regex(name, server_regex(v))}
        if t == 'any':
            return {'regex': feat_defined_regex(name)}
        raise GrewUnsupportedError('feature-value', f'Unsupported feature value for {name}.')

    def refuse_lexicon(self):
        # A request has no lexicons: only a rewriting rule declares one.
        raise GrewUnsupportedError('lexicon', 'A lexicon (lex.field) only works in a rewriting rule.')

    def lit_value(self, v: Optional[Dict[str, Any]]) -> str:
        if v and v['type'] == 'lit':
            return v['value']
        if v and v['type'] == 'lexref':
            self.refuse_lexicon()
        if v and v['type'] == 'regex':
            raise GrewUnsupportedError(
                'regex-inequality',
                'A "<>" (not-equal) constraint must compare against a literal, not a regex.')
        raise GrewUnsupportedError('value', 'Expected a literal value.')

    def edge_value_constraint(self, label: Optional[Dict[str, Any]]) -> Any:
        if not label or label['type'] == 'any':
            return None
        t = label['type']
        if t == 'list':
            if label['negated']:
                return {'regex': negated_label_regex(label['labels'])}
            return label['labels'][0] if len(label['labels']) == 1 else label['labels']
        if t == 'regex':
            return {'regex': server_regex(label)}
        if t == 'features':
            if not all(str(f['key']).isdigit() and str(f['key']).isascii() and not f.get('neg')
                       for f in label['feats']):
                raise GrewUnsupportedError(
                    'edge-feature', 'Only numbered edge features (1=, 2=, …) and `enhanced` are supported.')
            return {'regex': features_label_regex(label['feats'])}
        return None

    def check_depth(self, depth: int) -> None:
        if self.max_depth is not None and depth > self.max_depth:
            raise GrewUnsupportedError('nesting-too-deep', f'Query nesting exceeds {self.max_depth} levels.')


def _interleavings(a1: str, a2: str, b1: str, b2: str) -> List[Any]:
    """The orderings in which arcs {a1, a2} and {b1, b2} cross, each a strict
    precedence chain over the four endpoint tokens."""
    def chain(w, x, y, z):
        return [['precedes*', w, x], ['precedes*', x, y], ['precedes*', y, z]]
    return [chain(a1, b1, a2, b2), chain(a1, b2, a2, b1), chain(a2, b1, a1, b2),
            chain(a2, b2, a1, b1), chain(b1, a1, b2, a2), chain(b1, a2, b2, a1),
            chain(b2, a1, b1, a2), chain(b2, a2, b1, a1)]


def compile_grew(ast: Dict[str, Any], layers: GrewLayers, limit: Optional[int] = None,
                 limits: Optional[Dict[str, Any]] = None) -> Compiled:
    return _Compiler(layers, limit, limits).compile(ast)


def parse_and_compile(text: str, layers: GrewLayers, limit: Optional[int] = None,
                      limits: Optional[Dict[str, Any]] = None) -> Compiled:
    """A Grew request as one Plaid query. Raises :class:`GrewParseError` for
    text that is not Grew and :class:`GrewUnsupportedError` for Grew this
    cannot express, with the Search tab's messages. ``limits`` is the
    server's GET /info limits: past ``query_branches`` or
    ``query_clause_depth`` the pattern is refused here, in Grew's words.
    Without them the query is sent and the server refuses it."""
    return compile_grew(parse(text), layers, limit, limits)
