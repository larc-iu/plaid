"""A count the engine caps (``truncated``, at 100,000) is asked again as an
uncapped aggregate when that counts the same tuples, so ud's overview gives
GUM's 290,902 words and not 100,000 (H17-ASSIST-3)."""

from plaid_agent.ud.project import load_project
from plaid_agent.ud.tools import Workspace
from ud_fixtures import PID, ud_client


def _ws(total):
    client = ud_client()
    ws = Workspace(client, load_project(client, PID))
    asked = []

    def query(body):
        asked.append(body)
        if body.get('return') == 'count':
            return {'count': min(total, 100000), 'truncated': total > 100000}
        return {'results': [[total]]}
    client.query = query
    return ws, asked


def test_a_capped_count_of_every_variable_is_counted_again_whole():
    ws, asked = _ws(290902)
    assert ws.corpus.count([['token', '?t', {'layer': 'L'}]], ['?t']) == 290902
    assert asked[-1]['return'] == {'group': [], 'aggregates': [['count']]}
    assert not ws.corpus.clipped


def test_a_count_under_the_cap_is_asked_once():
    ws, asked = _ws(500)
    assert ws.corpus.count([['token', '?t', {'layer': 'L'}]], ['?t']) == 500
    assert len(asked) == 1


def test_a_capped_count_of_some_variables_is_marked_clipped():
    """An aggregate counts every variable's binding, so with one left out of
    ``find`` it would count more: the capped number stands, said to be part."""
    ws, asked = _ws(290902)
    where = [['token', '?s', {'layer': 'S'}], ['token', '?w', {'layer': 'W'}], ['within', '?w', '?s']]
    assert ws.corpus.count(where, ['?s']) == 100000
    assert len(asked) == 1 and ws.corpus.clipped


def test_the_overview_gives_the_whole_size():
    from plaid_agent.ud.toolkit import call_tool
    ws, _ = _ws(290902)
    assert '290902 words' in call_tool(ws, 'project_overview', {})
