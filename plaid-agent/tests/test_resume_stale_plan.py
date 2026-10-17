"""resume_plan after an approval refused as out of date asks the plan's
requests again on the documents as they are now (H17-ASSIST-9, ruled by
Luke 2026-10-17): the plan is what asking them from scratch makes today."""

import fixtures as igt_fx
import umr_fixtures as umr_fx

from plaid_agent.core.plan import stale_plan


def _card(status, pid='p-1'):
    return {'kind': 'assistant', 'plan': {'id': pid, 'proposed_count': 2, 'summary': '2 glosses',
                                          'documents': [{'id': 'd1'}]}, 'status': status}


def test_only_the_last_card_refused_as_out_of_date_is_taken():
    assert stale_plan([_card('stale')])['id'] == 'p-1'
    assert stale_plan([_card('stale'), _card(None, 'p-2')]) is None
    assert stale_plan([_card('applied')]) is None
    assert stale_plan([]) is None


def _igt_ws():
    from plaid_agent.igt.toolkit import call_tool
    client = igt_fx.FakeClient()
    return client, igt_fx.fake_ws(client), call_tool


def test_igt_asks_the_requests_again_over_the_documents_as_they_are_now():
    client, w, call_tool = _igt_ws()
    asked = [('set_field', {'document': 'Text 1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'fish'}),
             ('set_field', {'document': 'Text 1', 'refs': ['s1.w3'], 'field': 'Gloss', 'value': 'see'})]
    for name, args in asked:
        assert 'Planned' in call_tool(w, name, dict(args))
    state = w.plan_state()
    # Someone glossed s1.w2 as asked since: asked again, the plan holds only s1.w3.
    raw = client._documents['d1']
    raw['text_layers'][0]['token_layers'][1]['span_layers'][0]['spans'].append(
        {'id': 'sp-x', 'value': 'fish', 'tokens': ['w-2']})
    raw['version'] += 1
    w2 = igt_fx.fake_ws(client)
    w2.stale = stale_plan([_card('stale')])
    w2.load_plan_state = lambda plan_id: state if plan_id == 'p-1' else None
    out = call_tool(w2, 'resume_plan', {})
    assert out.startswith('Asked the requests of the plan of 2 changes (2 glosses) that was out of date again'), out
    assert 'now holds 1 change' in out, out
    assert [(o['kind'], o.get('token_id')) for o in w2.ops] == [('set_span', 'w-3')], w2.ops
    w3 = igt_fx.fake_ws(client)
    for name, args in asked:
        call_tool(w3, name, dict(args))
    assert w2.plan_view() == w3.plan_view()


def test_umr_asks_them_again_too():
    from plaid_agent.umr.toolkit import call_tool
    ws = umr_fx.umr_ws()
    assert 'Planned' in call_tool(ws, 'set_attributes', {'document': 'Story', 'sentence': 1, 'var': 's1b',
                                                         'line': ':aspect state'})
    state = ws.plan_state()
    w2 = umr_fx.umr_ws()
    w2.stale = stale_plan([_card('stale')])
    w2.load_plan_state = lambda plan_id: state
    out = call_tool(w2, 'resume_plan', {})
    assert 'now holds 1 change' in out, out
    assert [o['kind'] for o in w2.ops] == [o['kind'] for o in ws.ops]


def test_a_plan_with_nothing_stored_is_not_resumed():
    _client, w, call_tool = _igt_ws()
    w.stale = stale_plan([_card('stale')])
    w.load_plan_state = lambda plan_id: None
    assert call_tool(w, 'resume_plan', {}) == 'Error: Resume is not available for that plan. Stage its changes again.'
