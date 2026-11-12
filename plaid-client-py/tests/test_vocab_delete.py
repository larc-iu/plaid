"""Deleting a vocabulary: a dry run sends dry-run=true and answers the links
the delete would remove, and the refusal while another project borrows the
vocabulary keeps core's count on the error. The same as plaid-client-js's
test/vocabDelete.test.js."""

import os
import sys
from urllib.parse import parse_qs, urlparse

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import PlaidClient
from plaid_client.testing import Response, recording_session


def _query(request):
    return {k: v[0] for k, v in parse_qs(urlparse(request['url']).query).items()}


def test_a_dry_run_asks_with_dry_run_and_answers_the_links():
    c = PlaidClient('http://x', 'tok')
    c.session = recording_session(lambda request: Response(200, {'links': 14}))
    assert c.vocab_layers.delete('v1', dry_run=True) == {'links': 14}
    sent = c.session.sent[0]
    assert sent['method'] == 'DELETE' and _query(sent)['dry-run'] == 'true'
    assert set(_query(sent)) == {'dry-run'}


def test_a_delete_takes_no_project_to_keep():
    c = PlaidClient('http://x', 'tok')
    with pytest.raises(TypeError):
        c.vocab_layers.delete('v1', only_in_project='p1')


def test_a_refusal_carries_the_number_of_other_projects_and_its_sentence():
    c = PlaidClient('http://x', 'tok')
    body = {'error': '3 other projects use this vocabulary.', 'other-projects': 3}
    c.session = recording_session(lambda request: Response(409, body))
    with pytest.raises(Exception) as e:
        c.vocab_layers.delete('v1')
    assert getattr(e.value, 'status', None) == 409
    assert e.value.response_data['other-projects'] == 3
    assert '3 other projects use this vocabulary.' in str(e.value)
