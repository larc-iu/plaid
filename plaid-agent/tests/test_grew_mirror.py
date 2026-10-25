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


# Every pattern plaid-ud's Grew tests compile (its grewPatterns.test.js says
# so), and the inputs an escaping bug would hide in.
with open(os.path.join(HERE, '../../plaid-ud/test/fixtures/grewPatterns.json'), encoding='utf-8') as f:
    PATTERNS = json.load(f)


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
