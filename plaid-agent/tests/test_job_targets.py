"""What a job fills (its plan's targets) and THE rule for empty
(igt/targets.py, the owner's steer of 2026-11-15): any word, morpheme or
sentence level field, and segmentation, through the same code. A unit is
empty for a target when it holds no value for it, a word for segmentation
when it holds no morpheme analysis (a word field's value does not make a word
analysed: REV-DAY-S-7, REV-DAY-P-5). The walk, the message, the tools, the
evidence and Left blank all follow the plan's targets."""

import pytest

from fixtures import MGLOSS, TRANS
from job_fixtures import (MPOS, NOTE, ROLE, JobClient, Model, call, document, fields_project, reply, runner, start,
                          use, with_values)

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job, targets as tg
from plaid_agent.igt.job import sentence_targets, translation_state, word_state
from plaid_agent.igt.project import load_project, parse_document

J = 'JTG'
# s1: "ka" blank, "pata" a person's two morphemes (pa 'x', ta with no
# gloss), "sa" with no analysis but a person's Role. s2: "mo" blank.
SPEC = [{'words': ['ka', ('pata', [('pa', 'x'), ('ta', None)], 'human'), 'sa']}, {'words': ['mo']}]
PEOPLE = [(ROLE, 'd1-s1w3', 'patient', 'human')]


def _raw(analysed=(), values=()):
    """The document with ``analysed`` (word ids) analysed by the job and
    ``values`` set besides people's."""
    spec = [{'words': [(w, [(w, 'g')], J) if isinstance(w, str) and f'd1-s{si}w{wi}' in analysed else w
                       for wi, w in enumerate(s['words'], start=1)]} for si, s in enumerate(SPEC, start=1)]
    return with_values(document('d1', 'Story', spec), PEOPLE + list(values))


def _parsed():
    client = JobClient({'d1': _raw()}, project=fields_project())
    project = load_project(client, 'p1')
    return project, parse_document(client.documents.get('d1', include_body=True), project)


def _target(project, target_id):
    return next(t for t in tg.fillable(project) if t.id == target_id)


def test_what_a_job_can_fill_is_read_from_the_configuration():
    project, _ = _parsed()
    assert [(t.id, t.name, t.scope) for t in tg.fillable(project)] == [
        ('segmentation', 'segmentation', 'Word'), ('sl-gloss', 'Gloss', 'Word'), (ROLE, 'Role', 'Word'),
        (MGLOSS, 'Morph Gloss', 'Morpheme'), (MPOS, 'Morph POS', 'Morpheme'), (TRANS, 'Translation', 'Sentence'),
        (NOTE, 'Note', 'Sentence')]
    assert [t.id for t in tg.app_default(project)] == ['segmentation', MGLOSS, TRANS]


def test_the_one_rule_for_each_kind_of_target():
    project, doc = _parsed()
    s1, s2 = doc.sentences
    ka, pata, sa = s1.words
    seg = _target(project, 'segmentation')
    assert [word_state(w) for w in s1.words] == ['unanalyzed', 'protected', 'unanalyzed']
    # A word holding only a word field's value is still empty for
    # segmentation (REV-DAY-S-7).
    assert [tg.empty(seg, w=w) for w in s1.words] == [True, False, True]
    assert [tg.empty(_target(project, ROLE), w=w) for w in s1.words] == [True, True, False]
    mpos, mgloss = _target(project, MPOS), _target(project, MGLOSS)
    assert [(m.form, tg.empty(mgloss, m=m), tg.empty(mpos, m=m)) for w in s1.words for m in w.morphemes] == [
        ('ka', True, True), ('pa', False, True), ('ta', True, True), ('sa', True, True)]
    assert tg.empty(_target(project, NOTE), s=s1) and tg.empty(_target(project, TRANS), s=s1)
    words, fields = sentence_targets(s1, project, J, targets=[seg])
    assert [w.surface for w in words] == ['ka', 'sa'] and fields == []
    words, fields = sentence_targets(s1, project, J, targets=[_target(project, NOTE)])
    assert words == [] and [t.name for t in fields] == ['Note']
    assert translation_state(s2, project, J) == 'empty'


def test_what_a_piece_is_told_is_empty():
    project, doc = _parsed()
    s1 = doc.sentences[0]
    t = {i: _target(project, i) for i in ('segmentation', ROLE, MGLOSS, MPOS, NOTE, TRANS)}
    assert tg.empty_line(s1, [t['segmentation'], t[MGLOSS]]) == \
        'Empty in s1: segmentation and Morph Gloss in w1 "ka", w3 "sa" | Morph Gloss in w2.m2 "ta".'
    assert tg.empty_line(s1, [t[ROLE]]) == 'Empty in s1: Role in w1 "ka", w2 "pata".'
    assert tg.empty_line(s1, [t[MPOS]]) == 'Empty in s1: Morph POS in w1 "ka", w2.m1 "pa", w2.m2 "ta", w3 "sa".'
    assert tg.empty_line(s1, [t[NOTE], t[TRANS]]) == 'Empty in s1: Note | Translation.'
    assert tg.empty_line(s1, []) is None


# --- four jobs through the same code ------------------------------------------------------

JOBS = {
    # target id: (instructions, what the piece stages, the Empty line of s1, tools, Left blank refs)
    ROLE: ('Fill Role on every word.', ('set_field', {'refs': ['s1.w1'], 'field': 'Role', 'value': 'agent'}),
           'Empty in s1: Role in w1 "ka", w2 "pata".', [], ['s1.w2', 's2.w1']),
    MPOS: ('Fill Morph POS on every morpheme.',
           ('set_field', {'refs': ['s1.w2.m1'], 'field': 'Morph POS', 'value': 'N'}),
           'Empty in s1: Morph POS in w1 "ka", w2.m1 "pa", w2.m2 "ta", w3 "sa".', [], ['s1.w1', 's1.w2', 's1.w3',
                                                                                       's2.w1']),
    NOTE: ('Write a Note on every sentence.', ('set_field', {'refs': ['s1'], 'field': 'Note', 'value': 'n.'}),
           'Empty in s1: Note.', [], ['s2']),
    'gloss': ('Segment and gloss the words nobody analysed.',
              ('set_analysis', {'ref': 's1.w1', 'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'g'}}]}),
              'Empty in s1: segmentation and Morph Gloss in w1 "ka", w3 "sa" | Morph Gloss in w2.m2 "ta".',
              ['analyze_sentence', 'create_entry', 'link_entry', 'set_analysis'], ['s1.w2', 's1.w3', 's2.w1']),
}


@pytest.mark.parametrize('job_on', list(JOBS), ids=['word-field', 'morpheme-field', 'sentence-field', 'glossing'])
def test_a_job_on_any_field_is_told_offered_written_and_reported_by_its_targets(monkeypatch, job_on):
    instructions, (tool, args), line, more_tools, left = JOBS[job_on]
    fills = ('segmentation', MGLOSS) if job_on == 'gloss' else (job_on,)
    client = JobClient({'d1': _raw()}, project=fields_project())
    job = start(client, instructions, id=J, fills=fills)
    analysed, values, real = set(), [], igt_job.execute_plan

    def execute(c, ops, **kw):
        out = real(c, ops, **kw)
        for o in ops:
            if o.get('kind') == 'set_analysis':
                analysed.add(o['word_id'])
            elif o.get('kind') == 'set_span' and o.get('layer_id') in (ROLE, MPOS, NOTE):
                values.append((o['layer_id'], o['token_id'], o['value'], J))
        client.after_write['d1'] = {**_raw(analysed, values), 'version': len(client.writes) + 1}
        return out
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        return reply(calls=[call(1, tool, {'document': 'Story', **args})])
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    first = model.calls[0]
    assert line in first['asked'], first['asked']
    assert sorted(t['function']['name'] for t in first['kwargs']['tools']) == sorted(
        ['set_field', 'read_lexicon', 'analyses_of'] + more_tools)
    (doc,) = finished['report']['documents']
    assert [e['ref'] for e in doc['left']] == left, doc['left']
    assert analysed or values, 'the piece wrote'
    names = {e['ref']: e['targets'] for e in doc['left']}
    if job_on != 'gloss':
        assert set(n for ts in names.values() for n in ts) == {tg.of_ids(client_project(client), [job_on])[0].name}
    # What is still blank, per target of the plan and only those: a job that
    # fills no translation says nothing of translations (REV-DAY-P-4, S-9).
    assert doc['counts']['blank'] == BLANK[job_on], doc['counts']
    assert finished['report']['totals']['blank'] == BLANK[job_on]
    assert 'left_translations' not in doc['counts'] and 'not_reached_translations' not in doc['counts']
    if job_on == NOTE:
        assert 'left' not in doc['counts'], 'a plan that fills no word counts no word left'
    else:
        assert doc['counts']['left'] == len(left)


def _blank(target, left, unit='word'):
    return {'target': target, 'unit': unit, 'left': left, 'not_reached': 0, 'skipped': 0}


BLANK = {ROLE: [_blank('Role', 2)], MPOS: [_blank('Morph POS', 4)], NOTE: [_blank('Note', 1, 'sentence')],
         'gloss': [_blank('segmentation', 2), _blank('Morph Gloss', 3)]}


def client_project(client):
    return load_project(client, 'p1')


def test_a_plan_that_fills_nothing_tells_no_piece_anything_is_empty(monkeypatch):
    """A check: no Empty line, no evidence, no Nothing-empty line, the field
    tool and the reads, and nothing Left blank."""
    client = JobClient({'d1': _raw()}, project=fields_project())
    job = start(client, 'Check the glosses.', id=J, fills=())
    model = use(monkeypatch, Model(lambda asked, n, kwargs: reply('Checked.')))
    finished = run_job(job, runner(job))
    asked = model.calls[0]['asked']
    assert 'Empty in' not in asked and 'Nothing empty' not in asked and 'How these forms' not in asked
    assert sorted(t['function']['name'] for t in model.calls[0]['kwargs']['tools']) == [
        'analyses_of', 'read_lexicon', 'set_field']
    doc = finished['report']['documents'][0]
    assert doc['left'] == [] and 'blank' not in doc['counts'] and 'left' not in doc['counts']
    assert 'blank' not in finished['report']['totals']


def test_the_evidence_of_a_word_field_is_its_values_on_the_same_form(monkeypatch):
    """A Role job: "sa" is empty in Role in s2, and people gave "sa" the
    value patient in s1: the block says so, per value."""
    spec = [SPEC[0], {'words': ['sa', 'mo']}]
    raw = with_values(document('d1', 'Story', spec), PEOPLE)
    client = JobClient({'d1': raw}, project=fields_project())
    job = start(client, 'Fill Role.', id=J, fills=(ROLE,))
    model = use(monkeypatch, Model(lambda asked, n, kwargs: reply('Done.')))
    run_job(job, runner(job))
    asked = model.calls[0]['asked']
    assert 'Role on other words of these forms (by people in this project, and earlier in this job):\n' \
           '- "sa": people: patient (1)' in asked, asked
    assert 'Role on no other word of: ka, pata, mo.' in asked
    assert 'How these forms were analysed' not in asked and 'Lexicon entries' not in asked


def test_a_default_plan_shows_no_piece_a_sentence_people_analysed(monkeypatch):
    """REV-DAY-S-12: planning fails. The default plan fills the app's
    default and skips filled sentences, so the piece is handed s2 alone and
    the person's analysed and translated s1 only as context."""
    client = JobClient({'d1': document('d1', 'Story', [
        {'words': [('gam', [('gam', 'fish')], 'human')], 'translation': ('Fish.', 'human')},
        {'words': ['ka']}])})
    job = start(client, id=J, plan=None)

    def answer(asked, n, kwargs):
        if asked.endswith('Plan the job and end with plan_work.'):
            return reply('No plan.')
        return reply('Done.')
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    plan = finished['report']['plan']
    assert plan['by'] == 'default' and plan['only_empty'] is True
    assert plan['fills'] == ['segmentation', MGLOSS, TRANS]
    pieces = [c['asked'] for c in model.calls if 'Your piece:' in c['asked'] and c['n'] == 1]
    assert [p.splitlines()[-1] for p in pieces] == ['Your piece: s2. s1 is context.'], pieces
    assert 'Empty in s2: segmentation and Morph Gloss in w1 "ka" | Translation.' in pieces[0]


# --- people's precedent, per value, as each piece starts (REV-DAY-S-13, S-10) -----------------

def test_a_field_value_the_job_added_leaves_peoples_form_and_gloss_their_precedent(monkeypatch):
    """REV-DAY-S-13: the job filled Morph POS on a person's "ka" (eat) in
    another document. A gloss piece's block still reads people's analysis
    of ka, never "Analysed nowhere before"."""
    other = with_values(document('dP', 'Other', [{'words': [('ka', [('ka', 'eat')], 'human')]}]),
                        [(MPOS, 'dP-s1w1m1', 'V', J)])
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka']}]), 'dP': other}, project=fields_project())
    job = start(client, id=J, documents=['d1'])
    model = use(monkeypatch, Model(lambda asked, n, kwargs: reply('Done.')))
    run_job(job, runner(job))
    asked = model.calls[0]['asked']
    assert '- "ka": people: ka ‘eat’ (1)' in asked, asked
    assert 'Analysed nowhere before' not in asked


def test_a_later_piece_reads_peoples_work_as_it_is_when_it_starts(monkeypatch):
    """REV-DAY-S-10: piece s1 changes a person's gam 'fish' (s3) to 'net' in
    place. Piece s2, of the same walk, no longer counts it as people's
    'fish': people's precedent is read as each piece starts, and the
    gloss the job wrote is the job's, not people's."""
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 1)
    person = ('gam', [('gam', 'fish')], 'human')
    before = [{'words': ['gam']}, {'words': ['gam']}, {'words': [person]}]
    changed = [{'words': ['gam']}, {'words': ['gam']},
               {'words': [('gam', [('gam', 'net')], {'token': 'human', 'span': J, 'link': 'human'})]}]
    client = JobClient({'d1': document('d1', 'Story', before)})
    client.after_write['d1'] = document('d1', 'Story', changed, version=2)
    job = start(client, id=J)
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        out = real(c, ops, **kw)
        # The listing moves with the write, as core's does.
        client._documents['d1'] = document('d1', 'Story', changed, version=2)
        return out
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def answer(asked, n, kwargs):
        if n > 1 or 'Your piece: s1.' not in asked:
            return reply('Done.')
        return reply(calls=[call(1, 'set_field', {'document': 'Story', 'refs': ['s3.w1.m1'], 'field': 'Morph Gloss',
                                                  'value': 'net'})])
    model = use(monkeypatch, Model(answer))
    run_job(job, runner(job))
    first = next(c['asked'] for c in model.calls if c['n'] == 1 and 'Your piece: s1.' in c['asked'])
    second = next(c['asked'] for c in model.calls if c['n'] == 1 and 'Your piece: s2.' in c['asked'])
    assert 'people: gam ‘fish’ (1)' in first, first
    assert 'gam ‘fish’' not in second, second
