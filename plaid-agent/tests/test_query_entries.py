"""query names a lexicon entry the way the lexicon tools take it back, so
senses, which carry their headword's form, do not read as one headword
repeated, and the "limit" written in the query sets the rows shown when the
tool's own is not given: a model planned from the first 50 of 97 rows and
read three senses as "i" twice (2026-10-13 survey)."""
from fixtures import VOCAB
from test_dictionary import ITEMS, dict_ws

from plaid_agent.igt.toolkit import call_tool

Q = {'find': ['?v'], 'where': [['vocab', '?v', {'layer': 'Lexicon'}]], 'return': 'entities'}


def _ws(rows):
    w = dict_ws()
    asked = []

    def query(body):
        asked.append(body)
        return {'return': 'entities', 'columns': ['?v'], 'results': rows, 'count': len(rows)}
    w.client.query = query
    return w, asked


def test_a_sense_is_shown_by_its_address():
    w, _ = _ws([[dict(it, layer=VOCAB)] for it in ITEMS[:4]])
    out = call_tool(w, 'query', {'query': Q})
    assert out.splitlines()[1:] == ['  entry "kwatha" [Lexicon]', '  entry "kwatha#1.1" [Lexicon]',
                                    '  entry "kwatha#1.1.1" [Lexicon]', '  entry "kwatha#1.2" [Lexicon]']
    assert 'Sense 1.2 of headword "kwatha"' in call_tool(dict_ws(), 'lexicon_entry', {'entry_form': 'kwatha#1.2'})


def test_the_query_limit_sets_the_rows_shown_unless_the_tool_limit_is_given():
    rows = [[{'id': f'x{i}', 'form': f'f{i}', 'layer': VOCAB}] for i in range(97)]
    w, asked = _ws(rows)
    out = call_tool(w, 'query', {'query': dict(Q, limit=200)})
    assert out.startswith('97 rows: ?v') and len(out.splitlines()) == 98
    assert asked[-1]['limit'] == 200
    out = call_tool(w, 'query', {'query': dict(Q, limit=200), 'limit': 10})
    assert out.startswith("97 rows, showing 10 (the tool's limit argument shows up to 500): ?v")
    out = call_tool(w, 'query', {'query': Q})
    assert out.startswith("97 rows, showing 50 (the tool's limit argument shows up to 500)")
