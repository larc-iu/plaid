"""The walk of a plan limited by a search (SF).

The sentences the plan's search matched are taken once, at planning, and
kept in rows of their own among the job's decisions (the plan row is
capped), so a resumed job walks the same sentences. The walk takes only
those, AND those with something empty under skip_filled_sentences. A
document the search matched nothing in ends with no read and no model call,
its row saying so (``counts.matched`` 0), counted apart from the documents
worked. The search is never run again: a sentence a person changes after the
planning is taken by the walk's own rules, matching or not."""

from job_fixtures import JobClient, Model, PLANNING_ENDS, call, document, keep_plan, planned, reply, runner, start, use

from fixtures import MGLOSS
from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job

J = 'JSW'
OLD, NEW = 'be.3ᴀᴜɢII', 'be.3AUGII'
#: Story i holds the old gloss in this many of its sentences: 33 in 24 of 45.
HITS = {**{i: 1 for i in range(1, 18)}, **{i: 2 for i in range(18, 23)}, **{i: 3 for i in range(23, 25)}}


def _story(i, n=8):
    """Story i: ``n`` sentences of nidr and ka, each glossed by a person,
    nidr glossed OLD in the first HITS[i] sentences, else "be"."""
    k_old = HITS.get(i, 0)
    return document(f'd{i}', f'Story {i}', [{'words': [('nidr', [('nidr', OLD if k <= k_old else 'be')], 'human'),
                                                       ('ka', [('ka', 'go')], 'human')]} for k in range(1, n + 1)])


SEARCH = {'pattern': OLD, 'where': 'Morph Gloss'}
RENAME = {'pieces': 'sentences', 'fills': ['Morph Gloss'], 'search': SEARCH}


def _pieces(model):
    return [c['asked'] for c in model.calls if c['n'] == 1 and not str(c['asked']).rstrip().endswith(PLANNING_ENDS)]


def _your_piece(asked):
    return next(line for line in asked.splitlines() if line.startswith('Your piece: '))


def _renaming(asked, k, kwargs):
    """Each piece renames the old gloss in every sentence it is given."""
    if k > 1:
        return reply('Renamed.')
    name = next(line for line in asked.splitlines() if line.startswith('Document "'))
    doc = name.split('"')[1]
    refs = [r.strip() for r in _your_piece(asked)[len('Your piece: '):].split('.')[0].split(',')]
    return reply(calls=[call(1, 'set_field', {'document': doc, 'refs': [f'{r}.w1.m1' for r in refs],
                                              'field': 'Morph Gloss', 'value': NEW})])


def test_the_rename_shape_makes_pieces_only_for_the_matching_sentences(monkeypatch):
    """45 documents, 33 matching sentences in 24: one piece per document
    that holds a match, each given only its matching sentences, no piece and
    no read for the other 21, every row and the totals true."""
    client = JobClient({f'd{i}': _story(i) for i in range(1, 46)})
    job = start(client, f'Change the gloss {OLD} to {NEW} everywhere.', id=J, plan=None)
    lines = []

    def answer(asked, k, kwargs):
        if k == 1:
            lines.append(job.status.get('message'))
        return _renaming(asked, k, kwargs)
    model = use(monkeypatch, Model(planned(answer, RENAME)))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    pieces = _pieces(model)
    assert len(pieces) == 24, len(pieces)
    given = sorted(_your_piece(a) for a in pieces)
    assert 'Your piece: s1, s2, s3. ' in given[-1] or any(p.startswith('Your piece: s1, s2, s3.') for p in given), given
    assert all(p.startswith('Your piece: s1.') or p.startswith('Your piece: s1, s2.')
               or p.startswith('Your piece: s1, s2, s3.') for p in given), given
    # The line counts the matching sentences across the job, in its order.
    said, at = [], 0
    for d in job.order:
        n = HITS.get(int(d[1:]), 0)
        if n:
            said.append(f'Story {d[1:]}: ' + (f'matching sentence {at + 1}' if n == 1
                                               else f'matching sentences {at + 1} to {at + n}') + ' of 33.')
            at += n
    assert lines == said, (lines, said)
    report = finished['report']
    docs = {d['name']: d for d in report['documents']}
    for i in range(1, 46):
        d = docs[f'Story {i}']
        assert d['state'] == 'done', (i, d['state'])
        assert d['counts'][igt_job.MATCHED] == HITS.get(i, 0), (i, d['counts'])
        assert (d['targets'], d['done']) == (HITS.get(i, 0), HITS.get(i, 0)), (i, d['targets'], d['done'])
        assert d['counts']['changes'] == HITS.get(i, 0)
        assert igt_job.ONE_STEP not in d['counts']
    assert report['totals']['changes'] == 33
    assert igt_job.document_counts(report) == {'done': 24, 'changed': 24, 'with_nothing_found_by_the_search': 21,
                                              'skipped': 0, 'stopped_partway': 0, 'not_reached': 0, 'left_out': 0,
                                              'unanswered': 0}
    # Read only for planning and where a match is: the 21 others never after.
    plan = report['plan']
    assert plan['search'] == {**SEARCH, 'said': f'Morph Gloss "{OLD}"', 'sentences': 33, 'documents': 24}
    assert 'matched' not in plan
    # Nothing is blank, and the top line calls no document unread.
    assert 'not read through' not in (report.get('notice') or '')
    # Each piece's row names its sentences.
    summaries = [r for r in client.jobs.decision_rows[J].values() if r['form'] == igt_job.PIECE_FORM]
    import json
    named = sorted(json.loads(r['analysis']).get('matching') or [] for r in summaries)
    assert ['s1', 's2', 's3'] in named and ['s1'] in named, named


def test_the_matched_sentences_are_kept_in_rows_of_their_own_and_a_resumed_job_walks_them(monkeypatch):
    """The rows: one per sentence, keyed by its id, its document the row's,
    sent with the plan in one call. A job whose plan is kept is never planned
    again: a second worker reads the rows and walks the same sentences."""
    client = JobClient({f'd{i}': _story(i, 4) for i in (1, 2, 23)})
    job = start(client, 'Rename it.', id=J, plan=None)
    r = runner(job)
    model = use(monkeypatch, Model(planned(_renaming, {**RENAME, 'search': {'pattern': OLD, 'where': 'Morph Gloss',
                                                                             'documents': ['Story 1', 'Story 23']}})))
    plan = r.plan(job)
    assert plan['matched'] == {'d1': ['d1-s1'], 'd23': ['d23-s1', 'd23-s2', 'd23-s3']}
    rows = [x for x in client.jobs.decision_rows[J].values() if x['form'] == igt_job.SEARCH_FORM]
    assert sorted((x['first_document'], x['key']) for x in rows) == [
        ('d1', 'd1-s1'), ('d23', 'd23-s1'), ('d23', 'd23-s2'), ('d23', 'd23-s3')]
    calls = [c for c in client.jobs.calls if c[0] == 'add_decisions'
             and any(d['form'] == igt_job.PLAN_FORM for d in c[1]['decisions'])]
    assert len(calls) == 1 and sum(d['form'] == igt_job.SEARCH_FORM for d in calls[0][1]['decisions']) == 4
    plan_row = next(x for x in client.jobs.decision_rows[J].values() if x['form'] == igt_job.PLAN_FORM)
    assert 'd1-s1' not in plan_row['analysis']
    # A second worker: no planning, the same sentences.
    model.calls.clear()
    fresh = runner(job)
    assert fresh.plan(job)['matched'] == {'d1': ['d1-s1'], 'd23': ['d23-s1', 'd23-s2', 'd23-s3']}
    fresh.work(job)
    assert not any(str(c['asked']).rstrip().endswith(PLANNING_ENDS) for c in model.calls)
    assert [_your_piece(a).split('.')[0] for a in _pieces(model)] == ['Your piece: s1', 'Your piece: s1, s2, s3']
    assert job.rows['d2']['state'] == 'done' and job.rows['d2']['counts'][igt_job.MATCHED] == 0


def test_with_skip_filled_sentences_a_sentence_is_taken_when_both_rules_take_it(monkeypatch):
    """Story 1: s1 matches the search and has an empty word, s2 matches and
    is full, s3 has an empty word and does not match. Only s1 is worked, and
    the row says 1 of 3 with the others neither matching nor empty."""
    client = JobClient({'d1': document('d1', 'Story 1', [
        {'words': [('nidr', [('nidr', OLD)], 'human'), 'sa']},
        {'words': [('nidr', [('nidr', OLD)], 'human'), ('ka', [('ka', 'go')], 'human')]},
        {'words': [('nidr', [('nidr', 'be')], 'human'), 'ta']}])})
    job = start(client, 'Gloss what is empty where the old gloss is.', id=J, plan=None)
    model = use(monkeypatch, Model(planned(lambda a, k, kw: reply('Nothing to add.'),
                                           {'pieces': 'sentences', 'fills': ['segmentation', 'Morph Gloss'],
                                            'skip_filled_sentences': True, 'search': SEARCH})))
    finished = run_job(job, runner(job))
    pieces = _pieces(model)
    assert [_your_piece(a).split('.')[0] for a in pieces] == ['Your piece: s1'], [_your_piece(a) for a in pieces]
    d = finished['report']['documents'][0]
    assert (d['state'], d['targets'], d['done'], d['counts'][igt_job.MATCHED]) == ('done', 1, 1, 2)
    # Left blank: the empty word of s1 (worked) only, never s3's, which is
    # not the job's work.
    refs = [e['ref'] for e in (d.get('left') or [])] + [e['ref'] for e in (d.get('untouched') or [])]
    assert all(not r.startswith('s3') for r in refs), refs
    blank = {b['target']: b for b in d['counts'].get('blank') or []}
    assert all(b.get('not_reached', 0) == 0 for b in blank.values()), blank


def test_a_sentence_a_person_changes_after_the_planning_is_taken_by_the_walks_own_rules(monkeypatch):
    """The search is not run again. Story 1's s1 matched at planning, and a
    person renames its gloss before the walk reaches it: it is still taken.
    s2 did not match and a person writes the old gloss into it: not taken."""
    client = JobClient({'d1': document('d1', 'Story 1', [
        {'words': [('nidr', [('nidr', OLD)], 'human')]},
        {'words': [('nidr', [('nidr', 'be')], 'human')]}])})
    job = start(client, 'Rename it.', id=J, plan=None)
    r = runner(job)
    use(monkeypatch, Model(planned(_renaming, RENAME)))
    r.plan(job)
    changed = document('d1', 'Story 1', [{'words': [('nidr', [('nidr', 'be.3AUG')], 'human')]},
                                         {'words': [('nidr', [('nidr', OLD)], 'human')]}], version=2)
    client._holder('d1')['documents']['d1'] = changed
    model = use(monkeypatch, Model(lambda a, k, kw: reply('Left it: it no longer reads the old gloss.')))
    r.work(job)
    assert [_your_piece(a).split('.')[0] for a in _pieces(model)] == ['Your piece: s1']


def test_the_final_context_and_the_document_lines_say_the_search():
    report = {'totals': {'documents_done': 2}, 'plan': {'pieces': 'sentences', 'search': {
        'said': 'Gloss "x"', 'sentences': 3, 'documents': 1}},
        'documents': [{'name': 'A', 'state': 'done', 'done': 3, 'targets': 3, 'counts': {'matched': 3}},
                      {'name': 'B', 'state': 'done', 'done': 0, 'targets': 0, 'counts': {'matched': 0}}]}
    message = igt_job.summary_message(report)
    assert 'How the work was cut: sentences, only the sentences matching Gloss "x": 3 sentences in 1 document.' \
        in message, message
    assert '- "B": done, the plan\'s search found no sentence of it: not worked' in message, message
    assert 'documents with nothing found by the search 1' in message.replace('_', ' '), message


def test_read_job_says_the_search_where_the_plan_is_said():
    from plaid_agent.igt import jobread
    plan = {'pieces': 'sentences', 'fills_names': ['Gloss'],
            'search': {'pattern': OLD, 'where': 'Gloss', 'said': f'Gloss "{OLD}"', 'sentences': 33, 'documents': 24}}
    assert jobread.plan_line({'plan': plan}) == (
        f'Worked in stretches of sentences, only the sentences matching Gloss "{OLD}": 33 sentences in 24 '
        'documents. Fills: Gloss.')
    assert jobread.plan_line({'plan': {**plan, 'only_empty': True}}) == (
        f'Worked in stretches of sentences, only the sentences matching Gloss "{OLD}": 33 sentences in 24 '
        'documents, of them only those with something empty. Fills: Gloss.')
    report = {'totals': {'documents_done': 3}, 'plan': plan,
              'documents': [{'state': 'done', 'done': 1, 'targets': 1, 'counts': {'matched': 1}},
                            {'state': 'done', 'done': 0, 'targets': 0, 'counts': {'matched': 0}},
                            {'state': 'done', 'done': 0, 'targets': 0, 'counts': {'matched': 0}}]}
    said = jobread._totals(report)
    assert 'documents done 1, documents with nothing found by the search 2' in said, said


def _planned_then(monkeypatch, changed):
    """Story 1: s1 OLD, s2 OLD, s3 be (one word each). The planning matches
    s1 and s2, then a person reshapes the text (``changed``), then the walk."""
    client = JobClient({'d1': document('d1', 'Story 1', [{'words': [('nidr', [('nidr', g)], 'human')]}
                                                         for g in (OLD, OLD, 'be')])})
    job = start(client, 'Rename it.', id=J, plan=None)
    r = runner(job)
    use(monkeypatch, Model(planned(_renaming, RENAME)))
    assert r.plan(job)['matched'] == {'d1': ['d1-s1', 'd1-s2']}
    client._holder('d1')['documents']['d1'] = changed()
    model = use(monkeypatch, Model(lambda a, k, kw: reply('Looked at it.')))
    finished = run_job(job, r)
    return [_your_piece(a).split('.')[0] for a in _pieces(model)], finished['report']['documents'][0]


def test_a_matched_sentence_a_person_merges_is_followed_by_its_words(monkeypatch):
    """REV-SF-1: s1 and s2, both matched, are merged into one sentence of a
    new id before the walk: the walk takes it, as it holds their words."""
    from job_fixtures import document as doc_of

    def merged():
        raw = doc_of('d1', 'Story 1', [{'words': [('nidr', [('nidr', OLD)], 'human'), ('nidr', [('nidr', OLD)], 'human')]},
                                       {'words': [('nidr', [('nidr', 'be')], 'human')]}], version=2)
        layers = raw['text_layers'][0]['token_layers']
        layers[0]['tokens'][0]['id'], layers[0]['tokens'][1]['id'] = 'd1-sM', 'd1-s3'
        # The merge keeps each word's id: s1's and s2's words.
        layers[1]['tokens'][0]['id'], layers[1]['tokens'][1]['id'] = 'd1-s1w1', 'd1-s2w1'
        layers[1]['tokens'][2]['id'] = 'd1-s3w1'
        return raw
    taken, row = _planned_then(monkeypatch, merged)
    assert taken == ['Your piece: s1'], taken
    assert (row['targets'], row['done']) == (1, 1), row


def test_a_matched_sentence_a_person_splits_has_both_halves_taken(monkeypatch):
    from job_fixtures import document as doc_of

    def split():
        # s1 split in two: its first word stays in d1-s1, its second goes to
        # a new sentence, each word keeping its id.
        raw = doc_of('d1', 'Story 1', [{'words': [('nidr', [('nidr', OLD)], 'human')]},
                                       {'words': [('nidr', [('nidr', OLD)], 'human')]},
                                       {'words': [('nidr', [('nidr', OLD)], 'human')]},
                                       {'words': [('nidr', [('nidr', 'be')], 'human')]}], version=2)
        layers = raw['text_layers'][0]['token_layers']
        for tok, sid in zip(layers[0]['tokens'], ('d1-s1', 'd1-sNEW', 'd1-s2', 'd1-s3')):
            tok['id'] = sid
        for tok, wid in zip(layers[1]['tokens'], ('d1-s1w1', 'd1-s1w2', 'd1-s2w1', 'd1-s3w1')):
            tok['id'] = wid
        return raw

    # The planning reads s1 with two words, so both are its.
    client = JobClient({'d1': document('d1', 'Story 1', [
        {'words': [('nidr', [('nidr', OLD)], 'human'), ('nidr', [('nidr', OLD)], 'human')]},
        {'words': [('nidr', [('nidr', OLD)], 'human')]}, {'words': [('nidr', [('nidr', 'be')], 'human')]}])})
    job = start(client, 'Rename it.', id=J, plan=None)
    r = runner(job)
    use(monkeypatch, Model(planned(_renaming, RENAME)))
    assert r.plan(job)['matched'] == {'d1': ['d1-s1', 'd1-s2']}
    client._holder('d1')['documents']['d1'] = split()
    lines = []

    def look(a, k, kw):
        lines.append(job.status.get('message'))
        return reply('Looked at it.')
    model = use(monkeypatch, Model(look))
    finished = run_job(job, r)
    taken = [_your_piece(a).split('.')[0] for a in _pieces(model)]
    assert taken == ['Your piece: s1, s2, s3'], taken
    # REV-SF2-3: the total is counted as the positions are, never past them.
    assert lines[0] == 'Matching sentences 1 to 3 of 3.', lines
    row = finished['report']['documents'][0]
    assert (row['targets'], row['done'], row['sentences']) == (3, 3, 4), row


def test_a_resumed_job_in_the_middle_of_the_walk_takes_each_matched_sentence_once(monkeypatch):
    """The worker dies after its second piece; a fresh one walks the rest,
    each matched sentence once, its words included."""
    import pytest

    class Died(BaseException):
        pass
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 1)
    client = JobClient({'d23': _story(23, 6), 'd2': _story(2, 4), 'd18': _story(18, 5)})
    job = start(client, 'Rename it.', id=J, plan=None)
    n = {'k': 0}

    def dying(asked, k, kw):
        if k == 1:
            n['k'] += 1
            if n['k'] == 3:
                raise Died('the worker dies')
        return _renaming(asked, k, kw)
    model = use(monkeypatch, Model(planned(dying, RENAME)))
    with pytest.raises(Died):
        run_job(job, runner(job))
    first = [(a.split('"')[1], _your_piece(a).split('.')[0]) for a in _pieces(model)]
    model.calls.clear()
    model.answer = _renaming
    finished = run_job(job, runner(job))
    second = [(a.split('"')[1], _your_piece(a).split('.')[0]) for a in _pieces(model)]
    done = first[:2] + second
    # The third piece (Story 2 s1) died before its write: taken again, once.
    assert sorted(done) == sorted([('Story 23', 'Your piece: s1'), ('Story 23', 'Your piece: s2'),
                                   ('Story 23', 'Your piece: s3'), ('Story 18', 'Your piece: s1'),
                                   ('Story 18', 'Your piece: s2'), ('Story 2', 'Your piece: s1')]), (first, second)
    assert finished['report']['totals']['changes'] == 6


def test_each_matched_sentence_of_a_piece_sees_the_two_before_it(monkeypatch):
    """REV-SF-4: the planner is told a piece sees the two sentences before;
    matched sentences that are no run each get theirs."""
    client = JobClient({'d1': document('d1', 'Story 1', [
        {'words': [('nidr', [('nidr', OLD if k in (2, 6) else 'be')], 'human')]} for k in range(1, 8)])})
    job = start(client, 'Rename it.', id=J, plan=None)
    model = use(monkeypatch, Model(planned(lambda a, k, kw: reply('Looked.'), RENAME)))
    run_job(job, runner(job))
    (asked,) = _pieces(model)
    assert _your_piece(asked) == 'Your piece: s2, s6. s1, s4, s5 are context.', _your_piece(asked)
    assert '[s3]' not in asked and '[s4]' in asked and '[s7]' not in asked, asked


def test_the_plan_line_says_how_a_selection_fallen_back_was_worked():
    """REV-SF2-5, BRIEF RW: a selection whose piece failed is worked in
    stretches of sentences, and so is a document with a fallback row of its
    own, whatever its reason (whole_document)."""
    from plaid_agent.igt import jobread
    plan = {'pieces': 'selection', 'fills_names': ['Gloss'],
            'fallback': [{'document_id': None, 'reason': 'failed'}]}
    assert jobread.plan_line({'plan': plan}) == (
        'Worked in one part for all the documents, then in stretches of sentences. Fills: Gloss.')
    plan['fallback'].append({'document_id': 'd2', 'reason': 'too-long'})
    assert jobread.plan_line({'plan': plan}) == (
        'Worked in one part for all the documents, then in stretches of sentences. Fills: Gloss.')
    put_off = {'pieces': 'selection', 'fallback': [{'document_id': 'd1', 'reason': 'in-use'},
                                                   {'document_id': 'd2', 'reason': 'too-long'}]}
    assert jobread.plan_line({'plan': put_off}) == (
        'Worked in one part for all the documents, then 2 in stretches of sentences.')
