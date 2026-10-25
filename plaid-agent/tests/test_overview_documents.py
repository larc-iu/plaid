"""The project overview's document list, one form in every app
(core.tools.overview_documents).

igt listed the first 50 by name, matching what list_documents pages
through, while ud and umr listed the first 50 in the store's order, so on a
large corpus their model saw an arbitrary slice and was told to page through
a list in another order.
"""

import pytest

from plaid_agent.core.limits import OVERVIEW_DOCS
from plaid_agent.core.tools import overview_documents

TOTAL = OVERVIEW_DOCS + 5


def _docs():
    """More documents than the overview names, created in the reverse of
    their names' order."""
    return [{'id': f'd{i}', 'name': f'Text {TOTAL - 1 - i:03d}', 'version': 1} for i in range(TOTAL)]


def _ws(app):
    if app == 'igt':
        from fixtures import FakeClient, fake_ws
        return fake_ws(FakeClient())
    if app == 'ud':
        from ud_fixtures import PID, ud_client
        from plaid_agent.ud.project import load_project
        from plaid_agent.ud.tools import Workspace
        client = ud_client()
        return Workspace(client, load_project(client, PID))
    from umr_fixtures import umr_ws
    return umr_ws()


def _overview(app, monkeypatch):
    import importlib
    call_tool = importlib.import_module(f'plaid_agent.{app}.toolkit').call_tool
    w = _ws(app)
    docs = _docs()
    monkeypatch.setattr(w, 'documents', lambda: docs)
    return call_tool(w, 'project_overview', {})


@pytest.mark.parametrize('app', ['igt', 'ud', 'umr'])
def test_every_overview_names_the_first_documents_by_name(app, monkeypatch):
    out = _overview(app, monkeypatch)
    listed = out.split(f'Documents ({TOTAL}), the first {OVERVIEW_DOCS} by name:\n')[1].splitlines()
    names = [ln for ln in listed if ln.startswith('  "')]
    assert names[0].startswith('  "Text 000"') and names[-1].startswith(f'  "Text {OVERVIEW_DOCS - 1:03d}"'), out
    assert len(names) == OVERVIEW_DOCS, out
    assert f'  … {TOTAL - OVERVIEW_DOCS} more, list_documents(offset={OVERVIEW_DOCS}) for the next page' in listed, out


def test_a_short_list_is_all_there_with_no_overflow_line():
    docs = [{'id': 'b', 'name': 'beta'}, {'id': 'a', 'name': 'Alpha'}, {'id': 'n'}]
    assert overview_documents(docs) == ['Documents (3):', '  n', '  "Alpha"', '  "beta"']


def test_an_app_prints_a_document_its_own_way():
    docs = [{'id': 'b', 'name': 'beta'}, {'id': 'a', 'name': 'Alpha'}]
    assert overview_documents(docs, lambda page: [f'  {d["id"]}' for d in page]) \
        == ['Documents (2):', '  a', '  b']
