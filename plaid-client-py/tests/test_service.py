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
        def serve(self, project_id, service_info, handler, extras):
            captured['project_id'] = project_id
            captured['service_info'] = service_info
            captured['extras'] = extras
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
            self.serve = serve or (lambda project_id, service_info, handler, extras:
                                   _FakeRegistration())

    class FakeProjects:
        def __init__(self):
            self.current = []
            self.fail = False

        def list(self):
            if self.fail:
                raise RuntimeError('connection refused')
            return self.current

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

    def serve(project_id, service_info, handler, extras):
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
