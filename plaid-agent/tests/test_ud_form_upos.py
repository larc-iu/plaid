"""check_consistency kind form-upos: a form under several UPOS, the most
one-sided first, from grouped reads in a real core.

Survey 14: the best finding of one conversation ("۔" tagged PUNCT 735 times
and AUX, VERB or PART 9 times) took two walks over the corpus, since no check
grouped forms by UPOS.
"""

import copy

import pytest

from live import live_client, seed  # noqa: F401 - fixture
from plaid_agent.ud.project import load_project
from plaid_agent.ud.stats import CONSISTENCY, t_check_consistency
from plaid_agent.ud.tools import Workspace
from ud_fixtures import LEMMA, UPOS, document_raw, project_raw


def _copy(prefix, name, upos=None):
    """The fixture document under fresh ids, with some UPOS spans changed
    (span id -> value)."""
    doc = copy.deepcopy(document_raw())
    doc['id'], doc['name'] = prefix + doc['id'], name
    for tl in doc['text_layers']:
        tl['text']['id'] = prefix + tl['text']['id']
        for tk in tl['token_layers']:
            for t in tk.get('tokens') or []:
                t['id'] = prefix + t['id']
            for sl in tk.get('span_layers') or []:
                for sp in sl.get('spans') or []:
                    if sl['id'] == UPOS and sp['id'] in (upos or {}):
                        sp['value'] = upos[sp['id']]
                    sp['id'] = prefix + sp['id']
                    sp['tokens'] = [prefix + x for x in sp['tokens']]
                for rl in sl.get('relation_layers') or []:
                    rl['relations'] = []
    return doc


@pytest.fixture(scope='module')
def ws(live_client):
    """Four copies of "Vamos al mar. Corre.": "." is PUNCT in three and SYM in
    one, and "el" (a Form span, half of "al") is DET in three and PRON in one."""
    raw = project_raw()
    words = raw['text_layers'][0]['token_layers'][2]
    words['config'] = {'plaid': {'role': 'morpheme'}}
    docs = {'a-ud1': _copy('a-', 'Uno'), 'b-ud1': _copy('b-', 'Dos'), 'c-ud1': _copy('c-', 'Tres'),
            'd-ud1': _copy('d-', 'Cuatro', {'sp-u4': 'SYM', 'sp-u2b': 'PRON'})}
    s = seed(live_client, raw, docs, {}, name='ud-agent form-upos test')
    from live import Seeded
    lemma = next(sl for sl in words['span_layers'] if sl['id'] == LEMMA)
    with live_client.batched() as b:
        b.token_layers.set_config(s.ids[words['id']], 'plaid', 'role', 'syntactic-word')
        for rl in lemma['relation_layers']:
            rid = s._mint(rl['id'])
            b.relation_layers.create(s.ids[LEMMA], rl['name'], id=rid)
            Seeded._configs(b.relation_layers, rid, rl.get('config'))
    yield Workspace(live_client, load_project(live_client, s.project_id))
    s.delete()


def test_forms_under_several_upos_are_listed_one_sided_first(ws):
    out = t_check_consistency(ws, kind='form-upos')
    assert out.splitlines() == [
        'Forms with more than one UPOS: 2, the most one-sided first.',
        '  The rarer tags of a one-sided form are where to look: grew_search with [form="...", upos=...] '
        'lists those words.',
        "  '.': PUNCT x3 (75%), SYM x1",
        "  'el': DET x3 (75%), PRON x1",
    ]


def test_every_check_runs_when_none_is_named(ws):
    assert 'form-upos' in CONSISTENCY
    out = t_check_consistency(ws)
    assert 'Forms with more than one UPOS: 2' in out and 'Forms with more than one lemma' in out


def test_no_disagreement_is_one_line_with_no_hint(ws):
    """H16-UD-TOOLS-5: the grew_search hint is for forms found, so a check
    that found none says so in one line."""
    assert t_check_consistency(ws, kind='form-upos', document='Uno') == \
        'In "Uno":\nNo form has more than one UPOS.'
