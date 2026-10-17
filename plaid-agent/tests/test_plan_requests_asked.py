"""A request is identified by what it asked, not by what it changed
(REV8-PLAN, parent ruling 2026-10-17). Each test is a REV8-PLAN shape, held
against the plan the remaining requests make in a fresh workspace, and where
it matters against what approval writes. Live core."""
import json
import re
import time

import pytest

from live import live_client, seed  # noqa: F401
from fixtures import lexicon_raw, VOCAB
from rule_plan_model import approve, as_applied, project, values_of
from test_rule_restate_live import _doc

from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace

W = [('kan', 'G', [('ka', 'K'), ('n', '')]), ('to', 'H', [('to', 'K')]), ('mi', '', [('mi', '')])]


def _seeded(c, name, words=W, words_b=None):
    docs = [_doc('d0', 'Doc A', words)] + ([_doc('d1', 'Doc B', words_b)] if words_b else [])
    s = seed(c, project(), {d['id']: d for d in docs}, {VOCAB: lexicon_raw()}, name=name)
    return s, Workspace(c, load_project(c, s.project_id))


def _fresh(c, s):
    return Workspace(c, load_project(c, s.project_id))


def _ask(ws, *reqs):
    outs = []
    for tool, args in reqs:
        out = call_tool(ws, tool, args)
        assert not out.startswith('Error'), (tool, out)
        outs.append(out)
    return outs


def _plan(ws):
    p = ws.plan_payload()
    if p is None:
        return None
    p = json.loads(json.dumps(p, default=str))
    p.pop('id', None)
    return p


def _rows(ws):
    return [r['label'] for r in (_plan(ws) or {}).get('changes') or []]


def _scratch(c, s, *reqs):
    ws = _fresh(c, s)
    for tool, args in reqs:
        call_tool(ws, tool, args)
    return ws


ASKED_TWICE = {
    'a word value': ('set_field', {'document': 'Doc A', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'Q'}),
    'a morpheme value': ('set_field', {'document': 'Doc A', 'refs': ['s1.w1.m1'], 'field': 'Morph Gloss',
                                       'value': 'Q'}),
    'a word link': ('link_entry', {'document': 'Doc A', 'refs': ['s1.w2'], 'entry_form': 'gam#1'}),
    'a morpheme link': ('link_entry', {'document': 'Doc A', 'refs': ['s1.w1.m1'], 'entry_form': 'Ali'}),
    'a phrase link': ('link_phrase', {'document': 'Doc A', 'refs': ['s1.w2', 's1.w3'], 'entry_form': 'Ali'}),
    'a morpheme form': ('set_morpheme', {'document': 'Doc A', 'ref': 's1.w2.m1', 'form': 'tt'}),
}


@pytest.mark.parametrize('what', list(ASKED_TWICE))
def test_a_change_asked_twice_word_for_word_goes_with_one_drop(live_client, what):
    # REV8-PLAN-1: the second ask planned nothing (the plan held it already),
    # yet it asked for that change: dropping the change takes both asks.
    c = live_client
    s, ws = _seeded(c, 'twice ' + what)
    try:
        ask = ASKED_TWICE[what]
        other = ('set_field', {'document': 'Doc A', 'refs': ['s1.w3'], 'field': 'Gloss', 'value': 'Z'})
        _ask(ws, ask, other, ask)
        out = call_tool(ws, 'drop_planned', {'indexes': [1]})
        assert 'back in it' not in out, out
        assert _plan(ws) == _plan(_scratch(c, s, other))
        assert [r['tool'] for r in ws.requests] == ['set_field']
    finally:
        s.delete()


def test_a_ref_asked_again_among_others_goes_and_the_others_stay(live_client):
    # REV8-PLAN-1 (A2): the second request names s1.w2 again beside s1.w3.
    c = live_client
    s, ws = _seeded(c, 'overlap')
    try:
        _ask(ws, ('set_field', {'document': 'Doc A', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'Q'}),
             ('set_field', {'document': 'Doc A', 'refs': ['s1.w2', 's1.w3'], 'field': 'Gloss', 'value': 'Q'}))
        call_tool(ws, 'drop_planned', {'indexes': [1]})
        assert _plan(ws) == _plan(_scratch(c, s, ('set_field', {'document': 'Doc A', 'refs': ['s1.w3'],
                                                               'field': 'Gloss', 'value': 'Q'})))
    finally:
        s.delete()


def test_a_new_entry_given_a_field_afterwards_goes_whole_with_its_links(live_client):
    # REV8-PLAN-2 and -4: set_entry_field on the new entry is a request for
    # that entry, so dropping it takes both requests and the link to it. The
    # card row shows the value approval would write.
    c = live_client
    s, ws = _seeded(c, 'new entry field')
    try:
        out = call_tool(ws, 'create_entry', {'form': 'zu', 'fields': {'gloss': 'one'}})
        key = re.search(r'entry_id: (\S+)', out).group(1)
        _ask(ws, ('set_entry_field', {'entry_id': key, 'field': 'gloss', 'value': 'two'}))
        assert _rows(ws) == ['Lexicon: new entry zu | gloss=two']
        assert [ch['change'] for ch in _plan(ws)['changes']] == ['new entry zu | gloss=two']
        _ask(ws, ('link_entry', {'document': 'Doc A', 'refs': ['s1.w3'], 'entry_id': key}),
             ('set_field', {'document': 'Doc A', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'Q'}))
        out = call_tool(ws, 'drop_planned', {'indexes': [1]})
        assert 'back in it' not in out and 'Links to the dropped new entries were dropped with them.' in out, out
        assert _plan(ws) == _plan(_scratch(c, s, ('set_field', {'document': 'Doc A', 'refs': ['s1.w2'],
                                                               'field': 'Gloss', 'value': 'Q'})))
        assert not ws.new_entries
    finally:
        s.delete()


def test_a_drop_by_document_takes_a_value_an_analysis_had_taken_out(live_client):
    # REV8-PLAN-3: the value on s1.w1.m1 is held out by the analysis of s1.w1.
    c = live_client
    s, ws = _seeded(c, 'doc drop dormant')
    try:
        _ask(ws, ('set_field', {'document': 'Doc A', 'refs': ['s1.w1.m1', 's1.w2.m1'], 'field': 'Morph Gloss',
                                'value': 'Y'}),
             ('set_analysis', {'document': 'Doc A', 'ref': 's1.w1', 'morphemes': [{'form': 'k'}, {'form': 'an'}]}))
        out = call_tool(ws, 'drop_planned', {'document': 'Doc A'})
        assert 'back in it' not in out, out
        assert ws.ops == [] and ws.requests == []
    finally:
        s.delete()


def test_a_drop_by_field_takes_a_value_an_analysis_had_taken_out(live_client):
    # REV8-PLAN-3: dropping Morph Gloss, then the analysis, leaves nothing.
    c = live_client
    s, ws = _seeded(c, 'field drop dormant')
    try:
        _ask(ws, ('set_field', {'document': 'Doc A', 'refs': ['s1.w1.m1', 's1.w2.m1'], 'field': 'Morph Gloss',
                                'value': 'Y'}),
             ('set_analysis', {'document': 'Doc A', 'ref': 's1.w1', 'morphemes': [{'form': 'k'}, {'form': 'an'}]}))
        call_tool(ws, 'drop_planned', {'field': 'Morph Gloss'})
        out = call_tool(ws, 'drop_planned', {'indexes': [1]})
        assert 'back in it' not in out, out
        assert ws.ops == []
    finally:
        s.delete()


def test_a_value_another_user_wrote_after_planning_still_refuses_approval_after_a_drop(live_client):
    # REV8-PLAN-6: a drop asks the requests again over the reads they made,
    # so the rule still shows the 2 values it found, and approval refuses the
    # third another user wrote since.
    c = live_client
    wa = [('kan', 'G', [('kan', '')]), ('to', '', [('to', '')]), ('mi', 'G', [('mi', '')])]
    s, ws = _seeded(c, 'second user', wa, [('kan', '', [('kan', '')])])
    try:
        _ask(ws, ('replace_in_field', {'field': 'Gloss', 'pattern': 'G', 'replacement': 'Q', 'whole': True}),
             ('set_field', {'document': 'Doc B', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'Z'}))
        other = _fresh(c, s)
        _ask(other, ('set_field', {'document': 'Doc A', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'G'}))
        _p, h, _ = approve(c, s.project_id, other, tag='o')
        assert not h.errors, h.errors
        out = call_tool(ws, 'drop_planned', {'indexes': [2]})
        assert '2 values in 1 document' in out and 'more to change' not in out, out
        _p, h, _ = approve(c, s.project_id, ws)
        assert any('matches 3 places in 1 document, not the 2 shown' in e for e in h.errors), h.errors
    finally:
        s.delete()


def test_a_drop_that_leaves_a_rule_more_to_change_says_so(live_client):
    # REV8-PLAN-6: the named value after the rule took one of its matches;
    # dropped, the rule changes it again, and the answer says the rule grew.
    c = live_client
    wa = [('kan', 'G', [('kan', '')]), ('to', 'G', [('to', '')])]
    s, ws = _seeded(c, 'rule grew', wa)
    try:
        _ask(ws, ('replace_in_field', {'field': 'Gloss', 'pattern': 'G', 'replacement': 'Q', 'whole': True}),
             ('set_field', {'document': 'Doc A', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'X'}))
        i = next(i for i, o in enumerate(ws.ops, 1) if o.get('kind') == 'set_span')
        out = call_tool(ws, 'drop_planned', {'indexes': [i]})
        assert 'A corpus-wide change finds more to change without the dropped change' in out, out
        assert 'now makes 2 changes, 1 more than before' in out, out
    finally:
        s.delete()


def test_a_drop_by_field_names_the_field_as_stored_and_its_values_once(live_client):
    # REV8-PLAN-8.
    c = live_client
    s, ws = _seeded(c, 'field name')
    try:
        _ask(ws, ('set_analysis', {'document': 'Doc A', 'ref': 's1.w1',
                                   'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'X'}},
                                                 {'form': 'n', 'fields': {'Morph Gloss': 'Y'}}]}),
             ('set_analysis', {'document': 'Doc A', 'ref': 's1.w2',
                               'morphemes': [{'form': 't', 'fields': {'Morph Gloss': 'X'}}, {'form': 'o'}]}))
        out = call_tool(ws, 'drop_planned', {'field': 'morph gloss'})
        assert out.startswith('Took Morph Gloss out of 2 planned analyses: their morphemes and other values '
                              'stay.'), out
        assert 'values in planned analyses changed with it' not in out, out
    finally:
        s.delete()


def test_a_drop_reads_nothing_from_the_store_again(live_client):
    # REV8-PLAN-7: each request's reads are reused, so a drop on a plan of
    # 48 requests (12 each of two rules, set_field and set_analysis) over 20
    # documents runs no query, and takes well under a second.
    import random
    c = live_client
    rng = random.Random(3)
    docs = [_doc(f'd{d}', f'Doc {d}', [(f'w{rng.randrange(40)}', rng.choice(['G', 'H', '']),
                                        [(f'm{rng.randrange(20)}', rng.choice(['K', 'X', '']))]) for _ in range(30)])
            for d in range(20)]
    s = seed(c, project(), {x['id']: x for x in docs}, {VOCAB: lexicon_raw()}, name='drop cost')
    try:
        ws = Workspace(c, load_project(c, s.project_id))
        reqs = []
        for i in range(12):
            reqs += [('replace_in_field', {'field': 'Morph Gloss', 'pattern': rng.choice('KX'), 'replacement': f'R{i}',
                                           'whole': True}),
                     ('set_field_for_form', {'form': f'm{i}', 'field': 'Morph Gloss', 'value': f'F{i}',
                                             'only_empty': False}),
                     ('set_field', {'document': f'Doc {i}', 'refs': ['s1.w1', 's1.w2'], 'field': 'Gloss',
                                    'value': f'V{i}'}),
                     ('set_analysis', {'document': f'Doc {i}', 'ref': 's1.w3',
                                       'morphemes': [{'form': 'a'}, {'form': 'b'}]})]
        for tool, args in reqs:
            call_tool(ws, tool, args)
        queries = []
        real = ws.client.query
        ws.client.query = lambda body: queries.append(body) or real(body)
        try:
            t = time.monotonic()
            call_tool(ws, 'drop_planned', {'indexes': [len(ws.ops)]})
            took = time.monotonic() - t
        finally:
            ws.client.query = real
        assert queries == []
        assert took < 3, took
        last = next(i for i in range(len(reqs) - 1, -1, -1)
                    if reqs[i][0] == 'set_analysis')
        assert _plan(ws) == _plan(_scratch(c, s, *(reqs[:last] + reqs[last + 1:])))
    finally:
        s.delete()

