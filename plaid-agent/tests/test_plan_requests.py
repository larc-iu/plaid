"""A drop asks every remaining request again from scratch (Luke 2026-10-16,
REV7-PLAN-2 to -7), and a drop by field takes only that field's values out of
a planned analysis (PLAN-2). Each test is a REV7-PLAN shape, held against the
plan the same requests make in a fresh workspace and against what approval
writes. Live core."""
import json

from live import live_client, seed  # noqa: F401
from fixtures import lexicon_raw, VOCAB
from rule_plan_model import approve, as_applied, project, resumed, values_of
from test_rule_restate_live import _doc

from plaid_agent.core import rules
from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace


def _seeded(c, docs, name):
    s = seed(c, project(), {d['id']: d for d in docs}, {VOCAB: lexicon_raw()}, name=name)
    return s, Workspace(c, load_project(c, s.project_id))


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


def _scratch(c, s, *reqs):
    ws = Workspace(c, load_project(c, s.project_id))
    for tool, args in reqs:
        call_tool(ws, tool, args)
    return ws


def _rows(ws):
    return [r['label'] for r in (_plan(ws) or {}).get('changes') or []]


def _written(c, s, ws):
    _p, h, _ = approve(c, s.project_id, ws)
    assert h is None or not as_applied(h).errors, h.errors
    return values_of(Workspace(c, load_project(c, s.project_id)))


def _rf(pattern, rep, whole):
    return ('replace_in_field', {'field': 'Morph Gloss', 'pattern': pattern, 'replacement': rep, 'whole': whole})


def _mg(doc, ref, value):
    return ('set_field', {'document': doc, 'refs': [ref], 'field': 'Morph Gloss', 'value': value})


def test_a_rule_a_drop_left_with_nothing_comes_back_when_a_later_drop_gives_it_work(live_client):
    # REV7-PLAN-2: dropping N took R2 out as finding nothing, and dropping R1
    # then left an empty plan, where R2 asked from scratch finds mo's K.
    c = live_client
    s, ws = _seeded(c, [_doc('d0', 'Doc A', [('ta', '', [('ta', 'Z')]), ('mo', '', [('mo', 'K')])])], 'inert back')
    try:
        r1, n, r2 = _rf('K', 'X', True), _mg('Doc A', 's1.w1.m1', 'K'), _rf('K', 'Y', False)
        _ask(ws, r1, n, r2)
        out = call_tool(ws, 'drop_planned', {'indexes': [2]})
        assert 'now finds nothing to change and left the plan' in out, out
        out = call_tool(ws, 'drop_planned', {'indexes': [1]})
        assert '1 entry that the dropped change had held out of the plan is back in it.' in out, out
        assert _plan(ws) == _plan(_scratch(c, s, r2))
        assert _written(c, s, ws)[('Doc A', 's1.w2.m1', 'Morph Gloss')] == 'Y'
    finally:
        s.delete()


def test_a_value_an_analysis_took_out_comes_back_when_the_analysis_is_dropped(live_client):
    # REV7-PLAN-3
    c = live_client
    s, ws = _seeded(c, [_doc('d0', 'Doc A', [('ka', '', [('ka', 'K')]), ('kan', '', [('kan', 'K')])])], 'taken out')
    try:
        named = _mg('Doc A', 's1.w2.m1', 'Y')
        _ask(ws, named, ('set_analysis', {'document': 'Doc A', 'ref': 's1.w2',
                                          'morphemes': [{'form': 'ka'}, {'form': 'n'}]}))
        assert len(ws.ops) == 1
        call_tool(ws, 'drop_planned', {'indexes': [1]})
        assert _rows(ws) == ['Doc A s1.w2.m1 "kan": Morph Gloss "K" → "Y"']
        assert _plan(ws) == _plan(_scratch(c, s, named))
    finally:
        s.delete()


def test_a_request_answered_nothing_to_change_is_asked_again_after_a_drop(live_client):
    # REV7-PLAN-4, Luke 2026-10-16: every remaining request, this one too.
    c = live_client
    s, ws = _seeded(c, [_doc('d0', 'Doc A', [('ka', '', [('ka', 'K')]), ('kan', '', [('kan', 'K')])])], 'noop back')
    try:
        rule = _rf('K', 'X', True)
        outs = _ask(ws, ('set_analysis', {'document': 'Doc A', 'ref': 's1.w2',
                                          'morphemes': [{'form': 'ka'}, {'form': 'n'}]}),
                    ('set_analysis', {'document': 'Doc A', 'ref': 's1.w1', 'morphemes': [{'form': 'k'}, {'form': 'a'}]}),
                    rule)
        assert outs[-1].startswith('Nothing to change'), outs[-1]
        call_tool(ws, 'drop_planned', {'indexes': [1, 2]})
        assert _plan(ws) == _plan(_scratch(c, s, rule))
        assert any(rules.is_rule(o) for o in ws.ops)
        after = _written(c, s, ws)
        assert after[('Doc A', 's1.w1.m1', 'Morph Gloss')] == after[('Doc A', 's1.w2.m1', 'Morph Gloss')] == 'X'
    finally:
        s.delete()


def test_a_rule_found_again_keeps_its_match_mode(live_client):
    # REV7-PLAN-5: a keep finds the rule again, and its row still says how
    # it matches.
    c = live_client
    s, ws = _seeded(c, [_doc('d0', 'Doc A', [('ka', '', [('ka', 'K')]), ('mo', '', [('mo', 'K')])])], 'mode kept')
    try:
        _ask(ws, _rf('K', 'X', True), _mg('Doc A', 's1.w1.m1', 'K'))
        rule = next(o for o in ws.ops if rules.is_rule(o))
        assert rule.get('mode') == 'the whole value, case-sensitive', rule.get('mode')
        row = next(r for r in _plan(ws)['changes'] if r.get('rule'))
        assert row['rule'].get('mode') == 'the whole value, case-sensitive', row['rule']
    finally:
        s.delete()


def test_a_keep_on_a_morpheme_an_analysis_replaces_goes_with_it(live_client):
    # REV7-PLAN-6: the card read "stays K" beside an analysis that deletes
    # that morpheme. Dropped with it, the keep comes back.
    c = live_client
    s, ws = _seeded(c, [_doc('d0', 'Doc A', [('ka', '', [('ka', 'K')]), ('kan', '', [('ka', 'K'), ('n', '')])])],
                    'keep under analysis')
    try:
        _ask(ws, _rf('K', 'Q', True), _mg('Doc A', 's1.w2.m1', 'K'))
        assert any(o.get('kind') == 'keep' for o in ws.ops)
        _ask(ws, ('set_analysis', {'document': 'Doc A', 'ref': 's1.w2', 'morphemes': [{'form': 'kan'}]}))
        assert not any(o.get('kind') == 'keep' for o in ws.ops), ws.ops
        assert not any('stays' in r for r in _rows(ws)), _rows(ws)
        i = next(i for i, o in enumerate(ws.ops, 1) if o.get('kind') == 'set_analysis')
        call_tool(ws, 'drop_planned', {'indexes': [i]})
        assert any(o.get('kind') == 'keep' for o in ws.ops), ws.ops
    finally:
        s.delete()


def test_an_unrelated_drop_leaves_a_row_a_rule_asked_again_emptied(live_client):
    # REV7-PLAN-7: the drop took that row and called it "later".
    c = live_client
    s, ws = _seeded(c, [_doc('d0', 'Doc A', [('ka', 'G', [('ka', 'K')]), ('mo', '', [('mo', 'K')])])], 'reask row')
    try:
        reqs = [_rf('K', 'X', True), _rf('X', 'Z', True), _rf('K', 'X', True),
                ('set_field', {'document': 'Doc A', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'H'})]
        _ask(ws, *reqs)
        gi = next(i for i, o in enumerate(ws.ops, 1) if o.get('kind') == 'set_span')
        out = call_tool(ws, 'drop_planned', {'indexes': [gi]})
        assert 'later' not in out and 'went with it' not in out, out
        assert _plan(ws) == _plan(_scratch(c, s, *reqs[:3]))
    finally:
        s.delete()


def test_a_rule_dropped_by_number_stays_dropped_though_it_was_asked_twice(live_client):
    # Its second ask answered "Nothing to change" as the entry it already
    # was: that request stands for the same rule and goes with it.
    c = live_client
    s, ws = _seeded(c, [_doc('d0', 'Doc A', [('ka', '', [('ka', 'K')])])], 'asked twice')
    try:
        rule = _rf('K', 'X', True)
        _ask(ws, rule, _mg('Doc A', 's1.w1.m1', 'Y'))
        assert call_tool(ws, *rule).startswith('Nothing to change'), ws.ops
        i = next(i for i, o in enumerate(ws.ops, 1) if rules.is_rule(o))
        call_tool(ws, 'drop_planned', {'indexes': [i]})
        assert not any(rules.is_rule(o) for o in ws.ops), ws.ops
        assert _plan(ws) == _plan(_scratch(c, s, _mg('Doc A', 's1.w1.m1', 'Y')))
    finally:
        s.delete()


def test_a_drop_by_field_takes_only_that_fields_values_out_of_a_planned_analysis(live_client):
    # PLAN-2 (Luke 2026-10-16): the segmentation and other values stay, a
    # value named on one of its morphemes goes, and so does a request for
    # that field that stands for nothing in the plan.
    c = live_client
    s, ws = _seeded(c, [_doc('d0', 'Doc A', [('ka', 'G', [('ka', 'K')]), ('kan', '', [('kan', '')])])], 'by field')
    try:
        _ask(ws, ('set_analysis', {'document': 'Doc A', 'ref': 's1.w2',
                                   'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'X'}}, {'form': 'n'}]}),
             _mg('Doc A', 's1.w2.m2', 'PL'),
             ('set_field_for_form', {'form': 'ki', 'field': 'Morph Gloss', 'value': 'Q', 'only_empty': False}),
             ('set_field', {'document': 'Doc A', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'H'}))
        out = call_tool(ws, 'drop_planned', {'field': 'Morph Gloss'})
        assert out.startswith('Took Morph Gloss out of 1 planned analysis: its morphemes and other values stay.'), out
        ana = next(o for o in ws.ops if o.get('kind') == 'set_analysis')
        assert [m['form'] for m in ana['morphemes']] == ['ka', 'n']
        assert all(not m.get('fields') for m in ana['morphemes']), ana['morphemes']
        assert [o.get('kind') for o in ws.ops] == ['set_analysis', 'set_span']
        want = _scratch(c, s, ('set_analysis', {'document': 'Doc A', 'ref': 's1.w2',
                                                'morphemes': [{'form': 'ka'}, {'form': 'n'}]}),
                        ('set_field', {'document': 'Doc A', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'H'}))
        assert _plan(ws) == _plan(want)
        after = _written(c, s, ws)
        assert after[('Doc A', 's1.w2.m1', 'Morph Gloss')] == '' and after[('Doc A', 's1.w1', 'Gloss')] == 'H'
    finally:
        s.delete()


def test_a_drop_after_resume_asks_the_resumed_requests_again(live_client):
    c = live_client
    s, ws = _seeded(c, [_doc('d0', 'Doc A', [('ka', '', [('ka', 'K')]), ('kan', '', [('kan', 'K')])])], 'resumed')
    try:
        named = _mg('Doc A', 's1.w2.m1', 'Y')
        _ask(ws, named, ('set_analysis', {'document': 'Doc A', 'ref': 's1.w2',
                                          'morphemes': [{'form': 'ka'}, {'form': 'n'}]}))
        ws = resumed(c, s.project_id, ws)
        call_tool(ws, 'drop_planned', {'indexes': [1]})
        assert _rows(ws) == ['Doc A s1.w2.m1 "kan": Morph Gloss "K" → "Y"']
    finally:
        s.delete()


def test_a_new_entry_keeps_its_key_when_an_earlier_one_is_dropped(live_client):
    # The model was given "new:...#2": asked again after #1 is dropped, the
    # entry is still #2, and the link to it still finds it.
    c = live_client
    s, ws = _seeded(c, [_doc('d0', 'Doc A', [('ka', '', [('ka', '')]), ('mo', '', [('mo', '')])])], 'entry keys')
    try:
        call_tool(ws, 'create_entry', {'form': 'zuu'})
        out = call_tool(ws, 'create_entry', {'form': 'mo'})
        key = out.split('entry_id: ')[1].split()[0]
        assert key.endswith('#2'), key
        _ask(ws, ('link_entry', {'document': 'Doc A', 'refs': ['s1.w2'], 'entry_id': key}))
        call_tool(ws, 'drop_planned', {'indexes': [1]})
        assert [o['kind'] for o in ws.ops] == ['create_entry', 'link']
        assert ws.ops[0]['key'] == key and ws.ops[1]['new_entry_key'] == key
    finally:
        s.delete()
