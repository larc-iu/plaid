"""A plan limited by a search, under a real core (SF): the planning's
plan_work runs the search on the core's query engine, the walk takes only
the sentences it matched, and Undo job takes the job's writes back exactly.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time

from fixtures import MGLOSS
from job_fixtures import Model, PLANNING_ENDS, call, document, planned, reply, use
from test_job_live_entries import WORKER, _runner, world  # noqa: F401 - the fixture

from plaid_agent.core.job import Job, run_job
from plaid_agent.igt import job as igt_job

OLD, NEW = 'be.3ᴀᴜɢII', 'be.3AUGII'
#: Story i holds the old gloss in this many of its sentences: 33 in 24 of 45.
HITS = {**{i: 1 for i in range(1, 18)}, **{i: 2 for i in range(18, 23)}, **{i: 3 for i in range(23, 25)}}


def _job(admin, writer, s, instructions):
    """A job the writer started, claimed, with no plan: its planning context
    plans it on the core."""
    from plaid_client import PlaidClient
    from live import core_url
    made = writer.jobs.create(s.project_id, 'igt', instructions)
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    assert claimed and claimed['job']['id'] == made['id']
    offset = {'s': 0.0}

    def wait(sec):
        offset['s'] += sec
    return Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
               sleep=wait, now=lambda: time.time() + offset['s'])


def _glosses(admin, s):
    """Every Morph Gloss value in the project, by document and token, as the
    core holds them."""
    out = {}
    for d in s.ids:
        if not str(d).startswith('d') or d not in s.docs:
            continue
        raw = admin.documents.get(s.ids[d], include_body=True)
        for tl in raw['text_layers']:
            for tk in tl['token_layers']:
                for sl in tk.get('span_layers') or []:
                    if sl['id'] == s.ids[MGLOSS]:
                        for sp in sl.get('spans') or []:
                            out[(d, tuple(sp['tokens']))] = sp['value']
    return out


def _pieces(model):
    return [c['asked'] for c in model.calls if c['n'] == 1 and not str(c['asked']).rstrip().endswith(PLANNING_ENDS)]


def _rename(asked, k, kwargs):
    if k > 1:
        return reply('Renamed.')
    doc = next(line for line in asked.splitlines() if line.startswith('Document "')).split('"')[1]
    line = next(line for line in asked.splitlines() if line.startswith('Your piece: '))
    refs = [r.strip() for r in line[len('Your piece: '):].split('.')[0].split(',')]
    return reply(calls=[call(1, 'set_field', {'document': doc, 'refs': [f'{r}.w1.m1' for r in refs],
                                              'field': 'Morph Gloss', 'value': NEW})])


def test_the_rename_shape_walks_only_the_matching_sentences_and_undo_is_exact(world, monkeypatch):
    """45 texts of three sentences, the old gloss in 33 sentences of 24 of
    them: 24 pieces, one per text holding a match, given only its matching
    sentences; the other 21 end with no model call and say so; every row
    and the totals are true; Undo job puts every value back as it was."""
    admin, writer, make = world
    docs = {f'd{i}': document(f'd{i}', f'Story {i}', [
        {'words': [('nidr', [('nidr', OLD if k <= HITS.get(i, 0) else 'be')], 'human'),
                   ('ka', [('ka', 'go')], 'human')]} for k in (1, 2, 3)]) for i in range(1, 46)}
    s = make(docs, maintainer=True)
    s.docs = docs
    before = _glosses(admin, s)
    assert sum(v == OLD for v in before.values()) == 33
    model = use(monkeypatch, Model(planned(_rename, {'pieces': 'sentences', 'fills': ['Morph Gloss'],
                                                     'search': {'pattern': OLD, 'where': 'Morph Gloss'}})))
    job = _job(admin, writer, s, f'Change the gloss {OLD} to {NEW} everywhere.')
    finished = run_job(job, _runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    assert len(_pieces(model)) == 24
    after = _glosses(admin, s)
    assert sum(v == NEW for v in after.values()) == 33 and not any(v == OLD for v in after.values())
    assert {k: v for k, v in after.items() if before[k] != OLD} == {k: v for k, v in before.items() if v != OLD}
    report = finished['report']
    assert report['plan']['search'] == {'pattern': OLD, 'where': 'Morph Gloss', 'said': f'Morph Gloss "{OLD}"',
                                        'sentences': 33, 'documents': 24}
    assert report['totals']['changes'] == 33
    back = {real: fixture for fixture, real in s.ids.items()}
    for d in report['documents']:
        i = int(back[d['document_id']][1:])
        n = HITS.get(i, 0)
        assert (d['state'], d['targets'], d['done'], d['counts']['matched'], d['counts']['changes']) == \
            ('done', n, n, n, n), (i, d)
    assert igt_job.document_counts(report)['with_no_matching_sentence'] == 21
    assert igt_job.document_counts(report)['done'] == 24
    # As core keeps the job: the rows and the plan as the page reads them.
    read = admin.jobs.get(job.id)
    assert sum(1 for d in read['documents'] if d['counts'].get('matched') == 0) == 21
    assert writer.jobs.undo(job.id)
    assert _glosses(admin, s) == before, 'Undo job put every value back as it was'


def test_a_fill_limited_by_a_search_and_to_what_is_empty(world, monkeypatch):
    """Gloss the morphemes of sentences holding the word ka, only those with
    something empty: Alpha s1 (ka, an unglossed morpheme) is worked, s2 (ka,
    all glossed) and s3 (no ka, unglossed) are not, Beta (no ka) ends with no
    model call."""
    admin, writer, make = world
    docs = {'dA': document('dA', 'Alpha', [
        {'words': [('ka', [('ka', None)], 'human'), ('sa', [('sa', 'one')], 'human')]},
        {'words': [('ka', [('ka', 'go')], 'human'), ('ta', [('ta', 'two')], 'human')]},
        {'words': [('mo', [('mo', None)], 'human')]}]),
        'dB': document('dB', 'Beta', [{'words': [('mo', [('mo', None)], 'human')]}])}
    s = make(docs)
    s.docs = docs

    def gloss(asked, k, kwargs):
        if k == 1:
            return reply(calls=[call(1, 'set_field', {'document': 'Alpha', 'refs': ['s1.w1.m1'],
                                                      'field': 'Morph Gloss', 'value': 'go'})])
        return reply('Glossed ka.')
    model = use(monkeypatch, Model(planned(gloss, {'pieces': 'sentences', 'fills': ['Morph Gloss'],
                                                   'skip_filled_sentences': True, 'search': {'pattern': 'ka'}})))
    job = _job(admin, writer, s, 'Gloss the morphemes left empty in the sentences with ka.')
    finished = run_job(job, _runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    pieces = _pieces(model)
    assert len(pieces) == 1 and 'Your piece: s1.' in pieces[0] and '"Alpha"' in pieces[0], pieces
    by = {d['name']: d for d in finished['report']['documents']}
    assert (by['Alpha']['targets'], by['Alpha']['done'], by['Alpha']['counts']['matched']) == (1, 1, 2)
    assert (by['Beta']['state'], by['Beta']['targets'], by['Beta']['counts']['matched']) == ('done', 0, 0)
    assert by['Alpha']['counts']['changes'] == 1
    glossed = _glosses(admin, s)
    assert glossed[('dA', (s.ids['dA-s1w1m1'],))] == 'go'
    # Alpha s3 and Beta are not the job's work: nothing blank is counted there.
    blank = {b['target']: b for b in by['Alpha']['counts'].get('blank') or []}
    assert all(b.get('not_reached', 0) == 0 for b in blank.values()), blank
    assert not by['Beta']['counts'].get('blank') or all(
        b.get('not_reached', 0) == 0 for b in by['Beta']['counts']['blank']), by['Beta']['counts']
