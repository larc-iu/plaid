"""What follows a piece works as before on a job limited by a search (SF,
rule 7): the report's change counts, the History entries the job's undo
takes back, harmonize, and the piece after a text edit, which takes the
sentences the edit changed whatever the search matched."""

import json

from job_fixtures import JobClient, Model, PLANNING_ENDS, call, document, planned, recorded, reply, runner, start, \
    text_edits, use

from plaid_agent.core.job import analysis_key, canonical, run_job
from plaid_agent.igt import job as igt_job

J = 'JSF'
OLD, NEW = 'be.3ᴀᴜɢII', 'be.3AUGII'


def _story(i, old):
    return document(f'd{i}', f'Story {i}', [
        {'words': [('nidr', [('nidr', OLD if k in old else 'be')], 'human'), ('ka', [('ka', 'go')], 'human')]}
        for k in (1, 2, 3)])


def _rename(asked, k, kwargs):
    if k > 1:
        return reply('Renamed.')
    doc = next(line for line in asked.splitlines() if line.startswith('Document "')).split('"')[1]
    line = next(line for line in asked.splitlines() if line.startswith('Your piece: '))
    refs = [r.strip() for r in line[len('Your piece: '):].split('.')[0].split(',')]
    return reply(calls=[call(1, 'set_field', {'document': doc, 'refs': [f'{r}.w1.m1' for r in refs],
                                              'field': 'Morph Gloss', 'value': NEW})])


RENAME = {'pieces': 'sentences', 'fills': ['Morph Gloss'], 'search': {'pattern': OLD, 'where': 'Morph Gloss'}}


def test_the_change_counts_and_the_history_entries_are_as_any_jobs(monkeypatch):
    """Story 1 holds the old gloss twice, Story 2 not at all, Story 3 once.
    The counts say 3 values, each in its document, and each write goes under
    the job's operation of its document, which its undo takes back; Story 2
    has no entry."""
    client = JobClient({'d1': _story(1, (1, 3)), 'd2': _story(2, ()), 'd3': _story(3, (2,))})
    job = start(client, 'Rename it.', id=J, plan=None)
    refs = []
    real = client.operation

    def operation(message, **kw):
        refs.append(kw.get('ref'))
        return real(message, **kw)
    client.operation = operation
    use(monkeypatch, Model(planned(_rename, RENAME)))
    finished = run_job(job, runner(job))
    report = finished['report']
    assert report['totals']['changes'] == 3
    assert report['totals']['changes_parts'] == [{'kind': 'values', 'n': 3}]
    by = {d['name']: d for d in report['documents']}
    assert [by[f'Story {i}']['counts']['changes'] for i in (1, 2, 3)] == [2, 0, 1]
    written = {r.split('/')[1] for r in refs if r and r.startswith(f'job:{J}/doc:')}
    assert written == {'doc:d1', 'doc:d3'}, refs
    assert job.rows['d2'].get('gloss_group') is None
    assert job.rows['d1'].get('gloss_group') and job.rows['d3'].get('gloss_group')


def _keep_search_plan(client, job_id, matched):
    plan = {'pieces': 'sentences', 'documents': None, 'by': 'model', 'why': None, 'fills': ['segmentation'],
            'search': {'pattern': 'ka', 'said': 'word form "ka"', 'sentences': 1, 'documents': 1}}
    text = canonical(plan)
    rows = [{'form': igt_job.SEARCH_FORM, 'key': sid, 'analysis': '', 'count': 1, 'document_id': d,
             'sentence_id': sid} for d, ids in matched.items() for sid in ids]
    rows.append({'form': igt_job.PLAN_FORM, 'key': analysis_key(text), 'analysis': text, 'count': 1,
                 'document_id': None, 'sentence_id': None})
    client.jobs.add_decisions(job_id, 'worker-1', rows)


def test_harmonize_works_as_before_under_a_plan_limited_by_a_search():
    """The job's own analyses of ka, two to one: the minority rewritten, in
    a document whose sentences the search did not match too."""
    def w(form, gloss):
        return (form, [(form, gloss)], 'JH')
    client = JobClient({'d1': document('d1', 'Story d1', [{'words': [w('ka', 'go'), w('ka', 'go')]}]),
                        'd2': document('d2', 'Story d2', [{'words': [w('ka', 'come'), w('ta', 'x')]}])})
    job = start(client, id='JH', plan=None)
    _keep_search_plan(client, 'JH', {'d1': ['d1-s1']})
    for d in ('d1', 'd2'):
        job.update_row(d, state='done')
    recorded(job)
    r = runner(job)
    assert r.plan(job)['matched'] == {'d1': ['d1-s1']}
    out = r.harmonize(job)
    assert out['changed'] == [{'form': 'ka', 'to': 'ka ‘go’', 'by': 'majority',
                               'from': [{'analysis': 'ka ‘come’', 'count': 1, 'documents': ['d2']}]}]


def test_a_text_edit_of_a_matched_sentence_is_followed_by_its_piece_as_before(monkeypatch):
    """The search matched s2 (kvalaxar) only. Its piece inserts xosan before
    it, and the piece after the text edit takes s2 as the edit left it and
    analyses the new word: the following piece is not limited by the
    search."""
    text_edits(monkeypatch)
    before = [{'words': [('sa', [('sa', 'one')], 'human')]},
              {'words': [('kvalaxar', [('kvalax', 'work'), ('ar', 'PL')], 'human')]}]
    client = JobClient({'d1': document('d1', 'Story', before)})
    job = start(client, 'Insert xosan before kvalaxar and segment and gloss it.', id=J, plan=None)
    sent = []

    def execute(c, ops, **kw):
        sent.append([o['kind'] for o in ops])
        if any(o['kind'] == 'edit_text' for o in ops):
            raw = document('d1', 'Story', [before[0], {'words': [
                'xosan', ('kvalaxar', [('kvalax', 'work'), ('ar', 'PL')], 'human')]}], version=len(sent) + 1)
            words = raw['text_layers'][0]['token_layers'][1]['tokens']
            words[1]['id'], words[2]['id'] = 'd1-new', 'd1-s2w1'
            for m in raw['text_layers'][0]['token_layers'][2]['tokens']:
                m['id'] = m['id'].replace('d1-s2w2', 'd1-s2w1')
            client._holder('d1')['documents']['d1'] = raw
        return {}
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def answer(asked, n, kwargs):
        if igt_job.AFTER_TEXT_LINE in asked:
            if n == 1:
                return reply(calls=[call(9, 'set_analysis', {'document': 'Story', 'ref': 's2.w1 "xosan"',
                                                             'morphemes': [{'form': 'xosan',
                                                                            'fields': {'Morph Gloss': 'good'}}]})])
            return reply('Glossed xosan.')
        if n == 1:
            return reply(calls=[call(1, 'retype_sentence', {'document': 'Story', 'ref': 's2',
                                                            'text': 'xosan kvalaxar.'})])
        return reply('Inserted xosan.')
    model = use(monkeypatch, Model(planned(answer, {
        'pieces': 'sentences', 'fills': ['segmentation', 'Morph Gloss'], 'edits_text': True,
        'search': {'pattern': 'kvalaxar'}})))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    firsts = [c['asked'] for c in model.calls if c['n'] == 1 and not str(c['asked']).rstrip().endswith(PLANNING_ENDS)]
    assert len(firsts) == 2, 'the matched sentence, then its piece after the text edit'
    assert 'Your piece: s2.' in firsts[0]
    assert igt_job.AFTER_TEXT_LINE in firsts[1] and 'Your piece: s2.' in firsts[1]
    assert sent == [['edit_text'], ['set_analysis']]
    pieces = [json.loads(json.dumps(p['piece'])) for p in client.jobs.pieces(J) if p['piece'].get('document')]
    assert sorted(p.get('after_text') or '' for p in pieces) == ['', 'edited'], pieces
    # The work list names the matched piece's sentences, the following piece by its own words.
    assert sorted(str(p.get('matching')) for p in pieces) == ['None', "['s2']"], pieces
