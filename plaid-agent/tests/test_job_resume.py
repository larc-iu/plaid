"""The cursor, the counts and the decisions a stretch leaves, and a job that
resumes after a crash (SPEC 3.8, 7.3)."""

import json

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.core.job import analysis_key, canonical
from plaid_agent.igt.job import IgtRunner


def _analyse_all(asked, n, kwargs):
    if n > 1:
        return reply('Done.')
    calls = []
    for line in asked.splitlines():
        if line.startswith('Targets in s'):
            s = line.split()[2].rstrip(':')
            for w in line.split('words ')[1].split(' and ')[0].split(', ') if 'words ' in line else []:
                ref, form = w.split(' ')[0], w.split('"')[1]
                calls.append(call(len(calls) + 1, 'set_analysis', {'document': 'Story', 'ref': f'{s}.{ref}',
                                                                   'morphemes': [{'form': form, 'type': 'stem',
                                                                                  'fields': {'Morph Gloss': 'go'}}]}))
            if 'the translation' in line:
                calls.append(call(len(calls) + 1, 'set_field', {'document': 'Story', 'refs': [s],
                                                                'field': 'Translation', 'value': 'T.'}))
    return reply(calls=calls)


def test_a_stretch_counts_what_it_wrote_and_records_its_decisions(monkeypatch):
    before = [{'words': ['Ka', 'ta']}, {'words': ['ka'], 'translation': ('Old.', 'machine')}]
    after = [{'words': [('Ka', [('Ka', 'G')], 'J5'), ('ta', [('ta', 'G')], 'J5')], 'translation': ('T.', 'J5')},
             {'words': [('ka', [('ka', 'G')], 'J5')], 'translation': ('T.', 'J5')}]
    client = JobClient({'d1': document('d1', 'Story', before)})
    client.after_write['d1'] = document('d1', 'Story', after, version=2)
    job = start(client, ['translate', 'gloss'], id='J5')
    use(monkeypatch, Model(_analyse_all))
    assert runner(job).document('d1') == 'done'
    row = job.rows['d1']
    assert row['counts']['words'] == 3 and row['counts']['translations'] == 1 and row['counts']['refreshed'] == 1
    assert row['counts']['left'] == 0 and row['done'] == 2 and row['last_sentence'] == 'd1-s2'
    decided = client.jobs.decision_rows['J5']
    by_form = {}
    for (form, key), r in decided.items():
        by_form.setdefault(form, []).append(r)
        assert key == analysis_key(r['analysis']) and r['analysis'] == canonical(json.loads(r['analysis']))
    assert sorted(by_form) == ['ka', 'ta'], 'case-folded: Ka and ka are one form'
    assert sum(r['count'] for r in by_form['ka']) == 2
    a = json.loads(by_form['ta'][0]['analysis'])
    assert a == {'morphemes': [{'form': 'ta', 'type': None, 'equals': False, 'fields': {'Morph Gloss': 'G'},
                                'entry': None, 'made': False}], 'word': {}}


def test_a_resumed_document_goes_on_after_its_cursor(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['a']}, {'words': ['b']}, {'words': ['c']}])})
    job = start(client, ['gloss'])
    job.update_row('d1', last_sentence='d1-s2', gloss_group='G-1', state='working')
    model = use(monkeypatch, Model(_analyse_all))
    groups = []
    real = client.operation

    def operation(message, **kw):
        groups.append(kw.get('group_id'))
        return real(message, **kw)
    client.operation = operation
    runner(job).document('d1')
    assert [c['asked'].splitlines()[-1] for c in model.calls if c['n'] == 1] == ['Analyse s3. s1, s2 are context.']
    assert [g for g in groups if g] == ['G-1'], 'the History entry of the document the job began'


def test_a_cursor_whose_sentence_is_gone_starts_from_the_top_and_writes_nothing_twice(monkeypatch):
    analysed = [{'words': [('a', [('a', 'G')], 'J7')]}, {'words': ['b']}]
    client = JobClient({'d1': document('d1', 'Story', analysed)})
    job = start(client, ['gloss'], id='J7')
    job.update_row('d1', last_sentence='a-sentence-merged-away', state='working')
    model = use(monkeypatch, Model(_analyse_all))
    runner(job).document('d1')
    asked = [c['asked'] for c in model.calls if c['n'] == 1]
    assert len(asked) == 1 and asked[0].splitlines()[-1].startswith('Analyse s2.')


def test_a_job_that_crashed_in_harmonize_runs_it_again_and_skips_the_checks_and_the_documents():
    from plaid_agent.core.job import run_job
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['a']}])})
    job = start(client, ['gloss'])
    job.status['phase'] = 'harmonizing'
    calls = []

    class Runner(IgtRunner):
        def check(self, j):
            calls.append('check')

        def work(self, j):
            calls.append('work')

        def harmonize(self, j):
            calls.append('harmonize')
            return {'changed': [], 'left': []}

        def entries(self, j):
            calls.append('entries')
            return {}
    r = Runner(job, runner(job).cfg)
    done = run_job(job, r)
    assert calls == ['harmonize', 'entries'] and done['state'] == 'done'
