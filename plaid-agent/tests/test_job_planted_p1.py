"""Gaps the planted-faults campaign PF found in the job worker's helpers
(``igt/job.py`` lines 1 to 1450, lane 1, 2026-11-19): each test here fails
with a slip planted in that code that the rest of the job tests let through,
and passes on the code as it is."""

import json

import pytest

from job_fixtures import MORPH_LAYER, JobClient, Model, call, document, reply, runner, start, text_edits, use

from plaid_agent.core import sandbox
from plaid_agent.core.job import run_job
from plaid_agent.core.prompt import JOB_ANSWER_AGAIN, JOB_FINDINGS_ANSWER_AGAIN
from plaid_agent.igt import job as igt_job

J = 'JPF1'


# --- a summary over the cap keeps the first of its lists ---------------------------

def test_a_summary_over_the_cap_keeps_the_first_skipped_sentences_and_counts_the_rest():
    """A piece's summary row cuts its lists from the END: the page lists the
    first skipped sentences, in order, and says how many more."""
    skipped = [{'sentence_id': f'd1-s{i}', 'sentence': f's{i}', 'reason': 'no-answer'} for i in range(1, 200)]
    row = json.loads(igt_job.summary_text({'piece': 'k', 'document': 'd1', 'note': 'Fine.', 'skipped': skipped}))
    assert row['cut'] is True
    kept = row['skipped']
    assert 0 < len(kept) < len(skipped)
    assert [s['sentence'] for s in kept] == [f's{i}' for i in range(1, len(kept) + 1)], kept[:3]
    assert row['skipped-more'] == len(skipped) - len(kept)


# --- a sentence written in by two writes is one sentence ---------------------------

BEFORE = [{'words': [('sa', [('sa', 'one')], 'human'), ('jut', [('jut', 'thing')], 'human')]},
          {'words': [('kvalaxar', [('kvalax', 'work'), ('ar', 'PL')], 'human')]}]
AFTER = [{'words': [('sa', [('sa', 'one')], 'human'), 'xosan', ('jut', [('jut', 'thing')], 'human')]},
         {'words': [('kIvalaxar', [('kvalax', 'work'), ('ar', 'PL')], 'human')]}]


def _editing(asked, n, kwargs):
    if 'Instructions from' not in asked:
        return reply('Done.')
    if igt_job.AFTER_TEXT_LINE in asked:
        if n == 1:
            return reply(calls=[call(9, 'set_analysis', {'document': 'Story', 'ref': 's1.w2 "xosan"', 'morphemes': [
                {'form': 'xosan', 'fields': {'Morph Gloss': 'good'}}]})])
        return reply('Glossed xosan.')
    if n == 1:
        return reply(calls=[call(1, 'retype_sentence', {'document': 'Story', 'ref': 's1', 'text': 'sa xosan jut.'}),
                            call(2, 'retype_sentence', {'document': 'Story', 'ref': 's2', 'text': 'kIvalaxar.'})])
    return reply('Inserted xosan and respelled kvalaxar.')


def test_a_sentence_edited_then_filled_is_one_sentence_written_in(monkeypatch):
    """s1's text is edited by one write and its new word analysed by the
    piece after it, a second write: two writing rows of one sentence. The
    document's row and the totals count it once ("sentences written in")."""
    text_edits(monkeypatch)
    client = JobClient({'d1': document('d1', 'Story', BEFORE)})
    job = start(client, 'Insert xosan in s1, respell kvalaxar as kIvalaxar, and segment and gloss the new word.',
                id=J, plan='document')
    sent = []

    def execute(c, ops, **kw):
        sent.append([o['kind'] for o in ops])
        if any(o['kind'] == 'edit_text' for o in ops):
            raw = document('d1', 'Story', AFTER, version=len(sent) + 1)
            words = raw['text_layers'][0]['token_layers'][1]['tokens']
            words[1]['id'], words[2]['id'] = 'd1-new', 'd1-s1w2'
            for m in raw['text_layers'][0]['token_layers'][2]['tokens']:
                m['id'] = m['id'].replace('d1-s1w3', 'd1-s1w2')
            client._holder('d1')['documents']['d1'] = raw
        return {}
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    use(monkeypatch, Model(_editing))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    assert sent == [['edit_text'], ['edit_text'], ['set_analysis']], 'two writes in s1, one in s2'
    report = finished['report']
    assert report['totals']['sentences'] == 2, report['totals']
    assert report['documents'][0]['counts']['analyzed'] == 2, report['documents'][0]['counts']


# --- a piece that made only a table answered ---------------------------------------

def _two_docs():
    return {f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['ka', 'ta']}, {'words': ['sa']}])
            for i in range(1, 3)}


@pytest.mark.skipif(sandbox.available() is not None, reason='the code sandbox is not installed')
def test_a_piece_whose_code_made_a_table_and_said_nothing_is_not_asked_again_and_keeps_its_table(monkeypatch):
    """A piece's answer is its staged changes, its tables and its words: one
    whose code made a table and whose reply is empty answered. It is not
    asked to answer again, its selection is not worked again in stretches,
    and the report keeps its table."""
    client = JobClient(_two_docs())
    job = start(client, 'Count the sentences of each text. Change nothing.', id=J, plan='selection', fills=())
    code = ('rows = [[d["name"], len(load(d["id"])["sentences"])] for d in documents()]\n'
            'print(table("Sentences per text", ["text", "sentences"], rows))')

    def answer(asked, n, kwargs):
        if 'Your piece: the whole selection above.' not in asked:
            return reply('Nothing to do here.')
        if n == 1:
            return reply(calls=[call(1, 'run_code', {'code': code})])
        return reply('')
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    sent = [m.get('content') for c in model.calls for m in c['kwargs']['messages'] if m['role'] == 'user']
    assert not any(again in str(s) for s in sent for again in (JOB_ANSWER_AGAIN, JOB_FINDINGS_ANSWER_AGAIN)), \
        'asked to answer again'
    assert finished['report']['plan']['fallback'] == [], finished['report']['plan']['fallback']
    assert finished['report']['tables'] == [{'title': 'Sentences per text', 'columns': ['text', 'sentences'],
                                             'rows': [['Story 1', 2], ['Story 2', 2]], 'more': 0}]


# --- harmonize leaves a word that holds people's work ------------------------------

def _harmonize(docs, word_links=(), comments=(), monkeypatch=None):
    """Harmonize over ``docs`` (as test_job_harmonize's ``_run``), each word
    recorded as the job's writes would have recorded it, with
    ``word_links``: (word id, who) pairs, a link of the whole word to an
    entry. Returns the report part and every op handed the executor."""
    from job_fixtures import WORD_LAYER, recorded, stamp
    client = JobClient({d: document(d, f'Story {d}', s) for d, s in docs.items()},
                       comments=[{'id': f'c{i}', 'document_id': d, 'entity_type': 'token', 'entity_id': e,
                                  'body': 'Is this right?'} for i, (d, e) in enumerate(comments)])
    for i, (wid, who) in enumerate(word_links):
        d = wid.split('-')[0]
        layer = next(tl for tl in client._holder(d)['documents'][d]['text_layers'][0]['token_layers']
                     if tl['id'] == WORD_LAYER)
        layer['vocabs'][0]['vocab_links'].append({'id': f'wl{i}', 'vocab_item': {'id': f'e-w{i}', 'form': 'ka'},
                                                  'tokens': [wid], 'metadata': stamp(who, J)})
    job = start(client, id=J)
    for d in docs:
        job.update_row(d, state='done')
    recorded(job)
    staged = []
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        staged.extend(ops)
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    return runner(job).harmonize(job), staged


def _w(gloss, who=J):
    return ('ka', [('ka', gloss)], who)


def test_a_word_a_person_linked_whole_is_left_by_harmonize(monkeypatch):
    """The third "ka" holds the job's analysis and a person's link of the
    whole word to an entry: work not the job's, so harmonize never rewrites
    it, though the job's other two words agree on another analysis."""
    out, staged = _harmonize({'d1': [{'words': [_w('go'), _w('go'), _w('come')]}]},
                             word_links=[('d1-s1w3', 'human')], monkeypatch=monkeypatch)
    assert staged == [], staged
    assert out['changed'] == [], out['changed']


def test_a_word_whose_gloss_a_person_corrected_on_the_jobs_morphemes_is_peoples_precedent(monkeypatch):
    """The fourth "ka" is the job's analysis k-a, and a person corrected the
    gloss of k since: a word a person touched is people's work, the job's
    draft on it included (the owner's ruling of 2026-11-15 (d)), and the job
    wrote no value in place on a morpheme someone else made (REV-KM2-1). So
    people's one analysis of ka is k-a 'me-come', and it wins over the job's
    two thirds for 'go'."""
    from job_fixtures import MGLOSS
    corrected = ('ka', [('k', 'me'), ('a', 'come')], J)
    raw = document('d1', 'Story d1', [{'words': [_w('go'), _w('go'), _w('come'), corrected]}])
    spans = next(tl for tl in raw['text_layers'][0]['token_layers'] if tl['id'] == MORPH_LAYER)['span_layers'][0]
    assert spans['id'] == MGLOSS
    next(sp for sp in spans['spans'] if sp['tokens'] == ['d1-s1w4m1'])['metadata'] = {}
    out = _harmonize_raw(raw)
    assert [(c['to'], c['by']) for c in out['changed']] == [('k-a ‘me-come’', 'person')], out['changed']


def _harmonize_raw(raw):
    """Harmonize over one raw document, its words recorded as the job's
    writes would have recorded them."""
    from job_fixtures import recorded
    client = JobClient({raw['id']: raw})
    job = start(client, id=J)
    job.update_row(raw['id'], state='done')
    recorded(job)
    return runner(job).harmonize(job)


def test_a_word_beside_a_persons_morpheme_is_left_as_beside_others(monkeypatch):
    """The third "ka" is two morphemes: the job made k and a person's gloss
    is on it, and a person made a. The job could not record it as wholly its
    own, and it did not make every morpheme of it, so nothing says a person
    wrote there after the job: it held others' work, and harmonize lists it
    as left beside others, never as a word the job cannot vouch for."""
    mixed = ('ka', [('k', 'x'), ('a', 'y')], {'token': J, 'span': 'human', 'link': None})
    docs = {'d1': [{'words': [_w('go'), _w('go'), mixed]}]}
    raw = document('d1', 'Story d1', docs['d1'])
    morphs = next(tl for tl in raw['text_layers'][0]['token_layers'] if tl['id'] == MORPH_LAYER)['tokens']
    second = next(m for m in morphs if m['id'] == 'd1-s1w3m2')
    second['metadata'] = {'form': 'a'}
    out = _harmonize_raw(raw)
    assert out['changed'] == []
    assert [(x['form'], x['reason']) for x in out['left']] == [('ka', igt_job.BESIDE_OTHERS)], out['left']


# --- what a write counts of people's work -------------------------------------------

def _people_write(spec, word_link=None):
    """A job's write in a document of ``spec``, as test_job_people_changed
    makes one, ``word_link`` the provenance of a link of s1.w1 as a whole
    (wl1, to entry vi-x)."""
    from collections import Counter
    from job_fixtures import stamp
    from plaid_agent.igt.project import load_project, parse_document
    raw = document('d1', 'Story', spec)
    if word_link is not None:
        raw['text_layers'][0]['token_layers'][1]['vocabs'][0]['vocab_links'].append(
            {'id': 'wl1', 'vocab_item': {'id': 'vi-x', 'form': 'gam'}, 'tokens': ['d1-s1w1'],
             'metadata': stamp(word_link)})
    client = JobClient({'d1': raw})
    project = load_project(client, 'p1')
    doc = parse_document(client.documents.get('d1', include_body=True), project)
    return igt_job.Write('d1', '', igt_job.Stretch(doc, project, doc.sentences, J), [], [], Counter(), doc)


def test_a_sentence_merge_counts_the_translation_people_wrote_on_the_sentence_it_removes():
    """A merge of s1 and s2 removes s2: the person's translation of s2 is
    people's work it takes away, one. s1, which it keeps, holds none."""
    spec = [{'words': ['ka']}, {'words': ['sa'], 'translation': ('See.', 'human')}]
    merge = {'kind': 'merge_sentences', 'sentence_id': 'd1-s1', 'other_id': 'd1-s2'}
    c = _people_write(spec).of_people_and_text([merge])
    assert (c['peoples_values_changed'], c['text_changes']) == (1, 1), c


def test_a_word_deleted_with_its_entry_counts_the_word_link_people_made_once():
    """REV-JOIN19-1 for a deleted word: "gam" holds a person's morpheme,
    gloss and morpheme link, and a person's link of the whole word to vi-x.
    Deleting the word takes all four. Deleting vi-x in the same write would
    take the same word link: it is counted once, four, not five."""
    spec = [{'words': [('gam', [('gam', 'fish', 'vi-gam')], 'human'), 'ka']}]
    delete_word = {'kind': 'delete_word', 'word_id': 'd1-s1w1'}
    delete_entry = {'kind': 'delete_entry', 'item_id': 'vi-x', 'links': ['wl1']}
    alone = _people_write(spec, 'human')
    alone.people_links, alone.inside = {'wl1': 'd1'}, {'d1'}
    both = _people_write(spec, 'human')
    both.people_links, both.inside = {'wl1': 'd1'}, {'d1'}
    assert alone.of_people_and_text([delete_word])['peoples_values_changed'] == 4
    assert both.of_people_and_text([delete_word, delete_entry])['peoples_values_changed'] == 4


# --- a job that fills only what it adds --------------------------------------------

def test_a_job_that_fills_only_what_it_adds_finds_no_translation_empty_in_a_sentence_it_did_not_add(monkeypatch):
    """RPF-A7 for a sentence level target: a job set up to fill only the
    Translation of what it adds, over a sentence it did not add whose
    translation is blank. Nothing is empty of what it fills there: its
    piece is not told to fill it, and Left blank counts nothing untouched."""
    from job_fixtures import TRANS
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['sc', 'tqmc']}])})
    setup = {'fills': [{'id': TRANS, 'name': 'Translation'}], 'text': True, 'conversation': 'c1', 'onlynew': True}
    job = start(client, 'x', id=J, plan='document', edits_text=True, fills=(TRANS,), setup=setup)
    model = use(monkeypatch, Model(lambda asked, n, kwargs: reply('Nothing to add.')))
    finished = run_job(job, runner(job))
    doc = finished['report']['documents'][0]
    assert doc.get('left', []) == [], doc.get('left')
    assert [(b.get('untouched'), b.get('left')) for b in doc['counts']['blank']] == [(0, 0)], doc['counts']['blank']
    asked = [c['asked'] for c in model.calls if 'Your piece' in c['asked']]
    assert asked and all('Nothing empty in s1 of what this job fills.' in a for a in asked), asked
    assert not any('Empty in s1: Translation.' in a for a in asked), asked


# --- on a real core: a machine's link an entry takes is no person's ---------------

def test_live_a_deleted_entrys_link_a_machine_made_outside_the_job_is_not_peoples_work(monkeypatch):
    """S6-2's count, on a real core: kai is linked by a person in Long story
    (the job's document) and by a machine in Second (outside the job). The
    job deletes kai, taking both links: one is people's work, in Long story,
    and none is people's outside the job."""
    import time
    import uuid
    from plaid_client import PlaidClient
    from job_fixtures import job_project, plan_row
    from live import _skip_or_fail, core_url, login, seed
    from plaid_agent.core.agent import ModelConfig
    from plaid_agent.core.job import Job
    from plaid_agent.igt.job import IgtRunner
    from plaid_agent.jobworker import count_chars
    worker = '0193a5c0-0000-7000-8000-0000000000f7'
    try:
        admin = login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')
    lexicon = {'id': 'v1', 'name': 'Lex', 'project': 'p1', 'items': [
        {'id': 'e-kai', 'form': 'kai', 'metadata': {'gloss': 'go'}}]}
    docs = {'dA': document('dA', 'Long story', [{'words': [('kai', [('kai', 'go', 'e-kai')], 'human'), 'lo']}]),
            'dB': document('dB', 'Second', [{'words': [('kai', [('kai', 'go', 'e-kai')], 'machine'), 'lo']}])}
    s = seed(admin, job_project(), docs, {'v1': lexicon}, name=f'job pf1 machine link {uuid.uuid4().hex[:6]}')
    try:
        email = f'job-pf1-{uuid.uuid4().hex[:8]}@example.org'
        admin.users.create(email, 'job-pf1-pass-1', False)
        admin.projects.add_maintainer(s.project_id, email)
        starter = PlaidClient.login(core_url(), email, 'job-pf1-pass-1')

        def answer(asked, n, kwargs):
            if 'Instructions from' in asked and n == 1:
                return reply(calls=[call(1, 'delete_entry', {'entry_id': s.ids['e-kai']})])
            return reply('Done.')
        use(monkeypatch, Model(answer))
        made = starter.jobs.create(s.project_id, 'igt', 'Clean the lexicon.', [s.ids['dA']])
        claimed = admin.jobs.claim(worker, 'fake/m', ['igt'])
        assert claimed and claimed['job']['id'] == made['id']
        admin.jobs.add_decisions(made['id'], worker, [plan_row('document', ids=s.ids)])
        offset = {'s': 3600.0}

        def wait(sec):
            offset['s'] += sec
        job = Job(admin, claimed, worker, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
                  sleep=wait, now=lambda: time.time() + offset['s'])
        finished = run_job(job, IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                          count=count_chars, write_summary=False))
        assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
        totals = finished['report']['totals']
        assert totals['peoples_values_changed'] == 1, totals
        assert not totals.get('peoples_outside'), totals
    finally:
        s.delete()
