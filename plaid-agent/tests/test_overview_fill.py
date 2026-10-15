"""project_overview says how full each field is (survey item 9, 3c180b80 and
565ffa1d: an empty field searched 13 times), from two grouped reads of the
real engine whatever the number of fields."""

from fixtures import FakeClient, fake_ws

from plaid_agent.igt.toolkit import call_tool


def test_each_field_says_how_many_items_hold_a_value():
    client = FakeClient()
    w = fake_ws(client)
    sent = []
    real = client.query

    def counting(body):
        sent.append(body)
        return real(body)
    client.query = counting
    out = call_tool(w, 'project_overview', {})
    # Words: Ali-di, gam, akuna, ., Gam-ar, . (punctuation is a stored word).
    assert 'Word fields: Gloss (1 of 6 words filled)' in out, out
    assert 'Morpheme fields: Morph Gloss (2 of 5 morphemes filled)' in out
    assert 'Sentence fields: Translation (1 of 2 sentences filled)' in out
    assert len(sent) == 2


def test_an_empty_field_says_so():
    client = FakeClient()
    raw = client._documents['d1']
    for tl in raw['text_layers'][0]['token_layers']:
        for sl in tl.get('span_layers') or []:
            if sl['id'] == 'sl-trans':
                sl['spans'] = []
    out = call_tool(fake_ws(client), 'project_overview', {})
    assert 'Sentence fields: Translation (empty)' in out, out
