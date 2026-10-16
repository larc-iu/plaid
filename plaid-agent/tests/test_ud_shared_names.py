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
