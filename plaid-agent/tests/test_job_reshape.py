"""The job knows where it wrote by WORD as well as by sentence (REV-B4-1).

A sentence split keeps the left half's id and gives the right half a new one,
while its words keep theirs (plaid-igt ``splitSentencesAt``). A merge keeps
the survivor's id and drops the other. So a sentence id alone cannot say that
the job wrote in a sentence once a person has reshaped it. Each writing row
names the tags of every word of its sentence (those the write analyses and
the others), and a sentence that holds any word of a sentence the job began
to write in is never a target again, unless that write is known to have sent
nothing: nothing in it is glossed or translated, whatever its id now. Each
reshape is tested here, with what happens to it."""

import json
import re

import pytest

from job_fixtures import (INSTRUCTIONS, JobClient, Model, call, document, empty_translations, instructed, recorded,
                          reply, runner, start, use)

from plaid_client import PlaidAPIError
from plaid_agent.core.limits import JOB_ANALYSIS_MAX_CHARS, JOB_SENTENCE_MAX_WORDS
from plaid_agent.core.plan import PlanError
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import RECORD_FORM, WRITING_FORM
from test_job_vouched import _iso

J = 'JR'


class Crash(BaseException):
    """The worker's process dies here."""


def mine(form):
    return (form, [(form, 'go')], J)


def _refs(asked, verb):
    line = next((x for x in asked.splitlines() if x.startswith(verb + ' ')), None)
    return [int(r[1:]) for r in line[len(verb) + 1:].split('.')[0].split(', ')] if line else []


def _targets(asked):
    """(sentence index, word index) of every target word a stretch names."""
    out = []
    for line in asked.splitlines():
        m = re.match(r'Empty in s(\d+): words (.*?)(?: and the translation)?\.$', line)
        if m:
            out += [(int(m.group(1)), int(w)) for w in re.findall(r'w(\d+) "', m.group(2))]
    return out


def _named(asked):
    return re.search(r'^Document "(.*)"\.$', asked, re.M).group(1)


def gloss(asked, n, kwargs, leave=()):
    """'go' on every target word the stretch names (but those whose surface
    is in ``leave``), and a translation of every target translation."""
    if n > 1:
        return reply('Done.')
    name = _named(asked)
    forms = {}
    for line in asked.splitlines():
        m = re.match(r'Empty in s(\d+): words (.*?)(?: and the translation)?\.$', line)
        if m:
            forms.update({(int(m.group(1)), int(w)): f for w, f in re.findall(r'w(\d+) "([^"]*)"', m.group(2))})
    calls = [call(i, 'set_analysis', {'document': name, 'ref': f's{s}.w{w}',
                                      'morphemes': [{'form': 'x', 'fields': {'Morph Gloss': 'go'}}]})
             for i, (s, w) in enumerate(_targets(asked), start=1) if forms.get((s, w)) not in leave
             and instructed(asked, 'gloss')]
    calls += [call(100 + s, 'set_field', {'document': name, 'refs': [f's{s}'], 'field': 'Translation',
                                          'value': f'T{s}.'}) for s in empty_translations(asked)
              if instructed(asked, 'translat')]
    return reply(calls=calls)


def gloss_but_once(*left):
    """As :func:`gloss`, leaving blank the words whose surface is in ``left``
    in the first stretch only: asked again, the model glosses them."""
    asked_once = {'n': 0}

    def answer(asked, n, kwargs):
        if n == 1:
            asked_once['n'] += 1
        return gloss(asked, n, kwargs, leave=left if asked_once['n'] == 1 else ())
    return answer


def reshaped(raw, ids):
    """``raw`` (a document as ``document`` builds it) with token ids renamed:
    ``ids`` maps a sentence id (``d1-s2``) or a word id (``d1-s2w1``) to the
    id a person's reshape left it with. A word's morphemes, spans and links
    follow it."""
    text = json.dumps(raw)
    text = re.sub(r'd1-s\d+(?:w\d+)?(?=m\d|")', lambda m: ids.get(m.group(0), m.group(0)), text)
    return json.loads(text)


def _job(monkeypatch, before, instructions=INSTRUCTIONS, model=gloss, documents=None):
    docs = documents or {'d1': document('d1', 'Story', before)}
    client = JobClient(docs)
    clock = {'t': 1_800_000_000.0}
    job = start(client, instructions, id=J, now=lambda: clock['t'])
    job._sleep = lambda s: clock.__setitem__('t', clock['t'] + s)
    job.job['created_at'] = _iso(clock['t'] - 3600)
    use(monkeypatch, Model(model))
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 1)
    return client, job, clock


def _person_leaves(client, raw, clock, doc_id='d1'):
    """A person's edit: the document now reads ``raw``, and its History's
    newest change is theirs, twelve minutes ago (after the job began, outside
    the quiet window)."""
    client.after_write[doc_id] = raw
    client._holder(doc_id)['documents'][doc_id] = raw
    history = client._holder(doc_id)['audit']
    client._holder(doc_id)['audit'].append({'id': f'person-{len(history)}', 'time': _iso(clock['t'] - 700),
                                            'ref': None, 'documents': [{'id': doc_id}], 'ops': []})


def _after_record(monkeypatch, job, sentence_id, then):
    """Run ``then()`` once, right after the record of ``sentence_id`` lands."""
    real = job.add_decisions
    done = {}

    def add(decisions):
        out = real(decisions)
        if not done and any(d['form'] == RECORD_FORM + sentence_id for d in decisions):
            done['yes'] = True
            then()
        return out
    monkeypatch.setattr(job, 'add_decisions', add)
    return done


def _written(monkeypatch):
    """Every word id and translation token each write sends, write by write."""
    seen = []
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        seen.append(sorted(o.get('word_id') or o.get('token_id') for o in ops
                           if o.get('kind') in ('set_analysis', 'set_span')))
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    return seen


def _rows(client):
    return {f[len(WRITING_FORM):]: json.loads(r['analysis']) for (f, _), r in client.jobs.decision_rows[J].items()
            if f.startswith(WRITING_FORM)}


# --- a sentence split -----------------------------------------------------------------

def test_a_split_after_the_cursor_and_a_cleared_proposal_is_not_glossed_again(monkeypatch):
    """REV-B4-1: the starter splits s1 before "pa" and clears the job's
    proposal on pa. The right half has a new id after the cursor: it holds a
    word the job wrote, so nothing in it is a target. s2 is still glossed."""
    client, job, clock = _job(monkeypatch, [{'words': ['ka', 'ta', 'pa']}, {'words': ['sa']}])
    client.after_write['d1'] = document('d1', 'Story', [{'words': [mine('ka'), mine('ta'), mine('pa')]},
                                                         {'words': ['sa']}], version=2)
    split = reshaped(document('d1', 'Story', [{'words': [mine('ka'), mine('ta')]}, {'words': ['pa']},
                                              {'words': ['sa']}], version=3),
                     {'d1-s2w1': 'd1-s1w3', 'd1-s2': 'd1-sNEW', 'd1-s3w1': 'd1-s2w1', 'd1-s3': 'd1-s2'})
    done = _after_record(monkeypatch, job, 'd1-s1', lambda: _person_leaves(client, split, clock))
    seen = _written(monkeypatch)
    assert runner(job).document('d1') == 'done'
    assert done
    assert seen == [['d1-s1w1', 'd1-s1w2', 'd1-s1w3'], ['d1-s2w1']], seen


def test_a_split_off_half_holding_a_word_the_job_left_blank_is_left_whole(monkeypatch):
    """The model left "ma" blank in s1. The right half of a split holds pa,
    which the job wrote, and ma: the half is left to people, ma included."""
    client, job, clock = _job(monkeypatch, [{'words': ['ka', 'pa', 'ma']}, {'words': ['sa']}],
                              model=gloss_but_once('ma'))
    client.after_write['d1'] = document('d1', 'Story', [{'words': [mine('ka'), mine('pa'), 'ma']},
                                                         {'words': ['sa']}], version=2)
    split = reshaped(document('d1', 'Story', [{'words': [mine('ka')]}, {'words': [mine('pa'), 'ma']},
                                              {'words': ['sa']}], version=3),
                     {'d1-s2w1': 'd1-s1w2', 'd1-s2w2': 'd1-s1w3', 'd1-s2': 'd1-sNEW', 'd1-s3w1': 'd1-s2w1',
                      'd1-s3': 'd1-s2'})
    _after_record(monkeypatch, job, 'd1-s1', lambda: _person_leaves(client, split, clock))
    seen = _written(monkeypatch)
    assert runner(job).document('d1') == 'done'
    assert seen == [['d1-s1w1', 'd1-s1w2'], ['d1-s2w1']], seen


def test_a_split_after_a_crash_is_known_from_the_rows_in_core(monkeypatch):
    """The same split, made while no worker runs: a new worker reads the
    words of every writing row of the document from core (``GET
    /jobs/{id}/decisions``), not only the rows of the sentences it reads."""
    client, job, clock = _job(monkeypatch, [{'words': ['ka', 'ta', 'pa']}, {'words': ['sa']}])
    client.after_write['d1'] = document('d1', 'Story', [{'words': [mine('ka'), mine('ta'), mine('pa')]},
                                                         {'words': ['sa']}], version=2)

    def crash():
        raise Crash()
    _after_record(monkeypatch, job, 'd1-s1', crash)
    with pytest.raises(Crash):
        runner(job).document('d1')
    split = reshaped(document('d1', 'Story', [{'words': [mine('ka'), mine('ta')]}, {'words': ['pa']},
                                              {'words': ['sa']}], version=3),
                     {'d1-s2w1': 'd1-s1w3', 'd1-s2': 'd1-sNEW', 'd1-s3w1': 'd1-s2w1', 'd1-s3': 'd1-s2'})
    _person_leaves(client, split, clock)
    monkeypatch.setattr(job, 'add_decisions', type(job).add_decisions.__get__(job))
    job.rows = {r['document_id']: dict(r) for r in client.jobs.get(J)['documents']}
    seen = _written(monkeypatch)
    assert runner(job).document('d1') == 'done'
    assert seen == [['d1-s2w1']], seen


# --- a sentence merge ------------------------------------------------------------------

def test_the_cursors_sentence_merged_into_an_earlier_one_is_not_glossed_again(monkeypatch):
    """s0 holds a person's word only (no target). The job writes s1 and
    records it, the cursor on s1. The starter merges s1 into s0 (s0's id
    survives, s1's is gone, so the walk starts from the top) and clears the
    job's proposal on ka. s0 holds words of a sentence the job wrote in: it
    is left. s2 is glossed."""
    human = ('na', [('na', 'we')], 'human')
    client, job, clock = _job(monkeypatch, [{'words': [human]}, {'words': ['ka', 'ta']}, {'words': ['sa']}])
    client.after_write['d1'] = document('d1', 'Story', [{'words': [human]}, {'words': [mine('ka'), mine('ta')]},
                                                         {'words': ['sa']}], version=2)
    merged = reshaped(document('d1', 'Story', [{'words': [human, 'ka', mine('ta')]}, {'words': ['sa']}],
                               version=3),
                      {'d1-s1w2': 'd1-s2w1', 'd1-s1w3': 'd1-s2w2', 'd1-s2w1': 'd1-s3w1', 'd1-s2': 'd1-s3'})
    _after_record(monkeypatch, job, 'd1-s2', lambda: _person_leaves(client, merged, clock))
    seen = _written(monkeypatch)
    assert runner(job).document('d1') == 'done'
    assert seen == [['d1-s2w1', 'd1-s2w2'], ['d1-s3w1']], seen


# --- a word split, a word merge, a word retyped -------------------------------------------

def test_a_word_split_in_a_split_off_half_is_left(monkeypatch):
    """The starter splits s1 before "pa", then splits the word pa into p
    (the left half keeps pa's id) and a (a new id the job cannot know), and
    clears both. The half holds a word the job wrote: neither is glossed."""
    client, job, clock = _job(monkeypatch, [{'words': ['ka', 'ta', 'pa']}, {'words': ['sa']}])
    client.after_write['d1'] = document('d1', 'Story', [{'words': [mine('ka'), mine('ta'), mine('pa')]},
                                                         {'words': ['sa']}], version=2)
    split = reshaped(document('d1', 'Story', [{'words': [mine('ka'), mine('ta')]}, {'words': ['p', 'a']},
                                              {'words': ['sa']}], version=3),
                     {'d1-s2w1': 'd1-s1w3', 'd1-s2w2': 'd1-wNEW', 'd1-s2': 'd1-sNEW', 'd1-s3w1': 'd1-s2w1',
                      'd1-s3': 'd1-s2'})
    _after_record(monkeypatch, job, 'd1-s1', lambda: _person_leaves(client, split, clock))
    seen = _written(monkeypatch)
    assert runner(job).document('d1') == 'done'
    assert seen == [['d1-s1w1', 'd1-s1w2', 'd1-s1w3'], ['d1-s2w1']], seen


@pytest.mark.parametrize('survivor', ['d1-s1w3', 'd1-s1w4'], ids=['first-keeps-its-id', 'second-keeps-its-id'])
def test_a_word_merge_in_a_split_off_half_is_left(monkeypatch, survivor):
    """The starter splits s1 before "pa" and merges pa and ma into one word,
    which keeps the id of one of them, then clears it."""
    client, job, clock = _job(monkeypatch, [{'words': ['ka', 'ta', 'pa', 'ma']}, {'words': ['sa']}])
    client.after_write['d1'] = document('d1', 'Story', [{'words': [mine('ka'), mine('ta'), mine('pa'),
                                                                   mine('ma')]}, {'words': ['sa']}], version=2)
    split = reshaped(document('d1', 'Story', [{'words': [mine('ka'), mine('ta')]}, {'words': ['pama']},
                                              {'words': ['sa']}], version=3),
                     {'d1-s2w1': survivor, 'd1-s2': 'd1-sNEW', 'd1-s3w1': 'd1-s2w1', 'd1-s3': 'd1-s2'})
    _after_record(monkeypatch, job, 'd1-s1', lambda: _person_leaves(client, split, clock))
    seen = _written(monkeypatch)
    assert runner(job).document('d1') == 'done'
    assert seen == [['d1-s1w1', 'd1-s1w2', 'd1-s1w3', 'd1-s1w4'], ['d1-s2w1']], seen


def test_a_word_retyped_in_a_sentence_the_job_wrote_is_left(monkeypatch):
    """The starter deletes the job's word pa and types it again (a new word
    with a new id, R42). s1 keeps its id and its record: not a target. And
    in a split-off half that also holds a word the job wrote: left."""
    client, job, clock = _job(monkeypatch, [{'words': ['ka', 'ta', 'pa']}, {'words': ['sa']}])
    client.after_write['d1'] = document('d1', 'Story', [{'words': [mine('ka'), mine('ta'), mine('pa')]},
                                                         {'words': ['sa']}], version=2)
    retyped = reshaped(document('d1', 'Story', [{'words': [mine('ka'), mine('ta'), 'pa']}, {'words': ['sa']}],
                                version=3), {'d1-s1w3': 'd1-wNEW'})
    _after_record(monkeypatch, job, 'd1-s1', lambda: _person_leaves(client, retyped, clock))
    seen = _written(monkeypatch)
    assert runner(job).document('d1') == 'done'
    assert seen == [['d1-s1w1', 'd1-s1w2', 'd1-s1w3'], ['d1-s2w1']], seen


def test_a_word_retyped_in_a_split_off_half_with_a_word_the_job_wrote_is_left(monkeypatch):
    client, job, clock = _job(monkeypatch, [{'words': ['ka', 'ta', 'pa']}, {'words': ['sa']}])
    client.after_write['d1'] = document('d1', 'Story', [{'words': [mine('ka'), mine('ta'), mine('pa')]},
                                                         {'words': ['sa']}], version=2)
    split = reshaped(document('d1', 'Story', [{'words': [mine('ka')]}, {'words': [mine('ta'), 'pa']},
                                              {'words': ['sa']}], version=3),
                     {'d1-s2w1': 'd1-s1w2', 'd1-s2w2': 'd1-wNEW', 'd1-s2': 'd1-sNEW', 'd1-s3w1': 'd1-s2w1',
                      'd1-s3': 'd1-s2'})
    _after_record(monkeypatch, job, 'd1-s1', lambda: _person_leaves(client, split, clock))
    seen = _written(monkeypatch)
    assert runner(job).document('d1') == 'done'
    assert seen == [['d1-s1w1', 'd1-s1w2', 'd1-s1w3'], ['d1-s2w1']], seen


def test_a_sentence_deleted_and_typed_again_is_new_text(monkeypatch):
    """The rule's limit, on purpose: the starter deletes s1 and types its
    text again. Every token of it is new (a new sentence id, new word ids),
    nothing in it is a token the job wrote on or a word of a sentence it
    wrote in, so it is new text, blank, and the job glosses it as any text
    typed during the job. The job cannot tell it from new text."""
    client, job, clock = _job(monkeypatch, [{'words': ['ka', 'ta']}, {'words': ['sa']}])
    client.after_write['d1'] = document('d1', 'Story', [{'words': [mine('ka'), mine('ta')]}, {'words': ['sa']}],
                                        version=2)
    typed = reshaped(document('d1', 'Story', [{'words': ['ka', 'ta']}, {'words': ['sa']}], version=3),
                     {'d1-s1': 'd1-sNEW', 'd1-s1w1': 'd1-wNEW1', 'd1-s1w2': 'd1-wNEW2'})
    _after_record(monkeypatch, job, 'd1-s1', lambda: _person_leaves(client, typed, clock))
    seen = _written(monkeypatch)
    assert runner(job).document('d1') == 'done'
    assert seen == [['d1-s1w1', 'd1-s1w2'], ['d1-wNEW1', 'd1-wNEW2'], ['d1-s2w1']], seen


# --- a document copy ---------------------------------------------------------------------

def test_a_document_copied_into_the_job_is_written_on_its_own_rows(monkeypatch):
    """A copy is another document with tokens of its own (core mints them),
    and a job's documents are fixed when it starts, so a copy made during
    the job is not in it. A copy made before it is: what the job wrote in
    the original never stops the copy (the rows are kept per document)."""
    original = document('d1', 'Story', [{'words': ['ka', 'ta']}])
    copy = document('d2', 'Story (copy)', [{'words': ['ka', 'ta']}])
    client, job, clock = _job(monkeypatch, None, documents={'d1': original, 'd2': copy})
    client.after_write['d1'] = document('d1', 'Story', [{'words': [mine('ka'), mine('ta')]}], version=2)
    client.after_write['d2'] = copy
    seen = _written(monkeypatch)
    r = runner(job)
    assert r.document('d1') == 'done'
    assert r.document('d2') == 'done'
    assert seen == [['d1-s1w1', 'd1-s1w2'], ['d2-s1w1', 'd2-s1w2']], seen
    assert sorted(_rows(client)) == ['d1-s1', 'd2-s1']


# --- translations ------------------------------------------------------------------------

def test_a_split_off_half_of_a_sentence_the_job_translated_is_not_translated(monkeypatch):
    """A translate job writes no word, so only the words of its sentence say
    the job wrote there. The translation stays on the left half (its id):
    the right half has none, and holds words of a sentence the job wrote
    in. It is left to people."""
    client, job, clock = _job(monkeypatch, [{'words': ['ka', 'ta', 'pa']}, {'words': ['sa']}],
                              instructions='Translate the empty translations.')
    client.after_write['d1'] = document('d1', 'Story', [{'words': ['ka', 'ta', 'pa'], 'translation': ('T1.', J)},
                                                         {'words': ['sa']}], version=2)
    split = reshaped(document('d1', 'Story', [{'words': ['ka', 'ta'], 'translation': ('T1.', J)}, {'words': ['pa']},
                                              {'words': ['sa']}], version=3),
                     {'d1-s2w1': 'd1-s1w3', 'd1-s2': 'd1-sNEW', 'd1-s3w1': 'd1-s2w1', 'd1-s3': 'd1-s2'})
    _after_record(monkeypatch, job, 'd1-s1', lambda: _person_leaves(client, split, clock))
    seen = _written(monkeypatch)
    assert runner(job).document('d1') == 'done'
    assert seen == [['d1-s1'], ['d1-s2']], seen
    row = _rows(client)['d1-s1']
    assert len(row.pop('before')) == 1 and len(row.pop('pieces')) == 1
    assert row == {'document': 'd1', 'others': ['d1-s1w1', 'd1-s1w2', 'd1-s1w3'], 'translation': 'translations',
                   'words': []}


def test_a_merged_sentence_whose_joined_translation_a_person_cleared_is_not_translated(monkeypatch):
    """s0 has a person's translation. The job translates s1 (the cursor).
    The starter merges s1 into s0 (the joined value is the person's) and
    clears it. s0 holds words of a sentence the job translated: left."""
    client, job, clock = _job(monkeypatch, [{'words': ['na'], 'translation': ('We.', 'human')},
                                            {'words': ['ka']}, {'words': ['sa']}],
                              instructions='Translate the empty translations.')
    client.after_write['d1'] = document('d1', 'Story', [{'words': ['na'], 'translation': ('We.', 'human')},
                                                         {'words': ['ka'], 'translation': ('T2.', J)},
                                                         {'words': ['sa']}], version=2)
    merged = reshaped(document('d1', 'Story', [{'words': ['na', 'ka']}, {'words': ['sa']}], version=3),
                      {'d1-s1w2': 'd1-s2w1', 'd1-s2w1': 'd1-s3w1', 'd1-s2': 'd1-s3'})
    _after_record(monkeypatch, job, 'd1-s2', lambda: _person_leaves(client, merged, clock))
    seen = _written(monkeypatch)
    assert runner(job).document('d1') == 'done'
    assert seen == [['d1-s2'], ['d1-s3']], seen


# --- every way in: a reshape between the stretch's read and its write ------------------------

def test_a_merge_between_the_walks_read_and_the_stretchs_puts_the_sentence_out_of_reach(monkeypatch):
    """The guard sits where a stretch's targets are decided (``Stretch``),
    which the stretch's own read and the check under the lock both ask: the
    walk picks s2, and before the stretch reads the document the starter
    merges s1 (which the job wrote, its proposal on ta cleared) into s2, s2's
    id surviving. s2 now holds words of a sentence the job wrote in, so the
    stretch has nothing to write."""
    client, job, clock = _job(monkeypatch, [{'words': ['ka', 'ta']}, {'words': ['sa']}])
    client.after_write['d1'] = document('d1', 'Story', [{'words': [mine('ka'), mine('ta')]}, {'words': ['sa']}],
                                        version=2)
    merged = reshaped(document('d1', 'Story', [{'words': [mine('ka'), 'ta', 'sa']}], version=3),
                      {'d1-s1': 'd1-s2', 'd1-s1w3': 'd1-s2w1'})
    r = runner(job)
    real = r.model_work

    def model_work(project, document_id, sentence_ids):
        if sentence_ids == ['d1-s2']:
            _person_leaves(client, merged, clock)
        return real(project, document_id, sentence_ids)
    monkeypatch.setattr(r, 'model_work', model_work)
    seen = _written(monkeypatch)
    assert r.document('d1') == 'done'
    assert seen == [['d1-s1w1', 'd1-s1w2']], seen


# --- the size of a writing row -----------------------------------------------------------

def test_a_writing_row_holds_every_word_of_the_longest_sentence_a_job_takes():
    """CONTRACT: a sentence of JOB_SENTENCE_MAX_WORDS words, with a
    document id as long as core's and the longest translation outcome, is
    named whole within core's cap on a decision."""
    tags = [igt_job.word_tag(f'01a1d34a-0cde-7002-b1c0-{i:012x}') for i in range(JOB_SENTENCE_MAX_WORDS)]
    doc = '01a1d34a-0a05-7000-828b-bd5cf572de1a'
    for split in (0, JOB_SENTENCE_MAX_WORDS // 2, JOB_SENTENCE_MAX_WORDS):
        text = igt_job.writing_text(doc, 'refreshed', tags[:split], tags[split:])
        assert len(text) <= JOB_ANALYSIS_MAX_CHARS
        row = json.loads(text)
        assert row['words'] + row['others'] == tags


def test_a_sentence_of_more_words_than_a_writing_row_names_is_too_long(monkeypatch):
    client, job, clock = _job(monkeypatch, [{'words': ['a'] * (JOB_SENTENCE_MAX_WORDS + 1)},
                                            {'words': ['a'] * JOB_SENTENCE_MAX_WORDS}])
    r = runner(job)
    assert r.check(job) is None
    assert [(s['sentence_id'], s['reason']) for s in job.rows['d1']['skipped']] == [('d1-s1', 'too-long')]
    assert job.rows['d1']['targets'] == 1


def test_a_split_after_a_write_that_sent_nothing_leaves_both_halves_targets(monkeypatch):
    """The words of a sentence whose write this worker knows sent nothing
    (refused for the moved version on both tries, nothing landed) are not
    the job's: the starter splits that sentence meanwhile, and both halves
    are glossed when the document comes back."""
    client, job, clock = _job(monkeypatch, [{'words': ['ka', 'ta', 'pa']}])
    real = igt_job.execute_plan
    refused = {'n': 2}

    def execute(c, ops, **kw):
        if refused['n']:
            refused['n'] -= 1
            try:
                raise PlaidAPIError('HTTP 409 version', status=409)
            except PlaidAPIError as e:
                raise PlanError('moved', 0, len(ops)) from e
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    r = runner(job)
    assert r.document('d1') == 'deferred' and not client.batches
    split = reshaped(document('d1', 'Story', [{'words': ['ka', 'ta']}, {'words': ['pa']}], version=3),
                     {'d1-s2w1': 'd1-s1w3', 'd1-s2': 'd1-sNEW'})
    _person_leaves(client, split, clock)
    seen = _written(monkeypatch)
    assert r.document('d1') == 'done'
    assert seen == [['d1-s1w1', 'd1-s1w2'], ['d1-s1w3']], seen


# --- harmonize after a split -----------------------------------------------------------------

def test_harmonize_leaves_the_jobs_word_in_a_split_off_half_unchecked(monkeypatch):
    """The job's record of a sentence keeps each word's key under the
    sentence's id. After a split, a word of the job's in the right half has
    no record under its new sentence's id: harmonize cannot vouch for it,
    so it leaves it and lists it "Not checked", never rewrites it."""
    def w(gloss):
        return ('ka', [('ka', gloss)], J)
    client = JobClient({'d1': document('d1', 'Story', [{'words': [w('go'), w('go'), w('come')]}])})
    job = start(client, id=J)
    job.update_row('d1', state='done')
    recorded(job)
    client._holder('d1')['documents']['d1'] = reshaped(
        document('d1', 'Story', [{'words': [w('go'), w('go')]}, {'words': [w('come')]}], version=3),
        {'d1-s2w1': 'd1-s1w3', 'd1-s2': 'd1-sNEW'})
    seen = _written(monkeypatch)
    out = runner(job).harmonize(job)
    assert not seen and out['changed'] == []
    assert out['left'] == [{'form': 'ka', 'reason': 'unvouched', 'analyses': [{'analysis': 'ka ‘come’', 'count': 1}]}]
