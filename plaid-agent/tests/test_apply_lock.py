"""An approved plan holds the lock on every document it writes, for the whole apply.

A plan is applied in several requests, because a later batch needs the ids an
earlier one minted. A UMR node is written as its anchor token, then its concept
span, then its edges. Whoever opened the document in between used to find a
fresh anchor with no concept on it, which the editor's repair on open takes for
what an interrupted add left: it deleted the anchor, and the plan's next batch
failed on a token that was gone ("applied N of M"). Now the approval takes the
document lock before its staleness check and releases it after the last
write, so another user's repair is refused (423) until the plan is done. The
same holds in IGT and UD, whose executors also write in more than one request.

The fake server here keeps the lock table the way core does (per user, a
writer other than the holder refused), and the "open" runs between the first
and the second batch.
"""

import pytest

from plaid_client import PlaidAPIError, created_ids

import test_stale_by_sentence as sbs
from umr_fixtures import SENTENCE_1_PENMAN

from plaid_agent.core import plan as core_plan

APPS = sbs.APPS


def _lock_state(client, document_id):
    """Whether the requester holds the document's lock at this point of the
    call log: the fake records every acquire and release in order."""
    held = False
    for kind, payload in client.calls:
        if kind == 'lock' and payload == document_id:
            held = True
        elif kind == 'unlock' and payload == document_id:
            held = False
    return held


def _bracket(client, document_id):
    """(first lock, last unlock) positions in the call log."""
    kinds = client.calls
    lock = next(i for i, (k, p) in enumerate(kinds) if k == 'lock' and p == document_id)
    unlock = max(i for i, (k, p) in enumerate(kinds) if k == 'unlock' and p == document_id)
    return lock, unlock


@pytest.fixture(params=sorted(APPS))
def spec(request):
    return APPS[request.param]()


def test_every_write_of_an_approved_plan_is_made_under_the_document_lock(spec):
    client = spec['client']()
    plan, _ = sbs._plan(spec, client)
    helper = sbs._approve(spec, client, plan)
    assert helper.done and helper.done[-1]['kind'] == 'applied', helper.errors
    lock, unlock = _bracket(client, spec['did'])
    writes = [i for i, (k, _) in enumerate(client.calls)
              if k not in ('lock', 'unlock', 'read', 'operation') and not k.startswith('user_data')]
    assert writes, 'the plan wrote something'
    assert all(lock < i < unlock for i in writes), client.kinds


def test_the_staleness_check_reads_under_the_lock(spec, monkeypatch):
    """The check and the writes see one state of the document: a person's
    edit cannot land between the check passing and the first batch."""
    client = spec['client']()
    plan, _ = sbs._plan(spec, client)
    seen = []
    from plaid_agent.core import service as core_service
    real = core_service.stale_documents

    def watch(c, documents, **kw):
        seen.append(_lock_state(client, spec['did']))
        return real(c, documents, **kw)

    monkeypatch.setattr(core_service, 'stale_documents', watch)
    sbs._approve(spec, client, plan)
    assert seen == [True]


def test_a_document_another_user_holds_refuses_the_plan_with_nothing_written(spec):
    client = spec['client']()
    plan, _ = sbs._plan(spec, client)
    before = len(client.calls)

    def refuse(document_id, **kw):
        raise PlaidAPIError(f'Document {document_id} is locked by second@x.com', status=423)

    client.documents.locked = refuse
    helper = sbs._approve(spec, client, plan)
    assert not helper.done
    assert helper.errors and helper.errors[-1].startswith('Nothing was written.'), helper.errors
    assert 'is locked by another run' in helper.errors[-1]
    assert '@' not in helper.errors[-1], 'the holder is not named by their address'
    new = [k for k, _ in client.calls[before:] if not k.startswith('user_data')]
    assert not [k for k in new if k not in ('read', 'operation')], new
    # The card is decidable again: approving later is the way on.
    from plaid_agent.core.conversation import ConversationStore
    _, meta = ConversationStore(client, 'u@x', spec['pid'], spec['app']).load('c1')
    assert not (meta or {}).get('pending')


def test_documents_to_lock_leaves_out_a_document_another_service_rewrites():
    """UD's parser runs under a lock of its own, as another service, so the
    plan must not hold the document it parses. A plan never writes and parses
    the same document."""
    from plaid_agent.ud.plan import REWRITES_DOCUMENT
    ops = [{'kind': 'set_span', 'document_id': 'd1'},
           {'kind': 'run_parse', 'document_ids': ['d2'], 'project_id': 'p'}]
    pins = [{'id': 'd1'}, {'id': 'd2'}]
    assert core_plan.documents_to_lock(ops, pins, exclude=REWRITES_DOCUMENT) == ['d1']
    assert core_plan.documents_to_lock(ops, pins) == ['d1', 'd2']


def test_a_ud_plan_that_parses_a_document_does_not_lock_it():
    from plaid_agent.ud.service import AssistantService
    ops = [{'kind': 'run_parse', 'document_ids': ['d2'], 'project_id': 'p'}]
    assert AssistantService().documents_to_lock(ops, [{'id': 'd2'}]) == []


# --- the open between two batches -----------------------------------------------

def _umr_node_plan(client):
    """A new node under sentence 1's root: its anchor, its concept and its
    edge, three requests."""
    spec = APPS['umr']()
    text = SENTENCE_1_PENMAN.replace(':aspect performance)', ':ARG1 (s1c / cat)\n    :aspect performance)')
    plan, _ = sbs._plan(spec, client, ('apply_penman', {'document': 'Story', 'sentence': 1, 'text': text}))
    kinds = [op['kind'] for op in plan['ops']]
    assert 'create_node' in kinds, kinds
    return spec, plan


def _open_between_batches(monkeypatch, client, document_id, second_user):
    """Run a second user's repair on open after the plan's first batch: it
    deletes each anchor token the batch made (no concept on it yet), unless
    the server refuses it because the requester holds the document."""
    real_flush = core_plan.TrackingBatcher.flush
    state = {'flushes': 0, 'deleted': [], 'refused': 0}

    def flush(self):
        before = len(self.results)
        real_flush(self)
        state['flushes'] += 1
        if state['flushes'] != 1:
            return
        made = [t for r in self.results[before:] for t in (created_ids(r) or [])]
        strays = [t for t in made if t.startswith('tokens-')]
        if _lock_state(client, document_id):
            state['refused'] += 1          # 423: the lock is someone else's
            return
        state['deleted'].extend(strays)
        client.calls.append((f'{second_user}:tokens.delete', strays))

    monkeypatch.setattr(core_plan.TrackingBatcher, 'flush', flush)
    return state


def test_an_open_between_the_batches_leaves_the_plans_new_node_alone(monkeypatch):
    spec = APPS['umr']()
    client = spec['client']()
    spec, plan = _umr_node_plan(client)
    state = _open_between_batches(monkeypatch, client, spec['did'], 'second@x.com')
    helper = sbs._approve(spec, client, plan)
    assert helper.done and helper.done[-1]['kind'] == 'applied', helper.errors
    assert state['refused'] == 1 and state['deleted'] == []
    # The concept span stands on the anchor made beside it in the same batch.
    assert [p['args'][1] for p in client.payloads('spans.create')] == [[{'$ref': 0, 'index': 0}]]


def test_no_batch_leaves_an_anchor_without_its_node_for_an_open_to_take(monkeypatch):
    """What the lock guards against here cannot arise from the anchors any
    more: a new node's anchor and its concept span go in one batch, the span
    naming the anchor by a ref, so between two batches there is no anchor
    without a node for a repair on open to take. Without it, a lost answer
    or a failure after the anchors' batch left them for the next person's
    open to delete under their name (conc-2026-09-29 F-PY leftover)."""
    spec = APPS['umr']()
    client = spec['client']()
    spec, plan = _umr_node_plan(client)
    helper = sbs._approve(spec, client, plan)
    assert helper.done and helper.done[-1]['kind'] == 'applied', helper.errors
    for batch in client.batches:
        anchors = [i for i, (kind, _) in enumerate(batch) if kind == 'tokens.bulk_create']
        spans = [p for kind, p in batch if kind == 'spans.create']
        assert sorted(ref.op for p in spans for ref in p['args'][1]) == anchors


def test_a_document_that_cannot_be_found_is_left_to_the_staleness_check(spec):
    """A 404 on the lock is not someone else's run: the check that follows
    reads the document and says what became of it."""
    client = spec['client']()
    plan, _ = sbs._plan(spec, client)

    def gone(document_id, **kw):
        raise PlaidAPIError('Not found', status=404)

    client.documents.locked = gone
    helper = sbs._approve(spec, client, plan)
    assert helper.done and helper.done[-1]['kind'] == 'applied', helper.errors


# --- a lock that lapses while the plan is written ---------------------------------

def _lapse_before_the_first_batch(monkeypatch, client, document_id='d'):
    """The keep-alive fails as the plan is written. As on the real client,
    the loss is recorded on the client, every later non-GET it makes raises
    it (the record's writes too) and the ``locked()`` block clears it on its
    way out."""
    from plaid_client import DocumentLockLost
    lost = DocumentLockLost(f'The lock on document {document_id} lapsed: it could not be renewed.',
                            document_id=document_id)
    state = {'lost': None}
    real_locked = client.documents.locked

    import contextlib

    @contextlib.contextmanager
    def locked(document_id, **kw):
        with real_locked(document_id, **kw) as lock:
            try:
                yield lock
            finally:
                state['lost'] = None

    client.documents.locked = locked
    real_put = client.user_data.put

    def put(*a, **kw):
        if state['lost'] is not None:
            raise state['lost']
        return real_put(*a, **kw)

    monkeypatch.setattr(client.user_data, 'put', put)

    def flush(self):
        state['lost'] = lost
        raise lost

    monkeypatch.setattr(core_plan.TrackingBatcher, 'flush', flush)


def test_a_lock_that_lapses_during_the_apply_still_answers_and_settles_the_card(spec, monkeypatch):
    """The record is written after the locks are released: written inside the
    block, the lapse refused it too, the failure escaped the approval
    unanswered and the card stayed pending over the plan."""
    client = spec['client']()
    plan, _ = sbs._plan(spec, client)
    _lapse_before_the_first_batch(monkeypatch, client)
    helper = sbs._approve(spec, client, plan)
    assert not helper.done
    assert helper.errors and helper.errors[-1].startswith('Failed to apply the plan:'), helper.errors
    assert 'lapsed' in helper.errors[-1]
    from plaid_agent.core.conversation import ConversationStore
    _, meta = ConversationStore(client, 'u@x', spec['pid'], spec['app']).load('c1')
    assert not (meta or {}).get('pending')


NAMES = {'igt': 'Text 1', 'ud': 'Viaje', 'umr': 'Story'}


def test_a_lapse_is_told_by_the_documents_name_in_plain_words(spec, monkeypatch):
    """Not the document's id, not the exception's class name, and one period
    at the end of the clause."""
    client = spec['client']()
    plan, _ = sbs._plan(spec, client)
    _lapse_before_the_first_batch(monkeypatch, client, spec['did'])
    helper = sbs._approve(spec, client, plan)
    assert helper.errors == [f'Failed to apply the plan: the lock on document "{NAMES[spec["app"]]}" '
                             'lapsed. Nothing was written.'], helper.errors


def test_a_failure_whose_text_ends_in_a_period_is_not_given_a_second(spec, monkeypatch):
    client = spec['client']()
    plan, _ = sbs._plan(spec, client)

    def flush(self):
        raise core_plan.PlanError('The server refused the batch.', 0, 1)

    monkeypatch.setattr(core_plan.TrackingBatcher, 'flush', flush)
    helper = sbs._approve(spec, client, plan)
    assert helper.errors == ['Failed to apply the plan: The server refused the batch. Nothing was written.'], \
        helper.errors
