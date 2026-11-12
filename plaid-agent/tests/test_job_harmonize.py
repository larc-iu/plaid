"""Harmonize: the job's own analyses of one form made one, by a fixed rule
(SPEC 8). A person's one analysis wins whatever the counts; with none, two
thirds of the job's words decide; anything less, or people who differ, leaves
the form. Older machine drafts and words anyone touched since neither vote
nor change. Each document's rewrites are one History entry of their own."""

import pytest

from job_fixtures import JobClient, document, runner, start

from plaid_agent.core.job import harmonized

J = 'JH'


@pytest.mark.parametrize('job_keys,people,expected', [
    ({'a': 2, 'b': 1}, {}, ('a', 'majority')),
    ({'a': 2, 'b': 2}, {}, (None, 'no-clear-majority')),
    ({'a': 3, 'b': 2}, {}, (None, 'no-clear-majority')),
    ({'a': 4, 'b': 2}, {}, ('a', 'majority')),
    ({'a': 9, 'b': 1}, {'b': 1}, ('b', 'person')),
    ({'a': 2, 'b': 1}, {'a': 1, 'c': 4}, (None, 'people-differ')),
])
def test_the_rule_table(job_keys, people, expected):
    assert harmonized(job_keys, people) == expected


def w(form, gloss, who=J):
    return (form, [(form, gloss)], who)


def _run(docs):
    client = JobClient({d: document(d, f'Story {d}', s) for d, s in docs.items()})
    job = start(client, ['gloss'], id=J)
    for d in docs:
        job.update_row(d, state='done')
    tags = []
    real = client.operation

    def operation(message, **kw):
        tags.append((message, kw.get('ref'), kw.get('group_id')))
        return real(message, **kw)
    client.operation = operation
    out = runner(job).harmonize(job)
    return client, job, out, [t for t in tags if t[1]]


def test_a_two_thirds_majority_rewrites_the_minority_in_one_entry_per_document():
    client, job, out, tags = _run({
        'd1': [{'words': [w('ka', 'go'), w('ka', 'go')]}],
        'd2': [{'words': [w('ka', 'come'), w('ta', 'x')]}],
    })
    assert out['changed'] == [{'form': 'ka', 'to': 'ka ‘go’', 'by': 'majority',
                               'from': [{'analysis': 'ka ‘come’', 'count': 1, 'documents': ['d2']}]}]
    assert out['left'] == []
    assert [(m, r) for m, r, _ in tags] == [('Assistant job: analyses made consistent', f'job:{J}/doc:d2/pass:harmonize')]
    assert tags[0][2] == job.rows['d2']['harmonize_group']
    written = str([c for c in client.calls if c[0].startswith(('spans', 'tokens'))])
    assert "'go'" in written and f"'job': '{J}'" in written, 'the rewrite is the job\'s machine proposal'


def test_a_persons_one_analysis_wins_over_the_jobs_majority():
    client, job, out, tags = _run({
        'd1': [{'words': [w('ka', 'go'), w('ka', 'go'), w('ka', 'come'), w('ka', 'go', who='human')]}],
    })
    assert out['changed'][0]['to'] == 'ka ‘go’' and out['changed'][0]['by'] == 'person'
    client, job, out, tags = _run({
        'd1': [{'words': [w('ka', 'go'), w('ka', 'go'), w('ka', 'come'), w('ka', 'come', who='human')]}],
    })
    assert out['changed'][0]['to'] == 'ka ‘come’' and out['changed'][0]['by'] == 'person'
    assert out['changed'][0]['from'][0]['count'] == 2


def test_people_who_differ_leave_the_form_with_its_analyses():
    client, job, out, tags = _run({
        'd1': [{'words': [w('ka', 'go'), w('ka', 'come'), w('ka', 'go', who='human'), w('ka', 'walk', who='human')]}],
    })
    assert out['changed'] == [] and tags == []
    assert out['left'] == [{'form': 'ka', 'reason': 'people-differ',
                            'analyses': [{'analysis': 'ka ‘go’', 'count': 1}, {'analysis': 'ka ‘come’', 'count': 1}]}]


def test_no_clear_majority_leaves_the_form():
    client, job, out, tags = _run({'d1': [{'words': [w('ka', 'go'), w('ka', 'come')]}]})
    assert out['left'][0]['reason'] == 'no-clear-majority' and not tags


def test_older_machine_drafts_and_touched_words_neither_vote_nor_change():
    client, job, out, tags = _run({
        'd1': [{'words': [w('ka', 'go'), w('ka', 'come'), w('ka', 'come', who='machine'),
                          w('ka', 'come', who='J-earlier')]}],
    })
    assert out['left'][0]['reason'] == 'no-clear-majority', 'only the job\'s own two words vote'
    assert out['left'][0]['analyses'] == [{'analysis': 'ka ‘go’', 'count': 1}, {'analysis': 'ka ‘come’', 'count': 1}]


def _wg(gloss, word_gloss, who=J, word_who=J):
    """A word "ka" of one morpheme ka with ``gloss``, and a word Gloss."""
    return {'form': 'ka', 'morphs': [('ka', gloss)], 'who': who, 'gloss': (word_gloss, word_who)}


def _staged(monkeypatch):
    """Every op harmonize hands the executor, by document."""
    from plaid_agent.igt import job as igt_job
    seen = []
    real = igt_job.execute_plan

    def execute(client, ops, **kw):
        seen.extend(ops)
        return real(client, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    return seen


def test_a_word_gloss_a_person_wrote_takes_the_word_out_of_harmonize(monkeypatch):
    staged = _staged(monkeypatch)
    client, job, out, tags = _run({
        'd1': [{'words': [_wg('go', 'go'), _wg('go', 'go'), _wg('come', 'walk', word_who='human')]}],
    })
    assert staged == [] and tags == [], 'the third word holds a person\'s word gloss: harmonize leaves it'
    assert out['changed'] == []
    assert not [c for c in client.calls if c[0].startswith(('spans', 'tokens', 'vocab_links'))]


def test_a_touched_word_is_listed_as_left_where_its_form_was_made_consistent(monkeypatch):
    staged = _staged(monkeypatch)
    client, job, out, tags = _run({
        'd1': [{'words': [_wg('go', 'go'), _wg('go', 'go'), _wg('come', 'come'),
                          _wg('come', 'walk', word_who='human')]}],
    })
    assert [o['word_id'] for o in staged if o.get('kind') == 'set_analysis'] == ['d1-s1w3']
    assert {'form': 'ka', 'reason': 'touched', 'analyses': [{'analysis': 'ka ‘come’', 'count': 1}]} in out['left']


def test_harmonize_rewrites_no_word_field(monkeypatch):
    staged = _staged(monkeypatch)
    client, job, out, tags = _run({'d1': [{'words': [_wg('go', 'go'), _wg('go', 'go'), _wg('come', 'come')]}]})
    assert out['changed'][0]['from'][0]['analysis'] == 'ka ‘come’'
    assert [o['kind'] for o in staged] == ['set_analysis'], 'the word Gloss is not harmonize\'s to change'


PIECES = ('token', 'span', 'link')
WHO = (J,) * 8 + ('human', 'machine', f'confirmed:{J}', 'J-other')


def _random_word(rng, gloss):
    who = {p: rng.choice(WHO) for p in PIECES}
    word_gloss = rng.choice([None, None, ('x', J), ('y', 'human'), ('z', 'machine')])
    w = {'form': 'ka', 'morphs': [('ka', gloss, 'e-ka')], 'who': who}
    if word_gloss:
        w['gloss'] = word_gloss
    return w


@pytest.mark.parametrize('seed', range(40))
def test_harmonize_never_changes_a_word_holding_anything_not_the_jobs_own(monkeypatch, seed):
    """For random mixes of a person's, another producer's and the job's
    content on a word, harmonize stages nothing on a word unless every piece
    of it is the job's own unverified work."""
    import random
    rng = random.Random(seed)
    words = [_random_word(rng, rng.choice(['go', 'go', 'come'])) for _ in range(6)]
    staged = _staged(monkeypatch)
    client, job, out, tags = _run({'d1': [{'words': words}]})
    own = set()
    for i, w in enumerate(words, start=1):
        # The one morpheme spells the word and has no type: a token with no
        # stamp is its default morpheme, not anyone's content.
        pieces = [w['who'][p] for p in PIECES if p != 'token' or w['who'][p] != 'human'] \
            + ([w['gloss'][1]] if w.get('gloss') else [])
        if all(p == J for p in pieces):
            own.add(f'd1-s1w{i}')
    touched = {o.get('word_id') or o.get('analysis_word_id') or str(o.get('token_id', '')).split('m')[0]
               for o in staged}
    assert touched <= own, (seed, words, staged)
    assert all(o.get('kind') in ('set_analysis', 'link') for o in staged), 'only the analysis, and links'


def test_a_document_in_use_keeps_its_minority_and_the_form_is_listed():
    from datetime import datetime, timezone
    client = JobClient({'d1': document('d1', 'A', [{'words': [w('ka', 'go'), w('ka', 'go')]}]),
                        'd2': document('d2', 'B', [{'words': [w('ka', 'come')]}])})
    now = datetime.fromtimestamp(datetime.now(timezone.utc).timestamp() + 5000, timezone.utc) \
        .isoformat().replace('+00:00', 'Z')
    client._holder('d2')['audit'].append({'id': 'a1', 'time': now, 'ref': None, 'kind': None,
                                          'documents': [{'id': 'd2'}], 'ops': []})
    job = start(client, ['gloss'], id=J)
    for d in ('d1', 'd2'):
        job.update_row(d, state='done')
    out = runner(job).harmonize(job)
    assert {'form': 'ka', 'reason': 'in-use', 'analyses': [{'analysis': 'ka ‘come’', 'count': 1}]} in out['left']
    assert not [c for c in client.calls if c[0].startswith(('spans', 'tokens'))]
