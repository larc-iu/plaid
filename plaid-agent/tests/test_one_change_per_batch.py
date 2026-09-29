"""A plan past the batch's budget never cuts one change across two batches,
and a change counts as written once the batch holding it stood
(conc-2026-09-29 REV-W-PY2 N1 and D5).

N1: `Batcher.add` flushed after whichever write passed the budget, even in
the middle of one change, so a failure in the next batch left a word with
half its new analysis, or morphemes with no gloss. D5: the UMR and UD
executors finished every op only after the last flush, so a plan that failed
in a later batch said "0 of N changes written" over nodes that stood.
"""

import pytest
from plaid_client import PlaidAPIError

from plaid_agent.core import plan as core_plan


class _Client:
    def __init__(self):
        self.sent = []

    def batch(self):
        client = self

        class _Batch:
            def __init__(self):
                self.ops = []

            def ref(self, op, index=None):
                return {'$ref': op}

            def submit(self):
                client.sent.append(self.ops)
                return [{'id': f'id-{len(client.sent)}-{i}'} for i in range(len(self.ops))]
        return _Batch()


def test_one_change_goes_in_one_batch_whatever_the_budget():
    c = _Client()
    b = core_plan.Batcher(c, budget=2)
    with b.writing_for({'kind': 'x'}):
        for k in range(3):
            b.add(lambda batch, k=k: batch.ops.append(k))
        assert c.sent == [], 'nothing is sent in the middle of a change'
    assert c.sent == [[0, 1, 2]], 'the budget is checked once the change ends'
    with b.writing_for({'kind': 'x'}):
        b.add(lambda batch: batch.ops.append('a'))
    assert c.sent == [[0, 1, 2]]
    b.flush()
    assert c.sent == [[0, 1, 2], ['a']]


def test_a_change_past_the_servers_cap_is_cut_there():
    c = _Client()
    b = core_plan.Batcher(c, budget=2)
    with b.writing_for({'kind': 'x'}):
        for k in range(core_plan.MAX_BATCH_OPS + 1):
            b.add(lambda batch, k=k: batch.ops.append(k))
    b.flush()
    assert [len(ops) for ops in c.sent] == [core_plan.MAX_BATCH_OPS, 1]


def _budget(monkeypatch, n):
    monkeypatch.setattr(core_plan.TrackingBatcher.__init__, '__defaults__', (n, None))


def _nth_send_fails(monkeypatch, n):
    real = core_plan.Batcher.flush
    sent = []

    def flush(self):
        if self._batch is not None or any(self._bulk.values()):
            sent.append(1)
            if len(sent) == n:
                raise PlaidAPIError('HTTP 500 boom', status=500, method='POST')
        real(self)
    monkeypatch.setattr(core_plan.Batcher, 'flush', flush)


def _rows(ops):
    for i, op in enumerate(ops):
        op['_row'] = i
    return ops


def _analysis(word, begin, end, glosses):
    from fixtures import MGLOSS, MORPH_LAYER, TEXT_ID
    return {'kind': 'set_analysis', 'word_id': word, 'text_id': TEXT_ID, 'begin': begin, 'end': end,
            'morpheme_layer_id': MORPH_LAYER, 'existing': [],
            'morphemes': [{'form': g.lower(), 'morph_type': None,
                           'fields': [{'layer_id': MGLOSS, 'value': g}]} for g in glosses],
            'label': ''}


def test_an_igt_analysis_is_whole_in_its_batch_and_counts_once_it_stood(monkeypatch):
    from fixtures import FakeClient
    from plaid_agent.igt.plan import execute_plan
    _budget(monkeypatch, 3)
    _nth_send_fails(monkeypatch, 2)
    c = FakeClient()
    ops = _rows([_analysis('w-3', 11, 16, ['see', 'PST', 'X']),
                 _analysis('w-4', 18, 24, ['fish', 'PL', 'Y'])])
    with pytest.raises(core_plan.PlanError) as caught:
        execute_plan(c, ops, source='s', label='l')
    assert caught.value.written == [0]
    [first] = c.batches
    creates = [i for i, (kind, _) in enumerate(first) if kind == 'tokens.create']
    glossed = sorted(p['args'][1][0]['$ref'] for kind, p in first if kind == 'spans.create')
    assert len(creates) == 3 and glossed == creates, 'every morpheme of the first word, each glossed'


def test_a_ud_head_counts_once_its_batch_stood(monkeypatch):
    from ud_fixtures import PID, ud_client
    from plaid_agent.ud.plan import execute_plan
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.toolkit import call_tool
    from plaid_agent.ud.tools import Workspace
    client = ud_client()
    ws = Workspace(client, load_project(client, PID))
    for ref in ('s2.w2', 's1.w4'):
        assert 'Planned' in call_tool(ws, 'set_head', {'document': 'Viaje', 'ref': ref, 'head': 1,
                                                     'deprel': 'dep'})
    assert len(ws.ops) == 2
    _budget(monkeypatch, 1)
    _nth_send_fails(monkeypatch, 2)
    with pytest.raises(core_plan.PlanError) as caught:
        execute_plan(client, _rows(ws.ops), source='s', label='l', project=ws.project)
    assert caught.value.written == [0]
    [first] = client.batches
    assert 'relations.create' in [kind for kind, _ in first]


def test_a_ud_reshape_is_whole_in_its_batch_and_its_words_carry_the_plans_provenance(monkeypatch):
    from ud_fixtures import PID, ud_client
    from plaid_agent.ud.plan import execute_plan
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.toolkit import call_tool
    from plaid_agent.ud.tools import Workspace
    client = ud_client()
    ws = Workspace(client, load_project(client, PID))
    call_tool(ws, 'set_words', {'document': 'Viaje', 'ref': 's2.w1', 'forms': ['co', 'rre']})
    call_tool(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w1'], 'field': 'upos', 'value': 'VERB'})
    assert [op['kind'] for op in ws.ops] == ['set_words', 'set_span']
    _budget(monkeypatch, 1)
    _nth_send_fails(monkeypatch, 2)
    with pytest.raises(core_plan.PlanError) as caught:
        execute_plan(client, _rows(ws.ops), source='s', label='l', project=ws.project)
    assert caught.value.written == [0]
    [first] = client.batches
    kinds = [kind for kind, _ in first]
    assert kinds.count('spans.bulk_create') == 4, 'a Form and a Lemma on each new word, with them'
    [words] = [p for kind, p in first if kind == 'tokens.bulk_create']
    rows = words if isinstance(words, list) else words['args'][0]
    assert [r['metadata']['prov'] for r in rows] == ['inferred', 'inferred']
    assert all(r['metadata']['provConfirmed'] is True for r in rows)


def test_a_umr_plan_past_the_budget_counts_the_changes_whose_batch_stood(monkeypatch):
    import test_lost_answers as la
    from umr_fixtures import SENTENCE_1_PENMAN
    spec = la.APPS['umr']()
    client = spec['client']()
    text = SENTENCE_1_PENMAN.replace(':aspect performance)', ':ARG1 (s1c / cat)\n    :aspect performance)')
    plan = la._plan_of(spec, client, ('set_attributes', {'document': 'Story', 'sentence': 2, 'var': 's2r',
                                                         'line': ':aspect state'}),
                       ('apply_penman', {'document': 'Story', 'sentence': 1, 'text': text}))
    _budget(monkeypatch, 1)
    _nth_send_fails(monkeypatch, 2)
    svc = spec['service']()
    spec = {**spec, 'service': lambda: svc}
    helper = la.sbs._approve(spec, client, plan)
    [done] = helper.done
    written = la._stored(spec, client)['written']
    assert written, done['message']
    assert done['message'].startswith(f'Partly applied: {len(written)} of {len(plan["ops"])} changes written.')


def test_a_respelling_in_a_plan_over_two_documents_carries_its_documents_version():
    """REV-W-PY2 D4: the text updates the igt executor makes on the client,
    after the batch, went with no version under a hold of several documents,
    so one whose answer was lost could land over an edit made since."""
    from fixtures import TEXT_ID
    from test_lost_answers import _two_documents
    from plaid_agent.igt.plan import execute_plan
    from plaid_agent.igt.project import load_project
    c = _two_documents()
    c._documents['d2']['text_layers'][0]['text']['id'] = 'd2-text'
    project = load_project(c, 'p1')
    ops = [{'kind': 'respell', 'text_id': TEXT_ID, 'begin': 0, 'end': 6, 'value': 'Alidi', 'doc': 'd1', 'label': ''},
           {'kind': 'respell', 'text_id': 'd2-text', 'begin': 0, 'end': 6, 'value': 'Alido', 'doc': 'd2',
            'label': ''}]
    with core_plan.holding(c, ['d1', 'd2']):
        execute_plan(c, ops, source='s', label='l', project=project)
    assert sorted((kind, doc) for kind, doc, _ in c.stamps if kind == 'texts.update') == [
        ('texts.update', 'd1'), ('texts.update', 'd2')]
    assert c.strict_mode_document_id is None
