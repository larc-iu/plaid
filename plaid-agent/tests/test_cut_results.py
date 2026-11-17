"""A read cut at a cap is impossible to miss (survey 2026-11-17 item 4: a
run_code grouped query cut at 500 of about 1,768 values, code that never read
its "truncated" key, and a project-wide plan built from the part).

- query() inside run_code raises on a cut answer unless the code passes
  partial=True, and the refusal says what to do instead.
- The query tool says an aggregate answer was cut, as it says a row answer was.
- lexicon() raises when the counts of its links were cut.
"""

import pytest

from fixtures import FakeClient, fake_ws
from live import require_sandbox
from plaid_agent.core import query as core_query
from plaid_agent.igt.toolkit import call_tool

GROUPED = '{"where": [["span", "?s", {"layer": "Gloss"}]], "return": {"group": ["?s.value"], "aggregates": [["count"]]}}'


def _cut(monkeypatch, truncated=True, rows=3):
    def run(client, q, project_id):
        return {'return': 'aggregate', 'columns': ['?s.value', 'count'],
                'results': [[f'v{i}', 1] for i in range(rows)], 'truncated': truncated}
    monkeypatch.setattr(core_query, 'run', run)


@require_sandbox()
def test_a_cut_answer_in_code_raises_and_says_what_to_do(monkeypatch):
    _cut(monkeypatch)
    w = fake_ws(FakeClient())
    out = call_tool(w, 'run_code', {'code': f'r = query({GROUPED})\nprint(len(r["results"]))'})
    assert 'The query answer was cut at 3 rows' in out, out
    assert 'partial=True' in out and 'one document at a time' in out
    assert '\n3' not in out, 'the code never saw the part'


@require_sandbox()
def test_partial_true_takes_the_cut_answer_and_an_uncut_one_needs_nothing(monkeypatch):
    _cut(monkeypatch)
    w = fake_ws(FakeClient())
    out = call_tool(w, 'run_code', {'code': f'r = query({GROUPED}, partial=True)\nprint(len(r["results"]), r["truncated"])'})
    assert out.startswith('3 True'), out
    _cut(monkeypatch, truncated=False)
    out = call_tool(w, 'run_code', {'code': f'r = query({GROUPED})\nprint(len(r["results"]))'})
    assert out.startswith('3'), out


def test_the_query_tool_says_an_aggregate_answer_was_cut():
    res = {'return': 'aggregate', 'columns': ['?s.value', 'count'], 'results': [['a', 2], ['b', 1]],
           'truncated': True}
    out = core_query.render(res, {}, 50, {}, {}, {})
    assert out.startswith('2 groups (truncated by the engine limit): '), out
    res['truncated'] = False
    assert core_query.render(res, {}, 50, {}, {}, {}).startswith('2 groups: ')


def test_lexicon_in_code_refuses_counts_that_were_cut(monkeypatch):
    from plaid_agent.igt import sandbox as igt_sandbox
    w = fake_ws(FakeClient())

    def group(where, group, aggregates=None, limit=None):
        w.corpus.truncated = True
        return []
    monkeypatch.setattr(w.corpus, 'group', group)
    lexicon = igt_sandbox.lexicon_api(w)
    with pytest.raises(ValueError, match='lexicon\\(\\) could not count the links'):
        lexicon()


def test_the_prompt_asks_a_claim_of_all_or_none_to_name_what_was_read():
    from plaid_agent.core import prompt
    assert ('A claim that something never occurs, always occurs or is complete names what you read and how '
            'much of it.') in prompt.BE_CONCISE
