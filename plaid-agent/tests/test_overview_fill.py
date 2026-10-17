"""project_overview says how full each field is (survey item 9, 3c180b80 and
565ffa1d: an empty field searched 13 times), from grouped reads of the
real engine, six whatever the number of fields."""

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
    # Words: Ali-di, gam, akuna, Gam-ar, as every read counts them: the two
    # punctuation tokens are no words (H16-REVIEW-2).
    assert 'Word fields: Gloss (1 of 4 words filled)' in out, out
    assert 'Morpheme fields: Morph Gloss (2 of 5 morphemes filled)' in out
    assert 'Sentence fields: Translation (1 of 2 sentences filled)' in out
    # Six grouped reads whatever the number of fields: values, values on
    # ignored words and on ignored morphemes, items per layer, words, morphemes.
    assert len(sent) == 6


def test_an_empty_field_says_so():
    client = FakeClient()
    raw = client._documents['d1']
    for tl in raw['text_layers'][0]['token_layers']:
        for sl in tl.get('span_layers') or []:
            if sl['id'] == 'sl-trans':
                sl['spans'] = []
    out = call_tool(fake_ws(client), 'project_overview', {})
    assert 'Sentence fields: Translation (empty)' in out, out


def test_a_value_on_punctuation_is_not_a_word_filled():
    client = FakeClient()
    raw = client._documents['d1']
    words = raw['text_layers'][0]['token_layers'][1]
    words['span_layers'][0]['spans'].append({'id': 'sp-gp', 'value': 'PUNCT', 'tokens': ['w-p']})
    out = call_tool(fake_ws(client), 'project_overview', {})
    assert 'Word fields: Gloss (1 of 4 words filled)' in out, out


def test_values_on_an_ignored_token_count_nowhere_and_both_reads_agree():
    """An import that glossed punctuation (409 such words in Kalamang) put a
    morpheme and values on it. project_overview and corpus_stats leave them
    out of numerators and totals alike (H17-ASSIST-4)."""
    client = FakeClient()
    raw = client._documents['d1']
    words, morphs = raw['text_layers'][0]['token_layers'][1], raw['text_layers'][0]['token_layers'][2]
    words['span_layers'][0]['spans'].append({'id': 'sp-gp', 'value': 'PUNCT', 'tokens': ['w-p']})
    morphs['tokens'].append({'id': 'm-p', 'begin': 16, 'end': 17, 'precedence': 1})
    morphs['span_layers'][0]['spans'].append({'id': 'sp-mp', 'value': 'PUNCT', 'tokens': ['m-p']})
    out = call_tool(fake_ws(client), 'project_overview', {})
    assert 'Word fields: Gloss (1 of 4 words filled)' in out, out
    assert 'Morph Gloss (2 of 5 morphemes filled)' in out, out
    stats = call_tool(fake_ws(client), 'corpus_stats', {})
    assert '(1/4 words)' in stats and '(2/5 morphemes)' in stats and '5 morphemes' in stats, stats
