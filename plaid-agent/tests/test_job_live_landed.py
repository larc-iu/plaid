"""What landed is known, on a real core (BRIEF RX item 5): every piece kind
(a stretch, a whole document, the whole selection, the selection with a
lexicon change), with and without a sentence deletion, its write's answer
lost or its worker dead before the record. The worker asks core which of its
tries landed (``POST /jobs/{id}/landed``, the Idempotency-Keys core keeps on
each operation): nothing is written twice, the piece is not asked again, and
the report counts what was written. And a write of three tries whose middle
answer is lost: what landed is never sent again and the rest is done once.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import re
import uuid

import pytest

from fixtures import MORPH_LAYER
from job_fixtures import Model, call, document, job_project, reply, use
from live import seed
from test_job_live_delete_sentence import _admin, _job, _read, _runner

from plaid_client import PlaidAPIError, PlaidClient
from plaid_agent.core.job import run_job
from plaid_agent.core.plan import PlanError
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import IgtRunner

#: "ka ta." twice: a piece told to delete a sentence that repeats the one
#: before it deletes the second, and run again over what is left it finds
#: none (were it to delete again, it would have to take a sentence it should
#: not).
SENTENCES = [{'words': ['ka', 'ta']}, {'words': ['ka', 'ta']}, {'words': ['sa']}]
PIECES = ['sentences', 'document', 'selection', 'selection-lexicon']


class Crash(BaseException):
    """The worker's process dies here."""


def _model(delete, lexicon, entry, asked_pieces):
    """Glosses ka in s1, deletes the sentence that repeats the one before it
    when ``delete`` (none once it is gone), and renames gam to gaam when
    ``lexicon``. A selection reads its document first."""
    def answer(asked, n, kwargs):
        selection = 'Your piece: the whole selection above.' in asked
        if not selection and 'Your piece:' not in asked:
            return reply('Done.')
        if selection and n == 1:
            return reply(calls=[call(9, 'read_document', {'document': 'Alpha'})])
        if n > (2 if selection else 1):
            return reply('Done.')
        text = '\n'.join(str(m.get('content') or '') for m in kwargs['messages'])
        asked_pieces.append(asked)
        calls = [call(1, 'set_analysis', {'document': 'Alpha', 'ref': 's1.w1', 'morphemes': [
            {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]})]
        lines = re.findall(r'^\[s(\d+)\] (.*)$', text, re.M)
        if delete:
            double = next((k for (k, t), (_, before) in zip(lines[1:], lines) if t == before), None)
            if double:
                calls.append(call(2, 'delete_sentence', {'document': 'Alpha', 'refs': [f's{double}']}))
        if lexicon:
            calls.append(call(3, 'rename_entry', {'entry_id': entry, 'new_form': 'gaam'}))
        return reply(calls=calls)
    return answer


def _world(admin, pieces):
    email = f'job-landed-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-landed-pass-1', False)
    writer = PlaidClient.login(_core(), email, 'job-landed-pass-1')
    s = seed(admin, job_project(), {'dA': document('dA', 'Alpha', SENTENCES)},
             {'v1': {'id': 'v1', 'name': 'Lexicon', 'project': 'p1',
                     'items': [{'id': 'e-gam', 'form': 'gam', 'metadata': {'gloss': 'fish'}}]}},
             name=f'job landed {uuid.uuid4().hex[:6]}')
    # A maintainer, so the job may rename an entry.
    admin.projects.add_maintainer(s.project_id, email)
    return writer, s


def _core():
    from live import core_url
    return core_url()


def _morphs(admin, s):
    raw = admin.documents.get(s.ids['dA'], include_body=True)
    return [t for tl in raw['text_layers'] for tk in tl['token_layers'] if tk['id'] == s.ids[MORPH_LAYER]
            for t in tk.get('tokens') or [] if (t.get('metadata') or {}).get('prov')]


def _forms(admin, s):
    return [it['form'] for it in admin.vocab_layers.get(s.ids['v1'], include_items=True).get('items') or []]


def _last_kind(delete, lexicon):
    return 'rename_entry' if lexicon else 'delete_sentence' if delete else 'set_analysis'


@pytest.mark.parametrize('failure', ['lost', 'crash'])
@pytest.mark.parametrize('delete', [False, True], ids=['gloss', 'gloss-and-delete'])
@pytest.mark.parametrize('pieces', PIECES)
def test_a_write_whose_answer_was_lost_or_whose_worker_died_is_known_and_never_written_twice(
        monkeypatch, pieces, delete, failure):
    admin = _admin()
    lexicon = pieces == 'selection-lexicon'
    writer, s = _world(admin, pieces)
    try:
        asked = []
        use(monkeypatch, Model(_model(delete, lexicon, s.ids['e-gam'], asked)))
        real, sent, lost = igt_job.execute_plan, [], []
        last = _last_kind(delete, lexicon)

        def execute(c, ops, **kw):
            sent.append(sorted(o['kind'] for o in ops))
            out = real(c, ops, **kw)
            if failure == 'lost' and not lost and any(o['kind'] == last for o in ops):
                lost.append(True)
                try:
                    raise PlaidAPIError('HTTP 502 Bad Gateway', status=502, method='POST')
                except PlaidAPIError as e:
                    raise PlanError('the answer was lost', len(ops), len(ops), unknown=True) from e
            return out
        monkeypatch.setattr(igt_job, 'execute_plan', execute)
        job = _job(admin, writer, s, 'Gloss ka, delete a sentence that repeats the one before it.',
                   'selection' if lexicon else pieces)
        if failure == 'crash':
            real_record = IgtRunner.record

            def record(self, *a, **kw):
                raise Crash()
            monkeypatch.setattr(IgtRunner, 'record', record)
            with pytest.raises(Crash):
                run_job(job, _runner(job))
            monkeypatch.setattr(IgtRunner, 'record', real_record)
            # A new worker process: the rows as core has them, a new runner.
            job.rows = {x['document_id']: dict(x) for x in admin.jobs.get(job.id)['documents']}
        finished = run_job(job, _runner(job))
        assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
        assert failure == 'crash' or lost, 'the answer was lost'
        tries = [k for k in ([['set_analysis'], ['delete_sentence'], ['rename_entry']]) if
                 k[0] in ('set_analysis',) or (k[0] == 'delete_sentence' and delete) or (k[0] == 'rename_entry'
                                                                                         and lexicon)]
        assert sent == tries, f'each try sent once, never again: {sent}'
        # A selection taken up by a new worker runs its context again (its
        # plan is the whole selection): what it stages where it wrote is
        # left out. Any other piece is not asked again.
        again = failure == 'crash' and pieces.startswith('selection')
        assert len(asked) == (2 if again else 1), 'the piece is not asked again'
        body, sentences, _words = _read(admin, s)
        assert body == ('ka ta. sa.' if delete else 'ka ta. ka ta. sa.'), body
        assert len(_morphs(admin, s)) == 1, 'ka glossed once'
        assert _forms(admin, s) == (['gaam'] if lexicon else ['gam'])
        report = finished['report']
        doc = report['documents'][0]
        assert doc['skipped'] == [] and report['proposed'] == [], (doc['skipped'], report['proposed'])
        assert (report['totals']['words'], report['totals']['deletions']) == (1, 1 if delete else 0), report['totals']
    finally:
        s.delete()


def test_a_write_of_three_tries_whose_middle_answer_is_lost_sends_nothing_twice(monkeypatch):
    """A document piece glosses ka, deletes the doubled sentence and renames
    gam: three tries, one request each. The deletion's lands and its answer
    is lost, so the rename is never sent. Taken again, core says the gloss
    and the deletion landed: the piece is asked again over what is left, its
    gloss of s1 is left out as written, it finds no doubled sentence, and
    the rename is sent once."""
    admin = _admin()
    writer, s = _world(admin, 'document')
    try:
        asked = []
        use(monkeypatch, Model(_model(True, True, s.ids['e-gam'], asked)))
        real, sent, lost = igt_job.execute_plan, [], []

        def execute(c, ops, **kw):
            sent.append(sorted(o['kind'] for o in ops))
            out = real(c, ops, **kw)
            if not lost and any(o['kind'] == 'delete_sentence' for o in ops):
                lost.append(True)
                try:
                    raise PlaidAPIError('HTTP 502 Bad Gateway', status=502, method='POST')
                except PlaidAPIError as e:
                    raise PlanError('the answer was lost', len(ops), len(ops), unknown=True) from e
            return out
        monkeypatch.setattr(igt_job, 'execute_plan', execute)
        job = _job(admin, writer, s, 'Gloss ka, delete a sentence that repeats the one before it, rename gam.',
                   'document')
        finished = run_job(job, _runner(job))
        assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
        assert lost
        assert sent == [['set_analysis'], ['delete_sentence'], ['rename_entry']], sent
        assert len(asked) == 2, 'asked again over what is left'
        body, _sentences, _words = _read(admin, s)
        assert body == 'ka ta. sa.', body
        assert len(_morphs(admin, s)) == 1 and _forms(admin, s) == ['gaam']
        report = finished['report']
        assert report['documents'][0]['skipped'] == [] and report['proposed'] == []
        assert report['totals']['repeated'] == 1, 'the gloss of s1, left out when asked again'
        assert (report['totals']['words'], report['totals']['deletions']) == (1, 1), report['totals']
    finally:
        s.delete()
