"""The conversation record: pruning, the sidebar entry, plan outcomes, and
who may write a record while a request is under way."""

from fixtures import FakeClient

from plaid_agent.core.conversation import (
    CONVERSATION_BUDGET, DROPPED, ConversationStore, MissingConversation, assistant_item, build_meta,
    conv_key, conversation_bytes, error_item, find_plan, meta_key, prune, settle_plan, title_from, user_item,
)


def _conv(*items, messages=None):
    return {'messages': messages or [], 'display': list(items)}


def test_prune_drops_the_oldest_tool_results_first():
    big = 'x' * 300_000
    conv = _conv(user_item('q'), messages=[
        {'role': 'user', 'content': 'q'},
        {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'c1', 'type': 'function',
                                                                'function': {'name': 'search', 'arguments': '{}'}}]},
        {'role': 'tool', 'tool_call_id': 'c1', 'content': big},
        {'role': 'tool', 'tool_call_id': 'c2', 'content': big},
        {'role': 'tool', 'tool_call_id': 'c3', 'content': big},
        {'role': 'assistant', 'content': 'answer'},
    ])
    assert conversation_bytes(conv) > CONVERSATION_BUDGET
    out = prune(conv)
    assert conversation_bytes(out) <= CONVERSATION_BUDGET
    contents = [m.get('content') for m in out['messages'] if m['role'] == 'tool']
    assert contents[0] == DROPPED, 'the oldest result goes first'
    assert contents[-1] == big, 'the newest survives when dropping one is enough'
    assert out['messages'][-1]['content'] == 'answer'
    assert out['display'] == conv['display']
    # Within budget: untouched, same object.
    small = _conv(user_item('q'), messages=[{'role': 'tool', 'tool_call_id': 'c', 'content': 'ok'}])
    assert prune(small) is small


def test_prune_never_counts_an_already_dropped_result_twice():
    big = 'x' * 800_000
    conv = _conv(messages=[{'role': 'tool', 'tool_call_id': 'c0', 'content': DROPPED},
                           {'role': 'tool', 'tool_call_id': 'c1', 'content': big}])
    out = prune(conv)
    assert [m['content'] for m in out['messages']] == [DROPPED, DROPPED]


def test_title_and_meta():
    assert title_from('  what   is\nthis ') == 'what is this'
    assert len(title_from('w' * 100)) == 60 and title_from('w' * 100).endswith('…')
    conv = _conv(user_item('First question here'), assistant_item('a', None, [], [], '', 'm'),
                 user_item('Second'))
    meta = build_meta(None, 'c1', conv, 'igt:assist:m', 'm', pending={'kind': 'turn', 'request_id': 'r1'})
    assert meta['id'] == 'c1' and meta['title'] == 'First question here'
    assert meta['turns'] == 2 and meta['pending'] == {'kind': 'turn', 'request_id': 'r1'}
    assert meta['service_id'] == 'igt:assist:m' and meta['model'] == 'm'
    assert meta['created_at'] and meta['updated_at']
    # A later write keeps the title and creation time, clears pending by default.
    later = build_meta(meta, 'c1', conv, None, None)
    assert later['title'] == meta['title'] and later['created_at'] == meta['created_at']
    assert later['pending'] is None and later['service_id'] == 'igt:assist:m'
    # A browser-made entry (camelCase on its side) reads the same once recased.
    assert build_meta({'title': 'Kept'}, 'c1', conv, 's', 'm')['title'] == 'Kept'


def test_items_and_plan_settlement():
    plan = {'id': 'p1', 'summary': '1 field value', 'ops': [], 'labels': [], 'documents': []}
    conv = _conv(user_item('fix it'), assistant_item('Here is a plan.', plan, [], [], '', 'm'),
                 messages=[{'role': 'user', 'content': 'fix it'}, {'role': 'assistant', 'content': 'Here is a plan.'}])
    assert find_plan(conv, 'p1')[0] == 1
    assert find_plan(conv, 'nope') == (-1, None)
    out = settle_plan(conv, 1, 'applied', '(note) applied', as_human=True)
    assert out['display'][1]['status'] == 'applied' and out['display'][1]['as_human'] is True
    assert out['display'][0] == conv['display'][0]
    assert out['messages'][-1] == {'role': 'user', 'content': '(note) applied'}
    assert conv['display'][1]['status'] is None, 'the input is not mutated'
    assert error_item('Stopped.', stopped=True) == {'kind': 'error', 'text': 'Stopped.', 'stopped': True}
    assert error_item('x') == {'kind': 'error', 'text': 'x'}


def test_store_round_trip_and_ownership():
    c = FakeClient()
    store = ConversationStore(c, 'u@x', 'p1', 'igt')
    try:
        store.load('c1')
    except MissingConversation:
        pass
    else:
        raise AssertionError('a missing record must raise')
    conv = _conv(user_item('hi'), messages=[{'role': 'user', 'content': 'hi'}])
    meta = build_meta(None, 'c1', conv, 's', 'm', pending={'kind': 'turn', 'request_id': 'r1'})
    store.save('c1', conv, meta)
    got_conv, got_meta = store.load('c1')
    assert got_conv == conv and got_meta == meta
    assert set(c.user_data.store) == {('u@x', conv_key('igt', 'p1', 'c1')), ('u@x', meta_key('igt', 'p1', 'c1'))}
    # Ownership: the pending marker names the request that may write.
    assert store.owned_by('c1', 'r1')
    assert not store.owned_by('c1', 'r2'), 'another request has taken the conversation'
    assert store.owned_by('c1', None), 'a caller without a request id (a script) may write'
    store.save('c1', conv, build_meta(meta, 'c1', conv, 's', 'm'))
    assert store.owned_by('c1', 'r2'), 'nothing pending: anyone may write'
    c.user_data.delete('u@x', meta_key('igt', 'p1', 'c1'))
    assert not store.owned_by('c1', 'r1'), 'a deleted conversation is not resurrected'
