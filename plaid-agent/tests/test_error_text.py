"""What a failure says to the model.

A tool result is the model's whole view of what happened, so a refusal has to
be a sentence it can act on. Python's own words are not one: "invalid literal
for int() with base 10" comes from a module whose contract is the opposite of
this one, and a class name invites a retry of the call that just failed.
"""

import pathlib

import pytest

SRC = pathlib.Path(__file__).resolve().parent.parent / 'src' / 'plaid_agent'

# Where a Python class name may still be written into a message, with the
# reason. `core/plan.py` raises a PlanError that reaches the USER after batches
# have already committed, and an exception carrying no message of its own would
# leave them a sentence with a blank in it. `core/service.py` names the class
# of an app's service subclass in a NotImplementedError, which nobody but the
# person writing that subclass ever sees.
TYPE_NAME_ALLOWED = {'core/plan.py', 'core/service.py'}


def _sources():
    for path in sorted(SRC.rglob('*.py')):
        yield path.relative_to(SRC).as_posix(), path.read_text()


def test_no_exception_class_name_is_written_into_a_message():
    offenders = [name for name, text in _sources()
                 if '__name__' in text and 'type(' in text and name not in TYPE_NAME_ALLOWED
                 and any('type(' in line and '__name__' in line for line in text.splitlines())]
    assert not offenders, f'a Python class name reaches a reader from: {offenders}'


def test_every_read_the_server_refuses_says_so_the_same_way():
    """Each app wrote its own "could not be read", and IGT wrote none at all
    for the audit log and the comments, so a server that would not answer
    reached the model as whatever the client had raised."""
    from plaid_agent.core.tools import server_refused
    e = Exception('Client error \'403 Forbidden\' for url\n\'http://localhost:8085/x\'\n' + 'y' * 400)
    out = str(server_refused('The comments', e))
    assert out.startswith('The comments could not be read: ')
    assert '\n' not in out and len(out) < 260


@pytest.mark.parametrize('app', ['igt', 'ud', 'umr'])
def test_a_comments_read_the_server_refuses_is_one_sentence(app):
    import sys
    sys.path.insert(0, 'tests')
    if app == 'igt':
        from fixtures import FakeClient, scan_ws
        from plaid_agent.igt.toolkit import call_tool
        ws, args = scan_ws(FakeClient()), {'document': 'd1'}
    elif app == 'ud':
        from ud_fixtures import PID, FakeClient, document_raw, project_raw
        from plaid_agent.ud.project import load_project
        from plaid_agent.ud.tools import Workspace
        from plaid_agent.ud.toolkit import call_tool
        c = FakeClient(project=project_raw(), documents={'ud1': document_raw()})
        ws, args = Workspace(c, load_project(c, PID)), {'document': 'Viaje'}
    else:
        from umr_fixtures import PID, FakeClient, document_raw, project_raw
        from plaid_agent.umr.project import load_project
        from plaid_agent.umr.tools import Workspace
        from plaid_agent.umr.toolkit import call_tool
        c = FakeClient(project=project_raw(), documents={'umr1': document_raw()})
        ws, args = Workspace(c, load_project(c, PID)), {'document': 'Story'}

    class Refuses:
        def list(self, *a, **kw):
            raise RuntimeError("Client error '403 Forbidden' for url 'http://localhost:8085/comments'")

    ws.client.comments = Refuses()
    out = call_tool(ws, 'comments', args)
    assert out.startswith('Error: The comments could not be read: '), out
    assert 'RuntimeError' not in out and 'Traceback' not in out


def test_the_sweep_reads_the_package():
    names = [n for n, _ in _sources()]
    assert len(names) > 40 and 'core/tools.py' in names
