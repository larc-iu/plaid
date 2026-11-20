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
#: analyze_sentence's description in a glossing job's piece: the chat's,
#: less the other fields its help offers, which a job's piece does not take.
DEFAULT_DESCRIPTION = (
    'PLAN: segment and gloss sentences word by word. Each sentence is {ref, words}, words one "FORMS GLOSS" item per '
    'word of the ref, in order: morphemes apart by "-" or "=", one space before the gloss, e.g. {"ref": "s4", "words": '
    '["na-ku-ja PRS-INF-come", "le=o today=DEF"]}. Each glossed morpheme is linked to the one entry with that form '
    'and gloss; the answer lists those with several or none. help: true for the rest (words left as they are, '
    'new_entries).')


def _tool(model, name, n=0):
    return next(t for t in model.calls[n]['kwargs']['tools'] if t['function']['name'] == name)


def _answers(model):
    """What every tool call of the run answered, in order."""
    return [m['content'] for c in model.calls[-1:] for m in c['kwargs']['messages'] if m['role'] == 'tool']


def _job(monkeypatch, fills, sentences, raw=None, instructions='Segment the words and fill Morph POS.',
         project=None):
    """A job over ``raw`` (two blank words, kata and mo, by default) whose
    piece stages one analyze_sentence of ``sentences``: the client, the
    model, the finished job and every op written."""
    raw = raw or document('d1', 'Story', [{'words': ['kata', 'mo']}])
    client = JobClient({'d1': raw}, project=project or fields_project())
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
    assert '- "ka": people: ka ‘go’ (1)' in asked and '[' not in asked.split('- "ka"')[1].split('\n')[0]
    assert 'Columns' not in asked
    # Its help offers no column the piece does not take; the chat's does.
    from plaid_agent.igt import toolkit
    from plaid_agent.igt.lines import HELP
    from plaid_agent.igt.workspace import Workspace
    ws = igt_job.JobWorkspace(_client, load_project(_client, 'p1'))
    ws.in_sentences, ws.fills = True, [t for t in igt_job.tg.fillable(ws.project) if t.id in ('segmentation', MGLOSS)]
    said = toolkit.call_tool(ws, 'analyze_sentence', {'help': True})
    assert 'columns' not in said and '"POS"' not in said, said
    assert said == HELP.replace('Other morpheme fields: columns names an item\'s columns, e.g. "columns": ["forms", '
                                '"gloss", "POS"] and items like "na-ku-ja PRS-INF-come v-asp-v".\n\n', '')
    assert toolkit.call_tool(Workspace(_client, ws.project), 'analyze_sentence', {'help': True}) == HELP


def test_a_job_that_fills_two_morpheme_fields_sees_both_in_the_evidence_block(monkeypatch):
    raw = with_values(document('d1', 'Story', [{'words': [('ka', [('ka', 'go')], 'human')]}, {'words': ['ka']}]),
                      [(MPOS, 'd1-s1w1m1', 'V', 'human')])
    _client, model, finished, written = _job(monkeypatch, ('segmentation', MGLOSS, MPOS),
                                             [{'ref': 's2', 'words': ['ka go V']}], raw=raw)
    asked = model.calls[0]['asked']
    assert 'How these forms were analysed before (by people in this project, and earlier in this job):\n' \
           '- "ka": people: ka ‘go’ [Morph POS: V] (1)' in asked, asked
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


def test_a_job_that_segments_only_sees_the_gloss_in_its_evidence(monkeypatch):
    """The owner, 2026-11-20: the gloss of a past analysis tells two splits
    of one spelling apart, so a job that only segments sees it, though its
    items take "forms" alone."""
    raw = document('d1', 'Story', [{'words': [('kata', [('ka', 'go'), ('ta', 'PST')], 'human')]}, {'words': ['kata']}])
    _client, model, finished, _written = _job(monkeypatch, ('segmentation',), [{'ref': 's2', 'words': ['ka-ta']}],
                                              raw=raw, instructions='Segment.')
    assert '- "kata": people: ka-ta ‘go-PST’ (1)' in model.calls[0]['asked'], model.calls[0]['asked']
    said = _tool(model, 'analyze_sentence')['function']['description']
    assert json.dumps(['forms']) in said


def test_an_unknown_column_is_refused_with_the_pieces_columns_and_names_no_other_field(monkeypatch):
    _client, model, finished, written = _job(monkeypatch, ('segmentation', MPOS), [
        {'ref': 's1', 'words': ['ka-ta x-y', 'mo z'], 'columns': ['forms', 'Foo']}])
    assert not [o for o in written if o.get('kind') == 'set_analysis']
    (answer,) = _answers(model)
    assert f"this piece's items take the columns {json.dumps(POS_COLUMNS)}" in answer, answer
    assert 'Role' not in answer and 'Note' not in answer and 'Translation' not in answer, answer


# --- a column means a field the piece fills, by identity --------------------------------------------------

def _named(*fields):
    """The project of fields_project with morpheme fields ``(id, name)``
    added, the word field Gloss renamed Word Gloss (a name is no role)."""
    from job_fixtures import FIELD_LAYERS
    p = fields_project()
    layers = {tk['id']: tk for tk in p['text_layers'][0]['token_layers']}
    for layer_id, name in fields:
        layers[FIELD_LAYERS[MPOS][0]]['span_layers'].append(
            {'id': layer_id, 'name': name, 'config': {'igt': {'scope': 'Morpheme'}}})
    for tk in p['text_layers'][0]['token_layers']:
        for sl in tk['span_layers']:
            if sl['id'] == 'sl-gloss':
                sl['name'] = 'Word Gloss'
    return p


@pytest.mark.parametrize('name', ['Gloss', 'gloss', 'GLOSS'])
def test_the_gloss_field_named_gloss_is_the_default_glossing_job(monkeypatch, name):
    """The second review's probe: the gloss field's own name, "Gloss", was
    counted as a second column named "gloss", so the ordinary glossing job of
    a project whose morpheme gloss field is called Gloss lost analyze_sentence."""
    p = _named()
    for tk in p['text_layers'][0]['token_layers']:
        for sl in tk['span_layers']:
            if sl['id'] == MGLOSS:
                sl['name'] = name
    _client, model, finished, written = _job(monkeypatch, ('segmentation', MGLOSS),
                                             [{'ref': 's1', 'words': ['ka-ta A-B', 'mo C']}],
                                             project=p, instructions='Segment and gloss.')
    names = {t['function']['name'] for t in model.calls[0]['kwargs']['tools']}
    assert 'analyze_sentence' in names, names
    assert [vs for _w, ms in _values(written) for _f, vs in ms], written


@pytest.mark.parametrize('name', ['gloss', 'Gloss', 'forms', 'FORMS'])
def test_a_field_named_as_a_column_is_never_taken_for_it(monkeypatch, name):
    """The review's probe: a target field named "gloss" was taken for the
    default glossing job, and its values written on the gloss field, which
    the job does not fill. Such a piece is not offered analyze_sentence (it
    segments with set_analysis, as before columns) and is told no columns."""
    _client, model, finished, written = _job(monkeypatch, ('segmentation', 'sl-x'),
                                             [{'ref': 's1', 'words': ['ka-ta A-B', 'mo C']}],
                                             project=_named(('sl-x', name)), instructions='Segment and fill it.')
    assert not [v for _w, ms in _values(written) for _f, vs in ms for v in vs if v != 'sl-x'], written
    assert not _values(written)
    names = {t['function']['name'] for t in model.calls[0]['kwargs']['tools']}
    assert 'analyze_sentence' not in names and 'set_analysis' in names
    system = model.calls[0]['kwargs']['messages'][0]['content']
    assert 'columns' not in system and 'Segment each word with set_analysis' in system, system
    assert 'analyze_sentence' not in system


def test_two_target_fields_of_one_name_are_two_columns_by_the_names_the_project_gives_them(monkeypatch):
    """The project tells two fields of one name apart ("Morph POS
    (Morpheme)", "morph pos (Morpheme 2)"): two columns, each value written
    on its own field."""
    _client, model, finished, written = _job(monkeypatch, ('segmentation', MPOS, 'sl-x'),
                                             [{'ref': 's1', 'words': ['ka-ta A-B C-D', 'mo E F']}],
                                             project=_named(('sl-x', 'morph pos')))
    said = _tool(model, 'analyze_sentence')['function']['description']
    assert json.dumps(['forms', 'Morph POS (Morpheme)', 'morph pos (Morpheme 2)']) in said, said
    assert _values(written) == [('d1-s1w1', [('ka', {MPOS: 'A', 'sl-x': 'C'}), ('ta', {MPOS: 'B', 'sl-x': 'D'})]),
                                ('d1-s1w2', [('mo', {MPOS: 'E', 'sl-x': 'F'})])]


def test_a_column_named_by_its_fields_own_name_means_that_field(monkeypatch):
    """Resolved against the piece's own columns: "Morph Gloss" is the gloss
    column, "morph pos" the Morph POS one."""
    _client, model, finished, written = _job(monkeypatch, ('segmentation', MGLOSS, MPOS), [
        {'ref': 's1', 'words': ['ka-ta go-PST V-SFX', 'mo x N'], 'columns': ['forms', 'morph pos', 'Morph Gloss']}])
    assert _values(written) == [('d1-s1w1', [('ka', {MPOS: 'go', MGLOSS: 'V'}), ('ta', {MPOS: 'PST', MGLOSS: 'SFX'})]),
                                ('d1-s1w2', [('mo', {MPOS: 'x', MGLOSS: 'N'})])], written


def test_a_value_holding_a_delimiter_is_said_to_take_set_analysis(monkeypatch):
    _client, model, finished, _written = _job(monkeypatch, ('segmentation', MPOS),
                                              [{'ref': 's1', 'words': ['ka-ta V-SFX', 'mo N']}])
    said = _tool(model, 'analyze_sentence')['function']['description']
    assert 'A form or value holding a space, "-", "=" or "_" cannot be written here' in said, said


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
    assert (c['from'], c['to']) == ('ka ‘go’ [Morph POS: N]', 'ka ‘go’ [Morph POS: V]')
    # A value of no gloss is named all the same.
    c = run.describe(_op(project, pos='V'), doc, project)
    assert (c['from'], c['to']) == ('ka ‘go’ [Morph POS: N]', 'ka [Morph POS: V]')
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
    assert changed['to'] == 'ka ‘go’ [Morph POS: N]' and changed['from'][0]['analysis'] == 'ka ‘go’ [Morph POS: V]'
