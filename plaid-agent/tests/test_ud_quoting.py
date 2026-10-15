"""One quoting style for what a ud answer quotes: a form, a lemma or a
document's name in double quotes, a quotation mark inside escaped as a Grew
pattern writes it. Python's repr changed the marks with the value ('la' but
"qu'"), and a name holding quotes was printed "French "3"" (H16-UD-TOOLS)."""

from plaid_agent.ud.grew import parse_and_compile
from plaid_agent.ud.grew_search import t_grew_search
from plaid_agent.ud.grew_syntax import grew_string
from live import live_client  # noqa: F401 - fixture
from test_grew_search import LAYERS, treebank  # noqa: F401 - fixture


def test_a_value_is_quoted_as_grew_writes_it_and_reads_back_as_itself():
    assert [grew_string(v) for v in ('la', "qu'", '"', 'French "3"')] == [
        '"la"', '"qu\'"', '"\\""', '"French \\"3\\""']
    for form in ("qu'", '"', 'a"b'):
        where = parse_and_compile(f'pattern {{ X [form={grew_string(form)}] }}', LAYERS).query['where']
        assert any(form in str(c) for c in where), where


def test_grew_search_quotes_a_document_name_holding_quotation_marks(treebank, monkeypatch):
    doc = treebank.doc(treebank.resolve_document_id('Viaje dos'))
    monkeypatch.setattr(doc, 'name', 'French "3"')
    out = t_grew_search(treebank, 'pattern { V [upos=VERB]; V -[obl]-> N }')
    assert '"French \\"3\\"" (1 match in 1 sentence)' in out.splitlines(), out
    none = t_grew_search(treebank, 'pattern { X [upos=PRON] }', document=doc.id)
    assert none.endswith('No matches in "French \\"3\\"".'), none
