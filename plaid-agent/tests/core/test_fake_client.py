"""The fake client knows the API and nothing about any app."""

import inspect

import pytest

from core.fake_client import BaseFakeClient
from plaid_client.http import PlaidAPIError


def _client(**kw):
    return BaseFakeClient({'id': 'p', 'name': 'P', 'text_layers': []}, {'d': {'id': 'd', 'name': 'D'}}, **kw)


def test_it_carries_no_project_of_its_own():
    """It used to be one app's client, with the other app's project passed in
    around defaults that stayed: a lexicon that app has no concept of, and an
    audit log naming a document its project did not contain. So there is no
    default to inherit: a caller says what the project is."""
    required = [p for p in inspect.signature(BaseFakeClient.__init__).parameters.values()
                if p.name != 'self' and p.default is inspect.Parameter.empty]
    assert [p.name for p in required] == ['project', 'documents']
    assert not hasattr(_client(), 'vocab_layers')
    assert _client().audit == []


def test_it_answers_the_resources_every_assistant_reads():
    c = _client(audit=[{'id': 'a', 'time': '2026-01-01T00:00:00Z', 'documents': [{'id': 'd', 'name': 'D'}]}])
    assert c.projects.get('p')['name'] == 'P'
    assert c.projects.list_documents('p') == [{'id': 'd', 'name': 'D', 'version': None, 'time_modified': None}]
    assert c.documents.get('d')['id'] == 'd'
    assert [e['id'] for e in c.documents.audit('d')] == ['a']
    assert c.documents.audit('nope') == []
    c.user_data.put('u', 'k', {'v': 1})
    assert c.user_data.get('u', 'k')['value'] == {'v': 1}
    assert [r['key'] for r in c.user_data.list('u')] == ['k']


def test_a_write_is_recorded_and_a_batch_answers_per_op():
    c = _client()
    b = c.batch()
    b.spans.create('L', ['t'], 'v')
    b.tokens.bulk_create([{'begin': 0}, {'begin': 1}])
    assert c.log == []  # queued, not sent
    out = b.submit()
    assert [e[:2] for e in c.batches[0]] == [('spans', 'create'), ('tokens', 'bulk_create')]
    assert [e[:2] for e in c.log] == [('spans', 'create'), ('tokens', 'bulk_create')]
    assert out[0]['body']['id'] == 'new-spans-0'
    assert out[1]['body']['ids'] == ['new-tokens-1-0', 'new-tokens-1-1']
    # A bulk update is recorded as the per-item writes it stands for.
    ops = [{'op': 'set', 'path': ['prov'], 'value': 'inferred'}]
    c.spans.bulk_update([{'id': 's1', 'value': 'x', 'metadata': ops}])
    assert c.calls('spans', 'update') == [('spans', 'update', ('s1', 'x'), {})]
    assert c.calls('spans', 'patch_metadata')[0][2] == ('s1', ops)
    # A metadata patch is a list of ops, as the server takes it.
    with pytest.raises(PlaidAPIError):
        c.spans.patch_metadata('s1', {'prov': 'inferred'})
    with pytest.raises(PlaidAPIError):
        c.spans.bulk_update([{'id': 's1', 'metadata': {'prov': 'inferred'}}])
    assert c.bulk_calls[0][0] == 'spans'
    with c.operation('a label'):
        pass
    assert c.operations == ['a label']


def test_a_write_on_the_client_is_never_touched_by_an_open_batch():
    c = _client()
    b = c.batch()
    b.spans.create('L', ['t'], 'queued')
    c.spans.create('L', ['t'], 'now')
    assert [e[2][2] for e in c.log] == ['now']
    b.submit()
    assert [e[2][2] for e in c.log] == ['now', 'queued']


def test_an_aborted_batch_sends_nothing():
    c = _client()
    with pytest.raises(RuntimeError):
        with c.batched() as b:
            b.spans.create('L', ['t'], 'v')
            raise RuntimeError('boom')
    assert c.log == [] and c.batches == []
    with c.batched() as b:
        b.spans.create('L', ['t'], 'v')
    assert len(c.batches) == 1 and b.results[0]['body']['id'] == 'new-spans-0'


def test_the_user_data_store_matches_the_real_client_surface():
    """A fake that lies about a signature teaches the first tool written
    against it to call the real client wrong. ``pattern``, the GLOB the
    assistant's keys are picked out by, and ``page_size`` were both missing,
    and so was ``list_page``."""
    from plaid_client.client import UserDataResource

    def params(fn):
        return {n: p.default for n, p in inspect.signature(fn).parameters.items()
                if n not in ('self', 'user_id')}

    assert params(BaseFakeClient._UserData.list) == params(UserDataResource.list)
    assert params(BaseFakeClient._UserData.list_page) == params(UserDataResource.list_page)


def test_the_user_data_store_reads_like_the_server_does():
    c = _client()
    for k in ['igt:assistant:p2:meta:c2', 'igt:assistant:p1:meta:c1', 'igt:assistant:p1:conv:c1']:
        c.user_data.put('u', k, {'of': k})
    # Ordered by key, whatever order they were written in.
    assert [r['key'] for r in c.user_data.list('u', prefix='igt:assistant:p1:')] == [
        'igt:assistant:p1:conv:c1', 'igt:assistant:p1:meta:c1']
    # A GLOB picks out a segment in the middle, which a prefix cannot say.
    assert [r['key'] for r in c.user_data.list('u', pattern='igt:assistant:*:meta:*')] == [
        'igt:assistant:p1:meta:c1', 'igt:assistant:p2:meta:c2']
    assert 'value' not in c.user_data.list('u')[0]
    assert c.user_data.list('u', prefix='igt:assistant:p1:conv:', include_values=True)[0]['value'] == {
        'of': 'igt:assistant:p1:conv:c1'}
    first = c.user_data.list_page('u', pattern='*:meta:*', limit=1)
    assert [r['key'] for r in first['entries']] == ['igt:assistant:p1:meta:c1']
    rest = c.user_data.list_page('u', pattern='*:meta:*', limit=1, cursor=first['next_cursor'])
    assert [r['key'] for r in rest['entries']] == ['igt:assistant:p2:meta:c2']
    assert rest['next_cursor'] is None


def test_a_missing_user_data_key_is_a_404_and_not_a_none():
    from plaid_client.http import PlaidAPIError
    c = _client()
    with pytest.raises(PlaidAPIError):
        c.user_data.get('u', 'nope')
