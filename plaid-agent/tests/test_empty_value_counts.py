"""A span whose value is empty is an empty field to every read, as
project_overview counts it (H16-IGT-TOOLS-8): worklist lists it as
unglossed and frequency_list counts it among the empty. Against the real
engine."""

from fixtures import FakeClient, fake_ws

from plaid_agent.igt.toolkit import call_tool


def _ws():
    client = FakeClient()
    raw = client._documents['d1']
    morphs = raw['text_layers'][0]['token_layers'][2]
    morphs['span_layers'][0]['spans'].append({'id': 'sp-e', 'value': '', 'tokens': ['m-2']})
    words = raw['text_layers'][0]['token_layers'][1]
    words['span_layers'][0]['spans'].append({'id': 'sp-ew', 'value': '', 'tokens': ['w-2']})
    return fake_ws(client)


def test_an_empty_value_is_empty_to_every_read():
    w = _ws()
    assert 'Morph Gloss (2 of 5 morphemes filled)' in call_tool(w, 'project_overview', {})
    out = call_tool(w, 'frequency_list', {'what': 'Morph Gloss'})
    assert out.startswith('2 Morph Gloss values, 2 tokens, 3 empty'), out
    out = call_tool(w, 'worklist', {'kind': 'unglossed', 'field': 'Morph Gloss'})
    assert 'gam' in out and 'Nothing to do' not in out, out
    out = call_tool(w, 'frequency_list', {'what': 'Gloss'})
    assert out.startswith('1 Gloss values, 1 tokens, 3 empty'), out
    out = call_tool(w, 'worklist', {'kind': 'unglossed', 'field': 'Gloss'})
    assert 'gam' in out, out
