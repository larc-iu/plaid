"""What a client method puts on the wire: method, path, query and body. The
cases are the JS client's test/fixtures/requests.json, which
``plaid-client-js/test/requests.test.js`` runs too, so the two clients send the
same request for the same call.

A case calls ``py`` (``bundle.method`` and its positional arguments) with the
keyword arguments ``py_kw``. With no ``py``, it calls the JS call snake-cased.
``each`` and ``sends`` are read as the JS runner reads them."""

import json
import os
import re
import sys
from urllib.parse import parse_qsl, urlsplit

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import PlaidClient
from plaid_client.testing import recording_session

FIXTURE = os.path.join(os.path.dirname(__file__), '..', '..', 'plaid-client-js', 'test',
                       'fixtures', 'requests.json')

with open(FIXTURE, encoding='utf-8') as f:
    CASES = json.load(f)


def _snake(name):
    return re.sub(r'([A-Z])', lambda m: '_' + m.group(1).lower(), name)


def _expand(case):
    if 'each' not in case:
        return [case]
    out = []
    for bundle, kind in case['each']:
        def fill(value, bundle_name):
            text = json.dumps(value).replace('<bundle>', bundle_name).replace('<kind>', kind)
            return json.loads(text)
        out.append({**case, 'name': f"{case['name']} ({bundle})",
                    'js': fill(case['js'], bundle),
                    'py': fill(case['py'], _snake(bundle)) if 'py' in case else None,
                    'py_kw': fill(case.get('py_kw', {}), _snake(bundle)),
                    'sends': fill(case['sends'], bundle)})
    return out


EXPANDED = [c for case in CASES for c in _expand(case)]


def _sent(call, kwargs):
    client = PlaidClient('http://example.test', 'tok')
    out = []

    def answer(kw):
        url = urlsplit(kw['url'])
        request = {'method': kw['method'], 'path': url.path}
        if url.query:
            request['query'] = dict(parse_qsl(url.query, keep_blank_values=True))
        if kw['data'] is not None:
            request['body'] = json.loads(kw['data'])
        out.append(request)
        return {'entries': [], 'next-cursor': None}

    client.session = recording_session(answer)
    name, *args = call
    bundle, method = name.split('.')
    result = getattr(getattr(client, bundle), method)(*args, **kwargs)
    if hasattr(result, '__next__'):
        next(result, None)
    return out


@pytest.mark.parametrize('case', EXPANDED, ids=[c['name'] for c in EXPANDED])
def test_request(case):
    call = case.get('py') or [_snake(case['js'][0])] + case['js'][1:]
    assert '$undefined' not in call, 'a call leaving an argument out needs its own py'
    assert _sent(call, case.get('py_kw') or {}) == case['sends']
