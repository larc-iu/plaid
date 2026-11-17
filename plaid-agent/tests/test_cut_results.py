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
    assert 'The query answer was cut at 3 groups, the most the engine returns' in out, out
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


def _engine(monkeypatch, matches=1768):
    """Cuts as core's exec.clj does: rows at the query's own "limit" (the
    agent's run() holds it to 1,000), groups at their own "limit", else at
    the cap, with "truncated" when the answer stopped there."""
    def run(client, q, project_id):
        ret = q.get('return')
        if ret == 'count':
            return {'return': 'count', 'count': min(matches, 100000), 'truncated': matches > 100000}
        agg = isinstance(ret, dict)
        lim = min(q.get('limit') or (100000 if agg else 1000), 100000 if agg else 1000)
        rows = [[f'v{i}', 1] if agg else [f'id{i}'] for i in range(min(matches, lim))]
        return {'return': 'aggregate' if agg else 'entities', 'columns': ['?s'], 'results': rows,
                'truncated': matches > lim}
    monkeypatch.setattr(core_query, 'run', run)


ROWS = '{"where": [["span", "?s", {"layer": "Gloss"}]], "find": ["?s"]'
SURVEY = GROUPED[:-1] + ', "limit": 500}'


@require_sandbox()
def test_the_surveys_aggregate_cut_at_its_own_limit_says_to_leave_the_limit_out(monkeypatch):
    _engine(monkeypatch)
    w = fake_ws(FakeClient())
    out = call_tool(w, 'run_code', {'code': f'r = query({SURVEY})\nprint(len(r["results"]))'})
    assert ('The query answer was cut at its own "limit" of 500 groups, and groups come in no order, so it is '
            'an arbitrary part. Leave "limit" out for the whole answer.') in out, out
    assert 'partial=True' not in out
    out = call_tool(w, 'run_code', {'code': f'r = query({GROUPED})\nprint(len(r["results"]))'})
    assert out.startswith('1768'), 'without the limit the whole answer comes back'


@require_sandbox()
def test_rows_asked_for_by_the_codes_own_limit_are_not_refused_and_the_cap_is(monkeypatch):
    _engine(monkeypatch)
    w = fake_ws(FakeClient())
    out = call_tool(w, 'run_code', {'code': f'r = query({ROWS}, "limit": 5}})\nprint(len(r["results"]))'})
    assert out.startswith('5'), 'five rows asked for, five rows given: nothing misled'
    out = call_tool(w, 'run_code', {'code': f'r = query({ROWS}}})\nprint(len(r["results"]))'})
    assert 'The query answer was cut at 1000 rows, the most the engine returns' in out, out
    out = call_tool(w, 'run_code', {'code': f'r = query({ROWS}, "limit": 5000}})\nprint(len(r["results"]))'})
    assert 'cut at 1000 rows, the most the engine returns' in out, 'a limit past the cap is cut by the cap'


@require_sandbox()
def test_a_count_stopped_at_the_cap_raises(monkeypatch):
    _engine(monkeypatch, matches=250000)
    w = fake_ws(FakeClient())
    out = call_tool(w, 'run_code', {'code': f'r = query({ROWS}, "return": "count"}})\nprint(r["count"])'})
    assert 'The count stopped at the engine\'s cap: there are at least 100000.' in out, out


def test_the_query_tool_names_the_querys_own_limit():
    res = {'return': 'aggregate', 'columns': ['?s.value', 'count'], 'results': [['a', 2], ['b', 1]],
           'truncated': True}
    out = core_query.render(res, {}, 50, {}, {}, {}, own_limit=2)
    assert out.startswith('2 groups (cut at the query\'s own "limit" of 2): '), out
    rows = {'return': 'entities', 'columns': ['?s'], 'results': [['x'], ['y']], 'count': 2, 'truncated': True}
    assert core_query.render(rows, {'return': 'ids'}, 50, {}, {}, {}, own_limit=2).startswith(
        '2 rows (cut at the query\'s own "limit" of 2)')
    assert core_query.render(rows, {'return': 'ids'}, 50, {}, {}, {}).startswith(
        '2 rows (truncated by the engine limit)')


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
