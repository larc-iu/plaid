"""An applied plan names the id of every row it creates (idempotent writes, 2026-09-30).

The server once minted every id a plan's creates made, and a later write in
the same batch named its row by a ref to the create. A create whose answer was
lost could only be found again by its Idempotency-Key, and a plan applied again
(the service restarted before the record said applied) made each row a second
time. Now every create names an id drawn from the plan's own id (a UUIDv7
minted when the plan is staged, ``core.plan.Minter``), later writes name that
id, and the plan's writes are keyed by it, so applying the same plan again
sends the same creates: each is answered from its first send or refused as
``id-taken``, and no row is made twice.
"""

import copy
import uuid

import pytest
from plaid_client import PlaidAPIError, uuid7
from plaid_client import testing as fake_mod
from plaid_client.testing import BatchRef

import test_lost_answers as la
import test_stale_by_sentence as sbs
from fixtures import MGLOSS, MORPH_LAYER, TEXT_ID, VOCAB, FakeClient

from plaid_agent.core import plan as core_plan
from plaid_agent.core.plan import Minter


# --- reading what a run sent -----------------------------------------------------

def _is_create(kind):
    return kind.endswith('.create') or kind.endswith('.bulk_create') or kind == 'tokens.split'


def _ids_of(kind, payload):
    """The ids a create names, one per row (None for a row it leaves the
    server to name)."""
    if kind.endswith('.bulk_create'):
        rows = payload if isinstance(payload, list) else payload['args'][0]
        return [row.get('id') for row in rows]
    kwargs = payload.get('kwargs') if isinstance(payload, dict) else None
    return [(kwargs or {}).get('id')]


def _creates(client):
    """Every create that reached the fake, as (kind, [id, ...])."""
    return [(kind, _ids_of(kind, payload)) for kind, payload in client.calls if _is_create(kind)]


def _refs(value):
    if isinstance(value, BatchRef):
        return 1
    if isinstance(value, dict):
        return sum(_refs(v) for v in value.values())
    if isinstance(value, (list, tuple)):
        return sum(_refs(v) for v in value)
    return 0


def _v7(value):
    return uuid.UUID(value).version == 7


# --- the ids -------------------------------------------------------------------------

def test_a_plans_ids_are_uuidv7s_in_order_after_its_own_and_the_same_every_time():
    seed = uuid7()
    first = Minter(seed)
    ids = [first() for _ in range(5000)]
    assert all(_v7(i) for i in ids)
    assert ids == sorted(ids) and len(set(ids)) == len(ids) and seed < ids[0]
    again = Minter(seed)
    assert [again() for _ in range(5000)] == ids
    other = Minter(uuid7())
    assert not {other() for _ in range(100)} & set(ids)
    # Dated when the plan was staged: past 4096 ids the millisecond moves on by one.
    ms = lambda u: uuid.UUID(u).int >> 80  # noqa: E731
    assert ms(ids[-1]) - ms(seed) in (1, 2)


def test_a_taken_id_whose_row_was_deleted_is_not_taken_as_made():
    """R1-DEBT-CORE-6: the client's rule (plaid_client.http.minted_taken). A
    row deleted since an earlier run made it is not made for this plan, and
    the plan stops rather than writing on past it."""
    m = Minter(uuid7())
    made = m()
    taken = {'error': 'id-taken', 'id': made}
    assert m.made(PlaidAPIError('HTTP 409', status=409, response_data=taken))
    assert not m.made(PlaidAPIError('HTTP 409', status=409, response_data={**taken, 'deleted': True}))
    assert not m.made(PlaidAPIError('HTTP 409', status=409, response_data={**taken, 'id': uuid7()}))


def test_a_seed_that_is_not_a_uuidv7_is_refused():
    with pytest.raises(ValueError):
        Minter(str(uuid.uuid4()))


def test_a_staged_plans_id_is_a_uuidv7():
    for make in sbs.APPS.values():
        spec = make()
        plan, _ = sbs._plan(spec, spec['client']())
        assert _v7(plan['id']), spec['app']


# --- every executor names its rows ---------------------------------------------------------

def _igt_run(client, seed):
    from plaid_agent.igt.plan import execute_plan
    from plaid_agent.igt.project import load_project
    ops = [
        {'kind': 'set_analysis', 'word_id': 'w-3', 'text_id': TEXT_ID, 'begin': 11, 'end': 16,
         'morpheme_layer_id': MORPH_LAYER, 'existing': [],
         'morphemes': [{'form': 'aku', 'morph_type': None, 'fields': [{'layer_id': MGLOSS, 'value': 'see'}]},
                       {'form': 'na', 'morph_type': 'suffix', 'fields': [{'layer_id': MGLOSS, 'value': 'PST'}]}],
         'label': ''},
        # A link to a morpheme the analysis above creates, to an entry created below.
        {'kind': 'link', 'analysis_word_id': 'w-3', 'morpheme_index': 2, 'morpheme_form': 'na', 'item_id': None,
         'new_entry_key': 'new:1', 'existing_link_id': None, 'label': ''},
        {'kind': 'create_entry', 'vocab_id': VOCAB, 'form': 'akun', 'metadata': {'gloss': 'see'},
         'key': 'new:1', 'label': ''},
        {'kind': 'link', 'token_id': 'w-2', 'item_id': None, 'new_entry_key': 'new:1',
         'existing_link_id': None, 'label': ''},
        {'kind': 'set_span', 'layer_id': 'sl-gloss', 'token_id': 'w-2', 'span_id': None, 'value': 'fish',
         'label': ''},
        {'kind': 'split_word', 'word_id': 'w-4', 'position': 21, 'label': ''},
        {'kind': 'add_comment', 'entity_type': 'token', 'entity_id': 'w-1', 'body': 'A name?', 'label': ''},
        {'kind': 'add_guideline', 'title': 'Names', 'body': 'Names are glossed whole.', 'label': ''},
        {'kind': 'create_document', 'name': 'Text 2', 'text': 'Ali-di gam.\nGam-ar.\n', 'metadata': {},
         'label': ''},
    ]
    execute_plan(client, ops, source='s', label='l', project=load_project(client, 'p1'), seed=seed)


def _ud_run(client, seed):
    from ud_fixtures import PID
    from plaid_agent.ud.plan import execute_plan
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.toolkit import call_tool
    from plaid_agent.ud.tools import Workspace
    ws = Workspace(client, load_project(client, PID))
    # A reshape (its words and their spans), a head on words with no lemma
    # (each seeded from its form), a head on words with one, and a new value.
    for name, args in (('set_words', {'document': 'Viaje', 'ref': 's1.w4', 'forms': ['ma', 'r']}),
                       ('set_head', {'document': 'Viaje', 'ref': 's2.w2', 'head': 1, 'deprel': 'dep'}),
                       ('set_head', {'document': 'Viaje', 'ref': 's1.w2', 'head': 1, 'deprel': 'dep'}),
                       ('set_field', {'document': 'Viaje', 'refs': ['s1.w1'], 'field': 'xpos',
                                      'value': 'vmip1p0'})):
        assert 'Planned' in call_tool(ws, name, args), name
    execute_plan(client, ws.ops, source='s', label='l', project=ws.project, seed=seed)


def _umr_run(client, seed):
    from importlib import import_module
    from umr_fixtures import SENTENCE_1_PENMAN
    from plaid_agent.umr.plan import execute_plan
    spec = la.APPS['umr']()
    call_tool = import_module('plaid_agent.umr.toolkit').call_tool
    ws = spec['workspace'](client, spec['load'](client, spec['pid']))
    text = SENTENCE_1_PENMAN.replace(':aspect performance)', ':ARG1 (s1c / cat)\n    :aspect performance)')
    assert 'Planned' in call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1, 'text': text})
    execute_plan(client, ws.ops, source='s', label='l', project=ws.project, seed=seed)


def _ud_client():
    from ud_fixtures import ud_client
    return ud_client()


def _umr_client():
    return la.APPS['umr']()['client']()


RUNS = {'igt': (FakeClient, _igt_run), 'ud': (_ud_client, _ud_run), 'umr': (_umr_client, _umr_run)}


@pytest.mark.parametrize('app', sorted(RUNS))
def test_every_create_names_its_id_and_nothing_waits_on_a_ref(app):
    make, run = RUNS[app]
    seed = uuid7()
    client = make()
    run(client, seed)
    creates = _creates(client)
    assert creates, 'the plan creates something'
    ids = [i for _, row_ids in creates for i in row_ids]
    assert all(i and _v7(i) for i in ids), creates
    assert len(set(ids)) == len(ids)
    assert not any(_refs(payload) for _, payload in client.calls), 'a later write names the id itself'
    # Every id is the plan's, in the order drawn.
    minted = Minter(seed)
    assert ids == [minted() for _ in ids]


@pytest.mark.parametrize('app', sorted(RUNS))
def test_the_same_plan_applied_again_sends_the_same_writes(app):
    make, run = RUNS[app]
    seed = uuid7()
    first, second = make(), make()
    run(first, seed)
    run(second, seed)
    assert second.calls == first.calls
    third = make()
    run(third, uuid7())
    assert _creates(third) != _creates(first), 'another plan names other rows'


def test_the_igt_links_name_the_morpheme_and_the_entry_the_plan_made():
    seed = uuid7()
    client = FakeClient()
    _igt_run(client, seed)
    made = dict()
    for kind, payload in client.calls:
        if kind in ('tokens.create', 'vocab_items.create'):
            made.setdefault(kind, []).append(payload['kwargs']['id'])
    links = [p['args'][:2] for kind, p in client.calls if kind == 'vocab_links.create']
    [entry] = made['vocab_items.create']
    assert (entry, [made['tokens.create'][1]]) in links, 'the planned morpheme, second of the analysis'
    assert (entry, ['w-2']) in links
    glossed = [p['args'][1] for kind, p in client.calls
               if kind == 'spans.create' and p['args'][0] == MGLOSS]
    assert glossed == [[i] for i in made['tokens.create']]


# --- applied again after a lost answer: each row made once ------------------------------------

class _Server:
    """The core's rule on a create naming an id: a used id is refused 409
    ``id-taken``, and a batch holding one is refused whole. ``lose`` is how
    many sends commit and lose their answer.

    The fake keeps no Idempotency-Keys, so every resend meets the id rule:
    the case of a key past its 24 hours, or a batch of comments alone, which
    takes a key of its own. Within the day the core answers a resent keyed
    request from its first send instead."""

    def __init__(self, monkeypatch):
        self.made = []   # every id a committed create made, in order
        self.lose = 0
        real_submit = fake_mod._Batch.submit
        real_record = fake_mod.FakeClient.record
        server = self

        def taken(ids):
            used = set(server.made)
            return next((i for i in ids if i in used), None)

        def refuse(i):
            return PlaidAPIError(f'HTTP 409 {i} is taken', status=409, method='POST',
                                 url='http://h:8085/api/v1/batch',
                                 response_data={'error': 'id-taken', 'id': i, 'deleted': False})

        def submit(batch):
            ids = [i for kind, payload in batch.queued if _is_create(kind)
                   for i in _ids_of(kind, payload) if i]
            hit = taken(ids)
            if hit:
                batch.open = False
                raise refuse(hit)
            answer = real_submit(batch)
            server.made.extend(ids)
            if server.lose:
                server.lose -= 1
                raise la._lost()
            return answer

        def record(client, kind, payload=None, result=None):
            if _is_create(kind):
                ids = [i for i in _ids_of(kind, payload) if i]
                hit = taken(ids)
                if hit:
                    raise refuse(hit)
                server.made.extend(ids)
            return real_record(client, kind, payload, result)

        monkeypatch.setattr(fake_mod._Batch, 'submit', submit)
        monkeypatch.setattr(fake_mod.FakeClient, 'record', record)


@pytest.mark.parametrize('app', sorted(RUNS))
def test_a_plan_whose_answer_was_lost_applied_again_makes_each_row_once(app, monkeypatch):
    make, run = RUNS[app]
    seed = uuid7()
    whole = make()
    run(whole, seed)
    client = make()
    server = _Server(monkeypatch)
    server.lose = 1
    with pytest.raises(core_plan.PlanError) as caught:
        run(client, seed)
    assert caught.value.unknown
    made = list(server.made)
    assert made
    # Applied again, as a service that restarted before the record said so
    # would: what the first run made is taken as made, and the rest is written.
    run(client, seed)
    assert len(set(server.made)) == len(server.made), 'no row was made twice'
    assert server.made[:len(made)] == made
    assert set(server.made) == {i for _, ids in _creates(whole) for i in ids}, 'the whole plan'


@pytest.mark.parametrize('app', sorted(RUNS))
def test_a_plan_applied_whole_and_applied_again_makes_nothing_more(app, monkeypatch):
    """Every create of the second run, batched or made on the client (a new
    document and its text), is refused as taken and taken as made."""
    make, run = RUNS[app]
    seed = uuid7()
    client = make()
    server = _Server(monkeypatch)
    run(client, seed)
    made = list(server.made)
    run(client, seed)
    assert server.made == made


def test_a_plan_past_the_budget_finishes_when_applied_again(monkeypatch):
    """The first batch committed and its answer was lost, so the later ones
    were never sent. Applied again, the first is taken as made and the rest
    are written (M6: it said "Nothing was written" and could never finish)."""
    from test_one_change_per_batch import _budget
    from plaid_agent.igt.plan import execute_plan
    from plaid_agent.igt.project import load_project
    _budget(monkeypatch, 1)
    ops = [{'kind': 'add_guideline', 'title': t, 'body': 'b', 'label': ''} for t in ('One', 'Two', 'Three')]
    seed = uuid7()
    client = FakeClient()
    server = _Server(monkeypatch)
    server.lose = 1
    with pytest.raises(core_plan.PlanError):
        execute_plan(client, ops, source='s', label='l', project=load_project(client, 'p1'), seed=seed)
    assert len(server.made) == 1
    counts = execute_plan(client, ops, source='s', label='l', project=load_project(client, 'p1'), seed=seed)
    assert counts == {'guidelines': 3}
    assert len(server.made) == 3 == len(set(server.made))
    assert sorted(r['title'] for r in client.guideline_rows) == ['Glossing', 'One', 'Orthography',
                                                                 'Three', 'Translations', 'Two']


def test_approving_keys_the_writes_and_draws_the_ids_from_the_plans_id(monkeypatch):
    """Through the service: the operation is keyed by the plan's id, so the
    core answers a batch sent again from its first send, and the ids are the
    plan's."""
    for make in sbs.APPS.values():
        spec = make()
        client = spec['client']()
        plan, _ = sbs._plan(spec, client)
        seen = []
        real = type(client).operation

        def operation(self, message, **kw):
            seen.append(kw.get('keys'))
            return real(self, message, **kw)

        monkeypatch.setattr(type(client), 'operation', operation)
        helper = sbs._approve(spec, client, plan)
        assert not helper.errors, (spec['app'], helper.errors)
        assert seen[0] == {'seed': plan['id'], 'stamps': {}}, spec['app']
        monkeypatch.undo()


@pytest.mark.parametrize('app', sorted(sbs.APPS))
def test_an_approval_run_again_after_a_restart_makes_nothing_twice(app, monkeypatch):
    """The first approval commits and loses its answer. The service restarts
    before the record says what happened, so the card still offers Approve,
    and the user approves again: the same creates go out, are refused as
    taken, and the plan settles as applied."""
    spec = sbs.APPS[app]()
    client = spec['client']()
    tool = {'igt': ('set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'fish'}),
            'ud': ('set_words', {'document': 'Viaje', 'ref': 's2.w1', 'forms': ['co', 'rre']}),
            'umr': None}[app]
    if app == 'umr':
        from umr_fixtures import SENTENCE_1_PENMAN
        text = SENTENCE_1_PENMAN.replace(':aspect performance)', ':ARG1 (s1c / cat)\n    :aspect performance)')
        tool = ('apply_penman', {'document': 'Story', 'sentence': 1, 'text': text})
    plan, _ = sbs._plan(spec, client, tool)
    record = copy.deepcopy(_user_data(client))
    server = _Server(monkeypatch)
    server.lose = 1
    helper = sbs._approve(spec, client, plan)
    [done] = helper.done
    assert done['message'].startswith('Partly applied'), done
    made = list(server.made)
    assert made
    # The restart: the record as it was, a new service.
    _user_data(client).clear()
    _user_data(client).update(record)
    helper = sbs._approve(spec, client, plan)
    assert len(set(server.made)) == len(server.made), 'no row was made twice'
    assert server.made == made
    assert not helper.errors, helper.errors
    [done] = helper.done
    assert done['kind'] == 'applied' and done['message'].startswith('Applied'), done
    conv, _ = sbs.ConversationStore(client, 'u@x', spec['pid'], spec['app']).load('c1')
    assert conv['display'][1]['status'] == 'applied'


@pytest.mark.parametrize('app', sorted(sbs.APPS))
def test_an_approval_run_again_claims_the_versions_its_first_run_held(app, monkeypatch):
    """A keyed request names the document version it claims, so a run again
    that claimed the version the document has now was another request, which
    the core refuses with 422 instead of answering it from its first send. The
    first run writes the versions it holds onto the plan before it sends, and
    a run again holds the documents at them."""
    spec = sbs.APPS[app]()
    client = spec['client']()
    plan, _ = sbs._plan(spec, client)
    record = {}
    real = core_plan.Batcher.flush

    def lost(self):
        # The service stops here: the batch committed, the record as it is.
        real(self)
        record.update(copy.deepcopy(_user_data(client)))
        raise la._lost()

    monkeypatch.setattr(core_plan.Batcher, 'flush', lost)
    first = len(client.stamps)
    sbs._approve(spec, client, plan)
    claimed = [v for _, _, v in client.stamps[first:]]
    assert claimed and record
    monkeypatch.setattr(core_plan.Batcher, 'flush', real)
    # What the batch did to the document: its version moved on.
    client._documents[spec['did']]['version'] += 1
    _user_data(client).clear()
    _user_data(client).update(record)
    again = len(client.stamps)
    helper = sbs._approve(spec, client, plan)
    assert not helper.errors, helper.errors
    assert [v for _, _, v in client.stamps[again:]][:len(claimed)] == claimed


def test_a_run_that_wrote_nothing_leaves_the_next_to_hold_the_versions_then(monkeypatch):
    """A refused run wrote nothing, so there is nothing to repeat: an
    approval after an edit claims the version the edit left."""
    spec = sbs.APPS['igt']()
    client = spec['client']()
    plan, _ = sbs._plan(spec, client)
    real = core_plan.Batcher.flush

    def refused(self):
        raise PlaidAPIError('HTTP 500 boom', status=500, method='POST')

    monkeypatch.setattr(core_plan.Batcher, 'flush', refused)
    helper = sbs._approve(spec, client, plan)
    assert 'Nothing was written' in helper.errors[0]
    monkeypatch.setattr(core_plan.Batcher, 'flush', real)
    client._documents[spec['did']]['version'] += 1
    now = client._documents[spec['did']]['version']
    at = len(client.stamps)
    helper = sbs._approve(spec, client, plan)
    assert not helper.errors, helper.errors
    assert {v for _, _, v in client.stamps[at:]} == {now}


def test_a_plan_whose_id_is_not_a_uuidv7_is_settled_as_out_of_date():
    """A plan staged before its id was a UUIDv7 has no ids to draw. It is
    settled as out of date with a plain word, never left pending."""
    spec = sbs.APPS['igt']()
    client = spec['client']()
    plan, store = sbs._plan(spec, client)
    conv, meta = store.load('c1')
    old = uuid.uuid4().hex
    conv['display'][1]['plan']['id'] = old
    meta['pending']['plan_id'] = old
    store.save('c1', conv, meta)
    helper = sbs._approve(spec, client, {**plan, 'id': old})
    assert helper.errors == ['Nothing was written. This plan was made by an earlier version of the '
                             'assistant. Ask the assistant to plan again.']
    conv, meta = store.load('c1')
    assert conv['display'][1]['status'] == 'stale' and not meta.get('pending')
    # The card says why, after a reload too (H13-UPGRADE-3).
    assert conv['display'][1]['reason'] == 'This plan was made by an earlier version of the assistant.'
    assert not client.writes


def _user_data(client):
    """The fake's stored user data, which a test rewinds to stand for a
    record the settle never reached."""
    return client.user_data.store


def test_a_batch_or_bulk_an_earlier_run_made_counts_as_made_even_with_a_row_deleted_since():
    """REV-DEBT-R1 F3: a batch or a bulk create is one transaction, so a drawn
    id it finds taken means the earlier run made all of it, whichever of its
    rows the server names and whether a person deleted that row since. Only a
    single create's deleted row is not made (``minted_taken``)."""
    from plaid_agent.core.plan import Batcher

    class _Refused:
        def __init__(self, err):
            self.err = err

        def submit(self):
            raise self.err

    for deleted in (False, True):
        m = Minter(uuid7())
        b = Batcher(object(), ids=m)
        first = m()
        m()
        taken = PlaidAPIError('HTTP 409', status=409,
                              response_data={'error': 'id-taken', 'id': first, 'deleted': deleted})
        b._batch, b._pending = _Refused(taken), 2
        b.flush()
        assert b.results == [None, None]
        assert m.once(lambda: (_ for _ in ()).throw(taken), whole=True) is None
    with pytest.raises(PlaidAPIError):
        m.once(lambda: (_ for _ in ()).throw(taken))


def test_a_new_document_whose_text_failed_is_kept_for_the_plan_to_finish(monkeypatch):
    """REV-DEBT-R1 F3, older: the half-made document was deleted, and the plan
    draws the same id when it is approved again, so it was refused id-taken
    for good. It stays, and the plan approved again finishes it."""
    from plaid_agent.igt import plan as igt_plan
    calls = []

    class _Docs:
        def create(self, *args, **kwargs):
            calls.append('create')

        def delete(self, doc_id):
            calls.append('delete')

    class _Client:
        documents = _Docs()

    def fail(*args, **kwargs):
        raise PlaidAPIError('HTTP 503', status=503)

    monkeypatch.setattr(igt_plan, '_seed_text', fail)
    project = type('P', (), {'id': 'p1'})()
    with pytest.raises(PlaidAPIError):
        igt_plan.create_document(_Client(), project, 'Text', 'a b', {}, Minter(uuid7()))
    assert calls == ['create']
