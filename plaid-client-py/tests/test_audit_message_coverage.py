"""Coverage guard: EVERY write method (POST/PUT/PATCH/DELETE) on the resource
bundles must accept an ``audit_message`` keyword and thread it into the request
URL as ``?audit-message=``. Auto-discovers methods via a stubbed session, so a
new write method added without the param will fail this test.
"""

import inspect
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient

WRITE = {'POST', 'PUT', 'PATCH', 'DELETE'}
SENT = 'COVPROBE'


class _Resp:
    ok = True
    status_code = 200
    headers = {}
    text = ''
    content = b''

    def json(self):
        return {}


def test_every_write_method_threads_audit_message():
    client = PlaidClient('http://x', 'tok')
    last = {}

    class _Sess:
        def request(self, **kw):
            last.clear()
            last.update(kw)
            return _Resp()

        def close(self):
            pass

    client.session = _Sess()
    checked = []

    def probe(label, method):
        sig = inspect.signature(method)
        if 'audit_message' not in sig.parameters:
            return  # GET / non-write
        required = [p for p in sig.parameters.values()
                    if p.default is p.empty
                    and p.kind in (p.POSITIONAL_OR_KEYWORD, p.POSITIONAL_ONLY)
                    and p.name != 'self']
        last.clear()
        try:
            method(*(['x'] * len(required)), audit_message=SENT)
        except Exception:
            return
        if last.get('method') in WRITE:
            checked.append(label)
            assert 'audit-message=' + SENT in last.get('url', ''), \
                f"{label} ({last['method']}) did not thread audit_message: {last.get('url')}"

    for name, res in vars(client).items():
        if type(res).__name__.endswith('Resource'):
            for mname, fn in inspect.getmembers(res, inspect.ismethod):
                if not mname.startswith('_'):
                    probe(f'{name}.{mname}', fn)
    if hasattr(client, 'query'):
        probe('query', client.query)

    assert len(checked) >= 105, f'expected ~109 write methods, only checked {len(checked)}'
