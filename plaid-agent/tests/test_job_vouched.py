"""Harmonize compares each word with what the job recorded it wrote ON THAT
WORD, and the job records a word only when it knows the document reads
exactly as it wrote it (REV-J-B3 B3-1, B3-2). A person's deletion of a
job's piece is never put back: not when the job wrote what is left of the
word elsewhere, and not when the deletion lands between the write and its
record, by any of the ways into that window (a crash, one passing error
after the write, a write of two batches refused on its second, the
moment before the lock goes)."""

from datetime import datetime, timezone

from job_fixtures import WORD_LAYER, JobClient, Model, call, document, recorded, reply, runner, start, use

from plaid_client import PlaidAPIError
from plaid_agent.core.plan import PlanError
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import RECORD_FORM

J = 'JV'


def sani(g, who=J):
    return {'form': 'sani', 'morphs': [('sa', 'go'), ('ni', g)], 'who': who}


def _iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


def _staged(monkeypatch):
    """Every op the job hands ``execute_plan``, in order."""
    seen = []
    real = igt_job.execute_plan

    def execute(client, ops, **kw):
        seen.extend(ops)
        return real(client, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    return seen


def _rewritten(staged, start=0):
    return sorted(o['word_id'] for o in staged[start:] if o.get('kind') == 'set_analysis')


def _person_edits(client, doc_id, sentences, version, clock):
    """A person's edit of the document: it now reads ``sentences``, and its
    History's newest change is theirs, as core writes it."""
    client.after_write[doc_id] = document(doc_id, 'Story', sentences, version=version)
    client._holder(doc_id)['documents'][doc_id] = document(doc_id, 'Story', sentences, version=version)
    history = client._holder(doc_id)['audit']
    newest = max((e.get('time') or '' for e in history), default='')
    when = max(_iso(clock['t']), newest)
    client._holder(doc_id)['audit'].append({'id': f'person-{len(history)}', 'time': when[:-1] + '9Z',
                                            'ref': None, 'documents': [{'id': doc_id}], 'ops': []})


BLANK = [{'words': ['sani'] * 5}]
WRITTEN = [{'words': [sani('now')] * 4 + [sani('then')]}]
DELETED = [{'words': [sani('now')] * 4 + [sani(None)]}]   # a person cleared "then" on w5


def _gloss(asked, n, kwargs):
    """sa-ni 'go-now' on w1 to w4, 'go-then' on w5."""
    if n > 1:
        return reply('Done.')
    return reply(calls=[call(i, 'set_analysis', {'document': 'Story', 'ref': f's1.w{i}', 'morphemes': [
        {'form': 'sa', 'fields': {'Morph Gloss': 'go'}},
        {'form': 'ni', 'fields': {'Morph Gloss': 'then' if i == 5 else 'now'}}]}) for i in range(1, 6)])


def _job(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', BLANK)})
    client.after_write['d1'] = document('d1', 'Story', WRITTEN, version=2)
    clock = {'t': 1_800_000_000.0}

    def sleep(s):
        clock['t'] += s
    job = start(client, ['gloss'], id=J, now=lambda: clock['t'])
    job._sleep = sleep
    job.job['created_at'] = _iso(clock['t'] - 3600)
    use(monkeypatch, Model(_gloss))
    return client, job, clock


def _mark(client, sentence_id='d1-s1'):
    rows = [r for r in client.jobs.decisions(J) if r['form'] == RECORD_FORM + sentence_id]
    assert len(rows) == 1, rows
    import json
    return json.loads(rows[0]['analysis'])


class Crash(BaseException):
    """The worker's process dies here."""


# --- B3-1: the record is per word, not per form ------------------------------------

def test_a_gloss_a_person_deleted_is_not_put_back_when_the_job_wrote_that_shape_elsewhere(monkeypatch):
    """The job wrote sa-ni 'go-now' six times and once left -ni unglossed. A
    person clears "now" on one of the six: that word is now the job's other
    recorded analysis of the form, and it is still not the job's to change."""
    staged = _staged(monkeypatch)
    before = [{'words': [sani('now')] * 6 + [sani(None)]}]
    after = [{'words': [sani('now')] * 5 + [sani(None), sani(None)]}]
    client = JobClient({'d1': document('d1', 'Story', before)})
    job = start(client, ['gloss'], id=J)
    job.update_row('d1', state='done')
    recorded(job)
    client._holder('d1')['documents']['d1'] = document('d1', 'Story', after)
    out = runner(job).harmonize(job)
    assert _rewritten(staged) == ['d1-s1w7'], 'the job\'s own minority word is still made consistent'
    assert {'form': 'sani', 'reason': 'touched', 'analyses': [{'analysis': 'sa-ni ‘go-_’', 'count': 1}]} \
        in out['left']


def test_a_link_a_person_removed_is_not_put_back_when_the_job_left_that_form_unlinked_elsewhere(monkeypatch):
    from fixtures import lexicon_raw
    staged = _staged(monkeypatch)

    def gam(entry):
        return {'form': 'gam', 'morphs': [('gam', 'fish', entry)] if entry else [('gam', 'fish')], 'who': J}
    before = [{'words': [gam('vi-gam')] * 5 + [gam(None)]}]
    after = [{'words': [gam('vi-gam')] * 4 + [gam(None), gam(None)]}]   # a person unlinked w5
    client = JobClient({'d1': document('d1', 'Story', before)}, lexicon=lexicon_raw())
    job = start(client, ['gloss', 'link'], id=J)
    job.update_row('d1', state='done')
    recorded(job)
    client._holder('d1')['documents']['d1'] = document('d1', 'Story', after)
    runner(job).harmonize(job)
    touched = [(o.get('kind'), o.get('word_id') or o.get('analysis_word_id') or o.get('token_id')) for o in staged]
    assert ('set_analysis', 'd1-s1w5') not in touched
    assert not any(x and x.startswith('d1-s1w5') for k, x in touched if k == 'link'), touched
    assert ('set_analysis', 'd1-s1w6') in touched, 'the job\'s own unlinked word is linked as the majority'


def test_a_word_is_known_by_its_id_so_a_word_put_in_before_it_changes_nothing(monkeypatch):
    """A person puts a word in front of the job's words (a correction of the
    text): the record follows each word, not the place it stands in."""
    staged = _staged(monkeypatch)
    before = [{'words': [sani('now')] * 4 + [sani('then')]}]
    client = JobClient({'d1': document('d1', 'Story', before)})
    job = start(client, ['gloss'], id=J)
    job.update_row('d1', state='done')
    recorded(job)
    shifted = document('d1', 'Story', [{'words': ['oh'] + [sani('now')] * 4 + [sani('then')]}])
    layers = shifted['text_layers'][0]['token_layers']
    words = next(tl for tl in layers if tl['id'] == WORD_LAYER)['tokens']

    def renamed(token_id):
        # The fixture names words by place: give each its old id back, the
        # new word w1 an id of its own.
        import re
        m = re.match(r'd1-s1w(\d+)(.*)', token_id)
        if not m:
            return token_id
        i = int(m.group(1))
        return ('d1-s1w0' if i == 1 else f'd1-s1w{i - 1}') + m.group(2)
    for layer in layers:
        for t in layer['tokens']:
            t['id'] = renamed(t['id'])
        for sl in layer.get('span_layers') or []:
            for sp in sl['spans']:
                sp['tokens'] = [renamed(t) for t in sp['tokens']]
        for v in layer.get('vocabs') or []:
            for link in v['vocab_links']:
                link['tokens'] = [renamed(t) for t in link['tokens']]
    assert [t['id'] for t in words] == ['d1-s1w0', 'd1-s1w1', 'd1-s1w2', 'd1-s1w3', 'd1-s1w4', 'd1-s1w5']
    client._holder('d1')['documents']['d1'] = shifted
    runner(job).harmonize(job)
    assert _rewritten(staged) == ['d1-s1w5'], 'the job\'s minority word, where it now stands'


def test_a_word_whose_spelling_changed_under_the_jobs_analysis_is_left(monkeypatch):
    staged = _staged(monkeypatch)
    client = JobClient({'d1': document('d1', 'Story', [{'words': [sani('now')] * 4 + [sani('then')]}])})
    job = start(client, ['gloss'], id=J)
    job.update_row('d1', state='done')
    recorded(job)
    respelt = {**sani('then'), 'form': 'sanni'}
    client._holder('d1')['documents']['d1'] = document('d1', 'Story', [{'words': [sani('now')] * 4 + [respelt]}])
    runner(job).harmonize(job)
    assert _rewritten(staged) == []


def test_harmonize_asks_the_word_again_under_the_lock(monkeypatch):
    """A person deletes the gloss between harmonize's look and its lock, to
    a shape the job recorded elsewhere: left, not rewritten."""
    staged = _staged(monkeypatch)
    before = [{'words': [sani('now')] * 6 + [sani('then'), sani(None)]}]
    client = JobClient({'d1': document('d1', 'Story', before)})
    job = start(client, ['gloss'], id=J)
    job.update_row('d1', state='done')
    recorded(job)
    client.on_lock['d1'] = document('d1', 'Story', [{'words': [sani('now')] * 6 + [sani(None), sani(None)]}])
    out = runner(job).harmonize(job)
    assert 'd1-s1w7' not in _rewritten(staged)
    assert any(x['form'] == 'sani' and x['reason'] == 'touched' for x in out['left']), out


# --- B3-2: a word is recorded only from the job's own write ----------------------------

def test_a_stretch_records_a_key_for_each_word_it_wrote(monkeypatch):
    client, job, clock = _job(monkeypatch)
    assert runner(job).document('d1') == 'done'
    words = _mark(client)['words']
    assert sorted(words) == sorted(igt_job.word_tag(f'd1-s1w{i}') for i in range(1, 6))
    staged = _staged(monkeypatch)
    runner(job).harmonize(job)
    assert _rewritten(staged) == ['d1-s1w5'], 'its own work is still made consistent'


def test_a_person_editing_under_the_lock_after_the_jobs_last_batch_is_not_recorded_as_the_job(monkeypatch):
    """The moment between the job's last batch and the read for its record:
    the starter's own browser may write then, under the job's lock. The
    document's version moved past the job's own write, so no word of the
    stretch is vouched for."""
    client, job, clock = _job(monkeypatch)
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        out = real(c, ops, **kw)
        # The job's write left version 2, and the read for its record finds 3,
        # the person's, under the job's lock.
        client.after_write['d1'] = document('d1', 'Story', DELETED, version=3)
        return out
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    assert runner(job).document('d1') == 'done'
    mark = _mark(client)
    assert not mark.get('words') and mark['counts']['words'] == 5
    assert not [r for r in client.jobs.decisions(J) if r['form'] == 'sani'], 'no precedent from it either'
    staged = _staged(monkeypatch)
    out = runner(job).harmonize(job)
    assert _rewritten(staged) == []
    assert any(x['reason'] == 'touched' for x in out['left'])


def test_a_crash_before_the_record_and_a_persons_deletion_before_the_resume(monkeypatch):
    client, job, clock = _job(monkeypatch)
    real = job.add_decisions

    def crash(decisions):
        raise Crash()
    monkeypatch.setattr(job, 'add_decisions', crash)
    try:
        runner(job).document('d1')
    except Crash:
        pass
    monkeypatch.setattr(job, 'add_decisions', real)
    clock['t'] += 3600   # the worker comes back an hour later
    _person_edits(client, 'd1', DELETED, 3, clock)
    clock['t'] += 3600
    job.rows = {r['document_id']: dict(r) for r in client.jobs.get(J)['documents']}
    assert runner(job).document('d1') == 'done'
    assert not _mark(client).get('words')
    staged = _staged(monkeypatch)
    runner(job).harmonize(job)
    assert _rewritten(staged) == [], 'the deletion is not put back'


def test_a_crash_before_the_record_with_nobody_writing_since_is_recorded_whole(monkeypatch):
    client, job, clock = _job(monkeypatch)
    real = job.add_decisions

    def crash(decisions):
        raise Crash()
    monkeypatch.setattr(job, 'add_decisions', crash)
    try:
        runner(job).document('d1')
    except Crash:
        pass
    monkeypatch.setattr(job, 'add_decisions', real)
    job.rows = {r['document_id']: dict(r) for r in client.jobs.get(J)['documents']}
    assert runner(job).document('d1') == 'done'
    assert len(_mark(client)['words']) == 5, 'the newest change is the job\'s own glossing'
    staged = _staged(monkeypatch)
    runner(job).harmonize(job)
    assert _rewritten(staged) == ['d1-s1w5']


def test_one_passing_error_after_the_write_and_a_persons_deletion_in_the_wait(monkeypatch):
    """The record's call meets one 502, and the person's edit lands in the
    30 s the worker waits before it takes the document again."""
    client, job, clock = _job(monkeypatch)
    real = client.jobs.add_decisions
    calls = {'n': 0}

    def add(*a, **kw):
        calls['n'] += 1
        if calls['n'] == 1:
            raise PlaidAPIError('HTTP 502', status=502)
        return real(*a, **kw)
    client.jobs.add_decisions = add
    real_sleep = job._sleep

    def sleep(s):
        if calls['n'] == 1 and 'd1' in client.after_write and client.after_write['d1']['version'] == 2:
            _person_edits(client, 'd1', DELETED, 3, clock)
        real_sleep(s)
    job._sleep = sleep
    assert runner(job).document('d1') in ('done', 'deferred')
    clock['t'] += 3600
    assert runner(job).document('d1') == 'done'
    assert not _mark(client).get('words')
    staged = _staged(monkeypatch)
    runner(job).harmonize(job)
    assert _rewritten(staged) == []


def test_a_write_refused_on_its_second_batch_is_put_off_and_never_vouched_for(monkeypatch):
    """A stretch of two sentences written in two batches: s1's lands, s2's
    is refused, the starter having typed in s3 meanwhile. The document is
    put off, s2 is not written again at once, and when the document comes
    back the person's edit is its newest change: what the job wrote in s1
    is recorded without its keys, whatever the person did to it."""
    human = {'form': 'ka', 'morphs': [('ka', 'go')], 'who': 'human'}
    blank = [{'words': ['sani', 'sani']}, {'words': ['sani', 'sani']}, {'words': [human]}]
    typed = {'form': 'ka', 'morphs': [('ka', 'went')], 'who': 'human'}
    client = JobClient({'d1': document('d1', 'Story', blank)})
    clock = {'t': 1_800_000_000.0}
    job = start(client, ['gloss'], id=J, now=lambda: clock['t'])
    job._sleep = lambda s: clock.__setitem__('t', clock['t'] + s)
    job.job['created_at'] = _iso(clock['t'] - 3600)

    def model(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        return reply(calls=[call(i, 'set_analysis', {'document': 'Story', 'ref': ref, 'morphemes': [
            {'form': 'sa', 'fields': {'Morph Gloss': 'go'}}, {'form': 'ni', 'fields': {'Morph Gloss': 'now'}}]})
            for i, ref in enumerate(['s1.w1', 's1.w2', 's2.w1', 's2.w2'], start=1)])
    use(monkeypatch, Model(model))
    from plaid_agent.core import plan
    budget = plan.TrackingBatcher.__init__.__defaults__
    monkeypatch.setattr(plan.TrackingBatcher.__init__, '__defaults__', (2,) + budget[1:])
    from plaid_client import testing
    real, n = testing._Batch.submit, {'n': 0}

    def submit(self):
        n['n'] += 1
        if n['n'] == 2:
            # The starter typed in s3 just before: newest in History, and
            # older than the quiet window by the time anyone looks.
            done = [{'words': [sani('now'), sani('now')]}, {'words': ['sani', 'sani']}, {'words': [typed]}]
            _person_edits(client, 'd1', done, 3, {'t': clock['t'] - 700})
            raise PlaidAPIError('HTTP 409 version', status=409)
        return real(self)
    monkeypatch.setattr(testing._Batch, 'submit', submit)
    landed = len(client.batches)
    assert runner(job).document('d1') == 'deferred'
    assert len(client.batches) - landed == 1, 'the first batch landed, and nothing was sent again at once'
    # Back later: the person cleared the gloss of -ni on s1.w2 meanwhile.
    clock['t'] += 3600
    cleared = [{'words': [sani('now'), sani(None)]}, {'words': ['sani', 'sani']}, {'words': [typed]}]
    _person_edits(client, 'd1', cleared, 4, {'t': clock['t'] - 700})
    monkeypatch.setattr(testing._Batch, 'submit', real)
    real_execute = igt_job.execute_plan

    def execute(c, ops, **kw):
        # What the job's write of s2 leaves.
        client.after_write['d1'] = document('d1', 'Story', [{'words': [sani('now'), sani(None)]},
                                                            {'words': [sani('now'), sani('now')]},
                                                            {'words': [typed]}], version=5)
        return real_execute(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    assert runner(job).document('d1') == 'done'
    assert not _mark(client, 'd1-s1').get('words'), 's1 is not vouched for'
    assert len(_mark(client, 'd1-s2')['words']) == 2, 's2 was written whole under one lock'


def test_a_write_refused_before_anything_landed_is_sent_once_more_and_vouched_for(monkeypatch):
    client, job, clock = _job(monkeypatch)
    real = igt_job.execute_plan
    left = {'n': 1}

    def execute(c, ops, **kw):
        if left['n']:
            left['n'] -= 1
            try:
                raise PlaidAPIError('HTTP 409 version', status=409)
            except PlaidAPIError as e:
                raise PlanError('moved', 0, len(ops)) from e
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    assert runner(job).document('d1') == 'done'
    assert len(_mark(client)['words']) == 5


# --- the record's size ----------------------------------------------------------------

def test_a_record_cuts_the_blanks_first_and_then_the_words():
    left = [{'ref': f's1.w{i}', 'begin': i, 'form': 'x' * 30} for i in range(60)]
    words = {f'{i:012d}': 'a' * 12 for i in range(200)}
    text = igt_job.mark_text({'left': 60}, 'd1', left, words)
    import json
    mark = json.loads(text)
    assert len(text) <= 4000 and mark['left'] == [] and 0 < len(mark['words']) < 200
    small = json.loads(igt_job.mark_text({'left': 1}, 'd1', left[:1], dict(list(words.items())[:3])))
    assert len(small['left']) == 1 and len(small['words']) == 3
