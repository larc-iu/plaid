"""The wire snapshot: what every resource method of the client sends, held in
tests/fixtures/wire.json, with ``client.query`` and the classmethod entry points
(``PlaidClient.login`` and the others). The twin of plaid-client-js's
test/wireSnapshot.test.js. Each method is called with stub arguments twice, on
the client inside an open logical operation and on a batch. Per method:

- ``sends``: each request the call made on the client, in order, as its verb,
  path, query (keys sorted) and body, with every minted UUID written <uuid>,
  plus ``keyed`` when it carried an Idempotency-Key.
- ``batch``: what the same call did on a batch: ``queued`` with the queued
  operations, ``wire`` when it went out at once, ``threw`` or ``nothing``.
- ``outcome``: ``ok``, ``threw`` or ``pending`` for the call on the client.
- ``args`` and ``kwargs``: the stub arguments, ``$fn`` for a callback. The
  probe calls a method the snapshot holds with these, so a refactor that
  renames a parameter compares the same call. A method that gains a parameter
  is given it by deleting its line before regenerating.

A refactor that moves code proves itself by leaving the file unchanged. After
a change meant to change the wire, regenerate it with
``UPDATE_WIRE=1 python -m pytest tests/test_wire_snapshot.py`` and read the diff.
"""

import inspect
import json
import os
import re
import threading
from urllib.parse import parse_qsl, urlsplit

import requests
from requests.structures import CaseInsensitiveDict

from plaid_client import client as client_module
from plaid_client.client import PlaidClient

FIXTURE = os.path.join(os.path.dirname(__file__), 'fixtures', 'wire.json')
BASE = 'http://wire.test'

#: Left out of the stub arguments (their defaults stand), since a string
#: there would be a timer or a callback.
SKIPPED = {'timeout', 'on_progress', 'on_upload_progress', 'should_renew', 'signal', 'cancel'}

_UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')


def _scrub(value):
    if isinstance(value, str):
        return _UUID.sub('<uuid>', value)
    if isinstance(value, list):
        return [_scrub(v) for v in value]
    if isinstance(value, dict):
        return {k: _scrub(value[k]) for k in sorted(value)}
    return value


def _request_of(method, url, *, data=None, json_body=None, files=None, headers=None):
    parts = urlsplit(url)
    out = {'method': method.upper(), 'path': parts.path}
    if not url.startswith(BASE):
        out['host'] = parts.netloc
    if parts.query:
        pairs = parse_qsl(parts.query, keep_blank_values=True)
        query = {}
        for k, v in pairs:
            query.setdefault(k, []).append(v)
        out['query'] = {k: (vs[0] if len(vs) == 1 else vs) for k, vs in sorted(query.items())}
    if files is not None:
        out['body'] = {'$form': True}
    elif json_body is not None:
        out['body'] = json_body
    elif data is not None:
        if isinstance(data, (bytes, str)):
            try:
                out['body'] = json.loads(data)
            except ValueError:
                out['body'] = {'$raw': data if isinstance(data, str) else data.decode('utf-8', 'replace')}
        else:
            out['body'] = {'$form': True}
    if any(h.lower() == 'idempotency-key' for h in (headers or {})):
        out['keyed'] = True
    return _scrub(out)


class _Answer:
    ok = True
    status_code = 200
    reason = 'OK'

    def __init__(self):
        self.headers = CaseInsensitiveDict({'content-type': 'application/json'})
        self.text = json.dumps({'entries': [], 'next-cursor': None})
        self.content = self.text.encode()

    def json(self):
        return json.loads(self.text)

    def iter_lines(self, *a, **kw):
        return iter(())

    def iter_content(self, *a, **kw):
        return iter(())

    def raise_for_status(self):
        pass

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Wire:
    """Every request any client makes, kept only while it is the live
    client's, told apart by its token."""

    def __init__(self):
        self.live = None
        self.sent = []
        self.lock = threading.Lock()

    def note(self, method, url, headers=None, **kw):
        auth = (headers or {}).get('Authorization')
        with self.lock:
            if self.live is not None and (auth is None or auth == f'Bearer {self.live}'):
                self.sent.append(_request_of(method, url, data=kw.get('data'), json_body=kw.get('json'),
                                             files=kw.get('files'), headers=headers))
        return _Answer()


def _install(monkeypatch, wire):
    class _Session:
        def request(self, method=None, url=None, headers=None, **kw):
            return wire.note(method, url, headers, **kw)

        def post(self, url, headers=None, **kw):
            return wire.note('POST', url, headers, **kw)

        def get(self, url, headers=None, **kw):
            return wire.note('GET', url, headers, **kw)

        def close(self):
            pass

    monkeypatch.setattr(client_module.req_lib, 'Session', _Session)
    monkeypatch.setattr(requests, 'request',
                        lambda method, url, headers=None, **kw: wire.note(method, url, headers, **kw))
    for verb in ('get', 'post', 'put', 'patch', 'delete'):
        monkeypatch.setattr(requests, verb,
                            lambda url, headers=None, _v=verb, **kw: wire.note(_v, url, headers, **kw))


def _noop(*a, **kw):
    return None


def _stub_args(fn):
    args, kwargs = [], {}
    positional = True
    for i, p in enumerate(inspect.signature(fn).parameters.values()):
        if p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
            continue
        if p.name == 'base_url':
            value = BASE
        elif p.name in ('fn', 'callback') or p.name.startswith('on_') and p.name not in SKIPPED:
            value = '$fn'
        elif p.name in SKIPPED:
            if p.default is p.empty and p.kind != p.KEYWORD_ONLY:
                value = '$none'
            else:
                positional = False
                continue
        elif p.kind == p.KEYWORD_ONLY:
            value = f'kw.{p.name}'
        else:
            value = f'a{i}'
        if p.kind == p.KEYWORD_ONLY or not positional:
            kwargs[p.name] = value
        else:
            args.append(value)
    return args, kwargs


def _decode(v):
    return _noop if v == '$fn' else None if v == '$none' else v


def _drive(result):
    if inspect.isgenerator(result):
        next(result, None)
    elif hasattr(result, '__enter__') and hasattr(result, '__exit__'):
        with result:
            pass
    return result


def _settle(call, wait=1.0):
    outcome = ['pending']

    def run():
        try:
            _drive(call())
            outcome[0] = 'ok'
        except BaseException:
            outcome[0] = 'threw'

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(wait)
    return outcome[0]


def probe(monkeypatch, pinned=None):
    pinned = pinned or {}
    wire = _Wire()
    _install(monkeypatch, wire)
    count = [0]

    def fresh():
        token = f'tok{count[0]}'
        count[0] += 1
        with wire.lock:
            wire.live = token
            wire.sent = []
        return PlaidClient(BASE, token, retry_delays=[])

    c = fresh()
    names = []
    for b, resource in vars(c).items():
        if b.startswith('_') or not type(resource).__name__.endswith('Resource'):
            continue
        for m in dir(resource):
            if not m.startswith('_') and callable(getattr(resource, m)):
                names.append((b, m))
    names.append(('client', 'query'))
    for m in ('health', 'info', 'login', 'lookup_invite', 'redeem_invite', 'invite_url'):
        names.append(('PlaidClient', m))
    names.sort(key=lambda n: f'{n[0]}.{n[1]}')

    def method_of(target, b, m):
        if b == 'PlaidClient':
            return getattr(PlaidClient, m)
        if b == 'client':
            return getattr(target, m)
        return getattr(getattr(target, b), m)

    out = {}
    for b, m in names:
        name = f'{b}.{m}'
        client = fresh()
        if name in pinned:
            args, kwargs = pinned[name]['args'], pinned[name]['kwargs']
        else:
            args, kwargs = _stub_args(method_of(client, b, m))
        call_args = [_decode(a) for a in args]
        call_kwargs = {k: _decode(v) for k, v in kwargs.items()}
        entry = {'args': args, 'kwargs': kwargs}
        client.begin_operation('op')
        entry['outcome'] = _settle(lambda: method_of(client, b, m)(*call_args, **call_kwargs))
        with wire.lock:
            entry['sends'] = list(wire.sent)
        if b != 'PlaidClient':
            client = fresh()
            batch = client.batch()
            refused = _settle(lambda: method_of(batch, b, m)(*call_args, **call_kwargs)) == 'threw'
            queued = []
            for op in batch.operations:
                rest = {k: v for k, v in op.items() if k not in ('path', 'method', 'body')}
                body = op.get('body')
                req = _request_of(op['method'], BASE + op['path'],
                                  data=None if body is None else json.dumps(body))
                queued.append({**req, **_scrub(rest)})
            with wire.lock:
                sent = list(wire.sent)
            if queued:
                entry['batch'] = {'queued': queued}
            elif sent:
                entry['batch'] = 'wire'
            else:
                entry['batch'] = 'threw' if refused else 'nothing'
            batch.abort()
        out[name] = entry
    with wire.lock:
        wire.live = None
    return out


def _write(snapshot):
    # One method a line, so a diff names the methods that changed.
    lines = [f'  {json.dumps(k)}: {json.dumps(v, separators=(",", ":"))}' for k, v in snapshot.items()]
    os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
    with open(FIXTURE, 'w', encoding='utf-8') as f:
        f.write('{\n' + ',\n'.join(lines) + '\n}\n')


def test_every_resource_method_sends_what_the_wire_snapshot_holds(monkeypatch):
    pinned = {}
    if os.path.exists(FIXTURE):
        with open(FIXTURE, encoding='utf-8') as f:
            pinned = json.load(f)
    got = probe(monkeypatch, pinned)
    assert len(got) > 240, f'only {len(got)} methods'
    if os.environ.get('UPDATE_WIRE'):
        _write(got)
        return
    changed = sorted(k for k in set(got) | set(pinned) if got.get(k) != pinned.get(k))
    assert {k: got.get(k) for k in changed} == {k: pinned.get(k) for k in changed}, (
        f'{len(changed)} methods send other than tests/fixtures/wire.json holds: {", ".join(changed)}')


# --- the two snapshots side by side ---------------------------------------------------
#
# The JS client's snapshot (plaid-client-js/test/fixtures/wire.json, held to its
# code by test/wireSnapshot.test.js) and this one's, method by method in
# Python's spelling: the same requests in the same order (verb and path), the
# same keyed writes, the same joins of an open operation, and the same class on
# a batch (queued, at once, refused). Query and body keys are left out: the two
# probes stub an options object differently (a JS `options` argument is one
# string, Python's keywords are each given).

_JS_FIXTURE = os.path.join(os.path.dirname(__file__), '..', '..', 'plaid-client-js', 'test',
                           'fixtures', 'wire.json')

#: In the JS client alone (test_surface.py's JS_ONLY gives the reason).
_JS_ONLY = {'events.flush', 'events.record', 'events.set_enabled'}


def _snake(name):
    return re.sub(r'(?<=[a-z0-9])([A-Z])', r'_\1', name).lower()


def _py_name(js_name):
    b, m = js_name.split('.', 1)
    return f'{b if b in ("client", "PlaidClient") else _snake(b)}.{_snake(m)}'


def _class_of(entry):
    """What two clients sending the same request agree on."""
    def placeholder(path):
        return re.sub(r'\b(?:a\d+|kw)\.(\w+)', lambda m: f'<{_snake(m.group(1))}>', path)

    batch = entry.get('batch')
    return {
        'sends': [(s['method'], placeholder(s['path']), bool(s.get('keyed')),
                   'group-id' in s.get('query', {})) for s in entry['sends']],
        'batch': batch if batch is None or isinstance(batch, str) else 'queued',
    }


def wire_differences(js, py):
    out = []
    js_by_py = {_py_name(k): k for k in js}
    for name in sorted(set(js_by_py) | set(py)):
        if name in _JS_ONLY:
            continue
        if name not in py:
            out.append(f'{js_by_py[name]} is in the JS snapshot only')
        elif name not in js_by_py:
            out.append(f'{name} is in the Python snapshot only')
        elif _class_of(js[js_by_py[name]]) != _class_of(py[name]):
            out.append(f'{name}: JS {_class_of(js[js_by_py[name]])}, Python {_class_of(py[name])}')
    return out


def test_the_two_clients_send_each_method_the_same_way():
    with open(_JS_FIXTURE, encoding='utf-8') as f:
        js = json.load(f)
    with open(FIXTURE, encoding='utf-8') as f:
        py = json.load(f)
    problems = wire_differences(js, py)
    assert problems == [], 'The two clients differ on the wire:\n  ' + '\n  '.join(problems)


def test_a_method_sent_otherwise_is_named():
    js = {'spanLayers.create': {'sends': [{'method': 'POST', 'path': '/api/v1/span-layers', 'keyed': True}],
                                'batch': {'queued': []}},
          'audit.tally': {'sends': [{'method': 'GET', 'path': '/p/a0.projectId/tally'}], 'batch': 'wire'},
          'events.record': {'sends': [], 'batch': 'nothing'}}
    py = {'span_layers.create': {'sends': [{'method': 'POST', 'path': '/api/v1/span-layers'}],
                                 'batch': 'wire'},
          'audit.tally': {'sends': [{'method': 'GET', 'path': '/p/kw.project_id/tally'}], 'batch': 'wire'}}
    assert wire_differences(js, py) == [
        "span_layers.create: JS {'sends': [('POST', '/api/v1/span-layers', True, False)], 'batch': 'queued'}, "
        "Python {'sends': [('POST', '/api/v1/span-layers', False, False)], 'batch': 'wire'}",
    ]
