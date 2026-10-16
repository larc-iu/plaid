"""ud reads name a document whose name another shares by its id, as the
headings and the plan's lines already do (FX-B-AGENT left this open): a
query's references, a search's lines and a read's header."""

from plaid_agent.ud.project import load_project
from plaid_agent.ud.tools import Workspace
from ud_fixtures import PID, ud_client


def _ud():
    client = ud_client()
    return Workspace(client, load_project(client, PID))


def test_ud_reads_name_a_shared_document_name_with_its_id(monkeypatch):
    from plaid_agent.ud.query import _ref_index
    from plaid_agent.ud.stats import t_search
    ws = _ud()
    listed = ws.documents() + [{'id': 'ud9', 'name': 'Viaje'}]
    monkeypatch.setattr(ws, 'documents', lambda *a, **k: listed)
    refs = _ref_index(ws, ['ud1'])
    assert set(v.split(' ')[0] for v in refs.values()) == {'"ud1"'}
    # A ref's document is taken back as `document`.
    assert ws.resolve_document_id('ud1') == 'ud1'
    assert ws.render(ws.doc('ud1')).startswith('Document "Viaje" (ud1) (')
    out = t_search(ws, field='lemma', pattern='zzz', document='ud1')
    assert out == 'No lemma matches "zzz" in "Viaje" (ud1).', out


def test_every_read_and_refusal_prints_a_shared_name_with_its_id_in_the_form_document_reads_back(monkeypatch):
    """REV3-AGENT-5: list_documents, project_overview, the unknown-document
    refusal, confirm, discard_predictions and a reference error print
    '"Viaje" (ud1)', and document= takes that form back."""
    from plaid_agent.ud.toolkit import call_tool
    ws = _ud()
    listed = ws.documents() + [{'id': 'ud9', 'name': 'Viaje'}]
    monkeypatch.setattr(ws, 'documents', lambda *a, **k: listed)
    out = call_tool(ws, 'list_documents', {})
    assert out.splitlines()[1:] == ['  "Viaje" (ud1)', '  "Viaje" (ud9)'], out
    assert '  "Viaje" (ud1)\n  "Viaje" (ud9)' in call_tool(ws, 'project_overview', {})
    for form in ('"Viaje" (ud1)', 'Viaje (ud1)', 'ud1'):
        assert ws.resolve_document_id(form) == 'ud1'
    out = call_tool(ws, 'read_document', {'document': 'Nada'})
    assert out.endswith('Documents: "Viaje" (ud1), "Viaje" (ud9)'), out
    out = call_tool(ws, 'set_field', {'document': 'ud1', 'refs': ['s9.w1'], 'field': 'upos', 'value': 'X'})
    assert 'document "Viaje" (ud1) has' in out, out
    out = call_tool(ws, 'confirm', {'document': '"Viaje" (ud1)'})
    assert 'in "Viaje" (ud1):' in out, out
    assert ' in "Viaje" (ud1) (' in ws.ops[-1]['label']
    ws.ops.clear()
    out = call_tool(ws, 'discard_predictions', {'document': 'ud1'})
    assert 'the whole of "Viaje" (ud1).' in out, out


def test_a_scoped_read_names_its_documents_in_the_form_document_reads_back(monkeypatch):
    from plaid_agent.core.scope import among_documents as scoped
    ws = _ud()
    listed = ws.documents() + [{'id': 'ud9', 'name': 'Viaje'}]
    monkeypatch.setattr(ws, 'documents', lambda *a, **k: listed)

    @scoped
    def read(ws, document=None):
        return 'body'
    out = read(ws, documents=['ud1', 'ud9'])
    assert out.startswith('In 2 documents: "Viaje" (ud1), "Viaje" (ud9).'), out
