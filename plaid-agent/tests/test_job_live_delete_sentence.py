"""A job deletes a sentence, under a real core (BRIEF-JS): applied by the
rule, counted among its deletions, and exactly once when the answer to its
write is lost and the write is sent again.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time
import uuid

import pytest

from fixtures import SENT_LAYER, WORD_LAYER
from job_fixtures import Model, call, document, job_project, plan_row, reply, targets_named, use
from live import _skip_or_fail, core_url, login, seed

from plaid_client import PlaidAPIError
from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.job import Job, run_job
from plaid_agent.core.opkind import ROW
from plaid_agent.core.plan import PlanError
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import IgtRunner
from plaid_agent.jobworker import count_chars

WORKER = '0193a5c0-0000-7000-8000-0000000000f5'
#: The second sentence is doubled, and so is the third: a piece that deleted
#: again would take "sa ta." as well.
SENTENCES = [{'words': ['ka', 'ta'], 'translation': ('First.', 'human')},
             {'words': ['ka', 'ta'], 'translation': ('First again.', 'human')},
             {'words': ['sa', 'ta']},
             {'words': ['sa', 'ta']}]


def _admin():
    try:
        return login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')


def _job(admin, writer, s, instructions, pieces):
    from plaid_client import PlaidClient
    made = writer.jobs.create(s.project_id, 'igt', instructions)
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    assert claimed and claimed['job']['id'] == made['id']
    admin.jobs.add_decisions(made['id'], WORKER, [plan_row(pieces)])
    offset = {'s': 3600.0}

    def wait(sec):
        offset['s'] += sec
    return Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
               sleep=wait, now=lambda: time.time() + offset['s'])


def _runner(job):
    return IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000), count=count_chars,
                     write_summary=False)


def _read(admin, s):
    raw = admin.documents.get(s.ids['dA'], include_body=True)
    tl = raw['text_layers'][0]
    layers = {tk['id']: tk for tk in tl['token_layers']}
    return tl['text']['body'], layers[s.ids[SENT_LAYER]]['tokens'], layers[s.ids[WORD_LAYER]]['tokens']


def _seeded(admin, prefix, sentences=SENTENCES):
    from plaid_client import PlaidClient
    email = f'{prefix}-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-delete-sentence-1', False)
    writer = PlaidClient.login(core_url(), email, 'job-delete-sentence-1')
    s = seed(admin, job_project(), {'dA': document('dA', 'Alpha', sentences)},
             {'v1': {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': []}},
             name=f'{prefix} {uuid.uuid4().hex[:6]}')
    admin.projects.add_writer(s.project_id, email)
    return writer, s


def test_a_piece_deletes_the_doubled_sentence_and_the_report_counts_it(monkeypatch):
    admin = _admin()
    writer, s = _seeded(admin, 'job-del-sent')
    try:
        def answer(asked, n, kwargs):
            if 'Your piece: the whole document' not in asked or n > 1:
                return reply('Deleted the doubled sentence.')
            return reply(calls=[call(1, 'delete_sentence', {'document': 'Alpha', 'refs': ['s2']})])
        use(monkeypatch, Model(answer))
        job = _job(admin, writer, s, 'Delete the second sentence: it doubles the first.', 'document')
        finished = run_job(job, _runner(job))
        assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
        body, sentences, words = _read(admin, s)
        assert body == 'ka ta. sa ta. sa ta.' and len(sentences) == 3 and len(words) == 6
        assert s.ids['dA-s2'] not in {t['id'] for t in sentences}
        totals = finished['report']['totals']
        assert (totals['changes'], totals['deletions']) == (1, 1), totals
        assert finished['report']['proposed'] == []
    finally:
        s.delete()


def test_a_sentence_deletion_sent_again_after_a_lost_answer_deletes_no_second_sentence(monkeypatch):
    """As JH's item 10 for words: the write lands and its answer is lost (a
    proxy's 502 after the last batch), so the same write is sent again from
    the gate. The sentence it deleted is gone, so the write landed: its op is
    not sent again, the piece's other sentences are recorded and never
    worked again, and one sentence is deleted."""
    admin = _admin()
    writer, s = _seeded(admin, 'job-del-lost')
    try:
        asked_pieces = []

        def answer(asked, n, kwargs):
            if 'Your piece: the whole document' not in asked or n > 1:
                return reply('Deleted a doubled sentence.')
            asked_pieces.append(asked)
            # Whichever sentence repeats the one before it: run again over
            # what is left, it would delete "sa ta.".
            return reply(calls=[call(1, 'delete_sentence', {'document': 'Alpha',
                                                            'refs': ['s2' if len(asked_pieces) == 1 else 's3']})])
        use(monkeypatch, Model(answer))
        real, sent = igt_job.execute_plan, []

        def execute(c, ops, **kw):
            sent.append([o['kind'] for o in ops])
            out = real(c, ops, **kw)
            if len(sent) == 1:
                cause = PlaidAPIError('HTTP 502 Bad Gateway', status=502, method='PATCH')
                try:
                    raise cause
                except PlaidAPIError as e:
                    raise PlanError('the answer was lost', len(ops), len(ops), unknown=True) from e
            return out
        monkeypatch.setattr(igt_job, 'execute_plan', execute)
        job = _job(admin, writer, s, 'Delete a sentence that repeats the one before it.', 'document')
        finished = run_job(job, _runner(job))
        assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
        assert sent == [['delete_sentence']], f'sent once, never again: {sent}'
        assert len(asked_pieces) == 1, 'the piece is not worked again'
        body, sentences, _words = _read(admin, s)
        assert body == 'ka ta. sa ta. sa ta.' and len(sentences) == 3, body
        row = next(r for r in admin.jobs.get(job.id)['documents'] if r['document_id'] == s.ids['dA'])
        assert row['done'] == 4 and not row.get('skipped'), row
    finally:
        s.delete()


class Crash(BaseException):
    """The worker's process dies here."""


#: Stretches of one sentence: piece s3 reads sa and deletes the sentence
#: before it, xa, which piece s2 recorded. Run again over what is left, it
#: would delete ka.
LINES = [{'words': ['ka']}, {'words': ['xa']}, {'words': ['sa']}, {'words': ['ta']}]


def _delete_before_sa(asked_pieces):
    def answer(asked, n, kwargs):
        if n > 1 or 'Your piece:' not in asked:
            return reply('Done.')
        k = targets_named(asked)[0]
        asked_pieces.append(k)
        if k > 1 and f'[s{k}] sa.' in asked:
            return reply(calls=[call(1, 'delete_sentence', {'document': 'Alpha', 'refs': [f's{k - 1}']})])
        return reply('Nothing to delete here.')
    return answer


def test_a_later_pieces_deletion_of_a_recorded_sentence_sent_again_after_a_lost_answer_deletes_nothing_more(
        monkeypatch):
    """REV-JSF-1 on a real core: piece s3's write deletes xa, which piece s2
    recorded, and its answer is lost (a proxy's 502 after the last batch).
    The same worker settles the document: xa is gone and s3's own writing
    row names it, so the write landed. Piece s3 is not run again over what
    is left, and ka stays."""
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 1)
    admin = _admin()
    writer, s = _seeded(admin, 'job-del-later', LINES)
    try:
        asked_pieces = []
        use(monkeypatch, Model(_delete_before_sa(asked_pieces)))
        real, sent = igt_job.execute_plan, []

        def execute(c, ops, **kw):
            sent.append([o['kind'] for o in ops])
            out = real(c, ops, **kw)
            if any(o['kind'] == 'delete_sentence' for o in ops) and sent.count(['delete_sentence']) == 1:
                cause = PlaidAPIError('HTTP 502 Bad Gateway', status=502, method='PATCH')
                try:
                    raise cause
                except PlaidAPIError as e:
                    raise PlanError('the answer was lost', len(ops), len(ops), unknown=True,
                                    sent=[o[ROW] for o in ops]) from e
            return out
        monkeypatch.setattr(igt_job, 'execute_plan', execute)
        job = _job(admin, writer, s, 'Delete the line before each line reading sa.', 'sentences')
        finished = run_job(job, _runner(job))
        assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
        assert sent == [['delete_sentence']], f'sent once, never again: {sent}'
        assert asked_pieces == [1, 2, 3, 3], f'piece s3 once, then ta as s3: {asked_pieces}'
        body, sentences, _words = _read(admin, s)
        assert body == 'ka. sa. ta.' and len(sentences) == 3, body
    finally:
        s.delete()


def test_a_later_pieces_deletion_of_a_recorded_sentence_that_landed_before_a_crash_is_never_made_again(monkeypatch):
    """REV-JSF-1, the crash, on a real core: the same write lands and the
    worker dies before its record. A new worker reads the records of every
    sentence the job has a writing row for, xa's included, and takes s3 as
    written because its own row names xa, which is gone. ka stays."""
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 1)
    from plaid_agent.igt.job import RECORD_FORM
    admin = _admin()
    writer, s = _seeded(admin, 'job-del-crash', LINES)
    try:
        asked_pieces = []
        use(monkeypatch, Model(_delete_before_sa(asked_pieces)))
        real, sent = igt_job.execute_plan, []

        def execute(c, ops, **kw):
            sent.append([o['kind'] for o in ops])
            return real(c, ops, **kw)
        monkeypatch.setattr(igt_job, 'execute_plan', execute)
        job = _job(admin, writer, s, 'Delete the line before each line reading sa.', 'sentences')
        real_add, s3 = job.add_decisions, s.ids['dA-s3']

        def add(decisions):
            if any(d['form'] == RECORD_FORM + s3 for d in decisions):
                raise Crash()
            return real_add(decisions)
        monkeypatch.setattr(job, 'add_decisions', add)
        with pytest.raises(Crash):
            run_job(job, _runner(job))
        monkeypatch.setattr(job, 'add_decisions', real_add)
        assert sent == [['delete_sentence']] and _read(admin, s)[0] == 'ka. sa. ta.', 'the write landed'
        # A new worker process: the rows as core has them, a new runner.
        job.rows = {x['document_id']: dict(x) for x in admin.jobs.get(job.id)['documents']}
        finished = run_job(job, _runner(job))
        assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
        assert sent == [['delete_sentence']], f'never sent again: {sent}'
        assert asked_pieces == [1, 2, 3, 3], f'piece s3 once, then ta as s3: {asked_pieces}'
        body, sentences, _words = _read(admin, s)
        assert body == 'ka. sa. ta.' and len(sentences) == 3, body
    finally:
        s.delete()


def test_a_lexicon_batch_after_a_sentence_deletion_in_the_same_write_passes_the_strict_version_check(monkeypatch):
    """REV-JS-JHFIX, not yet checked: a document piece deletes the doubled
    s2 and renames gam, which s1 links. The deletion is a text edit that
    moves the document's version, and the rename is written after it, in
    the plan's last batch, under strict mode: core takes it, the write
    lands once, and nothing is put off or proposed."""
    from plaid_client import PlaidClient
    admin = _admin()
    email = f'job-del-lex-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-delete-sentence-1', False)
    writer = PlaidClient.login(core_url(), email, 'job-delete-sentence-1')
    linked = [{'words': [('ka', [('ka', 'go', 'e-gam')], 'human')]}, {'words': ['ka']}, {'words': ['sa']}]
    s = seed(admin, job_project(), {'dA': document('dA', 'Alpha', linked)},
             {'v1': {'id': 'v1', 'name': 'Lexicon', 'project': 'p1',
                     'items': [{'id': 'e-gam', 'form': 'gam', 'metadata': {'gloss': 'go'}}]}},
             name=f'job-del-lex {uuid.uuid4().hex[:6]}')
    try:
        admin.projects.add_maintainer(s.project_id, email)

        def answer(asked, n, kwargs):
            if 'Your piece: the whole document' not in asked or n > 1:
                return reply('Deleted the doubled sentence and renamed gam.')
            return reply(calls=[call(1, 'delete_sentence', {'document': 'Alpha', 'refs': ['s2']}),
                                call(2, 'rename_entry', {'entry_id': s.ids['e-gam'], 'new_form': 'gaam'})])
        use(monkeypatch, Model(answer))
        real, sent = igt_job.execute_plan, []

        def execute(c, ops, **kw):
            sent.append(sorted(o['kind'] for o in ops))
            return real(c, ops, **kw)
        monkeypatch.setattr(igt_job, 'execute_plan', execute)
        job = _job(admin, writer, s, 'Delete the doubled sentence and rename gam to gaam.', 'document')
        finished = run_job(job, _runner(job))
        assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
        assert sent == [['delete_sentence', 'rename_entry']], f'sent once: {sent}'
        body, sentences, _words = _read(admin, s)
        assert body == 'ka. sa.' and len(sentences) == 2, body
        items = admin.vocab_layers.get(s.ids['v1'], include_items=True).get('items') or []
        assert [it['form'] for it in items] == ['gaam'], items
        row = next(r for r in admin.jobs.get(job.id)['documents'] if r['document_id'] == s.ids['dA'])
        assert row['state'] == 'done' and not row.get('skipped'), row
        assert finished['report']['proposed'] == []
    finally:
        s.delete()
