"""A job's try is exactly one request (BRIEF RX-FIX): what the executor sends
as one request is one try, a write's whole manifest is in core before its
first request, and after a lost answer or a crash every change of every write
is exactly one of: landed and counted, a target again (the piece taken again
over its sentence, the model asked again), or listed among the report's
proposed changes as not written. The reviewer's probes (REV-RX-1 to -3, and
REV-JSF-1's shape) and a property over random plans."""

import copy
import json
import random

import pytest

from fixtures import lexicon_raw
from job_fixtures import JobClient, Model, call, document, reply, runner, start, targets_named, use

from plaid_client import PlaidAPIError, testing
from plaid_agent.igt import job as igt_job
from plaid_agent.igt import plan as igt_plan
from plaid_agent.igt.job import INTERRUPTED, WRITING_FORM
from test_job_vouched import _iso

J = 'JT'


class Crash(BaseException):
    """The worker's process dies here."""


def _job(monkeypatch, sentences, model, instructions='Do as asked.', plan='sentences', lexicon=None):
    client = JobClient({'d1': document('d1', 'Story', sentences)}, lexicon=lexicon)
    clock = {'t': 1_800_000_000.0}
    job = start(client, instructions, id=J, now=lambda: clock['t'], plan=plan)
    job._sleep = lambda s: clock.__setitem__('t', clock['t'] + s)
    job.job['created_at'] = _iso(clock['t'] - 3600)
    m = use(monkeypatch, Model(model))
    return client, job, m


def _batches(monkeypatch):
    """The sub-op kinds of each batch sent, in order."""
    sent, real = [], testing._Batch.submit

    def submit(self):
        sent.append(sorted({k for k, _ in self.queued}))
        return real(self)
    monkeypatch.setattr(testing._Batch, 'submit', submit)
    return sent


def _once(answer):
    """A model that stages ``answer(asked)`` on a piece's first call."""
    def model(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        return reply(calls=answer(asked))
    return model


def _run(r, document_id='d1', tries=6):
    out = None
    for _ in range(tries):
        out = r.document(document_id)
        if out == 'done':
            return out
    return out


def _rows(client):
    return [json.loads(x['analysis']) for (f, _), x in client.jobs.decision_rows[J].items() if f.startswith(WRITING_FORM)]


# --- REV-RX-1 and -2: what the executor sends as one request is one try ---------------------

def test_a_value_on_a_word_and_the_merge_of_that_word_are_two_tries_and_both_are_written(monkeypatch):
    """REV-RX-1, probe 1: a gloss on s1.w1 and the merge of s1.w1 with
    s1.w2. The executor writes the gloss in a request before the merge, so
    the gloss is a try of its own: two requests, the merge made, both
    counted."""
    client, job, _m = _job(monkeypatch, [{'words': ['ka', 'ta']}, {'words': ['sa']}], _once(lambda asked: [
        call(1, 'set_field', {'document': 'Story', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'X'}),
        call(2, 'merge_words', {'document': 'Story', 'refs': ['s1.w1', 's1.w2']})]
        if targets_named(asked) == [1, 2] else []), plan='document')
    sent = _batches(monkeypatch)
    assert _run(runner(job)) == 'done'
    assert sent == [['spans.create'], ['tokens.merge']], sent
    assert len(client.landed_keys) == 2 and all(k.endswith('.0') for k in client.landed_keys)
    assert job.rows['d1']['counts']['changes'] == 2 and not job.rows['d1'].get('skipped')


def _lexicon_with_a_sense():
    lex = copy.deepcopy(lexicon_raw())
    lex['items'].append({'id': 'vi-ali-s1', 'form': 'Ali', 'metadata': {'gloss': 'Ali (name)', 'parent': 'vi-ali',
                                                                        'senseOrder': 1}})
    return lex


@pytest.mark.parametrize('with_gloss', [False, True], ids=['alone', 'beside-a-gloss'])
def test_an_entry_delete_and_the_repairs_it_carries_are_one_request(monkeypatch, with_gloss):
    """REV-RX-1 and -2, probe 2: the delete of an entry with a sense frees
    the sense (a repair, ``REPAIR_OF``) in the delete's own request, as
    before RX (R1-3): the sense is never freed by a request of its own."""
    def answer(asked):
        calls = [call(1, 'delete_entry', {'entry_id': 'vi-ali'})]
        if with_gloss:
            calls.insert(0, call(2, 'set_field', {'document': 'Story', 'refs': ['s1.w1'], 'field': 'Gloss',
                                                  'value': 'X'}))
        return calls
    client, job, _m = _job(monkeypatch, [{'words': ['ka', 'ta']}], _once(answer), instructions='Delete Ali.',
                           lexicon=_lexicon_with_a_sense())
    sent = _batches(monkeypatch)
    r = runner(job)
    r._maintains = True
    assert _run(r) == 'done'
    lexicon = ['vocab_items.delete', 'vocab_items.patch_metadata']
    assert sent == ([['spans.create'], lexicon] if with_gloss else [lexicon]), sent
    counts = job.rows['d1']['counts']
    assert counts['deletions'] == 1 and counts['changes'] == (3 if with_gloss else 2), counts


# --- REV-RX-3: a write cut short after a try that covered the piece --------------------------

def _lost_first(monkeypatch, n=1):
    """The ``n``th batch lands and its answer is lost."""
    real, seen = testing._Batch.submit, []

    def submit(self):
        out = real(self)
        seen.append(True)
        if len(seen) == n:
            raise PlaidAPIError('HTTP 502 Bad Gateway', status=502, method='POST')
        return out
    monkeypatch.setattr(testing._Batch, 'submit', submit)


def test_a_rename_after_a_try_that_covered_the_piece_is_listed_not_lost(monkeypatch):
    """REV-RX-3, probe 3: a one-sentence document piece glosses ka and
    renames gam. The gloss lands and its answer is lost: the piece is not
    asked again (its sentence is written), the rename is never sent, and it
    is listed among the report's proposed changes as not written, and
    counted there."""
    client, job, m = _job(monkeypatch, [{'words': ['ka']}], _once(lambda asked: [
        call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1', 'morphemes': [
            {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]}),
        call(2, 'rename_entry', {'entry_id': 'vi-gam', 'new_form': 'gaam'})]), plan='document')
    _lost_first(monkeypatch)
    r = runner(job)
    r._maintains = True
    assert _run(r) == 'done'
    assert not any(k == 'vocab_items.update' for b in client.batches for k, _ in b), 'the rename is never sent'
    assert len([c for c in m.calls if c['n'] == 1]) == 1, 'the piece is not asked again'
    parts = r.report_parts(job)
    assert [(c['kind'], c['reason']) for c in parts['proposed']] == [('rename_entry', INTERRUPTED)], parts['proposed']
    assert job.rows['d1']['counts']['words'] == 1


def test_a_context_sentence_deletion_after_a_lost_gloss_is_listed(monkeypatch):
    """REV-RX-3 in REV-JSF-1's shape, probe 4: stretches of one, piece s3
    glosses s3 and deletes s2, the gloss lands and its answer is lost. No
    deletion is ever sent, s3's piece is not asked again, and the deletion
    is listed as not written."""
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 1)

    def answer(asked):
        k = targets_named(asked)[0]
        calls = [call(1, 'set_analysis', {'document': 'Story', 'ref': f's{k}.w1', 'morphemes': [
            {'form': 'x', 'fields': {'Morph Gloss': 'go'}}]})]
        if k == 3:
            calls.append(call(2, 'delete_sentence', {'document': 'Story', 'refs': ['s2']}))
        return calls
    client, job, m = _job(monkeypatch, [{'words': ['ka']}, {'words': ['sa']}, {'words': ['sa']}, {'words': ['ta']}],
                          _once(answer))
    edits = []
    monkeypatch.setattr(client.texts, 'edit', lambda *a, **k: edits.append(a))
    _lost_first(monkeypatch, 3)
    r = runner(job)
    assert _run(r) == 'done'
    assert edits == [], 'the deletion is never sent'
    assert [targets_named(c['asked']) for c in m.calls if c['n'] == 1] == [[1], [2], [3], [4]]
    listed = r.report_parts(job)['proposed']
    assert [(c['kind'], c['ref'], c['reason']) for c in listed] == [('delete_sentence', 's2', INTERRUPTED)], listed


@pytest.mark.parametrize('how', ['lost', 'crash'])
def test_a_comment_only_try_that_landed_is_never_posted_again(monkeypatch, how):
    """REV-RX-4: core audits no comment, so a try of comments alone leaves
    no operation. Core answers its key from the answers it keeps of keyed
    writes, for a day: after a lost answer or a crash the comment is known
    to have landed, posted once, and the model asked once."""
    client, job, m = _job(monkeypatch, [{'words': ['ka']}], _once(lambda asked: [
        call(1, 'add_comment', {'document': 'Story', 'ref': 's1', 'body': 'Check this sentence.'})]),
        plan='document')
    real = testing._Batch.submit

    def submit(self):
        out = real(self)
        if len(client.batches) == 1:
            if how == 'crash':
                raise Crash()
            raise PlaidAPIError('HTTP 502 Bad Gateway', status=502, method='POST')
        return out
    monkeypatch.setattr(testing._Batch, 'submit', submit)
    r = runner(job)
    if how == 'crash':
        with pytest.raises(Crash):
            r.document('d1')
        job.rows = {x['document_id']: dict(x) for x in client.jobs.get(J)['documents']}
        r = runner(job)
    assert _run(r) == 'done'
    assert [sorted({k for k, _ in b}) for b in client.batches] == [['comments.create']], 'posted once'
    assert len([c for c in m.calls if c['n'] == 1]) == 1, 'the model asked once'
    assert r.report_parts(job)['proposed'] == []


def _retype(monkeypatch, text, crash_after):
    """A document piece retypes s1 as ``text``, the worker dying just after
    the ``crash_after``-th request of the job landed (the edit, ``.0``, or
    the record of the piece once its write is done), then a new worker."""
    monkeypatch.setattr(igt_plan, '_composed_as', lambda body, stored: (body, lambda p: p))
    client, job, m = _job(monkeypatch, [{'words': ['ka', 'ta']}], _once(lambda asked: [
        call(1, 'retype_sentence', {'document': 'Story', 'ref': 's1', 'text': text})]), plan='document')
    client.texts.edit = lambda *a, **kw: client.record('texts.edit', {'args': a, 'kwargs': kw})
    real, n = client._landed_write, {'n': 0}

    def landed_write(*a, **kw):
        real(*a, **kw)
        n['n'] += 1
        if n['n'] == crash_after:
            raise Crash()
    client._landed_write = landed_write
    real_record = igt_job.IgtRunner.record

    def record(self, *a, **kw):
        if crash_after == 'record':
            raise Crash()
        return real_record(self, *a, **kw)
    monkeypatch.setattr(igt_job.IgtRunner, 'record', record)
    with pytest.raises(Crash):
        runner(job).document('d1')
    monkeypatch.setattr(igt_job.IgtRunner, 'record', real_record)
    client._landed_write = real
    job.rows = {x['document_id']: dict(x) for x in client.jobs.get(J)['documents']}
    r = runner(job)
    assert _run(r) == 'done'
    return client, r.report_parts(job)['proposed'], m


def test_a_text_edits_follow_up_cut_off_by_a_crash_is_listed(monkeypatch):
    """REV-RX-5: a retype whose new line calls for a sentence break. The
    edit lands and the worker dies before its follow-up (the break, ``.1``):
    the follow-up is named in the manifest, looked up, and listed as not
    written. The edit is not made again, and the piece is not asked again."""
    client, listed, m = _retype(monkeypatch, 'ka\nta', 1)
    assert [k for k, _ in client.calls if k == 'texts.edit'] == ['texts.edit'], 'the edit once'
    assert [(c['kind'], c['label'], c['reason']) for c in listed] == [
        ('edit_text', igt_job.FOLLOW_UP_LABEL, INTERRUPTED)], listed
    assert len([c for c in m.calls if c['n'] == 1]) == 1


def test_a_text_edit_that_called_for_no_follow_up_is_never_listed(monkeypatch):
    """A retype with no new line calls for no follow-up: a row says so once
    the edit landed, so a worker taken up later lists nothing."""
    client, listed, _m = _retype(monkeypatch, 'ka to', 'record')
    assert listed == []
    assert not any(k == 'tokens.split' for b in client.batches for k, _ in b)


def test_the_whole_manifest_is_in_core_before_the_first_request(monkeypatch):
    """Every try's rows, the lexicon's too, are in core when the first
    request of the write goes out."""
    client, job, _m = _job(monkeypatch, [{'words': ['ka']}], _once(lambda asked: [
        call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1', 'morphemes': [
            {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]}),
        call(2, 'rename_entry', {'entry_id': 'vi-gam', 'new_form': 'gaam'})]), plan='document')
    at_first = []
    real = igt_job.IgtRunner.sending

    def sending(self, w, seed):
        if not at_first:
            at_first.append(_rows(client))
        return real(self, w, seed)
    monkeypatch.setattr(igt_job.IgtRunner, 'sending', sending)
    r = runner(job)
    r._maintains = True
    assert _run(r) == 'done'
    tries = {row['try'] for row in at_first[0] if row['try']}
    assert len(tries) == 2, at_first
    assert any(row.get('loose') and [o['kind'] for o in row.get('ops') or []] == ['rename_entry']
               for row in at_first[0])


# --- the property: random plans, every op kind the rule applies ------------------------------

SENTENCES = [{'words': ['ka', 'ta', 'sa']}, {'words': ['pa', 'ma']}, {'words': ['ka', 'ta']}]


def _calls(rng, k):
    """Up to four tool calls a piece over sentence ``k`` might stage, drawn
    from every kind the apply rule applies, in any order."""
    words = SENTENCES[k - 1]['words']
    w = rng.randrange(1, len(words) + 1)
    other = rng.choice([i for i in range(1, len(SENTENCES) + 1) if i != k])
    kinds = [
        ('set_field', {'document': 'Story', 'refs': [f's{k}.w{w}'], 'field': 'Gloss', 'value': 'X'}),
        ('set_field', {'document': 'Story', 'refs': [f's{k}'], 'field': 'Translation', 'value': 'T'}),
        ('set_analysis', {'document': 'Story', 'ref': f's{k}.w{w}', 'morphemes': [
            {'form': words[w - 1], 'fields': {'Morph Gloss': 'go'}}]}),
        ('add_comment', {'document': 'Story', 'ref': f's{k}', 'body': 'Check.'}),
        ('merge_words', {'document': 'Story', 'refs': [f's{k}.w1', f's{k}.w2']}),
        ('split_word', {'document': 'Story', 'ref': f's{k}.w1', 'at': '1'}),
        ('delete_word', {'document': 'Story', 'refs': [f's{k}.w{len(words)}']}),
        ('split_sentence', {'document': 'Story', 'ref': f's{k}', 'before_word': 2}),
        ('delete_sentence', {'document': 'Story', 'refs': [f's{other}']}),
        ('retype_sentence', {'document': 'Story', 'ref': f's{k}', 'text': ' '.join(words) + 'x'}),
        ('respell', {'document': 'Story', 'ref': f's{k}.w{w}', 'new_text': words[w - 1] + 'a'}),
        ('link_entry', {'document': 'Story', 'refs': [f's{k}.w{w}'], 'entry_id': 'vi-gam'}),
        ('unlink_entry', {'document': 'Story', 'refs': [f's{k}.w{w}']}),
        ('link_phrase', {'document': 'Story', 'refs': [f's{k}.w1', f's{k}.w2'], 'entry_id': 'vi-ali'}),
        ('set_entry_field', {'entry_id': 'vi-gam', 'field': 'gloss', 'value': f'fish{k}'}),
        ('create_entry', {'form': f'zu{k}', 'fields': {'gloss': 'z'}}),
        ('rename_entry', {'entry_id': 'vi-gam', 'new_form': f'gaam{k}'}),
        ('delete_entry', {'entry_id': 'vi-ali'}),
        ('merge_entries', {'keep_id': 'vi-gam', 'remove_id': 'vi-gam2'}),
    ]
    if k > 1:
        kinds.append(('merge_sentences', {'document': 'Story', 'ref': f's{k}'}))
    return [call(i, *rng.choice(kinds)) for i in range(1, rng.randrange(1, 5) + 1)]


class World:
    """One job over SENTENCES whose pieces stage random plans (seeded by the
    plan's seed and the piece), with what every write and request did
    recorded: the writes and their tries (``writes``), the ops each try sent
    (``applied``), each request that landed, by key, in order (the fake's
    ``landed_keys``), and every model call."""

    def __init__(self, monkeypatch, seed, fail=None):
        monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 1)
        # The fake keeps the text as it was: the edit's follow-up is worked
        # out over the body the edit was made from.
        monkeypatch.setattr(igt_plan, '_composed_as', lambda body, stored: (body, lambda p: p))

        def answer(asked, n, kwargs):
            if n > 1 or 'Your piece: s' not in asked:
                return reply('Done.')
            k = targets_named(asked)[0]
            return reply(calls=_calls(random.Random(seed * 100 + k), k))
        self.client, self.job, self.model = _job(monkeypatch, copy.deepcopy(SENTENCES), answer,
                                                 lexicon=_lexicon_with_a_sense())
        self.client.texts.edit = lambda *a, **kw: self.client.record('texts.edit', {'args': a, 'kwargs': kw})
        self.client.texts.update = lambda *a, **kw: self.client.record('texts.update', {'args': a, 'kwargs': kw})
        self.writes, self.applied, self.sent_after = [], [], []
        self.fail, self.failed = fail, None
        world = self
        real_manifest, real_apply = igt_job.IgtRunner.manifest, igt_job.IgtRunner.apply

        def manifest(r, w, queue=()):
            world.writes.append((w, [(t['seed'], t['ops']) for t in queue], len(world.model.calls)))
            return real_manifest(r, w, queue)

        def apply(r, client, project, document_id, group, kept, seed, w):
            before = len(world.client.landed_keys)
            world.applied.append((w.id, seed, list(kept)))
            try:
                return real_apply(r, client, project, document_id, group, kept, seed, w)
            except BaseException:
                # Raised after a request of the try went out (a fault of the
                # cut, never one injected after the request itself).
                if len(world.client.landed_keys) > before and world.failed is None:
                    world.sent_after.append(seed)
                raise
            finally:
                mine = [k for k in world.client.landed_keys[before:] if k.startswith(seed)]
                assert len(mine) <= (2 if any(o['kind'] == 'edit_text' for o in kept) else 1), (seed, mine, kept)
        monkeypatch.setattr(igt_job.IgtRunner, 'manifest', manifest)
        monkeypatch.setattr(igt_job.IgtRunner, 'apply', apply)
        real_landed = self.client._landed_write

        def landed_write(*a, **kw):
            real_landed(*a, **kw)
            if world.fail is not None and world.failed is None and len(world.client.landed_keys) == world.fail[0]:
                world.failed = world.client.landed_keys[-1]
                if world.fail[1] == 'crash':
                    raise Crash()
                raise PlaidAPIError('HTTP 502 Bad Gateway', status=502, method='POST')
        self.client._landed_write = landed_write

    def run(self):
        r = runner(self.job)
        r._maintains = True
        for _ in range(12):
            try:
                if r.document('d1') == 'done':
                    return r
            except Crash:
                # A new worker process: the rows as core has them, a new runner.
                self.job.rows = {x['document_id']: dict(x) for x in self.client.jobs.get(J)['documents']}
                r = runner(self.job)
                r._maintains = True
        raise AssertionError('the job did not end')


PLANS = range(40)


@pytest.mark.parametrize('seed', PLANS)
def test_every_try_of_a_random_plan_is_one_request_and_the_tries_cover_its_ops_once(monkeypatch, seed):
    """Every write's tries hold each of its ops exactly once (an entry
    created again for a later try aside), each try sends one request (a
    text edit two at most), and nothing is raised after a request of a try
    went out."""
    world = World(monkeypatch, seed)
    world.run()
    assert world.writes
    for w, tries, _ in world.writes:
        held = [o for _, ops in tries for o in ops if id(o) not in w.again]
        assert sorted(map(id, held)) == sorted(map(id, w.ops)), 'each op in exactly one try'
    assert world.sent_after == []
    assert len(set(world.client.landed_keys)) == len(world.client.landed_keys), 'no request twice'


def _fates(world, r):
    """The write a request of which was cut, and for each of its ops
    ``(kind, own, landed, redone, listed, asked)``: whether it writes in one
    of the write's own sentences, whether its try's request is in core,
    whether a later write of the job made the same change and landed, whether
    the report's proposed changes list it as not written, and whether the
    model was asked again over its sentence (over the piece, for an op in
    no sentence of the piece)."""
    seed = world.failed.rsplit('.', 1)[0]
    w, tries, asked_before = next((w, t, a) for w, t, a in world.writes
                                  if any(s == seed for s, _ in t)
                                  or any(x[0] == w.id and x[1] == seed for x in world.applied))
    where = {id(o): s for s, ops in tries for o in ops}
    for wid, s, ops in world.applied:
        if wid == w.id:
            where.update({id(o): s for o in ops})
    listed = [c for c in r.report_parts(world.job)['proposed'] if c.get('reason') == INTERRUPTED]
    later = [set(targets_named(c['asked'])) for c in world.model.calls[asked_before:] if c['n'] == 1
             and 'Your piece: s' in c['asked']]
    piece = {s.index for s in w.st.doc.sentences if s.id in w.own}
    # The changes a later write of the job made and that landed (the piece
    # taken again staged them again): such a change is written, not listed.
    redone = {(o['kind'], o.get('label')) for wid, s, ops in world.applied
              if wid != w.id and f'{s}.0' in world.client.landed_keys for o in ops}
    out = []
    for o in w.ops:
        s = w.sentence_of(o)
        own = s is not None and s.id in w.own
        d = w.describe(o, s is not None)
        out.append((o['kind'], own, f'{where[id(o)]}.0' in world.client.landed_keys,
                    (o['kind'], o.get('label')) in redone,
                    any((c['kind'], c.get('ref'), c.get('label')) == (d['kind'], d.get('ref'), d.get('label'))
                        for c in listed),
                    any((s.index if own else None) in t or (not own and t & piece) for t in later)))
    return out


@pytest.mark.parametrize('how', ['lost', 'crash'])
@pytest.mark.parametrize('seed', PLANS)
def test_after_a_cut_after_any_request_every_change_is_landed_a_target_again_or_listed(monkeypatch, seed, how):
    """THE RULE, as a property: a random plan's job, cut after each of its
    requests in turn (its answer lost, or the worker dead), ends with every
    change of the write cut exactly one of landed, a target again, or
    listed, and no request sent twice: a change that landed is never listed,
    one in a sentence of the piece is listed or its sentence asked again,
    never both, and any other is listed, or made by a later write (the piece
    taken again), or asked again over its piece when nothing of its write
    landed."""
    with monkeypatch.context() as m:
        probe = World(m, seed)
        probe.run()
        total = len(probe.client.landed_keys)
    for k in range(1, total + 1):
        with monkeypatch.context() as m:
            world = World(m, seed, fail=(k, how))
            r = world.run()
            assert world.failed is not None
            assert world.sent_after == []
            assert len(set(world.client.landed_keys)) == len(world.client.landed_keys), 'no request twice'
            fates = _fates(world, r)
            some = any(landed for _, _, landed, _, _, _ in fates)
            for kind, own, landed, redone, listed, asked in fates:
                why = (k, how, kind, own, landed, redone, listed, asked)
                if landed:
                    assert not listed, why
                elif own:
                    assert listed != asked, why
                else:
                    assert listed or asked or redone, why
                    assert listed or redone or not some, why
                    assert not (listed and redone), why
