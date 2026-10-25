"""The reads that travel as a POST. A lost answer to one saved nothing, so a
service never tells its requester "may or may not have been saved" about it.
plaid-ui's errors.js, the JS twin's services.js and this client's services.py
each keep the list, and they must keep the same one. Mirrors the JS
``readPosts.test.js``."""

import os
import re
import sys

import pytest
import requests

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, '..', 'src'))

from plaid_client.http import PlaidAPIError  # noqa: E402
from plaid_client.service import requester_message  # noqa: E402

ROOT = os.path.join(HERE, '..', '..')


def _read(*path):
    with open(os.path.join(ROOT, *path), encoding='utf-8') as f:
        return f.read()


def _js_pattern(source):
    # A JS regex literal escapes the slash, a Python raw string need not.
    return re.search(r'const READ_POSTS =\s*/(.+)/;', source).group(1).replace('\\/', '/')


def _py_pattern(source):
    return re.search(r"_READ_POSTS = re\.compile\(r'(.+)'\)", source).group(1)


def test_errors_js_services_js_and_services_py_keep_one_list():
    ui = _js_pattern(_read('plaid-ui', 'src', 'lib', 'errors.js'))
    assert _js_pattern(_read('plaid-client-js', 'src', 'services.js')) == ui
    assert _py_pattern(_read('plaid-client-py', 'src', 'plaid_client', 'services.py')) == ui


@pytest.mark.parametrize('path', [
    '/api/v1/query',
    '/api/v1/query/token-counts',
    '/api/v1/login',
    '/api/v1/invites/lookup',
    '/api/v1/token-layers/L1/constraints/check',
    '/api/v1/span-layers/L1/constraints/check',
    '/api/v1/relation-layers/L1/constraints/refused-values?x=1',
])
def test_a_read_sent_as_a_post_whose_answer_was_lost_saved_nothing(path):
    timed_out = requests.exceptions.ReadTimeout('read timed out')
    url = f'http://plaid.internal:8085{path}'
    err = PlaidAPIError(f'Network error: {timed_out} at {url}', status=0, url=url,
                        method='POST', original_error=timed_out)
    assert requester_message(err) == 'The Plaid server did not answer.'
