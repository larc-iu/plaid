"""Every assistant refuses a document given as anything but text by naming
the argument, not with a Python error (A1-IGT polish, moved into the shared
workspace for ud and umr)."""

import pytest

from umr_fixtures import umr_ws

REFUSAL = 'Error: document must be a document\'s name or id, as text.'


def _ud_ws():
    import ud_fixtures as ud_fx
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.tools import Workspace
    client = ud_fx.FakeClient()
    return Workspace(client, load_project(client, ud_fx.PID))


@pytest.mark.parametrize('app', ['ud', 'umr'])
def test_a_document_given_as_an_entry_of_documents_is_refused_by_name(app):
    if app == 'ud':
        from plaid_agent.ud.toolkit import call_tool
        ws, entry = _ud_ws(), {'id': 'ud1', 'name': 'Viaje'}
    else:
        from plaid_agent.umr.toolkit import call_tool
        ws, entry = umr_ws(), {'id': 'umr1', 'name': 'Story'}
    assert call_tool(ws, 'read_document', {'document': entry}).startswith(REFUSAL)
    assert not call_tool(ws, 'read_document', {'document': entry['id']}).startswith('Error')
