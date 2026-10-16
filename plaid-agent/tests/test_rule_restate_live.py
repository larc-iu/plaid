"""A named change a rule rewrites, on a live core (FX-E-AGENT, REV4-AGENT-2 to
4): a form rule reads the form on the value's own word, a rule asked again
applies last unless it then finds nothing, and dropping a rule takes back
what it changed in the plan's analyses. The fake-client cases are in
``test_rule_chain.py``, the generated sweep in ``test_rule_plan_model.py``."""

import json

from fixtures import GLOSS, MGLOSS, MORPH_LAYER, SENT_LAYER, TEXT_LAYER, VOCAB, WORD_LAYER, lexicon_raw
from live import live_client, seed  # noqa: F401
from rule_plan_model import approve, project, resumed

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
        # Nothing to write: approved, it settles as discarded (Luke 2026-10-16).
        _p, h, _ = approve(c, s.project_id, ws)
        assert h.errors == ['Nothing to write. The plan was discarded.'] and not h.done, (h.errors, h.done)
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
        # Nothing to write: approved, it settles as discarded (Luke 2026-10-16).
        _p, h, _ = approve(c, s.project_id, ws)
        assert h.errors == ['Nothing to write. The plan was discarded.'] and not h.done, (h.errors, h.done)
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
        assert out == ('Nothing to change after the changes planned since: this change is entry 1 already, which '
                       'stays where it is and writes 1 value.'), out
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
        assert out.endswith(' 1 value in analyses this plan already holds, changed there.'), out
        assert ws.ops[0] != analysis
        out = call_tool(ws, 'drop_planned', {'indexes': [2]})
        assert out.startswith('Dropped 1 planned change. 1 value it set in planned analyses was taken back.'), out
        assert ws.ops == [analysis]
    finally:
        s.delete()


def test_a_rule_asked_again_after_resume_over_a_cycle_approves_untouched(live_client):
    # REV5-AGENT-3: "C" -> "B", "B" -> "C" (values go back to stored),
    # resume_plan, then "B" -> "C" again. Nobody writes; approval writes the
    # one net change and refuses nothing. The values are a person's, and the
    # resumed turn never reads Doc B.
    c = live_client
    docs = [_doc('d0', 'Doc A', [('ka', 'B', []), ('to', 'C', []), ('mi', '', [])]),
            _doc('d1', 'Doc B', [('ka', 'C', []), ('to', 'C', [])])]
    for d in docs:
        for sp in d['text_layers'][0]['token_layers'][1]['span_layers'][0]['spans']:
            sp.pop('metadata')
    s, ws = _seeded(c, docs, 'resume cycle again')
    try:
        def rep(p, r):
            return call_tool(ws, 'replace_in_field', {'field': 'Gloss', 'pattern': p, 'replacement': r,
                                                      'whole': True})
        rep('C', 'B')
        rep('B', 'C')
        ws = resumed(c, s.project_id, ws)
        assert ws.resolve_document_id('Doc B') not in ws._docs
        rep('B', 'C')
        assert plan_changes(ws.plan_payload()['ops']) == 1
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors and h.done[0].get('applied') == 1, (h.errors, h.done)
        assert [v for v, _m in _glosses(c, s.project_id)] == ['C', 'C', '']
        assert [v for v, _m in _glosses(c, s.project_id, 'Doc B')] == ['C', 'C']
    finally:
        s.delete()


_KA = [('ka', '', [('ka', '')]), ('kan', '', [('ka', ''), ('n', '')]), ('kan', '', [('ka', ''), ('n', '')])]
_ANA = {'document': 'Doc A', 'ref': 's1.w2', 'morphemes': [{'form': 'ka'}, {'form': 'n'}]}


def _form(form, value, only_empty=False):
    return {'form': form, 'field': 'Morph Gloss', 'value': value, 'only_empty': only_empty}


def _analysis(ws):
    [op] = [o for o in ws.ops if o.get('kind') == 'set_analysis']
    return [next((f['value'] for f in m.get('fields') or []), '') for m in op['morphemes']]


def _morph_glosses(c, pid):
    doc = Workspace(c, load_project(c, pid)).doc('Doc A')
    return [[m.fields['Morph Gloss'].value if 'Morph Gloss' in m.fields else '' for m in w.morphemes]
            for s in doc.sentences for w in s.words]


def _analysis_case(c, name, steps, analysis, stored, said=None):
    s, ws = _seeded(c, [_doc('d0', 'Doc A', _KA)], name)
    try:
        call_tool(ws, 'set_analysis', _ANA)
        out = None
        for tool, args in steps:
            out = call_tool(ws, tool, args)
        if said is not None:
            assert said in out, out
        assert _analysis(ws) == analysis, (_analysis(ws), out)
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert _morph_glosses(c, s.project_id) == stored
    finally:
        s.delete()


def test_dropping_a_form_rule_asked_again_takes_back_only_what_its_last_copy_set(live_client):
    # REV5-AGENT-1: "X" on every ka, "Y", "X" again, then drop "X": the
    # analysis's ka holds "Y", as the card's "Y" row says.
    _analysis_case(live_client, 'undo re-ask',
                   [('set_field_for_form', _form('ka', 'X')), ('set_field_for_form', _form('ka', 'Y')),
                    ('set_field_for_form', _form('ka', 'X')), ('drop_planned', {'indexes': [3]})],
                   ['Y', ''], [['Y'], ['Y', ''], ['Y', '']],
                   said='1 value it set in planned analyses was taken back.')


def test_dropping_a_form_rule_asked_again_without_a_change_between_takes_its_value_back(live_client):
    _analysis_case(live_client, 'undo re-ask twice',
                   [('set_field_for_form', _form('ka', 'X')), ('set_field_for_form', _form('ka', 'X')),
                    ('drop_planned', {'indexes': [2]})],
                   ['', ''], [[''], ['', ''], ['', '']])


def test_dropping_a_form_rule_takes_back_its_value_whatever_else_changed_the_analysis(live_client):
    # REV5-AGENT-2, the three shapes: a form rule on the other morpheme
    # before or after it, and a value named on the other morpheme.
    _analysis_case(live_client, 'undo, rule before',
                   [('set_field_for_form', _form('n', 'X', True)), ('set_field_for_form', _form('ka', 'Q')),
                    ('drop_planned', {'indexes': [2]})],
                   ['Q', ''], [['Q'], ['Q', ''], ['Q', '']])
    _analysis_case(live_client, 'undo, rule after',
                   [('set_field_for_form', _form('ka', 'X')), ('set_field_for_form', _form('n', 'Z')),
                    ('drop_planned', {'indexes': [2]})],
                   ['', 'Z'], [[''], ['', 'Z'], ['', 'Z']])
    _analysis_case(live_client, 'undo, named after',
                   [('set_field_for_form', _form('ka', 'X')),
                    ('set_field', {'document': 'Doc A', 'refs': ['s1.w2.m2'], 'field': 'Morph Gloss', 'value': 'Q'}),
                    ('drop_planned', {'indexes': [2]})],
                   ['', 'Q'], [[''], ['', 'Q'], ['', '']])


def test_dropping_a_form_rule_leaves_a_value_named_over_its_own(live_client):
    _analysis_case(live_client, 'undo, named over it',
                   [('set_field_for_form', _form('ka', 'X')),
                    ('set_field', {'document': 'Doc A', 'refs': ['s1.w2.m1'], 'field': 'Morph Gloss', 'value': 'Q'}),
                    ('drop_planned', {'indexes': [2]})],
                   ['Q', ''], [[''], ['Q', ''], ['', '']],
                   said='1 value it set in planned analyses, changed since, stays as planned.')


def test_a_form_rule_that_reaches_only_a_planned_analysis_is_staged_and_its_drop_takes_the_value_back(live_client):
    c = live_client
    s, ws = _seeded(c, [_doc('d0', 'Doc A', [('ka', '', [('ka', '')]), ('kan', '', [('kan', '')])])], 'only analysis')
    try:
        call_tool(ws, 'set_analysis', _ANA)
        out = call_tool(ws, 'set_field_for_form', _form('n', 'X'))
        assert out.startswith('Planned 0 changes') and out.endswith(
            ' 1 value in analyses this plan already holds, changed there.'), out
        assert _analysis(ws) == ['', 'X'] and len(ws.ops) == 2
        out = call_tool(ws, 'drop_planned', {'indexes': [2]})
        assert out.startswith('Dropped 1 entry. 1 value it set in planned analyses was taken back.'), out
        assert _analysis(ws) == ['', ''] and len(ws.ops) == 1
    finally:
        s.delete()
