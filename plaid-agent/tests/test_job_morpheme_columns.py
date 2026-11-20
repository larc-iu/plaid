"""A job that fills morpheme fields other than the gloss works through the
same code as a glossing job (the owner's steer of 2026-11-15, never a fixed
glossing list): a piece that segments is offered analyze_sentence, its items
in "forms" and exactly the morpheme fields its plan fills (the columns the
similar sentences name, ``lines.columns_of``), an item naming another column
is refused, the evidence block renders the fields the stretch fills, and the
report shows every morpheme field value a change writes. A glossing job is
told and shown what it was before, byte for byte."""

import json

import pytest

from fixtures import MGLOSS
from job_fixtures import (MPOS, JobClient, Model, call, document, fields_project, reply, runner, start, use,
                          with_values)

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import IgtRunner, holds_change
from plaid_agent.igt.project import load_project

J = 'JMC'
POS_COLUMNS = ["forms", "Morph POS"]
#: analyze_sentence's description in a glossing job's piece, as it was
#: before non-gloss columns (4ad569f28).
DEFAULT_DESCRIPTION = (
    'PLAN: segment and gloss sentences word by word. Each sentence is {ref, words}, words one "FORMS GLOSS" item per '
    'word of the ref, in order: morphemes apart by "-" or "=", one space before the gloss, e.g. {"ref": "s4", "words": '
    '["na-ku-ja PRS-INF-come", "le=o today=DEF"]}. Each glossed morpheme is linked to the one entry with that form '
    'and gloss; the answer lists those with several or none. help: true for the rest (other fields, words left as '
    'they are, new_entries).')


def _tool(model, name, n=0):
    return next(t for t in model.calls[n]['kwargs']['tools'] if t['function']['name'] == name)


def _answers(model):
    """What every tool call of the run answered, in order."""
    return [m['content'] for c in model.calls[-1:] for m in c['kwargs']['messages'] if m['role'] == 'tool']


def _job(monkeypatch, fills, sentences, raw=None, instructions='Segment the words and fill Morph POS.'):
    """A job over ``raw`` (two blank words, kata and mo, by default) whose
    piece stages one analyze_sentence of ``sentences``: the client, the
    model, the finished job and every op written."""
    raw = raw or document('d1', 'Story', [{'words': ['kata', 'mo']}])
    client = JobClient({'d1': raw}, project=fields_project())
    job = start(client, instructions, id=J, fills=fills)
    written, real = [], igt_job.execute_plan

    def execute(c, ops, **kw):
        written.extend(ops)
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        return reply(calls=[call(1, 'analyze_sentence', {'document': 'Story', 'sentences': sentences})])
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    return client, model, finished, written


def _values(ops):
    """``(word id, [(form, {layer id: value})])`` of each analysis written."""
    return [(o['word_id'], [(m['form'], {f['layer_id']: f['value'] for f in m.get('fields') or []})
                            for m in o['morphemes']]) for o in ops if o.get('kind') == 'set_analysis']


@pytest.mark.parametrize('columns', [None, POS_COLUMNS], ids=['the-pieces-own', 'named'])
def test_a_piece_that_segments_and_fills_a_non_gloss_field_stages_through_analyze_sentence(monkeypatch, columns):
    """Segmentation and Morph POS: the piece is offered analyze_sentence,
    told its columns once, and its items "FORMS MORPH-POS" write exactly
    those values, with no gloss and no link."""
    item = {'ref': 's1', 'words': ['ka-ta V-SFX', 'mo N'], **({'columns': columns} if columns else {})}
    _client, model, finished, written = _job(monkeypatch, ('segmentation', MPOS), [item])
    assert finished['state'] == 'done', finished.get('reason')
    names = {t['function']['name'] for t in model.calls[0]['kwargs']['tools']}
    assert {'analyze_sentence', 'set_analysis'} <= names
    assert _values(written) == [('d1-s1w1', [('ka', {MPOS: 'V'}), ('ta', {MPOS: 'SFX'})]),
                                ('d1-s1w2', [('mo', {MPOS: 'N'})])], written
    assert not [o for o in written if o.get('kind') in ('link', 'create_entry')]
    system = model.calls[0]['kwargs']['messages'][0]['content']
    assert system.count(json.dumps(POS_COLUMNS)) == 1, system
    assert 'look up only what its answer lists' not in system, 'no link is promised'
    tool = _tool(model, 'analyze_sentence')
    said = tool['function']['description']
    assert json.dumps(POS_COLUMNS) in said and 'FORMS GLOSS' not in said and 'linked' not in said, said
    assert set(tool['function']['parameters']['properties']) == {'document', 'sentences'}


@pytest.mark.parametrize('fills,columns,taken', [
    (('segmentation', MPOS), ['forms', 'gloss'], POS_COLUMNS),
    (('segmentation', MPOS), ['forms', 'Morph POS', 'gloss'], POS_COLUMNS),
    (('segmentation', MPOS), ['forms', 'Role'], POS_COLUMNS),
    (('segmentation', MGLOSS), ['forms', 'gloss', 'Morph POS'], ['forms', 'gloss']),
], ids=['gloss-not-a-target', 'one-more', 'a-word-field', 'glossing-job-with-pos'])
def test_an_item_naming_a_column_that_is_not_a_target_is_refused_and_nothing_written(monkeypatch, fills, columns,
                                                                                     taken):
    words = [' '.join(['ka-ta'] + ['x-y'] * (len(columns) - 1)), ' '.join(['mo'] + ['z'] * (len(columns) - 1))]
    _client, model, finished, written = _job(monkeypatch, fills, [{'ref': 's1', 'words': words, 'columns': columns}])
    assert not [o for o in written if o.get('kind') in ('set_analysis', 'set_span', 'link')], written
    (answer,) = _answers(model)
    assert f"this piece's items take the columns {json.dumps(taken)}" in answer, answer


def test_the_default_glossing_job_is_told_offered_and_shown_what_it_was(monkeypatch):
    """Segmentation and the gloss: the chat's analyze_sentence schema, the
    prompt's read-first line as it was, no columns named anywhere, and the
    evidence line ka ‘go’."""
    raw = document('d1', 'Story', [{'words': [('ka', [('ka', 'go')], 'human')]}, {'words': ['ka']}])
    _client, model, finished, _written = _job(monkeypatch, ('segmentation', MGLOSS),
                                              [{'ref': 's2', 'words': ['ka go']}], raw=raw,
                                              instructions='Segment and gloss.')
    assert finished['state'] == 'done'
    tool = _tool(model, 'analyze_sentence')['function']
    assert tool['description'] == DEFAULT_DESCRIPTION
    assert set(tool['parameters']['properties']) == {'document', 'sentences', 'new_entries', 'lexicon', 'help'}
    system = model.calls[0]['kwargs']['messages'][0]['content']
    assert ('Stage the words to segment with analyze_sentence first, and look up only what its answer lists as '
            'several or none.') in system
    assert 'columns' not in system
    asked = model.calls[0]['asked']
    assert '- "ka": people: ka ‘go’ (1)' in asked and 'Each analysis:' not in asked and 'Columns' not in asked


def test_a_job_that_fills_two_morpheme_fields_sees_both_in_the_evidence_block(monkeypatch):
    raw = with_values(document('d1', 'Story', [{'words': [('ka', [('ka', 'go')], 'human')]}, {'words': ['ka']}]),
                      [(MPOS, 'd1-s1w1m1', 'V', 'human')])
    _client, model, finished, written = _job(monkeypatch, ('segmentation', MGLOSS, MPOS),
                                             [{'ref': 's2', 'words': ['ka go V']}], raw=raw)
    asked = model.calls[0]['asked']
    assert 'How these forms were analysed before (by people in this project, and earlier in this job):\n' \
           'Each analysis: forms ‘gloss’ ‘Morph POS’.\n- "ka": people: ka ‘go’ ‘V’ (1)' in asked, asked
    said = _tool(model, 'analyze_sentence')['function']['description']
    assert json.dumps(['forms', 'gloss', 'Morph POS']) in said and 'linked' in said, said
    assert _values(written) == [('d1-s2w1', [('ka', {MGLOSS: 'go', MPOS: 'V'})])]


def test_a_job_that_segments_only_takes_forms_alone(monkeypatch):
    """No morpheme field among the targets: analyze_sentence with "forms"
    alone, the same rule (a whole sentence a call, never a word a call)."""
    _client, model, finished, written = _job(monkeypatch, ('segmentation',),
                                             [{'ref': 's1', 'words': ['ka-ta', 'mo']}], instructions='Segment.')
    assert finished['state'] == 'done'
    assert _values(written) == [('d1-s1w1', [('ka', {}), ('ta', {})]), ('d1-s1w2', [('mo', {})])]
    assert json.dumps(['forms']) in model.calls[0]['kwargs']['messages'][0]['content']


# --- the report shows every morpheme field value a change writes ------------------------------------------

def _story(pos):
    raw = with_values(document('d1', 'Story', [{'words': [('ka', [('ka', 'go')], 'human')]}]),
                      [(MPOS, 'd1-s1w1m1', pos, 'human')] if pos else [])
    client = JobClient({'d1': raw}, project=fields_project())
    job = start(client, id=J, fills=('segmentation', MGLOSS, MPOS))
    project = load_project(client, 'p1')
    from plaid_agent.igt.workspace import Workspace
    return runner(job), project, Workspace(client, project).doc('d1')


def _op(project, **values):
    layers = {'gloss': project.gloss_field('Morpheme').layer_id, 'pos': MPOS}
    return {'kind': 'set_analysis', 'word_id': 'd1-s1w1', 'label': 'x',
            'morphemes': [{'form': 'ka', 'fields': [{'layer_id': layers[k], 'value': v} for k, v in values.items()]}]}


def test_a_proposed_analysis_shows_every_morpheme_field_it_writes():
    run, project, doc = _story('N')
    c = run.describe(_op(project, gloss='go', pos='V'), doc, project)
    assert (c['from'], c['to']) == ('ka ‘go’ ‘N’', 'ka ‘go’ ‘V’')
    # The gloss alone, as before.
    run, project, doc = _story(None)
    c = run.describe(_op(project, gloss='went'), doc, project)
    assert (c['from'], c['to']) == ('ka ‘go’', 'ka ‘went’')


def test_a_change_differing_only_in_another_morpheme_field_is_not_taken_as_held():
    """Compared by the gloss alone, ka ‘go’ POS V was held by a word with
    ka ‘go’ POS N, and the proposed change was dropped from the report."""
    run, project, _ = _story('V')
    _, _, doc = _story('N')
    change = run.describe(_op(project, gloss='go', pos='V'), doc, project)
    assert not holds_change(doc, project, change)
    _, _, held = _story('V')
    assert holds_change(held, project, change)


def test_harmonizes_report_shows_every_morpheme_field_of_an_analysis():
    run, project, _ = _story(None)

    def analysis(pos):
        return {'morphemes': [{'form': 'ka', 'equals': False, 'fields': {'Morph Gloss': 'go', 'Morph POS': pos}}],
                'word': {}}
    moves = [{'form': 'ka', 'to': analysis('N'), 'by': 'people',
              'from': {'k': {'analysis': analysis('V'), 'words': [('d1', 'd1-s1w1')]}}}]
    report = IgtRunner.harmonize_report(moves, [], {('d1', 'd1-s1w1')}, {}, project)
    (changed,) = report['changed']
    assert changed['to'] == 'ka ‘go’ ‘N’' and changed['from'][0]['analysis'] == 'ka ‘go’ ‘V’'
