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
    assert c.documents.get('d', include_body=True, layers=[])['name'] == 'D'
    assert c.reads == [{'id': 'e', 'layers': None}, {'id': 'd', 'layers': []}]
    assert c.kinds == ['read', 'read'] and c.writes == []
    with pytest.raises(PlaidAPIError) as e:
        c.documents.get('nope')
    assert e.value.status == 404
    assert c.projects.get('p')['name'] == 'P'
    assert [d['id'] for d in c.projects.list_documents('p')] == ['d', 'e']
    assert [e['id'] for e in c.documents.audit('d')] == ['a']
    assert [e['id'] for e in c.projects.audit('p', start_time='2026-01-15')] == ['b']
    page = c.projects.audit_page('p', order='desc', limit=1)
    assert [e['id'] for e in page['entries']] == ['b'] and page['next_cursor']
    rest = c.projects.audit_page('p', order='desc', limit=1, cursor=page['next_cursor'])
    assert [e['id'] for e in rest['entries']] == ['a'] and rest['next_cursor'] is None
    assert c.audit_pages == [{'order': 'desc', 'start_time': None}] * 2


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


def test_only_a_write_the_real_client_has_is_recorded():
    # A typo, a method PlaidClient does not have, or a read nobody modelled is
    # an error, never a write that answers {}.
    c = _project_client()
    for resource, method in [('tokens', 'bulk_crate'), ('documents', 'get_many'),
                             ('tokens', 'get'), ('spans', 'list')]:
        with pytest.raises(AttributeError):
            getattr(getattr(c, resource), method)
    assert c.writes == []


def test_a_write_queued_on_a_batch_answers_as_the_real_batch_does():
    # A queued write has no id yet: the real PlaidBatch answers {'batched': True},
    # and the ids arrive in the results when it submits.
    c = _project_client()
    b = c.batch()
    assert b.spans.create('L', ['t'], 'v') == {'batched': True}
    assert b.tokens.bulk_create([{'begin': 0}]) == {'batched': True}
    assert b.tokens.update('t1', precedence=2) == {'batched': True}
    out = b.submit()
    assert out[0]['body']['id'] == 'spans-1'
    assert c.spans.create('L', ['t'], 'now') == {'id': 'spans-3'}


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
    with pytest.raises(PlaidAPIError):
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
    assert c.guidelines.list('p') == [{'id': 'g1', 'project': 'p', 'title': 'T', 'pinned': False,
                                       'created_at': 'then', 'updated_at': 'then',
                                       'body_chars': 3}]
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
    assert c.documents.restore('d', 'T') == {'total': 2}
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


# --- the fake refuses and answers as the real client does -----------------------
#
# Each of these was measured against the real PlaidClient on a dev core
# (docs/overnight-2026-09-26/PARITY.md, findings 4 to 10). A fake that is
# kinder than the real client lets a test pass on a call that fails for real.


def test_a_batch_refuses_what_the_real_batch_refuses():
    c = _project_client(guidelines=[])
    done = c.batch()
    done.submit()
    with pytest.raises(PlaidAPIError, match='already submitted or aborted'):
        done.spans.create('L', ['t'], 'v')
    with pytest.raises(PlaidAPIError, match='already submitted or aborted'):
        done.submit()
    dropped = c.batch()
    dropped.abort()
    for write in (lambda b: b.tokens.bulk_delete(['t']),
                  lambda b: b.documents.patch_metadata('d', []),
                  lambda b: b.comments.create('token', 't', 'x'),
                  lambda b: b.guidelines.create('p', 'T')):
        with pytest.raises(PlaidAPIError, match='already submitted or aborted'):
            write(dropped)
    with c.batched() as b:
        with pytest.raises(PlaidAPIError, match='not nestable'):
            b.batch()
        with pytest.raises(PlaidAPIError, match='not nestable'):
            b.batched()
        with pytest.raises(PlaidAPIError, match='cannot be used in a batch'):
            b.user_data.put('u', 'k', {'a': 1})
        with pytest.raises(PlaidAPIError, match='cannot be used in a batch'):
            b.user_data.delete('u', 'k')
        assert b.user_data.list('u') == []  # a read on a batch goes over the wire
    assert c.user_data.list('u') == [] and c.writes == [] and c.batches == []


def test_two_single_deletes_of_one_id_refuse_the_whole_batch():
    # plaid_delete_idempotence: the second 404s on the server, and the batch
    # rolls back with everything else in it.
    c = _project_client()
    with pytest.raises(PlaidAPIError) as e:
        with c.batched() as b:
            b.tokens.create('L', 'text', 0, 1)
            b.spans.delete('s1')
            b.spans.delete(span_id='s1')
    assert e.value.status == 404 and c.writes == [] and c.batches == []
    # A bulk delete of a gone id is accepted, and so is one single delete per id.
    with c.batched() as b:
        b.spans.delete('s1')
        b.tokens.delete('s1')
        b.spans.bulk_delete(['s1'])
        b.spans.bulk_delete(['s1'])
    assert len(c.writes) == 4


def test_comments_and_guidelines_written_on_a_batch_wait_for_it():
    c = _project_client(guidelines=[{'id': 'g1', 'title': 'T', 'body': 'abc', 'pinned': False,
                                     'updated_at': 'then'}])

    def titles():
        return [g['title'] for g in c.guidelines.list('p')]

    b = c.batch()
    assert b.comments.create('token', 't1', 'hm') == {'batched': True}
    assert b.guidelines.create('p', 'New', body='b') == {'batched': True}
    assert b.guidelines.update('g1', body='x') == {'batched': True}
    assert titles() == ['T'] and c.guidelines.get('g1')['body'] == 'abc'
    b.abort()
    assert titles() == ['T'] and c.guidelines.get('g1')['body'] == 'abc' and c.writes == []

    b = c.batch()
    b.guidelines.create('p', 'New', body='b')
    [created] = b.submit()
    assert titles() == ['T', 'New']
    assert c.guidelines.get(created['body']['id'])['body'] == 'b'

    # The server checks expected_updated_at when the batch runs, so a stale
    # one refuses the whole batch at submit.
    b = c.batch()
    b.guidelines.create('p', 'Other')
    b.guidelines.update('g1', body='y', expected_updated_at='earlier')
    with pytest.raises(PlaidAPIError) as e:
        b.submit()
    assert e.value.status == 409
    assert titles() == ['T', 'New'] and c.guidelines.get('g1')['body'] == 'abc'
    assert [k for k, _ in c.writes] == ['guidelines.create']


def _layered_document():
    return {'id': 'd', 'name': 'D', 'version': 3, 'text_layers': [{
        'id': 'TL', 'text': {'id': 'x', 'body': 'ab'},
        'token_layers': [
            {'id': 'KL', 'tokens': [{'id': 't'}], 'vocabs': [{'id': 'V'}],
             'span_layers': [
                 {'id': 'SL', 'spans': [{'id': 's'}],
                  'relation_layers': [{'id': 'RL', 'relations': [{'id': 'r'}]}]},
                 {'id': 'SL2', 'spans': [{'id': 's2'}], 'relation_layers': []}]},
            {'id': 'KL2', 'tokens': [{'id': 't2'}], 'vocabs': [], 'span_layers': []}]}]}


def test_a_document_read_carries_only_the_layers_it_named():
    import copy
    doc = _layered_document()
    c = testing.FakeClient({'d': doc})
    assert 'text_layers' not in c.documents.get('d')
    assert c.documents.get('d', include_body=True) == doc

    [tl] = c.documents.get('d', include_body=True, layers=['SL'])['text_layers']
    assert tl['text'] is None
    [kl] = tl['token_layers']
    assert kl['id'] == 'KL' and kl['tokens'] == [] and kl['vocabs'] == []
    [sl] = kl['span_layers']
    assert sl['id'] == 'SL' and sl['spans'] == [{'id': 's'}] and sl['relation_layers'] == []

    [tl] = c.documents.get('d', include_body=True, layers='TL,RL')['text_layers']
    assert tl['text'] == {'id': 'x', 'body': 'ab'}
    [kl] = tl['token_layers']
    assert kl['tokens'] == [] and [s['id'] for s in kl['span_layers']] == ['SL']
    assert kl['span_layers'][0]['spans'] == []
    assert kl['span_layers'][0]['relation_layers'] == [{'id': 'RL', 'relations': [{'id': 'r'}]}]

    with pytest.raises(PlaidAPIError) as e:
        c.documents.get('d', layers=['SL'])
    assert e.value.status == 400
    with pytest.raises(PlaidAPIError) as e:
        c.documents.get('d', include_body=True, layers=['nope'])
    assert e.value.status == 400
    with pytest.raises(TypeError):
        c.documents.get('d', True)
    assert doc == _layered_document() and copy.deepcopy(doc) == doc


def test_a_write_is_taken_only_as_the_real_client_takes_it():
    c = _project_client()
    ops = [{'op': 'set', 'path': ['k'], 'value': 1}]
    for bad in (lambda: c.tokens.create('L', 'text', 0, 1, 5),
                lambda: c.spans.update('s1'),
                lambda: c.tokens.update('t1', 3),
                lambda: c.documents.restore('d'),
                lambda: c.comments.create('token', 't1', 'hm', 'label'),
                lambda: c.guidelines.update('g1', 'title'),
                lambda: c.user_data.put('u', 'k')):
        with pytest.raises(TypeError):
            bad()
    assert c.writes == []
    c.tokens.bulk_create([{'begin': 0}], audit_message='m')
    c.tokens.bulk_update([{'id': 't', 'metadata': ops}], audit_message='m')
    c.tokens.bulk_delete(['t'], audit_message='m')
    c.tokens.patch_metadata('t', ops, audit_message='m')
    c.spans.patch_metadata(span_id='s', body=ops)
    assert c.patches('tokens') == [('t', ops), ('t', ops)] and c.patches('spans') == [('s', ops)]
    with pytest.raises(AttributeError):
        c.texts.bulk_update  # the real TextsResource has none


def test_a_read_nobody_modelled_is_never_recorded_as_a_write():
    c = _project_client()
    with pytest.raises(NotImplementedError):
        c.documents.check_lock('d')  # a GET the fake has no model of
    with pytest.raises(AttributeError):
        c.documents.get_media  # a read by its name
    assert c.calls == []


def test_a_signal_goes_straight_through_a_batch_and_an_upload_is_refused_on_one():
    c = _project_client()
    b = c.batch()
    b.documents.acquire_lock('d')
    assert c.kinds == ['documents.acquire_lock']
    with pytest.raises(PlaidAPIError, match='cannot be used in a batch'):
        b.documents.upload_media('d', ('a.wav', b'x', 'audio/wav'))
    b.abort()


def test_the_fake_methods_take_the_real_signatures():
    """Derived from the real classes, so a signature that changes there fails
    here rather than in a caller the fake let through."""
    import inspect
    from plaid_client import client as real

    def shape(fn):
        # The default too: a fake that defaults keep_alive or dry_run the
        # other way runs a caller's omitted argument as the client does not.
        return [(p.name, p.kind, p.default) for p in inspect.signature(fn).parameters.values()]

    pairs = [(testing.FakeClient._Documents, real.DocumentsResource),
             (testing.FakeClient._Projects, real.ProjectsResource),
             (testing.FakeClient._Comments, real.CommentsResource),
             (testing.FakeClient._Guidelines, real.GuidelinesResource),
             (testing.FakeClient._UserData, real.UserDataResource),
             (testing.FakeClient._Messages, real.MessagesResource),
             (testing._BatchUserData, real.UserDataResource),
             (testing._Operation, real._OperationContext)]
    for fake, real_cls in pairs:
        own = [n for n, v in vars(fake).items() if callable(v) and not n.startswith('_')]
        assert own, fake
        for name in own:
            assert hasattr(real_cls, name), f'{fake.__name__}.{name} is not on {real_cls.__name__}'
            assert shape(getattr(fake, name)) == shape(getattr(real_cls, name)), \
                f'{fake.__name__}.{name}'
    for name in ('batch', 'batched', 'operation'):
        assert shape(getattr(testing.FakeClient, name)) == shape(getattr(real.PlaidClient, name))
    for name in ('batch', 'batched', 'submit', 'abort'):
        assert shape(getattr(testing._Batch, name)) == shape(getattr(real.PlaidBatch, name))


def test_a_bulk_update_entry_is_refused_as_the_server_refuses_it():
    c = _project_client()
    ops = [{'op': 'set', 'path': ['k'], 'value': 1}]
    for resource, entry in [('tokens', {'id': 't', 'end': 9}),  # a 400 for real
                            ('tokens', {'id': 't', 'end': 9, 'metadata': ops}),  # end dropped
                            ('spans', {'id': 's', 'tokens': ['t']}),
                            ('relations', {'id': 'r', 'source': 's'}),
                            ('vocab_items', {'id': 'v', 'value': 'x'}),
                            ('spans', {'value': 'x'})]:
        with pytest.raises(PlaidAPIError) as e:
            getattr(c, resource).bulk_update([entry])
        assert e.value.status == 400, (resource, entry)
    c.tokens.bulk_update([{'id': 't', 'metadata': ops}])
    c.spans.bulk_update([{'id': 's', 'value': 'x'}])
    c.relations.bulk_update([{'id': 'r'}])
    c.vocab_items.bulk_update([{'id': 'v', 'form': 'f', 'metadata': ops}])
    assert len(c.writes) == 4


def test_the_user_data_store_answers_as_the_real_one_does():
    c = _project_client()
    put = c.user_data.put('u', 'k', {'snake_key': 1, 'kebab-key': 2, 'camelKey': 3, 'ns/k': 4,
                                     '0199-abcd': 5, 'metadata': {'a-b': 1}})
    assert put['key'] == 'k' and put['updated_at']
    got = c.user_data.get('u', 'k')
    # The client recases a value's keys on the way out and back, apart from
    # what sits under `metadata`.
    assert got['value'] == {'snake_key': 1, 'kebab_key': 2, 'camelKey': 3, 'k': 4,
                            '0199_abcd': 5, 'metadata': {'a-b': 1}}
    assert got['updated_at'] == put['updated_at']
    assert c.user_data.list('u') == [{'key': 'k', 'updated_at': put['updated_at']}]
    assert c.user_data.list_page('u')['entries'] == [{'key': 'k', 'updated_at': put['updated_at']}]
    c.user_data.delete('u', 'k')
    with pytest.raises(PlaidAPIError) as e:
        c.user_data.delete('u', 'k')
    assert e.value.status == 404
    with pytest.raises(TypeError):
        c.user_data.put('u', 'k', {'x': object()})  # not JSON


def test_the_smaller_shapes_match_the_real_client():
    summary = {'name': False, 'document_metadata': False, 'total': 0, 'skipped': []}
    c = _project_client(restore_summary=summary,
                        guidelines=[{'id': 'g1', 'title': 'T', 'body': '', 'pinned': False,
                                     'updated_at': 'then'}],
                        comments=[{'id': 'c1', 'entity_type': 'token', 'entity_id': 't1'},
                                  {'id': 'c2', 'entity_type': 'span', 'entity_id': 's1'}])
    # A restore answers with its summary, done or dry.
    assert c.documents.restore('d', 'T') == summary
    with c.operation('Merge') as op:
        op.set_message('Merged 3')
        with c.operation('inner') as inner:
            inner.set_message('ignored')  # only the outermost label is refined
    assert c.operation_labels == ['Merged 3', 'inner'] and op.id
    with c.documents.locked('d', keep_alive=False) as lock:
        assert lock.lost is None
        lock.raise_if_lost()
    assert c.kinds[-2:] == ['lock', 'unlock']
    assert 'time_created' in c.projects.list_documents('p')[0]
    [g] = c.guidelines.list('p')
    assert g['project'] == 'p' and g['created_at']
    updated = c.guidelines.update('g1', body='x')
    assert updated['body'] == 'x' and updated['id'] == 'g1'
    assert [r['id'] for r in c.comments.list('p', entity_type='span')] == ['c2']
    with pytest.raises(PlaidAPIError) as e:
        c.documents.get('nope')
    assert str(e.value).startswith('HTTP 404 ') and e.value.method == 'GET'
    assert e.value.url.endswith('/api/v1/documents/nope')


def test_an_empty_or_repeating_bulk_write_is_refused_as_the_server_refuses_it():
    # Measured on a dev core (REV-FAKE, 2026-09-27): every bulk create and
    # bulk update of an empty list is a 400, and so is a bulk update naming
    # one id twice. A bulk delete of an empty list is accepted.
    c = _project_client()
    ops = [{'op': 'set', 'path': ['k'], 'value': 1}]
    for resource in ('tokens', 'spans', 'relations', 'vocab_links', 'vocab_items'):
        with pytest.raises(PlaidAPIError) as e:
            getattr(c, resource).bulk_create([])
        assert e.value.status == 400, resource
        getattr(c, resource).bulk_delete([])
    for resource in ('tokens', 'spans', 'relations', 'vocab_items'):
        with pytest.raises(PlaidAPIError) as e:
            getattr(c, resource).bulk_update([])
        assert e.value.status == 400, resource
    with pytest.raises(PlaidAPIError) as e:
        c.tokens.bulk_update([{'id': 't', 'metadata': ops}, {'id': 't', 'metadata': ops}])
    assert e.value.status == 400
    assert [k for k, _ in c.writes] == ['tokens.bulk_delete', 'spans.bulk_delete',
                                        'relations.bulk_delete', 'vocab_links.bulk_delete',
                                        'vocab_items.bulk_delete']


def test_a_single_delete_of_an_id_bulk_deleted_earlier_in_the_batch_refuses_it():
    # Measured on a dev core: the single delete finds the row gone and 404s
    # the batch. The other order is fine, a bulk delete of a gone id is not.
    c = _project_client()
    with pytest.raises(PlaidAPIError) as e:
        with c.batched() as b:
            b.spans.bulk_delete(['s1', 's2'])
            b.spans.delete('s2')
    assert e.value.status == 404 and c.writes == []
    with c.batched() as b:
        b.spans.delete('s2')
        b.spans.bulk_delete(['s1', 's2'])
    assert len(c.writes) == 2


def test_a_metadata_write_answers_the_entity_as_the_real_one_does():
    """The real client answers a metadata write with the entity, recased,
    alone or as a batch result's body. The fake answers the fixture's entity
    with the metadata the write leaves."""
    c = testing.FakeClient({'d': {'id': 'd', 'text_layers': [{'id': 'tl', 'token_layers': [
        {'id': 'kl', 'tokens': [{'id': 't1', 'begin': 0, 'end': 2,
                                 'metadata': {'a': 1, 'b': 2}}]}]}]}})
    assert c.tokens.patch_metadata('t1', [{'op': 'set', 'path': ['c'], 'value': 3}]) == {
        'id': 't1', 'begin': 0, 'end': 2, 'metadata': {'a': 1, 'b': 2, 'c': 3}}
    assert c.tokens.set_metadata('t1', {'z': 1}) == {
        'id': 't1', 'begin': 0, 'end': 2, 'metadata': {'z': 1}}
    assert c.tokens.delete_metadata('t1') == {'id': 't1', 'begin': 0, 'end': 2, 'metadata': {}}
    # An entity the fixture does not hold still answers its id and metadata.
    assert c.spans.set_metadata('s9', {'k': 'v'}) == {'id': 's9', 'metadata': {'k': 'v'}}
    with c.batched() as b:
        assert b.tokens.patch_metadata('t1', [{'op': 'delete', 'path': ['a']}]) == {'batched': True}
    assert b.results == [{'body': {'id': 't1', 'begin': 0, 'end': 2, 'metadata': {'b': 2}}}]
    # What was recorded is unchanged: the fixture is never written.
    assert c.patches('tokens')[0] == ('t1', [{'op': 'set', 'path': ['c'], 'value': 3}])
    assert c.document('d')['text_layers'][0]['token_layers'][0]['tokens'][0]['metadata'] == \
        {'a': 1, 'b': 2}


def test_a_copy_and_a_split_answer_the_new_id_as_the_real_ones_do():
    c = _project_client()
    copied = c.documents.copy('d', 'D copy')
    split = c.tokens.split('t1', 2)
    assert set(copied) == {'id'} and set(split) == {'id'}
    assert copied['id'] != split['id']
    with c.batched() as b:
        b.tokens.split('t1', 1)
    assert set(b.results[0]['body']) == {'id'}


def test_the_operation_handle_is_the_real_one_and_the_label_is_read_off_the_client():
    c = _project_client()
    with c.operation('Merge') as op:
        op.set_message('Merged 3')
        with c.operation('inner') as inner:
            inner.set_message('ignored')
    assert not hasattr(op, 'message')
    assert c.operations == ['Merge', 'inner']
    assert c.operation_labels == ['Merged 3', 'inner']


def test_an_audit_entry_and_each_of_its_ops_carry_the_time_to_read_at():
    """The server sends ``end_time`` on an entry and on each op: an op's own
    time, or its batch's last op when it ran in one. A fixture that leaves
    them out reads as the server would send it, and a given one is kept."""
    c = _project_client(audit=[
        {'id': 'a', 'time': 'T1', 'documents': [{'id': 'd'}],
         'ops': [{'type': 'span/create', 'time': 'T1', 'batch_id': 'b'},
                 {'type': 'span/create', 'time': 'T2', 'batch_id': 'b'},
                 {'type': 'span/update', 'time': 'T3'}]},
        {'id': 'z', 'time': 'T4', 'end_time': 'T9', 'documents': [{'id': 'd'}],
         'ops': [{'type': 'span/delete'}]},
    ])
    first, second = c.documents.audit('d')
    assert [o['end_time'] for o in first['ops']] == ['T2', 'T2', 'T3']
    assert first['end_time'] == 'T3'
    assert second['end_time'] == 'T9' and second['ops'][0]['end_time'] == 'T9'
    assert [e['end_time'] for e in c.projects.audit('p')] == ['T3', 'T9']
    assert 'end_time' not in c.audit[0]  # the fixture itself is not changed


def test_an_op_types_read_ends_each_entry_at_the_last_op_it_kept():
    """The server's entry end_time is its last member's, and a filter drops
    members, so a filtered entry ends where its last kept op does."""
    c = _project_client(audit=[
        {'id': 'a', 'time': 'T1', 'documents': [{'id': 'd'}],
         'ops': [{'type': 'span/create', 'time': 'T1'},
                 {'type': 'span/delete', 'time': 'T2'}]}])
    [entry] = c.documents.audit('d', op_types=['span/create'])
    assert [o['type'] for o in entry['ops']] == ['span/create']
    assert entry['end_time'] == 'T1'
    assert c.documents.audit('d')[0]['end_time'] == 'T2'


def _two_projects(**kw):
    other = {'project': {'id': 'q', 'name': 'Q', 'text_layers': [{'id': 'qtl'}]},
             'documents': {'qd': {'id': 'qd', 'name': 'QD', 'text_layers': [{'id': 'qtl'}]}},
             'guidelines': [{'id': 'qg', 'title': 'Theirs', 'body': 'x', 'pinned': False}],
             'comments': [{'id': 'qc', 'body': 'hi'}],
             'audit': [{'id': 'qa', 'time': 'T5', 'documents': [{'id': 'qd'}]}]}
    return _project_client(
        audit=[{'id': 'a', 'time': 'T1', 'documents': [{'id': 'd'}]}],
        guidelines=[{'id': 'g', 'title': 'Ours', 'body': '', 'pinned': False}],
        comments=[{'id': 'c', 'body': 'ours'}],
        projects={'q': other},
        services={'q': [{'service_id': 's', 'online': True}]}, **kw)


def test_a_fake_given_other_projects_answers_each_read_for_the_project_it_names():
    c = _two_projects()
    assert c.projects.get('p')['name'] == 'P' and c.projects.get('q')['name'] == 'Q'
    assert [p['id'] for p in c.projects.list()] == ['p', 'q']
    assert [d['id'] for d in c.projects.list_documents('q')] == ['qd']
    assert [d['id'] for d in c.projects.list_documents('p')] == ['d', 'e']
    assert [e['id'] for e in c.projects.audit('q')] == ['qa']
    assert [e['id'] for e in c.projects.audit('p')] == ['a']
    assert [g['title'] for g in c.guidelines.list('q')] == ['Theirs']
    assert [g['title'] for g in c.guidelines.list('p')] == ['Ours']
    assert c.guidelines.get('qg')['title'] == 'Theirs'
    assert [r['id'] for r in c.comments.list('q')] == ['qc']
    # A document is read from whichever project holds it, its layers too.
    assert c.documents.get('qd')['name'] == 'QD'
    assert c.documents.get('qd', include_body=True, layers=['qtl'])['id'] == 'qd'
    assert [e['id'] for e in c.documents.audit('qd')] == ['qa']
    assert c.documents.get('d')['name'] == 'D'
    assert c.messages.discover_services('q') == [{'service_id': 's', 'online': True}]
    assert c.messages.discover_services('p') == []


def test_a_project_the_fake_does_not_know_is_a_403_once_it_knows_several():
    c = _two_projects()
    for read in (lambda: c.projects.get('x'), lambda: c.projects.list_documents('x'),
                 lambda: c.projects.audit('x'), lambda: c.guidelines.list('x'),
                 lambda: c.comments.list('x'), lambda: c.messages.discover_services('x')):
        with pytest.raises(PlaidAPIError) as e:
            read()
        assert e.value.status == 403
    # Knowing one project, every id is that one, as before.
    single = _project_client()
    assert single.projects.get('x')['id'] == 'p'
    assert single.messages.discover_services('x') == []


def test_a_guideline_write_lands_in_the_project_it_names_and_a_refused_batch_undoes_it():
    c = _two_projects()
    c.guidelines.create('q', 'New')
    assert [g['title'] for g in c.guidelines.list('q')] == ['Theirs', 'New']
    assert [g['title'] for g in c.guidelines.list('p')] == ['Ours']
    c.guidelines.delete('qg')
    assert [g['title'] for g in c.guidelines.list('q')] == ['New']
    with pytest.raises(PlaidAPIError):
        with c.batched() as b:
            b.guidelines.create('q', 'Rolled back')
            b.guidelines.update('g', title='X', expected_updated_at='stale')
    assert [g['title'] for g in c.guidelines.list('q')] == ['New']
    assert [g['title'] for g in c.guidelines.list('p')] == ['Ours']


def test_a_refused_batch_says_it_saved_nothing_as_the_real_one_does():
    # The real client's batch error carries what a split batch saved before
    # it failed. The fake never splits, so a refusal saved nothing.
    c = _project_client(guidelines=[{'id': 'g1', 'title': 'T', 'body': 'abc',
                                     'pinned': False, 'updated_at': 'then'}])
    with pytest.raises(PlaidAPIError) as e:
        with c.batched() as b:
            b.spans.delete('s1')
            b.spans.delete('s1')
    assert (e.value.committed, e.value.committed_results) == (0, [])
    with pytest.raises(PlaidAPIError) as e:
        with c.batched() as b:
            b.guidelines.update('g1', title='X', expected_updated_at='stale')
    assert (e.value.committed, e.value.committed_results) == (0, [])
