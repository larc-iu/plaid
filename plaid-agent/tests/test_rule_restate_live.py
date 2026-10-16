"""A named change a rule rewrites, on a live core (FX-E-AGENT, REV4-AGENT-2 to
4): a form rule reads the form on the value's own word, a rule asked again
applies last unless it then finds nothing, and dropping a rule takes back
what it changed in the plan's analyses. The fake-client cases are in
``test_rule_chain.py``, the generated sweep in ``test_rule_plan_model.py``."""

import json

from fixtures import GLOSS, MGLOSS, MORPH_LAYER, SENT_LAYER, TEXT_LAYER, VOCAB, WORD_LAYER, lexicon_raw
from live import live_client, seed  # noqa: F401
from rule_plan_model import approve, project

from plaid_agent.core.plan import plan_changes
from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace


def _doc(did, name, words):
    """One sentence of ``words``: (surface, gloss, [(morpheme form, gloss)])."""
    body, toks, morphs, gl, mg = '', [], [], [], []
    for i, (surface, gloss, ms) in enumerate(words):
        b = len(body)
        body += surface + ' '
        wid = f'{did}-w{i}'
        toks.append({'id': wid, 'begin': b, 'end': b + len(surface)})
        if gloss:
            gl.append({'id': f'{did}-g{i}', 'value': gloss, 'tokens': [wid],
                       'metadata': {'prov': 'human-marker'}})
        for k, (form, mgloss) in enumerate(ms):
            mid = f'{did}-m{i}{k}'
            morphs.append({'id': mid, 'begin': b, 'end': b + len(surface), 'precedence': k + 1,
                           'metadata': {'form': form}})
            if mgloss:
                mg.append({'id': f'{did}-mg{i}{k}', 'value': mgloss, 'tokens': [mid]})
    body = body.rstrip()
    return {'id': did, 'name': name, 'version': 1, 'text_layers': [{
        'id': TEXT_LAYER, 'name': 'Text', 'text': {'id': f'{did}-text', 'body': body},
        'token_layers': [
            {'id': SENT_LAYER, 'tokens': [{'id': f'{did}-s0', 'begin': 0, 'end': len(body)}], 'span_layers': []},
            {'id': WORD_LAYER, 'tokens': toks, 'span_layers': [{'id': GLOSS, 'spans': gl}], 'vocabs': []},
            {'id': MORPH_LAYER, 'tokens': morphs, 'span_layers': [{'id': MGLOSS, 'spans': mg}], 'vocabs': []},
        ]}]}


def _glosses(c, pid, name='Doc A'):
    doc = Workspace(c, load_project(c, pid)).doc(name)
    return [(w.fields['Gloss'].value, json.dumps(w.fields['Gloss'].metadata, sort_keys=True))
            if 'Gloss' in w.fields else ('', None) for s in doc.sentences for w in s.words]


def _seeded(c, docs, name):
    s = seed(c, project(), {d['id']: d for d in docs}, {VOCAB: lexicon_raw()}, name=name)
    return s, Workspace(c, load_project(c, s.project_id))


def test_a_form_rule_rewrites_a_named_value_whose_stored_value_is_already_its_own(live_client):
    # REV4-AGENT-3: "ka" holds "C"; the plan names "B" for it, then every "ka" is "C".
    c = live_client
    s, ws = _seeded(c, [_doc('d0', 'Doc A', [('ka', 'C', []), ('to', 'X', [])])], 'restate form')
    try:
        before = _glosses(c, s.project_id)
        call_tool(ws, 'set_field', {'document': 'Doc A', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'B'})
        out = call_tool(ws, 'set_field_for_form', {'form': 'ka', 'field': 'Gloss', 'value': 'C', 'only_empty': False})
        assert 'no occurrences' not in out, out
        assert 'rewritten by this one back to the value stored' in out, out
        assert plan_changes(ws.plan_payload()['ops']) == 0
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors and h.done[0].get('applied') == 0, (h.errors, h.done)
        assert _glosses(c, s.project_id) == before
    finally:
        s.delete()


def test_a_cleared_value_a_fill_rule_sets_back_is_no_change(live_client):
    c = live_client
    s, ws = _seeded(c, [_doc('d0', 'Doc A', [('ka', 'A', []), ('to', 'X', [])])], 'restate clear')
    try:
        before = _glosses(c, s.project_id)
        call_tool(ws, 'set_field', {'document': 'Doc A', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': ''})
        call_tool(ws, 'set_field_for_form', {'form': 'ka', 'field': 'Gloss', 'value': 'A', 'only_empty': False})
        assert ws.ops[0]['kind'] == 'keep', ws.ops
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors and h.done[0].get('applied') == 0, (h.errors, h.done)
        assert _glosses(c, s.project_id) == before
    finally:
        s.delete()


def test_a_form_rule_whose_occurrences_hold_its_value_says_so(live_client):
    c = live_client
    s, ws = _seeded(c, [_doc('d0', 'Doc A', [('ka', 'C', []), ('ka', 'C', []), ('to', 'X', [])])], 'form holds')
    try:
        out = call_tool(ws, 'set_field_for_form', {'form': 'ka', 'field': 'Gloss', 'value': 'C', 'only_empty': False})
        assert out == 'Nothing to change: all 2 occurrences of "ka" hold Gloss "C" already.', out
    finally:
        s.delete()


def test_a_rule_asked_again_that_then_finds_nothing_stays_where_it_was(live_client):
    # "A" → "B" in Doc A, then "A" → "C" everywhere, then "A" → "B" in Doc A
    # again: after the later rule it finds nothing, so the plan stays.
    c = live_client
    s, ws = _seeded(c, [_doc('d0', 'Doc A', [('ka', 'A', [])]), _doc('d1', 'Doc B', [('to', 'A', [])])], 'again')
    try:
        first = {'field': 'Gloss', 'pattern': 'A', 'replacement': 'B', 'whole': True, 'document': 'Doc A'}
        call_tool(ws, 'replace_in_field', first)
        call_tool(ws, 'replace_in_field', {'field': 'Gloss', 'pattern': 'A', 'replacement': 'C', 'whole': True})
        out = call_tool(ws, 'replace_in_field', first)
        assert out == ('Nothing to change after the changes planned since: this change is planned already as '
                       'entry 1, which stays where it is.'), out
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert [v for v, _m in _glosses(c, s.project_id)] == ['B']
        assert [v for v, _m in _glosses(c, s.project_id, 'Doc B')] == ['C']
    finally:
        s.delete()


def test_dropping_a_form_rule_takes_back_its_values_in_planned_analyses(live_client):
    c = live_client
    s, ws = _seeded(c, [_doc('d0', 'Doc A', [('kas', '', [('kas', '')]), ('ka', '', [('ka', '')])])], 'undo')
    try:
        call_tool(ws, 'set_analysis', {'document': 'Doc A', 'ref': 's1.w1',
                                       'morphemes': [{'form': 'ka'}, {'form': 's'}]})
        analysis = ws.ops[0]
        out = call_tool(ws, 'set_field_for_form', {'form': 'ka', 'field': 'Morph Gloss', 'value': 'DO'})
        assert '1 more in analyses this plan already holds, changed there.' in out, out
        assert ws.ops[0] != analysis
        out = call_tool(ws, 'drop_planned', {'indexes': [2]})
        assert 'The values it set in 1 planned analysis were taken back.' in out, out
        assert ws.ops == [analysis]
    finally:
        s.delete()
