"""Tests for the service self-description helpers + BaseService extras assembly.

Mirrors the JS ``serviceSchema.test.js``. Run with::

    cd plaid-client-py && python -m pytest tests/ -q

or with no dependencies::

    python tests/test_service.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.service_schema import (  # noqa: E402
    TASKS, Param, build_extras, default_values, coerce,
)
from plaid_client.service import BaseService  # noqa: E402
from plaid_client.http import PlaidAPIError  # noqa: E402
from plaid_client.services import ServiceRegistration, ServiceRegistrationError  # noqa: E402


def test_param_builders_and_options_normalize():
    p = Param.enum('language', 'Language',
                   ['english', ('german', 'German'), {'value': 'fr', 'label': 'French'}],
                   default=None, required=True)
    assert p['type'] == 'enum'
    assert p['default'] == 'english'  # first option when default omitted
    assert p['options'] == [
        {'value': 'english', 'label': 'english'},
        {'value': 'german', 'label': 'German'},
        {'value': 'fr', 'label': 'French'},
    ]
    n = Param.number('beam', 'Beam', min=1, max=10, default=5)
    assert n['min'] == 1 and n['max'] == 10 and n['default'] == 5


def test_build_extras_assembles_standard_shape():
    extras = build_extras(
        tasks=[TASKS.TOKENIZE],
        summary='## Hi',
        parameters=[Param.string('note', 'Note')],
        extra={'custom': 1},
    )
    assert extras['schema_version'] == 1
    assert extras['tasks'] == ['tokenize']
    assert extras['summary'] == '## Hi'
    assert extras['parameters'][0]['key'] == 'note'
    assert extras['custom'] == 1


def test_default_values():
    schema = [
        Param.enum('language', 'L', ['english', 'german']),
        Param.number('beam', 'B', min=1),
        Param.boolean('lower', 'Lo'),
        Param.string('note', 'N'),
        Param.multiselect('langs', 'La', ['en', 'de']),
    ]
    assert default_values(schema) == {
        'language': 'english', 'beam': 1, 'lower': False, 'note': '', 'langs': [],
    }


def test_coerce_casts_clamps_validates():
    schema = [
        Param.enum('language', 'L', ['english', 'german'], required=True),
        Param.number('beam', 'B', min=1, max=10),
        Param.boolean('lower', 'Lo'),
        Param.multiselect('langs', 'La', ['en', 'de']),
    ]
    values, errors = coerce(schema, {
        'language': 'german', 'beam': '99', 'lower': 'true',
        'langs': ['en', 'xx'], 'junk': 1,
    })
    assert values['language'] == 'german'
    assert values['beam'] == 10          # clamped
    assert values['lower'] is True       # str coerced
    assert values['langs'] == ['en']     # invalid option dropped
    assert 'junk' not in values          # unknown dropped
    assert errors == {}


def test_coerce_blank_number_falls_back_to_default():
    schema = [Param.number('beam', 'Beam', default=4, min=1, max=10)]
    v = lambda raw: coerce(schema, raw)[0]['beam']
    assert v({'beam': ''}) == 4
    assert v({'beam': '   '}) == 4
    assert v({'beam': None}) == 4
    assert v({'beam': 'abc'}) == 4
    assert v({'beam': '7'}) == 7      # valid value preserved
    assert v({'beam': '99'}) == 10    # clamped to max


def test_enum_out_of_range_default_never_escapes():
    schema = [Param.enum('x', 'X', ['en', 'de'], default='klingon')]
    assert default_values(schema)['x'] == 'en'
    assert coerce(schema, {'x': 'klingon'})[0]['x'] == 'en'


def test_required_zero_false_satisfy_empty_does_not():
    schema = [
        Param.number('n', 'N', required=True, default=0),
        Param.boolean('b', 'B', required=True),
        Param.multiselect('m', 'M', ['a'], required=True),
        Param.string('t', 'T', required=True),
    ]
    _, errors = coerce(schema, {'n': 0, 'b': False, 'm': [], 't': ''})
    assert 'n' not in errors   # 0 is not "empty"
    assert 'b' not in errors   # False is not "empty"
    assert 'm' in errors       # empty list is empty
    assert 't' in errors       # empty string is empty


def test_coerce_invalid_enum_falls_back_and_flags_required():
    schema = [Param.enum('language', 'L', ['english'], required=True)]
    values, errors = coerce(schema, {'language': 'klingon'})
    assert values['language'] == 'english'
    assert errors == {}

    req = [Param.string('name', 'Name', required=True)]
    _, errs = coerce(req, {})
    assert 'name' in errs


def test_base_service_assembles_extras_and_forwards_them():
    captured = {}

    class FakeMessages:
        def serve(self, project_id, service_info, handler, extras, on_status=None):
            captured['project_id'] = project_id
            captured['service_info'] = service_info
            captured['extras'] = extras
            captured['on_status'] = on_status
            return object()

    class FakeClient:
        messages = FakeMessages()

    class MyService(BaseService):
        def process_request(self, request_data, response_helper):
            pass

    svc = MyService('tok:test', 'Test', 'short',
                    tasks=[TASKS.TOKENIZE],
                    summary='## sum',
                    parameters=[Param.enum('language', 'L', ['english'])])
    assert svc.extras['tasks'] == ['tokenize']
    assert svc.extras['parameters'][0]['key'] == 'language'

    svc.client = FakeClient()
    svc.register_service('proj-1')
    # service_info uses snake keys the local serve() reads; extras passed as 4th arg.
    assert captured['service_info'] == {
        'service_id': 'tok:test', 'service_name': 'Test', 'description': 'short',
    }
    assert captured['extras']['summary'] == '## sum'
    assert captured['extras']['tasks'] == ['tokenize']
    # The registration reports connection transitions back to the service, which
    # is how an operator sees it heal itself after a server restart.
    assert captured['on_status'] == svc._on_channel_status


class _FakeRegistration:
    def __init__(self):
        self.stopped = False

    def stop(self):
        self.stopped = True

    def is_running(self):
        return not self.stopped


def _make_sync_service(serve=None):
    """A BaseService wired to a fake client whose project list is mutable
    (``svc.client.projects.current``) for exercising _sync_served_projects."""

    class FakeMessages:
        def __init__(self):
            self.serve = serve or (lambda project_id, service_info, handler, extras,
                                   on_status=None: _FakeRegistration())

    class FakeProjects:
        def __init__(self):
            self.current = []
            self.fail = False
            self.error = RuntimeError('connection refused')

        def list(self):
            if self.fail:
                raise self.error
            return self.current

        def list_page(self, *, limit=None, cursor=None, as_of=None):
            if self.fail:
                raise self.error
            return {'entries': self.current[:limit], 'next_cursor': None}

    class FakeClient:
        def __init__(self):
            self.messages = FakeMessages()
            self.projects = FakeProjects()

    class MyService(BaseService):
        def process_request(self, request_data, response_helper):
            pass

    svc = MyService('tok:test', 'Test', 'short', tasks=[TASKS.TOKENIZE])
    svc.client = FakeClient()
    return svc


def test_sync_served_projects_follows_the_project_set():
    svc = _make_sync_service()
    svc.client.projects.current = [{'id': 'p1', 'name': 'One'}]
    svc._sync_served_projects()
    assert set(svc._registrations_by_project) == {'p1'}

    # A project created after launch is registered on the next pass.
    svc.client.projects.current = [{'id': 'p1', 'name': 'One'}, {'id': 'p2'}]
    svc._sync_served_projects()
    assert set(svc._registrations_by_project) == {'p1', 'p2'}
    reg1 = svc._registrations_by_project['p1']
    reg2 = svc._registrations_by_project['p2']

    # A deleted project's registration is stopped and dropped everywhere.
    svc.client.projects.current = [{'id': 'p2'}]
    svc._sync_served_projects()
    assert set(svc._registrations_by_project) == {'p2'}
    assert reg1.stopped and not reg2.stopped
    assert svc.service_registrations == [reg2]

    # A failure to LIST projects leaves the served set untouched.
    svc.client.projects.fail = True
    svc._sync_served_projects()
    assert set(svc._registrations_by_project) == {'p2'}
    assert not reg2.stopped


def test_sync_served_projects_retries_failed_registrations():
    state = {'fail': True}

    def serve(project_id, service_info, handler, extras, on_status=None):
        if state['fail']:
            raise RuntimeError('409: already connected')
        return _FakeRegistration()

    svc = _make_sync_service(serve=serve)
    svc.client.projects.current = [{'id': 'p1', 'name': 'One'}]

    # Registration failing (e.g. another live instance holds the service id)
    # is non-fatal and does not poison the served set…
    svc._sync_served_projects()
    assert svc._registrations_by_project == {}
    assert svc.service_registrations == []

    # …and the next pass retries and succeeds.
    state['fail'] = False
    svc._sync_served_projects()
    assert set(svc._registrations_by_project) == {'p1'}
    assert svc._sync_failed_projects == set()


if __name__ == '__main__':
    test_param_builders_and_options_normalize()
    test_build_extras_assembles_standard_shape()
    test_default_values()
    test_coerce_casts_clamps_validates()
    test_coerce_blank_number_falls_back_to_default()
    test_enum_out_of_range_default_never_escapes()
    test_required_zero_false_satisfy_empty_does_not()
    test_coerce_invalid_enum_falls_back_and_flags_required()
    test_base_service_assembles_extras_and_forwards_them()
    test_sync_served_projects_follows_the_project_set()
    test_sync_served_projects_retries_failed_registrations()
    print('ok')


class _Helper:
    def __init__(self):
        self.errors = []
        self.done = []

    def progress(self, percent, msg=''):
        pass

    def complete(self, data=None):
        self.done.append(data)

    def error(self, err):
        self.errors.append(str(err))


def test_delegating_service_builds_requester_client_and_adopts_group_on_it():
    seen = {}

    class MyService(BaseService):
        def process_request(self, request_data, response_helper):
            seen.update(request_data)
            response_helper.complete('ok')

    svc = MyService('igt:assist', 'Assist', 'x', tasks=[TASKS.ASSIST], delegation=True)
    assert svc.extras['delegation'] is True

    class OwnClient:
        base_url = 'http://plaid.test'
    svc.client = OwnClient()
    helper = _Helper()
    svc.handle_service_request(
        {'q': 1, 'delegated_token': 'tok-123',
         'operation_group': {'id': 'g1', 'message': 'from requester'}}, helper)
    assert helper.done == ['ok'] and not helper.errors
    assert 'delegated_token' not in seen and 'operation_group' not in seen
    rc = seen['requester_client']
    assert rc.base_url == 'http://plaid.test' and rc.token == 'tok-123'
    # The group was begun and ended on the REQUESTER's client, not the service's.
    assert getattr(rc, '_operation_group', None) is None


def test_delegating_service_refuses_request_without_token():
    class MyService(BaseService):
        def process_request(self, request_data, response_helper):
            raise AssertionError('must not run')

    svc = MyService('igt:assist', 'Assist', 'x', tasks=[TASKS.ASSIST], delegation=True)

    class OwnClient:
        base_url = 'http://plaid.test'
    svc.client = OwnClient()
    helper = _Helper()
    svc.handle_service_request({'q': 1}, helper)
    assert helper.errors and 'delegated token' in helper.errors[0]
    assert not svc._processing_lock.locked()


def test_non_delegating_service_ignores_delegation_and_stays_single_flight():
    calls = []

    class MyService(BaseService):
        def process_request(self, request_data, response_helper):
            calls.append(dict(request_data))
            response_helper.complete(None)

    svc = MyService('tok:x', 'Tok', 'x', tasks=[TASKS.TOKENIZE])
    assert 'delegation' not in svc.extras
    svc.client = object()
    helper = _Helper()
    svc.handle_service_request({'a': 1}, helper)
    assert calls == [{'a': 1}] and not helper.errors


def test_run_registers_on_each_named_project(monkeypatch):
    svc = _make_sync_service()
    served = []
    svc.client.messages.serve = (lambda project_id, service_info, handler, extras,
                                 on_status=None:
                                 served.append(project_id) or _FakeRegistration())
    monkeypatch.setattr(BaseService, 'get_client', staticmethod(lambda url: svc.client))
    monkeypatch.setattr(svc, 'run_service_loop', lambda *a, **k: None)
    svc.run(['p1', 'p2', '--url', 'http://x'])
    assert served == ['p1', 'p2']
    assert set(svc._registrations_by_project) == {'p1', 'p2'}


def test_run_without_ids_serves_all(monkeypatch):
    svc = _make_sync_service()
    svc.client.projects.current = [{'id': 'a', 'name': 'A'}, {'id': 'b', 'name': 'B'}]
    monkeypatch.setattr(BaseService, 'get_client', staticmethod(lambda url: svc.client))
    monkeypatch.setattr(svc, 'run_service_loop', lambda *a, **k: None)
    svc.run(['--url', 'http://x'])
    assert set(svc._registrations_by_project) == {'a', 'b'}


# --- surviving the server: startup, reconnection, status reporting -----------


def test_run_waits_for_a_server_that_is_down_instead_of_exiting(monkeypatch, capsys):
    """A service launched while Plaid is down must start and keep trying, not
    die, or else every server restart is also a service restart."""
    svc = _make_sync_service()
    svc.client.projects.fail = True
    monkeypatch.setattr(BaseService, 'get_client', staticmethod(lambda url: svc.client))
    monkeypatch.setattr(svc, 'run_service_loop', lambda *a, **k: None)

    svc.run(['--url', 'http://x'])          # must not raise SystemExit
    assert svc._registrations_by_project == {}

    # setup() still ran, so the service is ready the moment the server answers.
    svc.client.projects.fail = False
    svc.client.projects.current = [{'id': 'p1', 'name': 'One'}]
    assert svc._sync_served_projects() is True
    assert set(svc._registrations_by_project) == {'p1'}
    out = capsys.readouterr().out
    assert 'not reachable yet' in out and 'Plaid server is reachable again' in out


def test_run_exits_when_the_server_rejects_the_token(monkeypatch):
    """A rejected token is an operator error worth dying on, before an
    expensive setup(), and unlike an unreachable server."""
    svc = _make_sync_service()
    svc.client.projects.fail = True
    svc.client.projects.error = PlaidAPIError('HTTP 401 Unauthorized', status=401)
    monkeypatch.setattr(BaseService, 'get_client', staticmethod(lambda url: svc.client))
    monkeypatch.setattr(svc, 'setup', lambda args: (_ for _ in ()).throw(
        AssertionError('setup must not run after a rejected token')))

    try:
        svc.run(['--url', 'http://x'])
    except SystemExit as e:
        assert e.code == 1
    else:
        raise AssertionError('expected SystemExit')


def test_named_projects_are_retried_and_never_listed(monkeypatch):
    """With explicit project ids the service must not need `projects.list`, and
    a registration that could not be made yet is retried by the run loop."""
    state = {'fail': True}

    def serve(project_id, service_info, handler, extras, on_status=None):
        if state['fail']:
            raise RuntimeError('connection refused')
        return _FakeRegistration()

    svc = _make_sync_service(serve=serve)
    svc.client.projects.fail = True   # listing would raise if it were attempted
    monkeypatch.setattr(BaseService, 'get_client', staticmethod(lambda url: svc.client))
    monkeypatch.setattr(svc, 'run_service_loop', lambda *a, **k: None)
    monkeypatch.setattr(svc, '_check_credentials', lambda: None)

    svc.run(['p1', 'p2', '--url', 'http://x'])
    assert svc._registrations_by_project == {}

    state['fail'] = False
    assert svc._sync_served_projects() is True
    assert set(svc._registrations_by_project) == {'p1', 'p2'}


def test_permanent_registration_failure_is_reported_once(capsys):
    """A project this token can never serve should not reprint its error on
    every pass, but must still be picked up if the permission is granted."""
    state = {'fail': True}

    def serve(project_id, service_info, handler, extras, on_status=None):
        if state['fail']:
            raise ServiceRegistrationError('lacks write access', status=403)
        return _FakeRegistration()

    svc = _make_sync_service(serve=serve)
    svc.client.projects.current = [{'id': 'p1', 'name': 'One'}]
    svc._sync_served_projects()
    svc._sync_served_projects()
    assert capsys.readouterr().out.count('lacks write access') == 1

    state['fail'] = False
    svc._sync_served_projects()
    assert set(svc._registrations_by_project) == {'p1'}


def test_outage_reports_one_lost_and_one_back_line_for_many_projects(capsys):
    """Reporting is per SERVICE, not per project: an operator watching a
    service on 3 projects sees one 'lost' line and one 'back' line, and both
    say the service heals itself."""
    svc = _make_sync_service()
    svc.client.projects.current = [{'id': 'p1', 'name': 'One'}, {'id': 'p2'}, {'id': 'p3'}]
    svc._sync_served_projects()
    capsys.readouterr()

    for pid in ('p1', 'p2', 'p3'):
        svc._on_channel_status('disconnected', pid, 'ConnectionError: refused')
    out = capsys.readouterr().out
    assert out.count('Lost the connection') == 1
    assert 'no need to restart' in out

    for pid in ('p1', 'p2'):
        svc._on_channel_status('reconnected', pid)
    assert 'Reconnected' not in capsys.readouterr().out   # p3 still down
    svc._on_channel_status('reconnected', 'p3')
    assert 'Reconnected to Plaid, serving 3 project(s)' in capsys.readouterr().out


class _FakeConnection:
    """Stand-in for an SSEConnection: `state` is the readyState it settles on
    (1 OPEN, 2 CLOSED), reported through the same wait_until_settled contract
    the real one uses."""

    def __init__(self, state, error=None):
        self.ready_state = state
        self.error = error
        self.closed = False

    def wait_until_settled(self, timeout=None):
        return self.ready_state

    def close(self):
        self.closed = True
        self.ready_state = 2


def _drain(events, timeout=3.0):
    """Wait for the supervisor thread to report something."""
    import time as _t
    deadline = _t.monotonic() + timeout
    while _t.monotonic() < deadline:
        if events:
            return events
        _t.sleep(0.01)
    return events


def test_registration_only_claims_reconnection_once_the_channel_is_really_open():
    """The supervisor must verify a reopened channel rather than treating the
    attempt itself as success. A failed attempt while the server is still down
    must report nothing and be retried."""
    events = []
    attempts = []
    outcomes = [_FakeConnection(2, error=RuntimeError('refused')),   # server still down
                _FakeConnection(2, error=RuntimeError('refused')),   # still down
                _FakeConnection(1)]                                  # back up

    def open_channel():
        conn = outcomes[min(len(attempts), len(outcomes) - 1)]
        attempts.append(conn)
        return conn

    reg = ServiceRegistration({'service_id': 'x'}, _FakeConnection(1),
                              project_id='p1', service_id='x',
                              open_channel=open_channel,
                              on_status=lambda e, pid, d=None: events.append((e, pid)))
    reg._connected = True
    reg._ever_connected = True
    reg._start_supervisor(check_interval_s=0.02)
    try:
        reg._connection.ready_state = 2          # the server went away
        _drain(events)
        assert events[0][0] == 'disconnected'
        # Only the third attempt actually opens. The two failures before it
        # must not be reported as a reconnection.
        import time as _t
        deadline = _t.monotonic() + 3.0
        while _t.monotonic() < deadline and not any(e[0] == 'reconnected' for e in events):
            _t.sleep(0.01)
        assert [e[0] for e in events] == ['disconnected', 'reconnected']
        assert len(attempts) >= 3
        assert reg.is_connected()
    finally:
        reg.stop()


def test_registration_keeps_retrying_for_as_long_as_the_server_is_away():
    """No attempt budget: a service left running through a long outage keeps
    trying, so it is still there when the server returns."""
    import time as _t
    attempts = []

    def open_channel():
        attempts.append(1)
        return _FakeConnection(2, error=RuntimeError('refused'))

    reg = ServiceRegistration({'service_id': 'x'}, _FakeConnection(2),
                              project_id='p1', service_id='x',
                              open_channel=open_channel)
    reg._start_supervisor(check_interval_s=0.02)
    try:
        _t.sleep(0.4)
        assert len(attempts) > 5
        assert reg.is_running() and not reg.is_connected()
    finally:
        reg.stop()
