"""Each value in a plan's lines sits between FSI and PDI (core/bidi.py), so
a change between two right-to-left values reads in its own order and a count
after it stays outside it (H10-SCRIPTS-1). The model reads its tools'
answers without them, so it never copies one into a call.
"""

import pytest

from plaid_agent.core import rules
from plaid_agent.core.agent import _clean_transcript
from plaid_agent.core.bidi import for_model
from plaid_agent.core.plan import PlanOutOfDate, labelled
from plaid_agent.core.trace import q
from plaid_agent.igt.plan import KIND

from test_igt_rules import _replace, _ws

pytestmark = pytest.mark.isolates

FSI, LRI, PDI = '\u2068', '\u2066', '\u2069'


def iso(v):
    return f'"{FSI}{v}{PDI}"'


def _span(token, old, new, doc='d1'):
    return {'kind': 'set_span', 'layer_id': 'g', 'token_id': token, 'span_id': f'sp-{token}', 'value': new,
            'doc': doc, **labelled(f'{doc} {token}', f'Gloss {iso(old)} → {iso(new)}')}


def _matched(ops):
    return rules.matched(KIND, ops, lambda o: o.get('doc'), lambda o: 0)


def test_a_rule_between_two_right_to_left_values_isolates_each():
    store = {'sp-g1': 'كتاب', 'sp-x2': 'كتاب', 'sp-x3': 'X', 'sp-y1': 'كتاب', 'sp-y2': 'قلم'}
    client, w = _ws(store)
    _replace(w, 'كتاب', 'كتب', whole=True)
    [row] = w.plan_payload()['changes']
    assert row['change'] == f'Gloss {iso("كتاب")} → {iso("كتب")}'
    # The count the card draws after it follows a closing quote, outside
    # every isolate.
    assert row['change'].endswith(PDI + '"')
    assert all(s['change'] == f'Gloss {iso("كتاب")} → {iso("كتب")}' for s in row['rule']['sample'])
    assert row['label'].startswith(f'Gloss: replace {iso("كتاب")} with {iso("كتب")} (the whole value, case-sensitive)')


def test_a_regular_expression_is_isolated_left_to_right():
    assert rules.pattern_words(r'^كتاب(?!\w)', True) == (f'matching "{LRI}^كتاب(?!\\w){PDI}"', True)
    assert rules.pattern_words(r'\bكتاب\b', True) == (f'{iso("كتاب")} as a whole word', False)


def test_the_stale_sentence_isolates_the_document_it_names():
    then = [_span('t1', 'كتاب', 'كتب')]
    now = then + [_span('t2', 'كتاب', 'كتب', 'd2')]
    op = {'matched': _matched(then), 'change': f'Gloss {iso("كتاب")} → {iso("كتب")}'}
    with pytest.raises(PlanOutOfDate) as e:
        rules.check_matched(op, _matched(now), lambda d: {'d1': 'قصة', 'd2': 'Сказка'}[d])
    assert e.value.reasons == [f'Gloss {iso("كتاب")} → {iso("كتب")} now matches 2 places in 2 documents, '
                               f'not the 1 shown when it was planned (1 more in {iso("Сказка")})']


def test_a_trace_line_isolates_its_values():
    assert q('كتاب') == f'“{FSI}كتاب{PDI}”'


def test_the_model_reads_no_isolates():
    line = f'Planned: Gloss {iso("كتاب")} → {iso("كتب")}'
    assert for_model(line) == 'Planned: Gloss "كتاب" → "كتب"'
    assert for_model(f'matching "{LRI}^x{PDI}"') == 'matching "^x"'
    assert for_model(None) is None
    history = _clean_transcript([
        {'role': 'user', 'content': f'(system) Not applied: {line}'},
        {'role': 'assistant', 'content': 'ok', 'tool_calls': [{'id': 'c1', 'function': {'name': 't'}}]},
        {'role': 'tool', 'tool_call_id': 'c1', 'content': line},
    ])
    assert FSI not in history[0]['content'] and FSI not in history[2]['content']
