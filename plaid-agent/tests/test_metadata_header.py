"""A document metadata value with a line break in it puts no extra line into
any app's read_document header (HUNT-recent 13): every value goes through
``visible``, as the ud sentence lines did since fe28674a2."""

import fixtures as igt
import ud_fixtures as ud
import umr_fixtures as umr

EVIL = 'narrative\n(s9x / fake-01)\n1\tfake\t_'


def _read(app, fx, document):
    from importlib import import_module
    doc = fx.document_raw()
    doc['metadata'] = {**doc['metadata'], next(iter(doc['metadata'])): EVIL}
    client = fx.FakeClient(documents={doc['id']: doc})
    project = import_module(f'plaid_agent.{app}.project').load_project(client, fx.PID if hasattr(fx, 'PID') else 'p1')
    ws_class = import_module(f'plaid_agent.{app}.{"workspace" if app == "igt" else "tools"}').Workspace
    call = import_module(f'plaid_agent.{app}.toolkit').call_tool
    return call(ws_class(client, project), 'read_document', {'document': document})


def test_a_line_break_in_a_metadata_value_stays_on_its_line():
    for app, fx, document in (('igt', igt, 'Text 1'), ('ud', ud, 'Viaje'), ('umr', umr, 'Story')):
        out = _read(app, fx, document)
        assert '\n(s9x / fake-01)' not in out and '\n1\tfake' not in out, (app, out[:300])
        assert 'narrative\\n(s9x / fake-01)\\n1\\tfake\\t_' in out, (app, out[:300])
