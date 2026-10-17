"""A document's name is its own in its project, ignoring case (ruling 5,
core refuses a second), so the assistant names a document by its name alone,
never with its id beside it, and reads a name back exactly first. A name
holding a straight quote is printed with the quote escaped
(``"French \\"3\\""``), and a quoted name is read back with it unescaped
(core.bidi.qname, core.workspace.resolve_document_id)."""

import pytest

from fixtures import FakeClient, document_raw, fake_ws
from plaid_agent.core.bidi import escape_name, for_model, plain_quote, qname
from plaid_agent.core.history import doc_label, doc_labels, ref_name
from plaid_agent.core.tools import ToolError
from plaid_agent.igt.toolkit import call_tool

QUOTED = 'French "3"'


def _ws(names=('Text 1', QUOTED, 'Text 2')):
    docs = {}
    for i, name in enumerate(names, 1):
        raw = document_raw()
        raw['id'], raw['name'] = f'd{i}', name
        docs[raw['id']] = raw
    return fake_ws(FakeClient(documents=docs))


def run(w, name, args):
    return for_model(str(call_tool(w, name, args)))


def test_a_name_is_quoted_with_an_inner_quote_escaped():
    assert escape_name(QUOTED) == 'French \\"3\\"'
    assert plain_quote(QUOTED) == '"French \\"3\\""'
    assert for_model(qname(QUOTED)) == '"French \\"3\\""'
    assert plain_quote(None) == '""'


def test_a_document_is_named_by_its_name_alone():
    w = _ws()
    assert ref_name(w, 'd2') == QUOTED
    assert doc_label(w, 'd2') == QUOTED
    assert for_model(doc_label(w, 'd2', qname)) == '"French \\"3\\""'
    assert doc_labels(w, plain_quote) == {'d1': '"Text 1"', 'd2': '"French \\"3\\""', 'd3': '"Text 2"'}


@pytest.mark.parametrize('typed', [QUOTED, '"French \\"3\\""', 'd2', 'french "3"'])
def test_every_printed_form_reads_back(typed):
    assert _ws().resolve_document_id(typed) == 'd2'


def test_the_exact_name_wins_over_a_case_fold_and_a_quoted_label_names_what_it_quotes():
    # Core keeps names apart ignoring case, but a fake project may hold both:
    # the one spelled exactly as asked is the one meant.
    w = _ws(('Cuento', '"Cuento"', 'cuento x'))
    assert w.resolve_document_id('Cuento') == 'd1'
    assert w.resolve_document_id('"Cuento"') == 'd1'
    assert w.resolve_document_id('"\\"Cuento\\""') == 'd2'


def test_a_label_with_an_id_beside_the_name_is_no_form_of_a_name():
    with pytest.raises(ToolError, match='No document'):
        _ws().resolve_document_id('"Text 1" (d1)')


def test_igt_reads_print_the_name_escaped_and_without_an_id():
    w = _ws()
    assert run(w, 'list_documents', {}).splitlines()[1:] == ['  "French \\"3\\""', '  "Text 1"', '  "Text 2"']
    assert run(w, 'read_document', {'document': '"French \\"3\\""'}).startswith('Document "French \\"3\\"":')
    assert run(w, 'read_document', {'document': 'Nada'}).endswith('Documents: "Text 1", "French \\"3\\"", "Text 2"')
    out = run(w, 'search', {'pattern': 'gam'})
    assert '"French \\"3\\"" s1.w2' in out and '"Text 1" s1.w2' in out, out
    out = run(w, 'set_field', {'document': 'd2', 'refs': ['s9.w1'], 'field': 'Gloss', 'value': 'x'})
    assert 'document "French \\"3\\"" has 2 sentences' in out, out


def test_igt_refuses_a_name_another_document_holds_naming_its_spelling():
    w = _ws()
    out = run(w, 'create_document', {'name': 'TEXT 1', 'text': 'a b'})
    assert out == 'Error: A document named "Text 1" already exists. Pick a different name.', out
    out = run(w, 'rename_document', {'document': 'Text 2', 'new_name': 'text 1'})
    assert out == 'Error: Another document is already named "Text 1". Pick a different name.', out


def test_igt_refuses_a_name_core_folds_alike_typed_in_another_spelling():
    """Core folds NFC, casefold, NFC: a name typed decomposed, or one whose
    casefold decomposes (long s with an acute folds to s with an acute), is
    the stored name. Both igt tools refuse it before core does."""
    w = _ws(('Café', 'Text 2', '\u015bwiat'))
    out = run(w, 'create_document', {'name': 'CAFE\u0301', 'text': 'a b'})
    assert out == 'Error: A document named "Café" already exists. Pick a different name.', out
    out = run(w, 'rename_document', {'document': 'Text 2', 'new_name': 'cafe\u0301'})
    assert out == 'Error: Another document is already named "Café". Pick a different name.', out
    out = run(w, 'create_document', {'name': '\u017f\u0301wiat', 'text': 'a b'})
    assert out == 'Error: A document named "\u015bwiat" already exists. Pick a different name.', out
    out = run(w, 'rename_document', {'document': 'Text 2', 'new_name': '\u017f\u0301WIAT'})
    assert out == 'Error: Another document is already named "\u015bwiat". Pick a different name.', out


def test_ud_reads_print_the_name_escaped_and_without_an_id(monkeypatch):
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.query import _ref_index
    from plaid_agent.ud.stats import t_search
    from plaid_agent.ud.tools import Workspace
    from ud_fixtures import PID, ud_client
    client = ud_client()
    ws = Workspace(client, load_project(client, PID))
    listed = [{**d, 'name': 'Viaje "2"'} if d['id'] == 'ud1' else d for d in ws.documents()]
    monkeypatch.setattr(ws, 'documents', lambda *a, **k: listed)
    assert {v.split(' s')[0] for v in _ref_index(ws, ['ud1']).values()} == {'"Viaje \\"2\\""'}
    assert ws.resolve_document_id('"Viaje \\"2\\""') == 'ud1'
    assert for_model(ws.render(ws.doc('ud1'))).startswith('Document "Viaje \\"2\\"" (')
    out = for_model(t_search(ws, field='lemma', pattern='zzz', document='ud1'))
    assert out == 'No lemma matches "zzz" in "Viaje \\"2\\"".', out


def test_a_query_cell_quotes_a_document_name_escaped():
    # REV8-AGENT R8A-3: the query renderer all three apps share.
    from plaid_agent.core.query import cell
    assert cell({'id': 'd2', 'name': QUOTED}, {}, {}) == 'document "French \\"3\\""'
    assert cell({'id': 'd1', 'name': 'Text 1'}, {}, {}) == 'document "Text 1"'


def test_umr_overview_lists_names_escaped():
    from plaid_agent.umr.tools import t_project_overview
    from umr_fixtures import document_raw as umr_doc, umr_client, umr_ws
    docs = {}
    for i, name in (('u1', QUOTED), ('u2', '"Draft"')):
        raw = umr_doc()
        raw['id'], raw['name'] = i, name
        docs[i] = raw
    out = for_model(t_project_overview(umr_ws(umr_client(documents=docs))))
    listed = out.split('Documents (2):\n')[1].splitlines()
    assert sorted(listed) == sorted(['  "French \\"3\\""', '  "\\"Draft\\""']), out


@pytest.mark.parametrize('refs', ['"French \\"3\\"" s1.w1, "French \\"3\\"" s1.w2',
                                  '"French \\"3\\"" s1.w1 and s1.w2', ['"French \\"3\\"" s1.w1', 's1.w2']])
def test_igt_reads_references_copied_with_an_escaped_name(refs):
    # REV8-AGENT R8A-4: a list copied from a read, whose name holds a quote.
    w = _ws()
    out = run(w, 'set_field', {'document': QUOTED, 'refs': refs, 'field': 'Gloss', 'value': 'q'})
    assert out.startswith('Planned 2 changes'), out


def test_igt_reads_a_reference_after_a_name_ending_in_a_backslash():
    from plaid_agent.igt.workspace import _refs
    assert _refs('"a\\" s1.w1, "a\\" s1.w2') == ['s1.w1', 's1.w2']
    assert _refs('"Text 1" s1.w1, "Text 1" s1.w2') == ['s1.w1', 's1.w2']
