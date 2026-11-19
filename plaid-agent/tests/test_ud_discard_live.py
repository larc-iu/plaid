"""The ud assistant's discard, in a real core: what is stored after it, what
plaid-ud's grid then holds up for review, and whether Parse takes the
sentence again (H3-10-1, REV-U4-1).

The grid counts a span for review by its stamp, not its value
(reviewTargets.js ``reviewWords``, SentenceRow's ``holds``), so a discarded
lemma left as a valueless span with the machine's stamp kept every word of a
parsed sentence waiting for review with nothing in it, and the sentence's
Accept then verified the empty lemmas, which Parse refuses to replace. The
grid's own Discard predictions deletes such a span, and so does the
assistant's discard now when every arc on it goes too.
"""

import copy
import json
import os
import subprocess
import tempfile
import types

import pytest

from live import live_client, seed  # noqa: F401 - fixture
from plaid_agent.ud.plan import execute_plan
from plaid_agent.ud.project import load_project
from plaid_agent.ud.toolkit import call_tool
from plaid_agent.ud.tools import Workspace
from plaid_client import testing as servicetest
from plaid_client.provenance import is_machine
from test_enhanced_mirror import _node
from test_ud_tools import _parsed_raw
from ud_fixtures import DEPREL, FORM, LEMMA, SENT_LAYER, WORD_LAYER, project_raw

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'ud_review_mirror.mjs')
SERVICES = os.path.abspath(os.path.join(HERE, '..', '..', 'plaid-ud', 'services'))
LAYER_KEYS = {'text_layers': 'textLayers', 'token_layers': 'tokenLayers',
              'span_layers': 'spanLayers', 'relation_layers': 'relationLayers'}


@pytest.fixture
def parsed(live_client):
    """The fixture project with sentence 1 of "Viaje" all the parser's, every
    span and arc stamped machine, as a fresh Parse leaves it. "al" has no
    form spans: the assistant has no column to discard them (REVIEW_FIELDS),
    and human ones would make Parse refuse the sentence before any discard."""
    praw = project_raw()
    words = praw['text_layers'][0]['token_layers'][2]
    words['config'] = {'plaid': {'role': 'morpheme'}}
    doc = _parsed_raw()
    next(sl for sl in doc['text_layers'][0]['token_layers'][2]['span_layers'] if sl['id'] == FORM)['spans'] = []
    s = seed(live_client, praw, {'ud1': doc}, {}, name='ud-agent discard live test')
    lemma = next(sl for sl in words['span_layers'] if sl['id'] == LEMMA)
    with live_client.batched() as b:
        b.token_layers.set_config(s.ids[WORD_LAYER], 'plaid', 'role', 'syntactic-word')
        b.token_layers.set_constraints(s.ids[WORD_LAYER], 'ud', [{'type': 'coextensive'}])
        for rl in lemma['relation_layers']:
            rid = s._mint(rl['id'])
            b.relation_layers.create(s.ids[LEMMA], rl['name'], id=rid)
            for ns, cfg in (rl.get('config') or {}).items():
                for k, v in cfg.items():
                    b.relation_layers.set_config(rid, ns, k, v)
        rels = doc['text_layers'][0]['token_layers'][2]['span_layers'][1]['relation_layers'][0]['relations']
        for r in rels:
            b.relations.create(s.ids[DEPREL], s.ids[r['source']], s.ids[r['target']], r['value'],
                               r['metadata'], id=s._mint(r['id']))
    yield s
    s.delete()


def _stored(s):
    """The document as stored, and the project as the client reads it."""
    project = s.client.projects.get(s.project_id)
    raw = s.client.documents.get(s.ids['ud1'], include_body=True)
    return raw, project


def _layer(raw, layer_id):
    for tl in raw['text_layers']:
        for tk in tl['token_layers']:
            if tk['id'] == layer_id:
                return tk
    raise KeyError(layer_id)


def _camel(raw, project):
    """The document as the JavaScript client hands it to the editor: layer
    lists in camelCase, each layer carrying the project's config for it."""
    config = {}

    def collect(node):
        for key in LAYER_KEYS:
            for child in node.get(key) or []:
                config[child['id']] = child.get('config') or {}
                collect(child)
    collect(project)

    def convert(node):
        out = {}
        for k, v in node.items():
            key = LAYER_KEYS.get(k, k)
            out[key] = [convert(c) for c in v] if key != k else v
        if out.get('id') in config and any(k in out for k in ('tokens', 'spans', 'relations', 'text')):
            out['config'] = config[out['id']]
        return out
    return convert(copy.deepcopy(raw))


def _grid(raw, project):
    """Per sentence, what plaid-ud's grid holds up for review (the runner)."""
    node = _node()
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'doc.json')
        with open(path, 'w') as fh:
            json.dump(_camel(raw, project), fh)
        run = subprocess.run([node, RUNNER, path], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    return json.loads(run.stdout)


_PARSE = []


def _parse_service():
    """The Parse service's own module. Its rule needs no Stanza, so an empty
    module stands in for the library, which is not installed everywhere this
    suite runs."""
    if not _PARSE:
        _PARSE.append(servicetest.load_service(os.path.join(SERVICES, 'ud_parse_stanza.py'),
                                               {'stanza': types.ModuleType('stanza')}))
    return _PARSE[0]


def _parse_refuses(raw, s):
    """The sentences Parse leaves alone as a person's work, by its own rule
    (ud_parse_stanza ``protected_sentence_indexes``)."""
    protected_sentence_indexes = _parse_service().protected_sentence_indexes
    words = _layer(raw, s.ids[WORD_LAYER])
    sentences = sorted(_layer(raw, s.ids[SENT_LAYER])['tokens'], key=lambda t: t['begin'])
    m2s = {m['id']: i for m in words['tokens'] for i, sent in enumerate(sentences)
           if sent['begin'] <= m['begin'] and m['end'] <= sent['end']}
    lemma = next(sl for sl in words['span_layers'] if sl['id'] == s.ids[LEMMA])
    return protected_sentence_indexes(words, lemma, m2s)


@pytest.mark.parametrize('refs', [None, ['s1.w1', 's1.w2', 's1.w3', 's1.w4', 's1.w5']])
def test_after_a_discard_nothing_waits_for_review_and_parse_takes_the_sentence(parsed, refs):
    s = parsed
    raw, project = _stored(s)
    assert _grid(raw, project)[0] == {'words': 5, 'discardable': True}
    assert _parse_refuses(raw, s) == set()

    ud = load_project(s.client, s.project_id)
    ws = Workspace(s.client, ud)
    args = {'document': 'Viaje', **({'refs': refs} if refs else {})}
    assert 'Planned' in call_tool(ws, 'discard_predictions', args)
    execute_plan(s.client, ws.ops, source='s', label='l', stamp_mode='verified', project=ud)

    raw, project = _stored(s)
    words = _layer(raw, s.ids[WORD_LAYER])
    lemma = next(sl for sl in words['span_layers'] if sl['id'] == s.ids[LEMMA])
    assert lemma.get('spans') == []
    assert [sp for sl in words['span_layers'] for sp in sl.get('spans') or [] if is_machine(sp.get('metadata'))] == []
    assert [r for rl in lemma.get('relation_layers') or [] for r in rl.get('relations') or []] == []
    assert _grid(raw, project) == [{'words': 0, 'discardable': False}, {'words': 0, 'discardable': False}]
    assert _parse_refuses(raw, s) == set()


def test_a_lemma_whose_arc_stays_keeps_its_place_unverified(parsed):
    """Lemmas only: every arc stays, so every lemma span stays, valueless and
    the machine's. Parse still takes the sentence."""
    s = parsed
    ud = load_project(s.client, s.project_id)
    ws = Workspace(s.client, ud)
    assert 'Planned' in call_tool(ws, 'discard_predictions', {'document': 'Viaje', 'field': 'lemma'})
    execute_plan(s.client, ws.ops, source='s', label='l', stamp_mode='verified', project=ud)

    raw, _project = _stored(s)
    words = _layer(raw, s.ids[WORD_LAYER])
    lemma = next(sl for sl in words['span_layers'] if sl['id'] == s.ids[LEMMA])
    assert len(lemma['spans']) == 5
    assert all(sp.get('value') is None and is_machine(sp.get('metadata')) for sp in lemma['spans'])
    assert len([r for rl in lemma['relation_layers'] for r in rl['relations']]) == 5
    assert _parse_refuses(raw, s) == set()


def test_a_confirm_after_a_discard_of_lemmas_takes_the_heads_and_leaves_the_empty_lemmas(parsed):
    """REV-JOIN20-2: after a discard of lemmas only, every head stays the
    parser's on a valueless machine lemma. A confirm of the whole document
    took those empty lemmas too, as the grid's Accept did, and stamped them
    verified. It takes the heads and the other values, and leaves each empty
    lemma the machine's."""
    s = parsed
    ud = load_project(s.client, s.project_id)
    ws = Workspace(s.client, ud)
    assert 'Planned' in call_tool(ws, 'discard_predictions', {'document': 'Viaje', 'field': 'lemma'})
    execute_plan(s.client, ws.ops, source='s', label='l', stamp_mode='verified', project=ud)

    ud = load_project(s.client, s.project_id)
    ws = Workspace(s.client, ud)
    said = call_tool(ws, 'confirm', {'document': 'Viaje'})
    assert 'Planned' in said and 'lemma' not in said, said
    execute_plan(s.client, ws.ops, source='s', label='l', stamp_mode='verified', project=ud)

    raw, project = _stored(s)
    words = _layer(raw, s.ids[WORD_LAYER])
    lemma = next(sl for sl in words['span_layers'] if sl['id'] == s.ids[LEMMA])
    assert len(lemma['spans']) == 5
    assert all(sp.get('value') is None and is_machine(sp.get('metadata')) for sp in lemma['spans'])
    relations = [r for rl in lemma['relation_layers'] for r in rl['relations']]
    assert len(relations) == 5 and not any(is_machine(r.get('metadata')) for r in relations)
    # The grid holds nothing up for review: the empty lemmas are no stop.
    assert _grid(raw, project)[0]['words'] == 0
