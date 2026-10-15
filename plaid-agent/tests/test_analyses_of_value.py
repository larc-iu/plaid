"""analyses_of(value=...) lists the references of the occurrences holding
that value (survey item 7, 528b6693: 15 queries to find the words behind a
minority analysis), capped and saying so. Run against the real engine."""

import pytest

from fixtures import FakeClient, fake_ws

from plaid_agent.core.bidi import for_model
from plaid_agent.igt import queries
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.trace import describe_step


def _ws(extra_spans=()):
    client = FakeClient()
    raw = client._documents['d1']
    for tl in raw['text_layers'][0]['token_layers']:
        for sl in tl.get('span_layers') or []:
            if sl['id'] == 'sl-mgloss':
                sl['spans'].extend(extra_spans)
    return fake_ws(client)


def test_the_references_of_a_value_on_the_morpheme_and_on_its_word():
    out = for_model(call_tool(_ws(), 'analyses_of', {'form': 'di', 'value': 'ERG'}))
    morpheme = out[out.index('Morpheme "di"'):]
    assert 'With the value "ERG": 1 morpheme:\n    s1.w1.m2' in morpheme, out
    out = for_model(call_tool(_ws(), 'analyses_of', {'form': 'Ali-di', 'value': 'ERG'}))
    assert 'With the value "ERG": 1 word:\n    s1.w1' in out, out


def test_a_value_nobody_holds_and_a_value_matched_whole_and_by_case():
    out = for_model(call_tool(_ws(), 'analyses_of', {'form': 'di', 'value': 'erg'}))
    assert 'With the value "erg": none.' in out
    out = for_model(call_tool(_ws(), 'analyses_of', {'form': 'di', 'value': 'ER'}))
    assert 'With the value "ER": none.' in out


def test_past_the_cap_it_says_how_many_more_and_how_to_see_them(monkeypatch):
    monkeypatch.setattr(queries, 'VALUE_REFS', 1)
    w = _ws([{'id': 'sp-x1', 'value': 'fish', 'tokens': ['m-2']}, {'id': 'sp-x2', 'value': 'fish', 'tokens': ['m-4a']}])
    out = for_model(call_tool(w, 'analyses_of', {'form': 'gam', 'value': 'fish'}))
    morpheme = out[out.index('Morpheme "gam"'):]
    assert 'With the value "fish": 2 morphemes, the first 1 by document:\n    s1.w2.m1\n    1 more: name a document' \
        in morpheme, out


def test_without_value_nothing_is_listed_and_the_trace_says_the_value():
    assert 'With the value' not in call_tool(_ws(), 'analyses_of', {'form': 'di'})
    line = describe_step('analyses_of', {'form': 'thuh', 'value': 'n'})
    text = line['text'] if isinstance(line, dict) else str(line)
    assert text == 'Tallied the analyses of “thuh” and listed those holding “n”'


def test_the_value_named_is_the_one_asked_whatever_the_word_tally_read_last():
    # The word block tallies every morpheme value of Ali-di, ERG last (H16-IGT-TOOLS-2).
    out = for_model(call_tool(_ws(), 'analyses_of', {'form': 'Ali-di'}))
    assert 'With the value' not in out, out
    out = for_model(call_tool(_ws(), 'analyses_of', {'form': 'Ali-di', 'value': 'erg'}))
    assert 'With the value "erg": none.' in out and '"ERG": none' not in out, out
    out = for_model(call_tool(_ws(), 'analyses_of', {'form': 'Ali-di', 'value': 'Ali'}))
    assert 'With the value "Ali": 1 word:\n    s1.w1' in out, out


def test_an_empty_value_tallied_last_does_not_drop_the_value_lines():
    w = _ws([{'id': 'sp-e1', 'value': '', 'tokens': ['m-2']}])
    out = for_model(call_tool(w, 'analyses_of', {'form': 'gam', 'value': 'fish'}))
    assert out.count('With the value "fish": none.') == 2, out
