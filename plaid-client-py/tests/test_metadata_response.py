"""A metadata write answers the entity, recased like every other write's
answer, whether it went alone or on a batch (where every result is recased).
It used to come back as the raw wire map when sent alone."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient


class _Resp:
    ok = True
    status_code = 200
    reason = 'OK'
    headers = {'content-type': 'application/json'}

    def json(self):
        return {'token/id': 'e1', 'token/begin': 0,
                'metadata': {'kebab-key': 1, 'ns/k': 2}}


def test_every_metadata_write_answers_the_recased_entity():
    client = PlaidClient('http://x', 'tok')

    class _Session:
        def request(self, **kw):
            return _Resp()

    client.session = _Session()
    resources = {name: r for name, r in vars(client).items()
                 if callable(getattr(r, 'set_metadata', None))}
    assert len(resources) == 7, 'the seven entity types with metadata'
    for name, resource in resources.items():
        for method, args in (('set_metadata', ('e1', {'a': 1})),
                             ('patch_metadata', ('e1', [{'op': 'set', 'path': ['a'], 'value': 1}])),
                             ('delete_metadata', ('e1',))):
            answer = getattr(resource, method)(*args)
            assert answer == {'id': 'e1', 'begin': 0,
                              'metadata': {'kebab-key': 1, 'ns/k': 2}}, f'{name}.{method}'
