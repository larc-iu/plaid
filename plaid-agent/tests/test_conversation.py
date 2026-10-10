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


def test_a_record_is_measured_the_way_the_server_measures_it():
    """The store counts clojure.data.json's output, which escapes every
    non-ASCII character as \\uXXXX. Counted as UTF-8 a Cyrillic conversation
    weighed a third of what the server saw: it sat under its budget, prune
    never fired, and the save came back 413."""
    cyrillic = 'предложение' * 20_000   # 2 bytes per character as UTF-8, 6 escaped
    conv = _conv(messages=[{'role': 'tool', 'tool_call_id': 'c1', 'content': cyrillic}])
    n = conversation_bytes(conv)
    assert n > len(cyrillic.encode('utf-8')) * 2.5, 'escaped, not UTF-8'
    assert n > CONVERSATION_BUDGET
    out = prune(conv)
    assert out['messages'][0]['content'] == DROPPED
    # A slash costs two bytes there and one here, so it is counted as two.
    assert conversation_bytes(_conv(messages=['a/b'])) == conversation_bytes(_conv(messages=['a\\b']))


def test_the_record_budget_is_the_cap_the_server_publishes():
    from plaid_agent.core.conversation import record_budget

    class Server:
        def __init__(self, limits):
            self._limits = limits

        def limits(self):
            return self._limits

    class C:
        def __init__(self, limits):
            self.server = Server(limits)

    # Less the browser's room: it adds the next message to the record as the
    # service left it, and a record filled to the cap refused that message.
    assert record_budget(C({'user_data_value_bytes': 1_000_000})) == 900_000
    # Not reported, reported as nonsense, or no /info at all: the fallback.
    assert record_budget(C({})) == CONVERSATION_BUDGET
    assert record_budget(C({'user_data_value_bytes': 'lots'})) == CONVERSATION_BUDGET
    assert record_budget(FakeClient()) == CONVERSATION_BUDGET


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


def test_the_document_a_docked_conversation_is_about_survives_a_write():
    """The app writes `about` once, when it opens the conversation, and the
    service rewrites the whole record on every settle. Dropping it meant the
    panel forgot its document the moment the first reply landed, and opening
    the panel on that document again started a new thread instead of resuming."""
    conv = {'display': [{'kind': 'user', 'text': 'Which words have no lemma?'}]}
    about = {'documentId': 'd1', 'documentName': 'Viaje'}
    meta = build_meta({'about': about}, 'c1', conv, 's', 'm')
    assert meta['about'] == about
    assert build_meta(meta, 'c1', conv, None, None)['about'] == about
    assert build_meta(None, 'c1', conv, 's', 'm')['about'] is None


def test_items_and_plan_settlement():
    plan = {'id': 'p1', 'summary': '1 field value', 'ops': [], 'labels': [], 'documents': [], 'proposed': []}
    conv = _conv(user_item('fix it'), assistant_item('Here is a plan.', plan, [], [], '', 'm'),
                 messages=[{'role': 'user', 'content': 'fix it'}, {'role': 'assistant', 'content': 'Here is a plan.'}])
    assert find_plan(conv, 'p1')[0] == 1
    assert find_plan(conv, 'nope') == (-1, None)
    out = settle_plan(conv, 1, 'applied', '(note) applied', as_human=True)
    assert out['display'][1]['status'] == 'applied' and out['display'][1]['as_human'] is True
    assert out['display'][0] == conv['display'][0]
    assert out['messages'][-1] == {'role': 'user', 'content': '(note) applied'}
    assert conv['display'][1]['status'] is None, 'the input is not mutated'
    assert out['display'][1]['plan'] == {'id': 'p1', 'summary': '1 field value', 'labels': [], 'op_count': 0,
                                         'proposed': []}, \
        'a settled plan keeps its card and drops what only approving it needed'
    undated = lambda item: {k: v for k, v in item.items() if k != 'created_at'}  # noqa: E731
    assert undated(error_item('Stopped.', stopped=True)) == {'kind': 'error', 'text': 'Stopped.', 'stopped': True}
    assert undated(error_item('x')) == {'kind': 'error', 'text': 'x'}
    assert error_item('x')['created_at'].endswith('Z')


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


def test_prune_can_actually_reach_its_budget():
    """It measured `display` and pruned only `messages`, so a conversation
    whose weight was in the display came back still over budget with every
    tool result destroyed for nothing, and the save was then refused."""
    from plaid_agent.core.conversation import CONVERSATION_BUDGET, conversation_bytes, prune

    heavy = 'x' * 200_000
    conv = {
        'messages': [{'role': 'tool', 'tool_call_id': 't1', 'content': 'y' * 50_000}],
        'display': [
            {'kind': 'user', 'text': 'first'},
            {'kind': 'assistant', 'text': 'a', 'plan': None,
             'citations': [{'text': heavy}], 'steps': [{'out': heavy}],
             'status': None, 'model': 'm', 'steps_summary': 's'},
            {'kind': 'assistant', 'text': 'b', 'plan': None,
             'citations': [{'text': heavy}], 'steps': [{'out': heavy}],
             'status': None, 'model': 'm', 'steps_summary': 's'},
            {'kind': 'assistant', 'text': 'newest', 'plan': None,
             'citations': [{'text': 'small'}], 'steps': [], 'status': None,
             'model': 'm', 'steps_summary': 's'},
        ],
    }
    assert conversation_bytes(conv) > CONVERSATION_BUDGET
    out = prune(conv, CONVERSATION_BUDGET)
    assert conversation_bytes(out) <= CONVERSATION_BUDGET, 'still over budget'
    # The newest reply keeps its evidence, and no plan was touched.
    assert out['display'][-1]['citations'] == [{'text': 'small'}]
    assert all(i.get('plan') is None for i in out['display'] if i['kind'] == 'assistant')


def test_prune_leaves_a_record_that_already_fits_alone():
    from plaid_agent.core.conversation import prune

    conv = {'messages': [{'role': 'tool', 'tool_call_id': 't', 'content': 'small'}],
            'display': [{'kind': 'user', 'text': 'hi'}]}
    assert prune(conv) == conv


def test_every_settled_plan_is_compacted_and_an_undecided_one_never_is():
    """Eline's 1MB thread was 618KB of plans, most of them already applied or
    discarded, and prune never touched a plan. The card is drawn from
    `changes` and `labels`, so dropping `ops` and `documents` changes nothing
    on screen."""
    ops = [{'kind': 'set_span', 'value': 'x' * 1000}] * 50
    docs = [{'id': 'd1', 'name': 'Text', 'version': 3}]

    def item(status, pid):
        return {**assistant_item('a', {'id': pid, 'summary': '50 field values', 'ops': ops,
                                       'labels': ['l'] * 50, 'changes': [{'label': 'l'}] * 50,
                                       'documents': docs, 'proposed': [['set_span', 't', 'x']] * 50},
                                 [], [], '', 'm'), 'status': status}

    conv = _conv(item('applied', 'p1'), item('discarded', 'p2'), item('stale', 'p3'), item(None, 'p4'))
    out = prune(conv, 10_000_000)
    for d in out['display'][:3]:
        assert 'ops' not in d['plan'] and 'documents' not in d['plan']
        assert d['plan']['op_count'] == 50 and len(d['plan']['changes']) == 50
        assert len(d['plan']['proposed']) == 50, 'what it proposed stays'
    assert out['display'][3]['plan']['ops'] == ops, 'an undecided plan can still be approved'
    assert out['display'][3]['plan']['documents'] == docs


def test_the_transcript_is_held_to_the_models_share_even_when_the_record_fits():
    """The record's limit is 5MB by default, far past any model's window, so the record
    fitting says nothing about whether the next turn can be sent. Old tool
    results go until the transcript fits its token budget, oldest first."""
    words = lambda v: len(str(v).split())  # a stand-in tokenizer: one token a word
    result = ' '.join(['w'] * 1000)
    conv = _conv(user_item('q'), messages=[
        {'role': 'user', 'content': 'q'},
        {'role': 'tool', 'tool_call_id': 'a', 'content': result},
        {'role': 'tool', 'tool_call_id': 'b', 'content': result},
        {'role': 'tool', 'tool_call_id': 'c', 'content': result},
        {'role': 'assistant', 'content': 'answer'},
    ])
    out = prune(conv, 10_000_000, (2500, words))
    contents = [m['content'] for m in out['messages'] if m['role'] == 'tool']
    assert contents == [DROPPED, result, result], 'one dropped result is enough, and it is the oldest'
    assert sum(words(m) for m in out['messages']) <= 2500
    # Within both budgets: untouched.
    assert prune(conv, 10_000_000, (10_000, words)) is conv


def test_a_model_of_unknown_window_keeps_the_old_byte_bound_on_its_transcript():
    """Without a window there is no token budget, and the transcript is held
    to CONVERSATION_BUDGET bytes, what the 1MB record limit used to give it."""
    big = 'x' * (CONVERSATION_BUDGET // 2)
    conv = _conv(messages=[{'role': 'tool', 'tool_call_id': str(i), 'content': big} for i in range(3)])
    out = prune(conv, 10_000_000)
    assert conversation_bytes(out) <= CONVERSATION_BUDGET
    assert out['messages'][-1]['content'] == big


def test_a_new_plan_replaces_every_plan_still_waiting_and_no_other():
    """Luke's ruling (2026-10-05). Eline's thread had two approvable cards over
    overlapping changes after the model restaged its plan without Q. A settled
    plan keeps its outcome, and an interrupted approval is left alone, since
    its changes may have been written."""
    from plaid_agent.core.conversation import replace_undecided

    def item(pid, status=None, **extra):
        return {**assistant_item('a', {'id': pid, 'summary': '1 field value', 'ops': [{'kind': 'x'}],
                                       'labels': ['l'], 'changes': [{'label': 'l'}], 'documents': [],
                                       'proposed': [['x', 't', None]]},
                                 [], [], '', 'm'), 'status': status, **extra}

    display = [user_item('q'), item('waiting'), item('applied', 'applied'),
               item('lost', None, interrupted=True), assistant_item('no plan', None, [], [], '', 'm')]
    out = replace_undecided(display)
    assert out[1]['status'] == 'replaced' and out[1]['settled_at']
    assert 'ops' not in out[1]['plan'] and out[1]['plan']['op_count'] == 1
    assert out[2]['status'] == 'applied'
    assert out[3]['status'] is None and out[3]['plan']['ops'], 'an interrupted approval may have landed'
    assert out[0] == display[0] and out[4] == display[4]
