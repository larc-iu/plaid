"""A vocabulary has a home project: create names it, move changes it, the
home's maintainer lists the borrowers and may end a borrowing, and a project
delete has a dry run and a refusal while a borrower links one of its
vocabularies. The maintainer methods are gone. The same as plaid-client-js's
test/vocabMove.test.js."""

import json
import os
import sys
from urllib.parse import parse_qs, urlparse

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import PlaidClient
from plaid_client.http import PlaidAPIError
from plaid_client.testing import Response, recording_session


def _call(status, body, fn):
    c = PlaidClient('http://plaid.test', 'tok', retry_delays=[])
    c.session = recording_session(lambda request: Response(status, body))
    return fn(c), c.session.sent


def _url(request):
    return urlparse(request['url'])


def _query(request):
    return {k: v[0] for k, v in parse_qs(_url(request).query).items()}


def _body(request):
    if request['json'] is not None:
        return request['json']
    return json.loads(request['data']) if request['data'] else None


def test_create_sends_the_home_project_and_keeps_a_minted_id():
    _, sent = _call(201, {'id': 'v1'}, lambda c: c.vocab_layers.create(
        'p1', 'Lexicon', 'made', id='0190a000-0000-7000-8000-000000000001'))
    assert sent[0]['method'] == 'POST'
    assert _url(sent[0]).path == '/api/v1/vocab-layers'
    assert _body(sent[0]) == {'id': '0190a000-0000-7000-8000-000000000001',
                              'name': 'Lexicon', 'project-id': 'p1'}
    assert _query(sent[0])['audit-message'] == 'made'


def test_a_create_sent_again_under_its_minted_id_answers_as_made():
    new_id = '0190a000-0000-7000-8000-000000000002'

    def make(c):
        with c.operation('Make', keys=c.key_seed(), minted={new_id}):
            return c.vocab_layers.create('p1', 'Lexicon', id=new_id)

    made, sent = _call(409, {'error': 'id-taken', 'id-taken': True, 'id': new_id}, make)
    assert made == {'id': new_id}
    assert _body(sent[0])['id'] == new_id and _body(sent[0])['project-id'] == 'p1'


def test_move_posts_the_new_home_and_answers_the_vocabulary():
    answer = {'vocab/id': 'v1', 'vocab/name': 'Lex', 'vocab/project': 'p2', 'config': {}}
    result, sent = _call(200, answer, lambda c: c.vocab_layers.move('v1', 'p2', 'moved'))
    assert sent[0]['method'] == 'POST'
    assert _url(sent[0]).path == '/api/v1/vocab-layers/v1/move'
    assert _body(sent[0]) == {'project-id': 'p2'}
    assert _query(sent[0])['audit-message'] == 'moved'
    assert result['project'] == 'p2' and 'maintainers' not in result


def test_a_move_refused_keeps_cores_sentence():
    body = {'error': 'Moving a vocabulary needs maintainer rights on both projects.'}
    with pytest.raises(PlaidAPIError) as e:
        _call(403, body, lambda c: c.vocab_layers.move('v1', 'p2'))
    assert e.value.status == 403
    assert 'needs maintainer rights on both projects.' in str(e.value)


def test_borrowers_lists_the_projects_a_name_none_where_unreadable():
    answer = [{'id': 'p2', 'name': 'B'}, {'id': 'p3', 'name': None}]
    result, sent = _call(200, answer, lambda c: c.vocab_layers.borrowers('v1'))
    assert sent[0]['method'] == 'GET'
    assert _url(sent[0]).path == '/api/v1/vocab-layers/v1/borrowers'
    assert result == answer


def test_unlink_has_a_dry_run_that_answers_the_links():
    result, sent = _call(200, {'links': 3},
                         lambda c: c.projects.unlink_vocab('p2', 'v1', dry_run=True))
    assert sent[0]['method'] == 'DELETE'
    assert _url(sent[0]).path == '/api/v1/projects/p2/vocabs/v1'
    assert _query(sent[0])['dry-run'] == 'true'
    assert result == {'links': 3}


def test_unlinking_the_home_is_refused_with_cores_sentence():
    body = {'error': 'A vocabulary cannot be unlinked from its own project.'}
    with pytest.raises(PlaidAPIError) as e:
        _call(409, body, lambda c: c.projects.unlink_vocab('p1', 'v1'))
    assert e.value.status == 409
    assert 'cannot be unlinked from its own project.' in str(e.value)


def test_a_project_delete_has_a_dry_run_naming_the_vocabularies_it_takes():
    answer = {'vocabularies': [{'id': 'v1', 'name': 'Lex'}]}
    result, sent = _call(200, answer, lambda c: c.projects.delete('p1', dry_run=True))
    assert sent[0]['method'] == 'DELETE'
    assert _url(sent[0]).path == '/api/v1/projects/p1'
    assert _query(sent[0])['dry-run'] == 'true'
    assert result == answer


def test_a_project_delete_without_a_dry_run_sends_none():
    _, sent = _call(204, None, lambda c: c.projects.delete('p1'))
    assert 'dry-run' not in _query(sent[0])


def test_a_project_delete_refused_keeps_the_count_of_borrowers():
    body = {'error': '2 other projects use a vocabulary of this project.', 'other-projects': 2}
    with pytest.raises(PlaidAPIError) as e:
        _call(409, body, lambda c: c.projects.delete('p1'))
    assert e.value.status == 409
    assert e.value.response_data['other-projects'] == 2
    assert '2 other projects use a vocabulary of this project.' in str(e.value)


def test_a_vocabulary_has_no_maintainer_methods():
    c = PlaidClient('http://plaid.test', 'tok')
    assert not hasattr(c.vocab_layers, 'add_maintainer')
    assert not hasattr(c.vocab_layers, 'remove_maintainer')
