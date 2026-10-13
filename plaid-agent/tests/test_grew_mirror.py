"""The agent's Grew compiler (ud/grew.py) against plaid-ud's own
(src/grew/index.js), pattern for pattern.

grew_search promises the user that the pattern it echoes finds the same
sentences in the Search tab. That holds only while the two compilers write the
same query, so every case here is compiled by both and compared whole: the
query, the warnings, whether it was folded to "never matches", and for a
refusal its kind, feature, message and position. The patterns are every one
the JS compile, parser, lexer, enhanced, FEATS and regex tests compile, and
the inputs an escaping bug would hide in (a space, a quote, a bracket, an
unbalanced brace, the empty string).
"""

import json
import os
import subprocess

import pytest

from node_exe import node_or_skip
from plaid_agent.ud.grew import GrewError, GrewLayers, parse_and_compile

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'grew_mirror.mjs')

# Each layer set in the Search tab's shape (getUdLayerInfo) and in the port's.
JS_LAYERS = {
    'plain': {'sentenceTokenLayer': {'id': 'SENT'}, 'morphemeTokenLayer': {'id': 'MORPH'},
              'lemmaLayer': {'id': 'LEMMA'}, 'uposLayer': {'id': 'UPOS'},
              'xposLayer': {'id': 'XPOS'}, 'featuresLayer': {'id': 'FEATS'},
              'relationLayer': {'id': 'REL'}, 'enhancedRelationLayer': {'id': 'EREL'}},
}
JS_LAYERS['full'] = {**JS_LAYERS['plain'], 'formLayer': {'id': 'FORM'},
                     'lemmaLayer': {'id': 'LEMMA', 'relationLayers': [{'id': 'REL'}, {'id': 'EREL'}]}}
JS_LAYERS['crowded'] = {**JS_LAYERS['full'],
                        'lemmaLayer': {'id': 'LEMMA', 'relationLayers': [
                            {'id': 'REL'}, {'id': 'EREL'}, {'id': 'OTHER'}]}}
JS_LAYERS['sparse'] = {**JS_LAYERS['plain'], 'xposLayer': None, 'enhancedRelationLayer': None}


def py_layers(js):
    def lid(key):
        return (js.get(key) or {}).get('id')
    return GrewLayers(sentence=lid('sentenceTokenLayer'), word=lid('morphemeTokenLayer'),
                      lemma=lid('lemmaLayer'), upos=lid('uposLayer'), xpos=lid('xposLayer'),
                      features=lid('featuresLayer'), form=lid('formLayer'),
                      relation=lid('relationLayer'), enhanced=lid('enhancedRelationLayer'),
                      lemma_relations=[x['id'] for x in (js.get('lemmaLayer') or {}).get('relationLayers') or []])


PATTERNS = [
    # grewCompile.test.js
    'pattern { X [upos=VERB] }',
    'pattern { X [upos=VERB]; Y [upos=NOUN]; X -[nsubj]-> Y }',
    'pattern { X [upos=VERB|AUX] }',
    'pattern { X [Number=Sing] }', 'pattern { X [Number] }', 'pattern { X [Number<>Sing] }',
    'pattern { X [!Person] }', 'pattern { X [upos<>VERB] }',
    'pattern { X [lemma=re"^be"] }', 'pattern { X [lemma=/be/i] }',
    'pattern { X [upos=VERB] } without { X -[obj]-> Y }',
    'pattern { X [upos=VERB,Tense=Past] | [upos=ADJ] }',
    'pattern { X[]; Y[]; X < Y }', 'pattern { X[]; Y[]; X << Y }', 'pattern { X[]; Y[]; X ->> Y }',
    'pattern { X [upos=VERB] } global { is_projective }',
    'pattern { X [] } global { is_not_projective }',
    'global { is_cyclic }', 'global { is_tree }',
    'pattern { X[]; Y[]; delta(X,Y) = 2 }',
    'with { X.lemma = Y.lemma }',
    'pattern { X[]; Y[]; Z[] }', 'pattern { X[]; Y[]; Z$[] }',
    'pattern { X[]; Y[]; delta(X,Y) = 999 }', 'pattern { X -[!deep]-> Y }',
    'pattern { X[]; Y[]; X -[re"x"]->> Y }', 'pattern { X[] } without { X.lemma <> Y.lemma }',
    'pattern { X [xpos=NN] }',
    'global { sent_id = "x" }',
    'pattern { X [!lemma] }', 'pattern { X [lemma] }', 'pattern { X [lemma="dog"] }',
    # grewParser.test.js and grewLexer.test.js
    'pattern { X [upos=VERB, Number=Sing|Plur, !Person] }',
    'pattern { X [Tense<>Fut]; Y [lemma=re"^be"] }',
    'pattern { X -[nsubj]-> Y }', 'pattern { X -[nsubj|obj]-> Y }', 'pattern { X -[^nsubj|obj]-> Y }',
    'pattern { X -[nsubj:pass]-> Y }', 'pattern { X -[1=nsubj,2=pass]-> Y }',
    'pattern { X -[re".*subj"]-> Y }', 'pattern { X -> Y }', 'pattern { e: X -[obj]-> Y }',
    'pattern { * -[nsubj]-> Y }', 'pattern { X -[nsubj]-> * }', 'pattern { X << Y }',
    'pattern { X -[nsubj]->> Y }', 'pattern { e1: A -> B; e2: C -> D; e1 >< e2 }',
    'pattern { e1 >< e2 }', 'with { X.lemma <> Y.lemma }', 'with { X.lemma = "be" }',
    'pattern { delta(X,Y) = 3 }', 'pattern { length(X,Y) <= 4 }', 'pattern { delta(X,Y) = -3 }',
    'global { is_not_cyclic }', r'global { text = re"\baux\b" }',
    'pattern { X -[ARG0]-> A; X -[ARG1]-> B$ }',
    'pattern { X [upos=VERB] } without { X -[obj]-> Y } global { is_tree }',
    'pattern { X [upos=] }', 'foo { X }', 'a="oops', 'pattern {\n  X % comment\n}',
    'lemma="être" a=re"^b.*" b=/x/i',
    # grewEnhanced.test.js
    'pattern { X -[E:nsubj|E:nsubj:xsubj]-> Y }', 'pattern { e: X -> Y }',
    'pattern { A -> B; B -> C; C -> D; D -> E; E -> F } global { is_projective }',
    'pattern { X -[^det]-> Y }',
    'pattern { X [] } without { X -[nsubj|E:nsubj]-> Y }',
    'pattern { X [] } without { X -[nsubj|E:nsubj:xsubj]-> Y }',
    'pattern { X -[root]-> Y }', 'pattern { X -[E:root]-> Y }', 'pattern { X -[root|cc]-> Y }',
    'pattern { * -[E:root]-> Y }', 'pattern { X -[E:conj]->> Y }', 'pattern { X -[conj|E:conj]->> Y }',
    'pattern { X -[^E:nsubj]-> Y }', 'pattern { X -[1=nsubj, enhanced=yes]-> Y }',
    'pattern { X -[1=nsubj, !enhanced]-> Y }', 'pattern { X -[enhanced=yes]-> Y }',
    'pattern { X -[re"E:nsubj"]-> Y }', 'pattern { X -[re"^E:n"]-> Y }', 'pattern { X -[re"^nsubj"]-> Y }',
    # grewFeatsAgree.test.js
    'pattern { X [FEATS=re"Number=Sing"] }', 'pattern { X [FEATS=re"Number"] }',
    'pattern { X [FEATS=re"^Def"] }', 'pattern { X [FEATS=/sing/i] }', 'pattern { X [FEATS="Number=Sing"] }',
    'pattern { X [FEATS="Number=Sing"|"Tense=Past"] }', 'pattern { X [FEATS<>"Number=Sing"] }',
    'pattern { X [FEATS] }', 'pattern { X [!FEATS] }', 'pattern { X [upos=NOUN, feats=re"Plur"] }',
    'pattern { X [] } without { X [FEATS=re"Def"] }', 'pattern { X [FEATS="Gender=Fem|Number=Sing"] }',
    'pattern { X [FEATS]; Y [FEATS]; X.FEATS = Y.FEATS }',
    'pattern { X [Number=re"^S"] }', 'pattern { X [Number=re"^P|^S"] }', 'pattern { X [Number=re"g$"] }',
    'pattern { X [Number=re"^Sing$"] }', 'pattern { X [Number=re"in"] }',
    'pattern { X [Number=re"(?:^|x)P"] }', 'pattern { X [Definite=re"[^I]nd"] }',
    'pattern { X [Definite=re"^[^D]"] }', r'pattern { X [Number=/\^S/] }', 'pattern { X [Number=/^s/i] }',
    'pattern { X [] } without { X [Number=re"^S"] }', r'pattern { X [Number=re"\Q^a\E^b"] }',
    r'pattern { X [Number=re"[]^]^"] }', r'pattern { X [Number=re"\Q^"] }',
    # grewRegexAgree.test.js
    r'pattern { X [lemma=re"\p{InArabic}"] }', 'pattern { X [lemma=re"a++"] }',
    'pattern { X [lemma=re".*{.*"] }', 'pattern { X -[re"a++"]-> Y }',
    'pattern { X -[re"^E:*"]-> Y }', 'pattern { X -[re"E:+"]-> Y }', 'pattern { X -[re"^E:{2}"]-> Y }',
    'pattern { X -[re"^nsubj:*"]-> Y }', 'pattern { X -[re"E:obl:.*"]-> Y }',
    r'pattern { X [lemma=re"^\w+$"] }', r'pattern { X [lemma=/^\w+$/] }', r'pattern { X [lemma=re"\d"] }',
    r'pattern { X [lemma=re"^\p{IsArabic}+$"] }', r'pattern { X [lemma=re"\-"] }',
    r'pattern { X [lemma=re"a\\"] }', r'pattern { X [lemma=/a\\/] }', r'pattern { X [lemma=re"\b\d{2}\b"] }',
    r'pattern { X [lemma=re"say \"hi\""] }', 'pattern { X [lemma=re"́"] }',
    'pattern { X [lemma="pʰá"] }',
    # quickSearch.js writes these
    'pattern { W [form=re"dog"] }', 'pattern { W [form="dog"] }', 'pattern { * -[nsubj|E:nsubj]-> W }',
    'pattern { * -[re"^a b$"]-> W }', 'pattern { W [FEATS=re"Number=Sing"] }',
    # form, every way
    'pattern { X [form<>"a"] }', 'pattern { X [!form] }', 'pattern { X [form] }', 'pattern { X [form=*] }',
    'pattern { X [form="a"|"b"] }', 'pattern { X.form = Y.form }', 'pattern { X [] } without { X [form="el"] }',
    # comparisons
    'pattern { X [upos=VERB]; Y []; X.upos <> Y.upos }', 'pattern { X []; Y []; X.Number = Y.Number }',
    'pattern { X []; Y []; X.Number <> Y.Number }', 'pattern { X [] } without { X.Number = Y.Number }',
    'pattern { X [] } without { Y [upos=NOUN]; X.lemma = Y.lemma }',
    # distances
    'pattern { X []; Y []; delta(X,Y) > 0 }', 'pattern { X []; Y []; delta(X,Y) > 2 }',
    'pattern { X []; Y []; delta(X,Y) >= 0 }', 'pattern { X []; Y []; delta(X,Y) >= 3 }',
    'pattern { X []; Y []; delta(X,Y) < 3 }', 'pattern { X []; Y []; delta(X,Y) <= 3 }',
    'pattern { X []; Y []; delta(X,Y) < -1 }', 'pattern { X []; Y []; delta(X,Y) = 0 }',
    'pattern { X []; Y []; length(X,Y) = 2 }', 'pattern { X []; Y []; length(X,Y) > 1 }',
    'pattern { X []; Y []; length(X,Y) < 2 }', 'pattern { X []; Y []; length(X,Y) = -1 }',
    'pattern { X []; Y []; length(X,Y) <= 51 }', 'pattern { X [] } without { Y []; delta(X,Y) = 1 }',
    # globals and metadata
    'global { is_forest }', 'global { is_not_tree }', 'global { is_not_forest }', 'global { is_dag }',
    'pattern { X [] } global { is_tree; is_not_cyclic }', 'global { text = "x" }', 'global { text <> "x" }',
    'global { text = * }', 'global { !text }', 'global { !sent_id }', 'global { sent_id = "a"|"b" }',
    'global { sent_id <> "a" }', 'global { sent_id = re"^train" }', 'global { genre = "?PL" }',
    'global { meta.sent_id = "a" }', 'global { sent_id = * }', 'global { sent_id = re"a"|"b" }',
    # lexicons, rules and other residue
    'pattern { X [lemma=lex.noun] }', 'pattern { X [FEATS=lex.f] }', 'pattern { X [Number=lex.f] }',
    'pattern { X [lemma<>lex.f] }', 'pattern { X.lemma = lex.noun }',
    'rule r { pattern { X [] } commands { del_node X } }', 'pattern { X [] } commands { del_node X }',
    'strat s { Onf(r) }', 'package p { }', '#BEGIN lex\na\tb\n#END', 'pattern { X ==> Y }',
    'pattern { X [lemma<>re"a"] }', 'pattern { X [upos<>VERB|AUX] }', 'pattern { X [upos=re"V"|"A"] }',
    'pattern { X [Number=re"S"|"P"] }', 'pattern { X [Number=*] }', 'pattern { X -[2=pass, 1=nsubj]-> Y }',
    'pattern { X -[a=b]-> Y }', 'pattern { X ->> * }', 'pattern { X -[^a]->> Y }',
    'pattern { e1: X -> Y; e1 >< e2 }', 'pattern { e1: * -> Y; e2: A -> B; e1 >< e2 }',
    'pattern { X [] | [] | [] | [] | []; Y [] | [] | [] | [] | []; Z [] | [] | [] | [] | [] | [] }',
    # what an escaping bug would hide in
    '', '   ', 'pattern { }', 'pattern {', 'pattern { X [lemma="a b"] }', 'pattern { X [lemma="a\\"b"] }',
    'pattern { X [lemma="[x]"] }', 'pattern { X [lemma="{"] }', 'pattern { X [lemma=""] }',
    'pattern { X -[a b]-> Y }', 'pattern { X -["a b"]-> Y }', 'pattern { X [lemma=re""] }',
    'pattern { X [lemma=re"a\nb"] }', 'pattern { X [lemma="tab\\there"] }', 'pattern { X [lemma="ок"] }',
    'pattern { X [lemma="😀"] }', 'pattern { X [lemma="😀"] } x', 'pattern { X [lemma="x"] } % trailing comment',
    'pattern { X - Y }', 'pattern { X [lemma=/unterminated }', 'pattern { X [lemma="multi\nline"] }',
    'pattern { X.lemma }', 'pattern { X > Y; Y >> Z }', 'pattern { X$ -> Y }', 'pattern { X [a=1] }',
    'pattern { X [Number=Sing,] }', 'pattern { delta(X,Y) == 2 }', 'pattern { X [upos="?x"] }',
    'pattern { e: X -[nsubj]-> Y } without { e: X -[obj]-> Z }',
    'pattern { X [upos=VERB] }\nwithout { X -[nsubj]-> S }\nwithout { X -[obj]-> O }',
]


def _py(pattern, name):
    try:
        c = parse_and_compile(pattern, py_layers(JS_LAYERS[name]))
    except GrewError as e:
        return {'error': {'name': type(e).__name__, 'message': e.message,
                          'feature': getattr(e, 'feature', None), 'line': getattr(e, 'line', None),
                          'col': getattr(e, 'col', None), 'sourceLine': getattr(e, 'source_line', None)}}
    q = dict(c.query)
    q['orderBy'] = q.pop('order_by')
    # The JS side goes through JSON, which writes a tuple as a list.
    return {'ok': json.loads(json.dumps({'query': q, 'warnings': c.warnings,
                                         'impossible': c.impossible, 'nodes': c.nodes,
                                         'edges': c.edges}))}


@pytest.fixture(scope='module')
def js_answers(tmp_path_factory):
    node = node_or_skip('The Grew mirror runs plaid-ud/src/grew with it.')
    cases = [[p, name] for name in JS_LAYERS for p in PATTERNS]
    path = tmp_path_factory.mktemp('grew') / 'cases.json'
    path.write_text(json.dumps({'layers': JS_LAYERS, 'cases': cases}), encoding='utf-8')
    run = subprocess.run([node, RUNNER, str(path)], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    return dict(zip([(p, n) for p, n in cases], json.loads(run.stdout)))


@pytest.mark.parametrize('name', list(JS_LAYERS))
def test_the_port_compiles_every_pattern_as_the_search_tab_does(js_answers, name):
    differ = []
    for p in PATTERNS:
        js, py = js_answers[(p, name)], _py(p, name)
        if js != py:
            differ.append(f'{p!r}\n  js: {json.dumps(js, ensure_ascii=False)[:600]}\n'
                          f'  py: {json.dumps(py, ensure_ascii=False)[:600]}')
    assert not differ, f'{len(differ)} of {len(PATTERNS)} differ:\n' + '\n'.join(differ[:8])


def test_the_cases_cover_both_answers(js_answers):
    """A mirror whose cases all refuse, or all compile, compares half the code."""
    kinds = {next(iter(a)) for a in js_answers.values()}
    assert kinds == {'ok', 'error'}
    names = {a['error']['name'] for a in js_answers.values() if 'error' in a}
    assert names == {'GrewParseError', 'GrewUnsupportedError'}


def test_a_character_outside_the_bmp_is_named_whole():
    """The one place the two are allowed to differ: the Search tab reads text
    by UTF-16 unit and names half of an emoji it does not expect. The port
    names the character, at the same position."""
    with pytest.raises(GrewError) as e:
        parse_and_compile('pattern { \U0001F600 }', py_layers(JS_LAYERS['plain']))
    assert (e.value.message, e.value.line, e.value.col) == ("Unexpected character '\U0001F600'", 1, 11)
