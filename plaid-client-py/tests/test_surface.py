"""Small surface points the two clients must share (PARITY 15)."""

import json
import os
import re
import shutil
import subprocess
import sys
import types

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import client as client_module
from plaid_client.client import PlaidClient
from plaid_client.testing import Response, recording_session
from plaid_client.http import DEFAULT_BATCH_TIMEOUT_S


def test_a_batch_timeout_of_none_disables_it_whatever_timeout_is():
    assert PlaidClient('http://x', 't', timeout=5, batch_timeout=None).batch_timeout is None
    assert PlaidClient('http://x', 't', timeout=5).batch_timeout == 5
    assert PlaidClient('http://x', 't').batch_timeout == DEFAULT_BATCH_TIMEOUT_S
    assert PlaidClient('http://x', 't', batch_timeout=7).batch_timeout == 7


def test_health_and_info_answer_with_no_client_and_no_token(monkeypatch):
    seen = []

    def get(url, **kw):
        seen.append((url, kw.get('headers')))
        body = ({'ok': True, 'uptime-ms': 3} if url.endswith('/health')
                else {'limits': {'batch-operations': 1000}})
        return Response(200, body)

    monkeypatch.setattr(client_module.req_lib, 'get', get)
    assert PlaidClient.health('http://x/') == {'ok': True, 'uptime_ms': 3}
    assert PlaidClient.info('http://x') == {'limits': {'batch_operations': 1000}}
    assert seen == [('http://x/health', None), ('http://x/api/v1/info', None)]


def test_a_vocabularys_comments_page_like_a_projects():
    client = PlaidClient('http://x', 'tok')
    client.session = recording_session([{'entries': [{'id': 'c1'}], 'next-cursor': 'k'},
                                        {'entries': [{'id': 'c2'}], 'next-cursor': None}])
    got = [[c['id'] for c in page]
           for page in client.comments.iter_in_vocab_pages('v1', entity_id='e1', page_size=1)]
    assert got == [['c1'], ['c2']]
    sent = [request['url'] for request in client.session.sent]
    assert sent[0].startswith('http://x/api/v1/vocab-layers/v1/comments?')
    assert 'entity-id=e1' in sent[0] and 'limit=1' in sent[0]
    assert 'cursor=k' in sent[1]


# AU-CLIENTS (2026-10-05): the points below were found different between the
# two clients and made the same. Each has its JS twin in surface.test.js.

def test_a_request_id_is_one_path_segment_in_every_service_request_path(monkeypatch):
    from plaid_client import services

    client = PlaidClient('http://x', 'tok')
    sent = []

    def answer(request):
        sent.append(request['url'])
        return {}

    class _Stream:
        ok = False
        status_code = 404
        text = 'gone'

        def close(self):
            pass

    def get(url, **kw):
        sent.append(url)
        return _Stream()

    client.session = recording_session(answer)
    monkeypatch.setattr(services.requests, 'get', get)
    odd = 'a/b?c#d'
    services._report_event(client, 'p', odd, {'status': 'completed'})
    services.cancel_service_request(client, 'p', odd)
    try:
        services.attach_service_request(client, 'p', odd)
    except Exception as e:
        assert getattr(e, 'status', None) == 404
    assert sent == [
        'http://x/api/v1/projects/p/service-requests/a%2Fb%3Fc%23d/events',
        'http://x/api/v1/projects/p/service-requests/a%2Fb%3Fc%23d',
        'http://x/api/v1/projects/p/service-requests/a%2Fb%3Fc%23d',
    ]


def test_a_timeout_of_0_disables_it_as_in_the_js_client():
    from plaid_client.http import wire_timeout

    client = PlaidClient('http://x', 'tok', timeout=0)
    client.session = recording_session(
        lambda request: [{'status': 200, 'headers': {}, 'body': {}}]
        if request['url'].endswith('/api/v1/batch') else {})
    client.projects.get('p')
    with client.batched() as b:
        b.projects.update('p', 'n')
    client.projects.delete('p', timeout=0)
    assert [request['timeout'] for request in client.session.sent] == [None, None, None]
    assert wire_timeout(0) is None and wire_timeout(-1) is None and wire_timeout(None) is None
    assert wire_timeout(5) == 5 and wire_timeout((3, 10)) == (3, 10)


def test_login_and_redeem_invite_forward_the_client_options(monkeypatch):
    def post(url, **kw):
        return Response(200, {'token': 'tk', 'user-id': 'u', 'kind': 'signup'})

    monkeypatch.setattr(client_module.req_lib, 'post', post)
    c = PlaidClient.login('http://x', 'u', 'pw', batch_timeout=None, retry_delays=[0.1])
    assert (c.token, c.batch_timeout, c.retry_delays) == ('tk', None, [0.1])
    c, data = PlaidClient.redeem_invite('http://x', 'code', 'password1', batch_timeout=7,
                                        retry_delays=[])
    assert (c.token, c.batch_timeout, c.retry_delays, data['kind']) == ('tk', 7, [], 'signup')
    c = PlaidClient.login('http://x', 'u', 'pw')
    assert (c.batch_timeout, c.retry_delays) == (DEFAULT_BATCH_TIMEOUT_S, None)


def test_the_package_exports_what_the_js_index_exports():
    import plaid_client
    from plaid_client.provenance import stamp_inferred, confirmed_inferred, stamp_contributed

    assert plaid_client.MAX_BATCH_OPS == 1000
    assert plaid_client.is_machine(stamp_inferred('service:x'))
    assert not plaid_client.is_machine(confirmed_inferred('service:x'))
    assert not plaid_client.is_machine(stamp_contributed('u'))
    assert not plaid_client.is_machine(None)
    assert not plaid_client.is_machine({'gloss': 'dog'})


# --- the two clients' method lists (beta review A5-4) ---------------------------------
#
# requests.json holds the request shape of about a fifth of the methods. Nothing
# held the lists themselves: a method added to one client alone passed
# everything. This compares the JS client's surface (read by tests/js_surface.mjs)
# with this one's, in Python's spelling, with every difference that is on purpose
# below, each with its reason.

_HERE = os.path.dirname(os.path.abspath(__file__))
_JS_INDEX = os.path.join(_HERE, '..', '..', 'plaid-client-js', 'src', 'index.js')

#: A JS name whose Python twin is spelled otherwise, beyond the casing.
RENAMED = {
    'uuidv7': 'uuid7',
    'buildDefaultValues': 'default_values',
    'coerceParamValues': 'coerce',
    'createCancelScope': 'CancelScope',
    'writerPolicy': 'WriterPolicy',
    'withOperation': 'operation',
}

#: In one client alone, by what each language is for. Keyed by the name as the
#: client spells it (a bundle method as ``bundle.method``).
JS_ONLY = {
    **dict.fromkeys(['cpIndexOf', 'cpLength', 'cpSlice', 'cpSlicer', 'utf16ToCp'],
                    'a JS string counts UTF-16 units, a Python str counts code points'),
    'uuidv4': 'a browser helper',
    'BACKUP_TIMEOUT_MS': 'Python keeps it in seconds as client.BACKUP_TIMEOUT_S',
    'PROV': 'Python names each provenance key (PROV_KEY and the others)',
    'PROV_STATES': 'Python names each state in plaid_client.provenance',
    **dict.fromkeys(['REQUESTED_BY', 'requesterOf', 'makeRequester'],
                    'Python reads a requester in plaid_client.workflows.requester, for services'),
    **dict.fromkeys(['getParamSchema', 'getServiceSummary', 'filterServicesByTask', 'servesTask'],
                    'an app reads what a service declares, Python declares it (build_extras)'),
    **dict.fromkeys(['events.record', 'events.flush', 'events.setEnabled'],
                    'the browser telemetry recorder'),
    **dict.fromkeys(['MORPH_TYPES', 'entryForm', 'readAffixMarkers', 'decorateWithAffixMarkers'],
                    'Python keeps the entry-form rule with the other igt rules, in '
                    'plaid_client.workflows.igt.entry_forms (test_entry_forms_mirror.py)'),
}
PY_ONLY = {
    **dict.fromkeys(['BaseService', 'Param', 'build_extras', 'ServiceRegistrationError', 'StreamClosed'],
                    'service scaffolding, which only Python services use'),
    **dict.fromkeys(['PROV_KEY', 'PROV_SOURCE_KEY', 'PROV_CONFIRMED_KEY', 'PROV_PROB_KEY', 'PROV_DETAIL_KEY'],
                    'JS groups the provenance keys in PROV'),
    'PlaidAPIError': 'JS throws an Error carrying the same fields',
    'close': 'closes the requests session, which the browser has none of',
}


def _py_name(js_name):
    """A JS name in Python's spelling: constants and classes as they are,
    camelCase in snake_case."""
    if js_name in RENAMED:
        return RENAMED[js_name]
    if js_name[0].isupper():
        return js_name
    return re.sub(r'(?<=[a-z0-9])([A-Z])', r'_\1', js_name).lower()


def surface_differences(js, py):
    """Each difference between the two surfaces not on purpose, one line each.
    Both are ``{'exports': [...], 'methods': [...], 'bundles': {name: [...]}}``,
    each in its own language's spelling."""
    out = []

    def compare(where, js_names, py_names, prefix=''):
        js_by_py = {_py_name(n): n for n in js_names}
        for p, j in sorted(js_by_py.items()):
            if p not in py_names and f'{prefix}{j}' not in JS_ONLY:
                out.append(f'{where}: {j} is in plaid-client-js only')
        for p in sorted(py_names):
            if p not in js_by_py and f'{prefix}{p}' not in PY_ONLY:
                out.append(f'{where}: {p} is in plaid-client-py only')

    compare('root export', js['exports'], set(py['exports']))
    compare('client method', js['methods'], set(py['methods']))
    js_bundles = {_py_name(b): b for b in js['bundles']}
    for b in sorted(set(js_bundles) | set(py['bundles'])):
        if b not in py['bundles']:
            out.append(f'bundle: {js_bundles[b]} is in plaid-client-js only')
        elif b not in js_bundles:
            out.append(f'bundle: {b} is in plaid-client-py only')
        else:
            compare(f'{b} method', js['bundles'][js_bundles[b]], set(py['bundles'][b]),
                    prefix=f'{js_bundles[b]}.')
    return out


def _py_surface():
    import plaid_client
    from plaid_client.client import PlaidClient

    client = PlaidClient('http://x', 't')
    public = lambda obj: [n for n in dir(obj) if not n.startswith('_') and callable(getattr(obj, n))]
    return {
        'exports': [n for n in dir(plaid_client) if not n.startswith('_')
                    and not isinstance(getattr(plaid_client, n), types.ModuleType)],
        'methods': public(PlaidClient),
        'bundles': {k: public(v) for k, v in vars(client).items()
                    if not k.startswith('_') and type(v).__name__.endswith('Resource')},
    }


@pytest.fixture(scope='module')
def js_surface():
    exe = shutil.which('node')
    if not exe:
        pytest.skip('node is not here')
    out = subprocess.run([exe, os.path.join(_HERE, 'js_surface.mjs'), _JS_INDEX], capture_output=True,
                         text=True, timeout=60, check=True).stdout
    return json.loads(out)


def test_the_two_clients_have_the_same_methods(js_surface):
    py = _py_surface()
    assert len(js_surface['bundles']) >= 20 and len(py['bundles']) >= 20
    problems = surface_differences(js_surface, py)
    assert problems == [], (
        'The two clients differ:\n  ' + '\n  '.join(problems) + '\nAdd the method to the other client '
        '(memory plaid_client_parity.md). A difference that is on purpose goes in RENAMED, JS_ONLY or '
        'PY_ONLY in plaid-client-py/tests/test_surface.py with its reason.')


def test_every_exemption_is_still_needed(js_surface):
    py = _py_surface()
    js_names = set(js_surface['exports']) | set(js_surface['methods']) | {
        f'{b}.{m}' for b, ms in js_surface['bundles'].items() for m in ms}
    py_names = set(py['exports']) | set(py['methods'])
    assert sorted(set(JS_ONLY) - js_names) == []
    assert sorted(set(PY_ONLY) - py_names) == []
    assert sorted(j for j, p in RENAMED.items() if j not in js_names or p not in py_names) == []


def test_a_method_in_one_client_alone_is_named():
    js = {'exports': ['MAX_BATCH_OPS', 'isMachine', 'cpLength', 'uuidv7', 'newHelper'],
          'methods': ['batch', 'withOperation'],
          'bundles': {'spanLayers': ['create', 'setConfig', 'bulkCreate'], 'events': ['listen', 'record'],
                      'newThings': ['list']}}
    py = {'exports': ['MAX_BATCH_OPS', 'is_machine', 'uuid7', 'BaseService', 'py_helper'],
          'methods': ['batch', 'operation', 'close'],
          'bundles': {'span_layers': ['create', 'set_config', 'delete'], 'events': ['listen']}}
    assert surface_differences(js, py) == [
        'root export: newHelper is in plaid-client-js only',
        'root export: py_helper is in plaid-client-py only',
        'bundle: newThings is in plaid-client-js only',
        'span_layers method: bulkCreate is in plaid-client-js only',
        'span_layers method: delete is in plaid-client-py only',
    ]
