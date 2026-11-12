"""Small surface points the two clients must share (PARITY 15)."""

import inspect
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
    'UploadAborted': "JS rejects with the AbortSignal's own AbortError",
    'close': 'closes the requests session, which the browser has none of',
}


# --- their parameters (beta code review CR-CORE-2) -------------------------------------
#
# The lists above hold the names. Below, each shared method's parameters: the same plain
# (positional) parameters, by name and in order, and the same option keys, a JS
# destructured `{ ... }` or the keys read off its `options` object (by the method or by
# what it hands the object to, js_surface.mjs follows it) against the Python keywords past
# the positional ones. The client's constructor is compared as `constructor`. Spelling as
# above. Each difference that is on purpose is listed with its reason.

#: Methods whose parameters are not compared.
PARAMS_EXEMPT = {
    **dict.fromkeys(['batched', 'withOperation'],
                    'JS takes the body as a callback, Python is a context manager'),
    'documents.locked': 'JS takes the body as a callback (and acquireRetryMs, for its tests), Python '
                        'is a context manager (and should_renew, asked before each renewal)',
}

#: A parameter or option key in one client alone, keyed (method, parameter) in that client's
#: spelling.
JS_ONLY_PARAMS = {
    **dict.fromkeys([('messages.requestService', 'signal'), ('messages.attachServiceRequest', 'signal')],
                    'an AbortSignal, Python cancels with a CancelScope'),
    **dict.fromkeys([('constructor', 'onAuthError'), ('login', 'onAuthError'),
                     ('redeemInvite', 'onAuthError')],
                    'a browser app sends the person back to login on a 401, Python raises PlaidAPIError'),
    **dict.fromkeys([('vocabLayers.delete', 'options'), ('projects.unlinkVocab', 'options')],
                    'takes none, and throws on any given (a dryRun from before), which Python\'s signature does'),
}
PY_ONLY_PARAMS = {
    ('documents.get_media', 'to_path'): 'writes the file to disk, which a browser does not',
}

#: A JS positional parameter whose Python twin is named otherwise, keyed (method, parameter).
#: JS spells the record's id `id` (a JS caller never names a positional parameter), Python
#: names it by its kind, which a keyword caller writes.
POSITIONAL_RENAMED = {
    **dict.fromkeys([('comments.delete', 'id'), ('comments.get', 'id'), ('comments.update', 'id')],
                    'comment_id'),
    **dict.fromkeys([('documents.audit', 'id'), ('documents.auditPage', 'id')], 'document_id'),
    **dict.fromkeys([('guidelines.delete', 'id'), ('guidelines.get', 'id'), ('guidelines.update', 'id')],
                    'guideline_id'),
    ('invites.revoke', 'id'): 'invite_id',
    **dict.fromkeys([('projects.audit', 'id'), ('projects.auditPage', 'id')], 'project_id'),
    **dict.fromkeys([('users.audit', 'id'), ('users.auditPage', 'id')], 'user_id'),
}

#: A JS parameter or option key whose Python twin is spelled otherwise, beyond the casing.
PARAM_RENAMED = {
    'retryDelaysMs': 'retry_delays',  # milliseconds in JS, seconds in Python
}


def _py_param(js_name):
    return PARAM_RENAMED.get(js_name) or re.sub(r'(?<=[a-z0-9])([A-Z])', r'_\1', js_name).lower()


def param_differences(js, py):
    """Each difference between the two clients' parameters not on purpose, one line each.
    ``js['params']`` is js_surface.mjs's, ``py['params']`` maps a method (``bundle.method`` or
    the method, Python's spelling) to its parameter names in order, ``self``, ``*args`` and
    ``**kwargs`` left out. A method in one client alone is ``surface_differences``'s."""
    out = []
    for js_key, sig in sorted(js['params'].items()):
        if js_key in PARAMS_EXEMPT:
            continue
        py_key = '.'.join(_py_name(part) for part in js_key.split('.'))
        if py_key not in py['params']:
            continue
        positional, keys = [], set()
        for p in sig['positional']:
            if (js_key, p) in JS_ONLY_PARAMS:
                continue
            if p not in sig['bags']:
                positional.append(p)
                continue
            bag = [k for k in sig['bags'][p] if (js_key, k) not in JS_ONLY_PARAMS]
            if not sig['bags'][p]:
                out.append(f'{js_key}: no key of its {p} object is read, by it or by what it hands it to')
            keys |= {_py_param(k) for k in bag}
        keys |= {_py_param(k) for k in sig['options'] if (js_key, k) not in JS_ONLY_PARAMS}
        names = [n for n in py['params'][py_key] if (py_key, n) not in PY_ONLY_PARAMS]
        py_positional = [n for n in names if n not in keys]
        if len(py_positional) != len(positional):
            out.append(f'{js_key}: plaid-client-js takes {len(positional)} positional '
                       f'({", ".join(positional)}), plaid-client-py {len(py_positional)} '
                       f'({", ".join(py_positional)})')
        else:
            for i, (j, p) in enumerate(zip(positional, py_positional)):
                if POSITIONAL_RENAMED.get((js_key, j), _py_param(j)) != p:
                    out.append(f'{js_key}: positional parameter {i + 1} is {j} in plaid-client-js, {p} in '
                               f'plaid-client-py')
        for k in sorted(keys - set(names)):
            out.append(f'{js_key}: option {k} is in plaid-client-js only')
    return out


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
    bundles = {k: v for k, v in vars(client).items()
               if not k.startswith('_') and type(v).__name__.endswith('Resource')}

    def names(f):
        try:
            ps = inspect.signature(f).parameters.values()
        except (TypeError, ValueError):
            return []
        return [p.name for p in ps if p.kind not in (p.VAR_POSITIONAL, p.VAR_KEYWORD)]

    return {
        'exports': [n for n in dir(plaid_client) if not n.startswith('_')
                    and not isinstance(getattr(plaid_client, n), types.ModuleType)],
        'methods': public(PlaidClient),
        'bundles': {k: public(v) for k, v in bundles.items()},
        'params': {'constructor': names(PlaidClient),
                   **{n: names(getattr(client, n)) for n in public(PlaidClient)},
                   **{f'{k}.{m}': names(getattr(v, m)) for k, v in bundles.items() for m in public(v)}},
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


def test_the_two_clients_methods_take_the_same_parameters(js_surface):
    problems = param_differences(js_surface, _py_surface())
    assert problems == [], (
        'The two clients\' parameters differ:\n  ' + '\n  '.join(problems) + '\nGive the other client '
        'the same parameter (memory plaid_client_parity.md). A difference that is on purpose goes in '
        'PARAMS_EXEMPT, JS_ONLY_PARAMS, PY_ONLY_PARAMS or PARAM_RENAMED in '
        'plaid-client-py/tests/test_surface.py with its reason.')


def test_every_parameter_exemption_is_still_needed(js_surface):
    py = _py_surface()
    js_params = js_surface['params']
    assert sorted(k for k in PARAMS_EXEMPT if k not in js_params) == []
    def js_names(key):
        sig = js_params.get(key, {'positional': [], 'options': [], 'bags': {}})
        return sig['positional'] + sig['options'] + [k for b in sig['bags'].values() for k in b]

    assert sorted(k for k in JS_ONLY_PARAMS if k[1] not in js_names(k[0])) == []
    assert sorted(k for k in PY_ONLY_PARAMS if k[1] not in py['params'].get(k[0], [])) == []
    used = {k for sig in js_params.values()
            for k in sig['options'] + sig['positional'] + [x for b in sig['bags'].values() for x in b]}
    assert sorted(set(PARAM_RENAMED) - used) == []
    assert sorted(k for k, p in POSITIONAL_RENAMED.items()
                  if k[1] not in js_params.get(k[0], {}).get('positional', [])
                  or p not in py['params'].get('.'.join(_py_name(x) for x in k[0].split('.')), [])) == []


def test_a_parameter_in_one_client_alone_is_named():
    js = {'params': {
        'spanLayers.create': {'positional': ['tokenLayerId', 'name', 'auditMessage'], 'options': ['id'],
                              'bags': {}},
        'spanLayers.setConfig': {'positional': ['id', 'namespace', 'configKey', 'configValue', 'auditMessage',
                                                'options'], 'options': [], 'bags': {'options': ['expected']}},
        'spanLayers.checkConstraints': {'positional': ['layerId', 'constraints', 'options'], 'options': [],
                                        'bags': {'options': ['limit', 'newKey']}},
        'spanLayers.repairConstraints': {'positional': ['layerId', 'constraints', 'auditMessage', 'options'],
                                         'options': [], 'bags': {'options': []}},
        'documents.list': {'positional': [], 'options': ['limit', 'cursor'], 'bags': {}},
        'projects.get': {'positional': ['id', 'asOf'], 'options': [], 'bags': {}},
        'vocabLayers.restoreItem': {'positional': ['id', 'asOf', 'itemId', 'auditMessage'],
                                    'options': ['dryRun'], 'bags': {}},
        'comments.get': {'positional': ['id'], 'options': [], 'bags': {}},
    }}
    py = {'params': {
        'span_layers.create': ['token_layer_id', 'name', 'audit_message', 'id', 'metadata'],
        'span_layers.set_config': ['id', 'namespace', 'config_key', 'config_value', 'audit_message', 'expected'],
        'span_layers.check_constraints': ['layer_id', 'constraints', 'limit'],
        'span_layers.repair_constraints': ['layer_id', 'constraints', 'audit_message', 'document'],
        'documents.list': ['limit'],
        'projects.get': ['id'],
        'vocab_layers.restore_item': ['id', 'item_id', 'as_of', 'dry_run', 'audit_message'],
        'comments.get': ['comment_id'],
    }}
    assert param_differences(js, py) == [
        'documents.list: option cursor is in plaid-client-js only',
        'projects.get: plaid-client-js takes 2 positional (id, asOf), plaid-client-py 1 (id)',
        'spanLayers.checkConstraints: option new_key is in plaid-client-js only',
        'spanLayers.create: plaid-client-js takes 3 positional (tokenLayerId, name, auditMessage), '
        'plaid-client-py 4 (token_layer_id, name, audit_message, metadata)',
        'spanLayers.repairConstraints: no key of its options object is read, by it or by what it '
        'hands it to',
        'spanLayers.repairConstraints: plaid-client-js takes 3 positional (layerId, constraints, '
        'auditMessage), plaid-client-py 4 (layer_id, constraints, audit_message, document)',
        'vocabLayers.restoreItem: positional parameter 2 is asOf in plaid-client-js, item_id in '
        'plaid-client-py',
        'vocabLayers.restoreItem: positional parameter 3 is itemId in plaid-client-js, as_of in '
        'plaid-client-py',
    ]


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
