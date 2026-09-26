"""The service-handler harness the client ships for service authors.

``plaid_client.testing`` is a public module, and the suites that use it live in
other repos (both apps' ``services/tests``), so what it promises is checked
here: a service loads from its path, a run reaches the handler on a thread of
its own and reports, and a batch that raises reaches the server with nothing.

Run: cd plaid-client-py && python -m pytest tests/ -q
"""

import sys
import types

import pytest

from plaid_client import testing
from plaid_client.http import PlaidAPIError
from plaid_client.service import BaseService
from plaid_client.services import ServiceCancelled


def test_a_service_loads_from_its_path_and_gives_the_stand_ins_back(tmp_path):
    # A service is a script, not an installed module, and the ones worth
    # testing import a model library at module level.
    (tmp_path / 'my_service.py').write_text(
        'import heavy_model\n\nLOADED = heavy_model.NAME\n')
    stand_in = types.ModuleType('heavy_model')
    stand_in.NAME = 'stood in'

    module = testing.load_service(tmp_path / 'my_service.py', {'heavy_model': stand_in})

    assert module.LOADED == 'stood in'
    assert 'heavy_model' not in sys.modules


class _Service(BaseService):
    """A handler with one beat and one write, and a failure on request."""

    def process_request(self, request_data, response_helper):
        response_helper.progress(50, 'Working...')
        with self.client.batched() as b:
            b.tokens.bulk_create([{'begin': 0, 'end': 1}])
            if request_data.get('fail'):
                raise ValueError('the model said no')
        response_helper.complete({'ok': True})


def _service(fails=None):
    service = _Service('svc', 'Svc', 'a service')
    service.client = testing.FakeClient([{'id': 'd1'}], fails=fails)
    return service


def test_a_run_reaches_the_handler_and_reports():
    service = _service()

    helper = testing.run(service, {'document_id': 'd1'})

    assert helper.errors == []
    assert helper.results == [{'ok': True}]
    assert helper.beats == [(50, 'Working...')]
    [(kind, ops)] = service.client.writes
    assert kind == 'tokens.bulk_create' and ops == [{'begin': 0, 'end': 1}]


def test_a_batch_that_raises_reaches_the_server_with_nothing():
    service = _service()

    helper = testing.run(service, {'document_id': 'd1', 'fail': True})

    assert service.client.writes == []
    assert len(helper.errors) == 1


def test_a_stop_is_read_at_the_next_checkpoint():
    # What ``critical()`` is for: a stop pressed during the block is held off
    # until the block ends, so half-written work is never left behind.
    helper = testing.Helper(stop_when=lambda pct, msg: pct == 50)
    with helper.critical():
        helper.progress(50, 'Working...')
        helper.raise_if_cancelled()
    assert helper.cancelled
    with pytest.raises(ServiceCancelled):
        helper.raise_if_cancelled()


# --- the fake client, as a project-level caller (an assistant) uses it --------


def _project_client(**kw):
    return testing.FakeClient({'d': {'id': 'd', 'name': 'D'}, 'e': {'id': 'e', 'name': 'E'}},
                              project={'id': 'p', 'name': 'P'}, **kw)


def test_documents_given_by_id_are_read_by_id():
    c = _project_client(audit=[{'id': 'a', 'time': '2026-01-01T00:00:00Z',
                                'documents': [{'id': 'd', 'name': 'D'}]},
                               {'id': 'b', 'time': '2026-02-01T00:00:00Z', 'documents': []}])
    assert c.documents.get('e')['name'] == 'E'
    assert c.documents.get('d', layers=['l1'])['name'] == 'D'
    assert c.reads == [{'id': 'e', 'layers': None}, {'id': 'd', 'layers': ['l1']}]
    assert c.kinds == ['read', 'read'] and c.writes == []
    with pytest.raises(PlaidAPIError) as e:
        c.documents.get('nope')
    assert e.value.status == 404
    assert c.projects.get('p')['name'] == 'P'
    assert [d['id'] for d in c.projects.list_documents('p')] == ['d', 'e']
    assert [e['id'] for e in c.documents.audit('d')] == ['a']
    assert [e['id'] for e in c.projects.audit('p', start_time='2026-01-15')] == ['b']
    page = c.projects.audit_page('p', order='desc', limit=1)
    assert [e['id'] for e in page['entries']] == ['b'] and page['next_cursor'] is None
    assert c.audit_pages == [{'order': 'desc', 'start_time': None}]


def test_a_list_of_documents_is_still_one_document_as_each_read_finds_it():
    c = testing.FakeClient([{'id': 'd', 'version': 1}, {'id': 'd', 'version': 2}])
    assert [c.documents.get('d')['version'] for _ in range(3)] == [1, 2, 2]


def test_any_write_is_recorded_by_one_rule():
    c = _project_client()
    c.tokens.update('t1', precedence=2)
    c.tokens.split('t1', 3)
    c.relations.delete('r1')
    c.spans.update('s1', 'x')
    assert c.writes == [('tokens.update', {'args': ('t1',), 'kwargs': {'precedence': 2}}),
                        ('tokens.split', ('t1', 3)),
                        ('relations.delete', 'r1'),
                        ('spans.update', ('s1', 'x'))]
    with pytest.raises(AttributeError):
        c.tokens._private


def test_a_batch_queues_until_it_submits_and_answers_per_op():
    c = _project_client()
    b = c.batch()
    b.spans.create('L', ['t'], 'v')
    b.tokens.bulk_create([{'begin': 0}, {'begin': 1}])
    b.documents.patch_metadata('d', [{'op': 'set', 'path': ['k'], 'value': 1}])
    c.spans.create('L', ['t'], 'now')  # a write on the client is never held by the batch
    assert [k for k, _ in c.writes] == ['spans.create']
    out = b.submit()
    assert [k for k, _ in c.batches[0]] == ['spans.create', 'tokens.bulk_create',
                                            'documents.patch_metadata']
    assert [k for k, _ in c.writes] == ['spans.create', 'spans.create', 'tokens.bulk_create',
                                        'documents.patch_metadata']
    assert out[0]['body']['id'] == 'spans-1'
    assert out[1]['body']['ids'] == ['tokens-2', 'tokens-3']
    with pytest.raises(AssertionError):
        b.submit()
    with pytest.raises(RuntimeError):
        with c.batched() as b2:
            b2.spans.create('L', ['t'], 'v')
            raise RuntimeError('boom')
    assert len(c.batches) == 1


def test_a_metadata_patch_is_a_list_of_ops_and_reads_back_either_way_it_travelled():
    c = _project_client()
    ops = [{'op': 'set', 'path': ['prov'], 'value': 'inferred'}]
    c.spans.patch_metadata('s1', ops)
    c.spans.bulk_update([{'id': 's2', 'value': 'x', 'metadata': ops}, {'id': 's3', 'value': 'y'}])
    assert c.patches('spans') == [('s1', ops), ('s2', ops)]
    assert c.updates('spans') == [('s2', 'x'), ('s3', 'y')]
    assert testing.as_fragment(ops + [{'op': 'delete', 'path': ['a', 'b']}]) == {
        'prov': 'inferred', 'a': {'b': None}}
    with pytest.raises(PlaidAPIError):
        c.spans.patch_metadata('s1', {'prov': 'inferred'})
    with pytest.raises(PlaidAPIError):
        c.spans.bulk_update([{'id': 's1', 'metadata': {'prov': 'inferred'}}])
    with pytest.raises(PlaidAPIError):
        c.documents.patch_metadata('d', {'prov': 'inferred'})


def test_guidelines_comments_and_a_restore():
    c = _project_client(guidelines=[{'id': 'g1', 'title': 'T', 'body': 'abc', 'pinned': False,
                                     'updated_at': 'then'}],
                        comments=[{'id': 'c1', 'document_id': 'd', 'entity_type': 'token',
                                   'entity_id': 't1'}],
                        restore_summary={'total': 2})
    assert c.guidelines.list('p') == [{'id': 'g1', 'title': 'T', 'pinned': False,
                                       'updated_at': 'then', 'body_chars': 3}]
    with pytest.raises(PlaidAPIError) as e:
        c.guidelines.update('g1', body='x', expected_updated_at='earlier')
    assert e.value.status == 409 and c.writes == []
    c.guidelines.update('g1', body='x', expected_updated_at='then')
    assert c.guidelines.get('g1')['body'] == 'x'
    with c.batched() as b:
        b.guidelines.create('p', 'New', body='b')
        b.comments.create('token', 't1', 'hm', anchor_label='w1')
        assert c.writes[-1][0] == 'guidelines.update'  # queued, not sent
    assert [k for k, _ in c.batches[0]] == ['guidelines.create', 'comments.create']
    assert c.payloads('comments.create') == [{'args': ('token', 't1', 'hm'),
                                              'kwargs': {'anchor_label': 'w1'}}]
    assert [r['id'] for r in c.comments.list('p', document_id='d')] == ['c1']
    assert c.comments.list('p', entity_type='token', entity_id='t2') == []
    assert c.documents.restore('d', 'T', dry_run=True) == {'total': 2}
    assert c.documents.restore('d', 'T') == {'id': 'd'}
    assert [p['kwargs']['dry_run'] for p in c.payloads('documents.restore')] == [True, False]
    denied = _project_client(fails={'documents.restore': PlaidAPIError('HTTP 403', status=403)})
    with pytest.raises(PlaidAPIError):
        denied.documents.restore('d', 'T', dry_run=True)


def test_the_user_data_store_matches_the_real_client_surface():
    """A fake that lies about a signature teaches the first caller written
    against it to call the real client wrong."""
    import inspect
    from plaid_client.client import UserDataResource

    def params(fn):
        return {n: p.default for n, p in inspect.signature(fn).parameters.items()
                if n not in ('self', 'user_id')}

    assert params(testing.FakeClient._UserData.list) == params(UserDataResource.list)
    assert params(testing.FakeClient._UserData.list_page) == params(UserDataResource.list_page)


def test_the_user_data_store_reads_like_the_server_does():
    c = _project_client()
    for k in ['igt:assistant:p2:meta:c2', 'igt:assistant:p1:meta:c1', 'igt:assistant:p1:conv:c1']:
        c.user_data.put('u', k, {'of': k})
    assert c.writes == []  # the store is read back, not logged
    # Ordered by key, whatever order they were written in.
    assert [r['key'] for r in c.user_data.list('u', prefix='igt:assistant:p1:')] == [
        'igt:assistant:p1:conv:c1', 'igt:assistant:p1:meta:c1']
    # A GLOB picks out a segment in the middle, which a prefix cannot say.
    assert [r['key'] for r in c.user_data.list('u', pattern='igt:assistant:*:meta:*')] == [
        'igt:assistant:p1:meta:c1', 'igt:assistant:p2:meta:c2']
    assert 'value' not in c.user_data.list('u')[0]
    assert c.user_data.get('u', 'igt:assistant:p1:conv:c1')['value'] == {'of': 'igt:assistant:p1:conv:c1'}
    first = c.user_data.list_page('u', pattern='*:meta:*', limit=1)
    assert [r['key'] for r in first['entries']] == ['igt:assistant:p1:meta:c1']
    rest = c.user_data.list_page('u', pattern='*:meta:*', limit=1, cursor=first['next_cursor'])
    assert [r['key'] for r in rest['entries']] == ['igt:assistant:p2:meta:c2']
    assert rest['next_cursor'] is None
    with pytest.raises(PlaidAPIError):
        c.user_data.get('u', 'nope')


def test_a_resource_a_test_swapped_in_is_kept_on_a_batch():
    """Service suites replace ``documents`` or ``projects`` with their own
    stand-ins, and a batch keeps using theirs."""
    class Documents:
        def __init__(self, writer):
            self.writer = writer

    c = testing.FakeClient([{'id': 'd'}])
    c.documents = Documents(c)
    c.projects = object()
    with c.batched() as b:
        assert b.documents is c.documents and b.projects is c.projects
