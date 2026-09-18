"""Tests for the service self-description helpers + BaseService extras assembly.

Mirrors the JS ``serviceSchema.test.js``. Run with::

    cd plaid-client-py && python -m pytest tests/ -q

or with no dependencies::

    python tests/test_service.py
"""

import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.service_schema import (  # noqa: E402
    TASKS, Param, build_extras, default_values, coerce,
)
from plaid_client.service import (  # noqa: E402
    BaseService, requester_message, UNKNOWN_FAILURE, progress_heartbeat, check_unchanged,
)
from plaid_client.http import PlaidAPIError  # noqa: E402
from plaid_client.services import (  # noqa: E402
    ServiceRegistration, ServiceRegistrationError, CancelScope, ServiceCancelled,
)


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


def test_field_param_is_a_string_naming_a_field():
    p = Param.field('gloss_field', 'Gloss field', 'Morpheme', default='Gloss', required=True)
    assert p == {'key': 'gloss_field', 'label': 'Gloss field', 'type': 'field',
                 'scope': 'Morpheme', 'default': 'Gloss', 'required': True}
    assert default_values([p]) == {'gloss_field': 'Gloss'}
    assert coerce([p], {'gloss_field': 'Gloss (pmy)'}) == ({'gloss_field': 'Gloss (pmy)'}, {})
    assert 'gloss_field' in coerce([p], {'gloss_field': ''})[1]


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
         'operation_group': {'id': 'g1', 'message': 'from requester'}}, helper).join(5)
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
    svc.handle_service_request({'q': 1}, helper).join(5)
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
    svc.handle_service_request({'a': 1}, helper).join(5)
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


# --- a request outlives its requester: cancel, requester id, attach ----------


class _OpenConnection:
    ready_state = 1
    error = None

    def wait_until_settled(self, timeout=None):
        return 1

    def close(self):
        pass


def _serve_with_capture(handler):
    """Register a handler through ``serve`` on a fake client and return the
    channel's event callback plus the events the service reported back."""
    from plaid_client import services as svc_mod
    captured = {}
    reported = []

    class FakeMessages:
        def listen(self, project_id, on_event, path=None):
            captured['on_event'] = on_event
            return _OpenConnection()

        def _request(self, method, path, body=None, **kw):
            reported.append((method, path, body))

    class FakeClient:
        messages = FakeMessages()

    reg = svc_mod.serve(FakeClient(), 'p1', {'service_id': 's1', 'service_name': 'S'}, handler)
    return captured['on_event'], reported, reg


def test_served_request_sees_requester_and_cancel():
    seen = []
    on_event, reported, reg = _serve_with_capture(lambda data, helper: seen.append((data, helper)))
    try:
        on_event('service_request', {'request_id': 'r1', 'requester_id': 'u@x.com',
                                     'delegated_token': 'tok', 'data': {'q': 1}})
        (data, helper), = seen
        assert data == {'q': 1, 'delegated_token': 'tok', 'requester_id': 'u@x.com'}
        assert helper.request_id == 'r1' and helper.requester_id == 'u@x.com'
        assert helper.cancelled is False
        on_event('service_cancel', {'request_id': 'other'})
        assert helper.cancelled is False
        on_event('service_cancel', {'request_id': 'r1'})
        assert helper.cancelled is True
        helper.complete({'done': True})
        assert reported == [('POST', '/api/v1/projects/p1/service-requests/r1/events',
                             {'status': 'completed', 'data': {'done': True}})]
    finally:
        reg.stop()


def test_request_id_rides_the_url_and_accepted_reaches_the_caller(monkeypatch):
    from plaid_client import services as svc_mod

    class FakeResponse:
        status_code = 200
        ok = True
        raw = None

        def iter_lines(self, decode_unicode=True):
            yield 'event: accepted'
            yield 'data: {"request-id":"abc"}'
            yield ''
            yield 'event: progress'
            yield 'data: {"progress":{"percent":5,"message":"Thinking"}}'
            yield ''
            yield 'event: result'
            yield 'data: {"data":{"kind":"turn"}}'
            yield ''

        def close(self):
            pass

    calls = []

    def fake_post(url, **kw):
        calls.append(('POST', url))
        return FakeResponse()

    def fake_get(url, **kw):
        calls.append(('GET', url))
        return FakeResponse()

    monkeypatch.setattr(svc_mod.requests, 'post', fake_post)
    monkeypatch.setattr(svc_mod.requests, 'get', fake_get)

    class Client:
        base_url = 'http://plaid.test'
        token = 't'

    accepted, progress = [], []
    out = svc_mod.request_service(Client(), 'p1', 's1', {'a': 1}, timeout=5,
                                  on_progress=progress.append, request_id='abc',
                                  on_accepted=accepted.append)
    assert out == {'kind': 'turn'}
    assert accepted == ['abc'] and progress == [{'percent': 5, 'message': 'Thinking'}]
    assert calls[-1] == ('POST', 'http://plaid.test/api/v1/projects/p1/services/s1/requests?request-id=abc')

    out = svc_mod.attach_service_request(Client(), 'p1', 'abc', timeout=5)
    assert out == {'kind': 'turn'}
    assert calls[-1] == ('GET', 'http://plaid.test/api/v1/projects/p1/service-requests/abc')


def test_attach_to_an_unknown_request_raises_404(monkeypatch):
    from plaid_client import services as svc_mod

    class Gone:
        status_code = 404
        ok = False
        text = '{"error":"Unknown or expired request"}'

        def close(self):
            pass

    monkeypatch.setattr(svc_mod.requests, 'get', lambda url, **kw: Gone())

    class Client:
        base_url = 'http://plaid.test'
        token = 't'

    try:
        svc_mod.attach_service_request(Client(), 'p1', 'nope', timeout=5)
    except PlaidAPIError as e:
        assert e.status == 404
    else:
        raise AssertionError('expected a 404')


def test_detect_speech_task_and_slider_param():
    """The detect-speech task exists in both clients, and `slider` is a
    rendering hint on a number rather than a type of its own."""
    assert TASKS.DETECT_SPEECH == 'detect-speech'
    param = Param.number('threshold', 'Speech threshold', slider=True,
                         min=0.1, max=0.9, step=0.05, default=0.5)
    assert param['type'] == 'number'
    assert param['slider'] is True
    extras = build_extras(tasks=[TASKS.DETECT_SPEECH], parameters=[param])
    assert extras['tasks'] == ['detect-speech']
    assert default_values(extras['parameters']) == {'threshold': 0.5}
    # Value logic is a plain number's: clamped to the declared range.
    values, errors = coerce(extras['parameters'], {'threshold': '5'})
    assert values == {'threshold': 0.9}
    assert errors == {}
    # A number without `slider` does not gain the key.
    assert 'slider' not in Param.number('n', 'N', min=0, max=10)


# --- cooperative cancellation -------------------------------------------------
# Nothing interrupts a handler; the request ends at the next point the handler
# looks. `progress()` is that point, which is what makes an existing service
# cancellable for free.

def _scope(flag):
    return CancelScope(lambda: flag['cancelled'])


def test_cancel_scope_is_quiet_until_the_requester_stops_it():
    flag = {'cancelled': False}
    sc = _scope(flag)
    assert sc.cancelled is False
    sc.raise_if_cancelled()  # no-op

    flag['cancelled'] = True
    assert sc.cancelled is True
    try:
        sc.raise_if_cancelled()
        assert False, 'should have raised'
    except ServiceCancelled:
        pass


def test_critical_holds_cancellation_off_until_the_block_ends():
    """A write under way must finish, or the document is left half-written."""
    flag = {'cancelled': True}
    sc = _scope(flag)

    with sc.critical():
        sc.raise_if_cancelled()      # suppressed
        assert sc.cancelled is True  # but still visible to a handler that asks

    try:
        sc.raise_if_cancelled()
        assert False, 'should raise once the block is over'
    except ServiceCancelled:
        pass


def test_critical_nests_and_unwinds_on_an_exception():
    flag = {'cancelled': True}
    sc = _scope(flag)

    with sc.critical():
        with sc.critical():
            sc.raise_if_cancelled()
        sc.raise_if_cancelled()  # still inside the outer block

    # An exception inside a block must not leave cancellation wedged off.
    try:
        with sc.critical():
            raise ValueError('boom')
    except ValueError:
        pass
    try:
        sc.raise_if_cancelled()
        assert False, 'should raise'
    except ServiceCancelled:
        pass


def test_a_long_request_does_not_block_the_reader_thread():
    """The SSE reader calls the handler, and that channel is what carries
    `service_cancel` for the request being handled. Running the work inline
    meant a stop was not read until the work it was meant to stop had already
    finished — so cancellation could never work for any Python service."""
    import threading as _t

    started = _t.Event()
    release = _t.Event()

    class _Svc(BaseService):
        def process_request(self, request_data, response_helper):
            started.set()
            release.wait(5)

    svc = _Svc('svc', 'Svc', 'test')
    caller = _t.current_thread()
    thread = svc.handle_service_request({}, _Helper())

    # handle_service_request returned while the work is still going, and the
    # work is NOT on the calling (reader) thread.
    assert started.wait(5)
    assert thread is not None and thread.is_alive()
    assert thread is not caller

    # Single-flight still holds: a second request is rejected, not queued.
    second = _Helper()
    assert svc.handle_service_request({}, second) is None
    assert second.errors and 'another request' in second.errors[0]

    release.set()
    thread.join(5)

    # …and the lock is free again once the work ends.
    third = _Helper()
    t3 = svc.handle_service_request({}, third)
    assert t3 is not None
    t3.join(5)
    assert not third.errors


def test_a_stop_is_not_swallowed_by_a_service_catching_Exception():
    """Every service wraps its work in `except Exception` to report a failure.
    If the stop were an Exception, that handler would swallow it and report an
    error — or, caught inside a per-item loop, be shrugged off so the loop ran
    on. Same reason asyncio.CancelledError left Exception in 3.8."""
    assert issubclass(ServiceCancelled, BaseException)
    assert not issubclass(ServiceCancelled, Exception)

    cleaned = []
    try:
        try:
            raise ServiceCancelled('stop')
        except Exception:  # noqa: BLE001 - the point of the test
            assert False, 'a broad handler must not catch a stop'
        finally:
            cleaned.append('finally still runs')
    except ServiceCancelled:
        pass
    assert cleaned == ['finally still runs']


# --- The request deadline is idle time, not a cap on the run -----------------
#
# A service that reports its progress is not hung, so every event it sends
# starts the clock again. As a deadline on the whole run, the default killed
# working transcriptions and handed the document back to the user as editable
# while the service went on writing to it.

def _stream_client(monkeypatch, beats):
    """A response that yields each of `beats`, a (delay_s, line) pair, in order."""
    import time as _time
    from plaid_client import services as svc_mod

    class FakeResponse:
        status_code = 200
        ok = True
        raw = None

        def iter_lines(self, decode_unicode=True):
            for delay, line in beats:
                _time.sleep(delay)
                yield line

        def close(self):
            pass

    monkeypatch.setattr(svc_mod.requests, 'post', lambda url, **kw: FakeResponse())
    monkeypatch.setattr(svc_mod, 'abort_response', lambda resp: None)

    class Client:
        base_url = 'http://plaid.test'
        token = 't'

    return svc_mod, Client()


def test_progress_restarts_the_clock_so_a_long_run_still_finishes(monkeypatch):
    # Four 0.1s gaps under a 0.4s timeout: 0.4s of work, none of it silent.
    beats = []
    for pct in (25, 50, 75):
        beats += [(0.1, 'event: progress'),
                  (0.0, 'data: {"progress":{"percent":%d}}' % pct),
                  (0.0, '')]
    beats += [(0.1, 'event: result'), (0.0, 'data: {"data":{"ok":true}}'), (0.0, '')]
    svc_mod, client = _stream_client(monkeypatch, beats)
    assert svc_mod.request_service(client, 'p1', 's1', {}, timeout=0.4) == {'ok': True}


def test_silence_gives_up_and_says_the_request_is_still_there(monkeypatch):
    beats = [(0.01, 'event: progress'),
             (0.0, 'data: {"progress":{"percent":10}}'),
             (0.0, ''),
             (5.0, 'event: result'),
             (0.0, 'data: {"data":{"ok":true}}'),
             (0.0, '')]
    svc_mod, client = _stream_client(monkeypatch, beats)
    with pytest.raises(TimeoutError) as caught:
        svc_mod.request_service(client, 'p1', 's1', {}, timeout=0.15)
    assert 'of silence' in str(caught.value)
    assert getattr(caught.value, 'pending', False) is True


def test_an_error_the_service_reported_is_the_end_of_it(monkeypatch):
    beats = [(0.0, 'event: error'), (0.0, 'data: {"error":"model refused"}'), (0.0, '')]
    svc_mod, client = _stream_client(monkeypatch, beats)
    with pytest.raises(RuntimeError) as caught:
        svc_mod.request_service(client, 'p1', 's1', {}, timeout=5)
    assert str(caught.value) == 'model refused'
    assert getattr(caught.value, 'pending', False) is False


def test_a_stream_that_ends_without_a_result_leaves_the_request_alive(monkeypatch):
    svc_mod, client = _stream_client(monkeypatch, [(0.0, 'event: progress'),
                                                   (0.0, 'data: {"progress":{"percent":1}}'),
                                                   (0.0, '')])
    with pytest.raises(RuntimeError) as caught:
        svc_mod.request_service(client, 'p1', 's1', {}, timeout=5)
    assert 'without a result' in str(caught.value)
    assert getattr(caught.value, 'pending', False) is True


# --- what a requester is told about a failure --------------------------------

def test_an_api_failure_reaches_the_requester_without_its_url():
    err = PlaidAPIError('HTTP 400 Span value is required at http://plaid.internal:8085/api/v1/spans',
                        status=400, url='http://plaid.internal:8085/api/v1/spans', method='POST')
    assert requester_message(err) == 'HTTP 400 Span value is required'
    timed_out = PlaidAPIError('Request timed out at http://plaid.internal:8085/api/v1/batch',
                              status=0, url='http://plaid.internal:8085/api/v1/batch')
    assert requester_message(timed_out) == 'The Plaid server could not be reached.'


def test_the_locks_own_wording_survives_the_scrub():
    # documents.locked() already authors a 423 for the person who asked; it
    # carries no URL, so nothing may rewrite it.
    said = "Document d1 is locked by a@b.com (likely being edited); try again once they're done."
    assert requester_message(PlaidAPIError(said, status=423, url='http://x:8085/lock')) == said


def test_a_transport_error_loses_its_url_and_a_key_loses_itself():
    raw = Exception("404 Client Error: Not Found for url: http://plaid.internal:8085/api/v1/media?v=3")
    assert requester_message(raw) == '404 Client Error: Not Found'
    keyed = Exception('Incorrect API key provided: sk-abcdefghij. Check your key.')
    assert requester_message(keyed, secrets=('sk-abcdefghij',)) == \
        'Incorrect API key provided: [redacted]. Check your key.'
    # A short or empty "secret" must not turn every message into redactions.
    assert requester_message(Exception('plain'), secrets=('', 'ab')) == 'plain'


def test_an_exception_with_nothing_to_say_is_not_named_by_its_class():
    assert requester_message(KeyError()) == UNKNOWN_FAILURE
    assert 'KeyError' not in requester_message(KeyError())


def test_the_failure_funnel_prefixes_a_fault_and_passes_a_refusal_through():
    class MyService(BaseService):
        def process_request(self, request_data, response_helper):
            raise request_data['boom']

    svc = MyService('tok:x', 'Tok', 'x', tasks=[TASKS.TOKENIZE])
    svc.client = object()
    helper = _Helper()
    svc.handle_service_request(
        {'boom': PlaidAPIError('HTTP 500 nope at http://h:8085/api/v1/x', status=500,
                               url='http://h:8085/api/v1/x')}, helper).join(5)
    assert helper.errors == ['Tok: HTTP 500 nope']

    helper = _Helper()
    svc.handle_service_request({'boom': ValueError('No field named "Gloss".')}, helper).join(5)
    assert helper.errors == ['No field named "Gloss".']


def test_the_funnel_redacts_the_services_own_secrets():
    class MyService(BaseService):
        REQUEST_SECRETS = ('sk-topsecret1',)

        def process_request(self, request_data, response_helper):
            raise RuntimeError('provider said: bad key sk-topsecret1')

    svc = MyService('an:x', 'An', 'x', tasks=[TASKS.ANALYZE])
    svc.client = object()
    helper = _Helper()
    svc.handle_service_request({}, helper).join(5)
    assert helper.errors == ['An: provider said: bad key [redacted]']


# --- a document that changed while the run was working -----------------------

class _VersionClient:
    def __init__(self, version):
        self.reads = 0
        outer = self

        class Documents:
            def get(self, document_id, include_body=None):
                outer.reads += 1
                return {'id': document_id, 'version': version}
        self.documents = Documents()


def test_a_run_writes_only_against_the_document_it_read():
    client = _VersionClient(58)
    check_unchanged(client, 'd1', 58)          # unchanged: nothing to say
    assert client.reads == 1
    with pytest.raises(ValueError) as caught:
        check_unchanged(client, 'd1', 57)
    assert str(caught.value) == 'The document changed while this run was working. Run it again.'


def test_a_caller_that_just_read_the_document_is_not_made_to_read_it_again():
    client = _VersionClient(58)
    check_unchanged(client, 'd1', 57, current=57)
    assert client.reads == 0
    with pytest.raises(ValueError):
        check_unchanged(client, 'd1', 57, current=58)
    assert client.reads == 0


def test_no_version_to_compare_is_not_a_refusal():
    client = _VersionClient(58)
    check_unchanged(client, 'd1', None)
    check_unchanged(client, 'd1', 0)
    assert client.reads == 0


# --- a blocking call that would otherwise go quiet ---------------------------

class _BeatHelper:
    def __init__(self, stop_after=None):
        self.beats = []
        self.stop_after = stop_after

    def progress(self, percent, msg='', **extra):
        self.beats.append((percent, msg))
        if self.stop_after is not None and len(self.beats) >= self.stop_after:
            raise ServiceCancelled('stopped')


def test_a_blocking_call_keeps_the_requester_hearing_the_same_thing():
    helper = _BeatHelper()
    started = threading.Event()
    with progress_heartbeat(helper, 40, 'Transcribing audio...', interval_s=0.01):
        while len(helper.beats) < 3:
            started.wait(0.01)
    beats = list(helper.beats)
    assert beats[:3] == [(40, 'Transcribing audio...')] * 3
    # The beat stops with the block: nothing is reported after it returns.
    time.sleep(0.05)
    assert len(helper.beats) == len(beats)


def test_a_stop_ends_the_beat_and_leaves_the_work_to_notice_it():
    helper = _BeatHelper(stop_after=1)
    with progress_heartbeat(helper, 40, 'Transcribing audio...', interval_s=0.01):
        time.sleep(0.08)
    # The beat swallowed its own ServiceCancelled and stopped rather than
    # carrying on or taking the wrapped call's thread down with it.
    assert helper.beats == [(40, 'Transcribing audio...')]


def test_no_helper_means_no_beat():
    with progress_heartbeat(None, 40, 'x', interval_s=0.01):
        pass


# --- every path that reports a failure scrubs it first ------------------------

class _FakeChannel:
    ready_state = 1
    error = None

    def wait_until_settled(self, timeout=None):
        return 1

    def close(self):
        self.ready_state = 2


def _served(handler):
    """Stand ``serve`` up against a fake channel.

    Returns ``(registration, deliver, events)``: ``deliver(payload)`` plays a
    ``service_request`` down the channel and ``events`` collects everything the
    service reported back.
    """
    import plaid_client.services as svc

    events = []
    captured = {}

    class _Messages:
        def listen(self, project_id, on_event, path=None):
            captured['on_event'] = on_event
            return _FakeChannel()

        def _request(self, method, path, body=None, **kwargs):
            events.append(body)

    class _Client:
        messages = _Messages()

    registration = svc.serve(
        _Client(), 'p1',
        {'service_id': 'svc1', 'service_name': 'Punkt Tokenizer'},
        handler)

    def deliver(data=None):
        captured['on_event']('service_request', {'request_id': 'r1', 'data': data or {}})

    return registration, deliver, events


def _reported_error(handler):
    registration, deliver, events = _served(handler)
    try:
        deliver()
    finally:
        registration.stop()
    errors = [e['data']['error'] for e in events if e.get('status') == 'error']
    assert len(errors) == 1, f'expected one error event, got {events}'
    return errors[0]


def test_serves_fallback_does_not_hand_the_requester_an_internal_url():
    # A service written directly against `serve` (no BaseService) whose work
    # raises. The raw text names the endpoint the client called.
    def handler(_data, _helper):
        raise PlaidAPIError(
            'HTTP 400 Span value is required at http://plaid.internal:8085/api/v1/spans',
            status=400, url='http://plaid.internal:8085/api/v1/spans', method='POST')

    assert _reported_error(handler) == 'Punkt Tokenizer: HTTP 400 Span value is required'


def test_serves_fallback_does_not_name_a_python_class():
    def handler(_data, _helper):
        raise KeyError()

    message = _reported_error(handler)
    assert 'KeyError' not in message
    assert message == f'Punkt Tokenizer: {UNKNOWN_FAILURE}'


def test_a_service_reporting_its_own_error_is_scrubbed_too():
    # The guard is on the helper, not only on serve's fallback: a service that
    # catches its own exception and reports it reaches the requester the same
    # way.
    def handler(_data, helper):
        helper.error(Exception(
            '404 Client Error: Not Found for url: http://plaid.internal:8085/api/v1/media?v=3'))

    assert _reported_error(handler) == '404 Client Error: Not Found'


def test_an_authored_refusal_keeps_its_own_words():
    said = 'No gloss field by that name.'

    def handler(_data, _helper):
        raise ValueError(said)

    assert _reported_error(handler) == said
