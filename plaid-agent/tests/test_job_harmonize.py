"""Harmonize: the job's own analyses of one form made one, by a fixed rule
(SPEC 8). A person's one analysis wins whatever the counts; with none, two
thirds of the job's words decide; anything less, or people who differ, leaves
the form. Older machine drafts and words anyone touched since neither vote
nor change. Each document's rewrites are one History entry of their own."""

import json

import pytest

from job_fixtures import WORD_LAYER, JobClient, document, recorded, runner, start

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


def _run(docs, after=None, comments=(), mwes=()):
    """Harmonize over ``docs``, recorded as the job's stretches would have
    recorded them, then read as ``after`` holds them (a person's edits since)
    with ``comments`` (anchored ids) and ``mwes`` (pairs of word ids, a
    person's multi-word expressions)."""
    client = JobClient({d: document(d, f'Story {d}', s) for d, s in docs.items()},
                       comments=[{'id': f'c{i}', 'document_id': d, 'entity_type': 'token', 'entity_id': e,
                                  'body': 'Is this right?'} for i, (d, e) in enumerate(comments)])
    job = start(client, ['gloss'], id=J)
    for d in docs:
        job.update_row(d, state='done')
    recorded(job)
    for d, sentences in (after or {}).items():
        client._holder(d)['documents'][d] = document(d, f'Story {d}', sentences)
    for i, (a, b) in enumerate(mwes):
        d = a.split('-')[0]
        layer = next(tl for tl in client._holder(d)['documents'][d]['text_layers'][0]['token_layers']
                     if tl['id'] == WORD_LAYER)
        layer['vocabs'][0]['vocab_links'].append({'id': f'mwe{i}', 'vocab_item': {'id': f'e-mwe{i}', 'form': 'x y'},
                                                  'tokens': [a, b], 'metadata': {}})
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


def _word_ops(staged):
    return {o['token_id']: o['value'] for o in staged if o.get('kind') == 'set_span' and o.get('layer_id') == 'sl-gloss'}


def test_harmonize_sets_the_word_field_the_job_wrote_to_the_chosen_analysis(monkeypatch):
    staged = _staged(monkeypatch)
    client, job, out, tags = _run({'d1': [{'words': [_wg('go', 'go'), _wg('go', 'go'), _wg('come', 'come')]}]})
    assert out['changed'][0]['from'][0]['analysis'] == 'ka ‘come’'
    assert _word_ops(staged) == {'d1-s1w3': 'go'}, 'the job\'s own word Gloss follows the analysis it was set to'


def test_harmonize_clears_a_word_field_the_chosen_analysis_does_not_have(monkeypatch):
    staged = _staged(monkeypatch)
    w = lambda g: {'form': 'ka', 'morphs': [('ka', g)], 'who': J}  # noqa: E731
    _run({'d1': [{'words': [w('go'), w('go'), w('go'), _wg('come', 'come')]}]})
    assert _word_ops(staged) == {'d1-s1w4': ''}


def test_harmonize_adds_no_word_field_a_word_does_not_hold(monkeypatch):
    staged = _staged(monkeypatch)
    w = lambda g: {'form': 'ka', 'morphs': [('ka', g)], 'who': J}  # noqa: E731
    _run({'d1': [{'words': [_wg('go', 'go'), _wg('go', 'go'), w('come')]}]})
    assert _word_ops(staged) == {}, 'only what the job wrote on the word is rewritten'


def test_a_piece_a_person_deleted_is_never_put_back(monkeypatch):
    """A person cleared the gloss of the job's -ni on one word: its analysis
    is one the job never recorded, and harmonize leaves it (REV-J-B2 S3-1)."""
    staged = _staged(monkeypatch)
    sani = lambda g: {'form': 'sani', 'morphs': [('sa', 'go'), ('ni', g)], 'who': J}  # noqa: E731
    client, job, out, tags = _run({'d1': [{'words': [sani('now'), sani('now'), sani('now'), sani('then')]}]},
                                  after={'d1': [{'words': [sani('now'), sani('now'), sani('now'), sani(None)]}]})
    assert staged == [] and tags == [], 'the word a person changed is not rewritten'
    assert out['changed'] == []
    assert out['left'] == [{'form': 'sani', 'reason': 'touched', 'analyses': [{'analysis': 'sa-ni ‘go-_’', 'count': 1}]}]


def test_a_word_whose_analysis_the_job_never_recorded_is_left(monkeypatch):
    """The same word changed by a person to another value, every piece still
    stamped as the job's."""
    staged = _staged(monkeypatch)
    client, job, out, tags = _run({'d1': [{'words': [w('ka', 'go'), w('ka', 'go'), w('ka', 'come')]}]},
                                  after={'d1': [{'words': [w('ka', 'go'), w('ka', 'go'), w('ka', 'walk')]}]})
    assert staged == [] and out['changed'] == []
    assert out['left'] == [{'form': 'ka', 'reason': 'touched', 'analyses': [{'analysis': 'ka ‘walk’', 'count': 1}]}]


@pytest.mark.parametrize('anchor', ['d1-s1w3', 'd1-s1w3m1', 'sp-d1-s1w3m1'])
def test_a_comment_on_the_word_or_a_piece_of_it_keeps_harmonize_off_it(monkeypatch, anchor):
    staged = _staged(monkeypatch)
    client, job, out, tags = _run({'d1': [{'words': [w('ka', 'go'), w('ka', 'go'), w('ka', 'come')]}]},
                                  comments=[('d1', anchor)])
    assert staged == [] and out['changed'] == []
    assert out['left'] == [{'form': 'ka', 'reason': 'commented',
                            'analyses': [{'analysis': 'ka ‘come’', 'count': 1}]}]


def test_a_word_in_a_multi_word_expression_is_left(monkeypatch):
    staged = _staged(monkeypatch)
    client, job, out, tags = _run({'d1': [{'words': [w('ka', 'go'), w('ka', 'go'), w('ka', 'come'), 'xo']}]},
                                  mwes=[('d1-s1w3', 'd1-s1w4')])
    assert staged == [] and out['changed'] == []
    assert out['left'] == [{'form': 'ka', 'reason': 'in-mwe', 'analyses': [{'analysis': 'ka ‘come’', 'count': 1}]}]


def test_the_rest_of_the_form_is_still_made_consistent_around_a_word_left(monkeypatch):
    staged = _staged(monkeypatch)
    client, job, out, tags = _run({'d1': [{'words': [w('ka', 'go'), w('ka', 'go'), w('ka', 'go'), w('ka', 'come'),
                                                     w('ka', 'come')]}]}, comments=[('d1', 'd1-s1w5')])
    assert [o['word_id'] for o in staged if o.get('kind') == 'set_analysis'] == ['d1-s1w4']
    assert {'form': 'ka', 'reason': 'commented', 'analyses': [{'analysis': 'ka ‘come’', 'count': 1}]} in out['left']


PIECES = ('token', 'span', 'link')
WHO = (J,) * 8 + ('human', 'machine', f'confirmed:{J}', 'J-other')
#: what a person may have done since the job wrote a word: nothing (mostly),
#: deleted its gloss, commented on it or a piece of it, made a multi-word
#: expression of it and the next word
SINCE = (None,) * 6 + ('deleted', 'commented', 'mwe')


def _random_word(rng, gloss):
    who = {p: rng.choice(WHO) for p in PIECES}
    word_gloss = rng.choice([None, None, ('x', J), ('y', 'human'), ('z', 'machine')])
    w = {'form': 'ka', 'morphs': [('ka', gloss, 'e-ka')], 'who': who}
    if word_gloss:
        w['gloss'] = word_gloss
    return w


@pytest.mark.parametrize('seed', range(60))
def test_harmonize_never_changes_a_word_holding_anything_not_the_jobs_own(monkeypatch, seed):
    """For random mixes of a person's, another producer's and the job's
    content on a word, and what a person did since (a piece deleted, a
    comment, a multi-word expression), harmonize stages nothing on a word
    unless every piece of it is the job's own unverified work as the job
    recorded it and nothing of a person's hangs on it."""
    import random
    rng = random.Random(seed)
    words = [_random_word(rng, rng.choice(['go', 'go', 'come'])) for _ in range(6)]
    since = [rng.choice(SINCE) for _ in words]
    after = [dict(x, morphs=[('ka', None, 'e-ka')]) if since[i] == 'deleted' else x for i, x in enumerate(words)]
    comments = [('d1', rng.choice([f'd1-s1w{i}', f'd1-s1w{i}m1', f'l-d1-s1w{i}m1']))
                for i, why in enumerate(since, start=1) if why == 'commented']
    mwes = [(f'd1-s1w{i}', f'd1-s1w{i + 1}') for i, why in enumerate(since, start=1) if why == 'mwe' and i < 6]
    in_mwe = {x for pair in mwes for x in pair}
    staged = _staged(monkeypatch)
    client, job, out, tags = _run({'d1': [{'words': words}]}, after={'d1': [{'words': after}]}, comments=comments,
                                  mwes=mwes)
    own = set()
    for i, w in enumerate(words, start=1):
        # The one morpheme spells the word and has no type: a token with no
        # stamp is its default morpheme, not anyone's content.
        pieces = [w['who'][p] for p in PIECES if p != 'token' or w['who'][p] != 'human'] \
            + ([w['gloss'][1]] if w.get('gloss') else [])
        wid = f'd1-s1w{i}'
        if all(p == J for p in pieces) and since[i - 1] in (None, 'mwe') and wid not in in_mwe:
            own.add(wid)
    touched = {o.get('word_id') or o.get('analysis_word_id') or str(o.get('token_id', '')).split('m')[0]
               for o in staged}
    assert touched <= own, (seed, words, staged)
    assert all(o.get('kind') in ('set_analysis', 'link', 'set_span') for o in staged), 'the analysis, links, fields'
    # Every word harmonize rewrote ends with all the job wrote on it agreeing
    # with the chosen analysis: its morpheme gloss, and its word Gloss where
    # it held one (that of most words of the chosen gloss, the first on a tie).
    rewritten = {o['word_id']: o for o in staged if o.get('kind') == 'set_analysis'}
    if rewritten:
        chosen = out['changed'][0]['to'].split('‘')[1].rstrip('’')
        of = [w.get('gloss', (None,))[0] or '' for i, w in enumerate(words, start=1)
              if f'd1-s1w{i}' in own and w['morphs'][0][1] == chosen]
        counts = {}
        for v in of:
            counts[v] = counts.get(v, 0) + 1
        best = sorted(counts.items(), key=lambda kv: (-kv[1], json.dumps({'Gloss': kv[0]} if kv[0] else {})))[0][0]
        fields = _word_ops(staged)
        for i, w in enumerate(words, start=1):
            wid = f'd1-s1w{i}'
            if wid not in rewritten:
                continue
            assert [f['value'] for f in rewritten[wid]['morphemes'][0]['fields']] == [chosen]
            had = (w.get('gloss') or (None,))[0]
            if had is None:
                assert wid not in fields, 'no field added'
            elif had != best:
                assert fields.get(wid) == best, (seed, wid, had, best, fields)


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
    recorded(job)
    out = runner(job).harmonize(job)
    assert {'form': 'ka', 'reason': 'in-use', 'analyses': [{'analysis': 'ka ‘come’', 'count': 1}]} in out['left']
    assert not [c for c in client.calls if c[0].startswith(('spans', 'tokens'))]


def test_a_form_whose_only_rewrite_stayed_in_use_is_listed_left_and_not_changed():
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
    recorded(job)
    out = runner(job).harmonize(job)
    assert out['changed'] == [], 'nothing was rewritten, so nothing is reported changed'
    assert [entry['reason'] for entry in out['left']] == ['in-use']


def test_a_rewrite_in_a_document_gone_meanwhile_is_not_reported_as_done():
    from plaid_client import PlaidAPIError
    client = JobClient({'d1': document('d1', 'A', [{'words': [w('ka', 'go'), w('ka', 'go')]}]),
                        'd2': document('d2', 'B', [{'words': [w('ka', 'come')]}])})
    job = start(client, ['gloss'], id=J)
    for d in ('d1', 'd2'):
        job.update_row(d, state='done')
    recorded(job)
    r = runner(job)
    real = client.documents.locked

    def locked(document_id, **kw):
        raise PlaidAPIError('HTTP 404', status=404)
    client.documents.locked = locked
    out = r.harmonize(job)
    client.documents.locked = real
    assert out['changed'] == []


def test_harmonize_waits_three_times_for_a_document_in_use_before_leaving_it():
    from datetime import datetime, timezone
    client = JobClient({'d1': document('d1', 'A', [{'words': [w('ka', 'go'), w('ka', 'go')]}]),
                        'd2': document('d2', 'B', [{'words': [w('ka', 'come')]}])})
    future = datetime.fromtimestamp(datetime.now(timezone.utc).timestamp() + 5000, timezone.utc) \
        .isoformat().replace('+00:00', 'Z')
    client._holder('d2')['audit'].append({'id': 'a1', 'time': future, 'ref': None, 'kind': None,
                                          'documents': [{'id': 'd2'}], 'ops': []})
    job = start(client, ['gloss'], id=J)
    slept = []
    real = job._sleep
    job._sleep = lambda s: (slept.append(s), real(s))
    for d in ('d1', 'd2'):
        job.update_row(d, state='done')
    recorded(job)
    runner(job).harmonize(job)
    from plaid_agent.core.limits import JOB_DEFER_WAIT_S
    assert sum(slept) == 3 * JOB_DEFER_WAIT_S


# --- nothing harmonize does not write goes unsaid (REV-J-B2 S3-2) ------------------------

def test_a_value_off_the_tagset_is_written_as_a_stretch_writes_it(monkeypatch):
    """The job's own majority holds a tag the tagset does not list: harmonize
    stages through the job's workspace, which lets a machine value off the
    list through as a stretch's staging does (SPEC 6.4)."""
    staged = _staged(monkeypatch)
    client, job, out, tags = _run({'d1': [{'words': [w('ka', 'XYZ'), w('ka', 'XYZ'), w('ka', 'XYZ'),
                                                     w('ka', 'come')]}]})
    assert [o['word_id'] for o in staged if o.get('kind') == 'set_analysis'] == ['d1-s1w4']
    assert out['changed'][0]['to'] == 'ka ‘XYZ’' and out['left'] == []


def _linked(entry):
    return ('ka', [('ka', 'go', entry)], J)


def _run_linking(docs, monkeypatch):
    client = JobClient({d: document(d, f'Story {d}', s) for d, s in docs.items()})
    job = start(client, ['gloss', 'link'], id=J)
    for d in docs:
        job.update_row(d, state='done')
    recorded(job)
    return client, job, runner(job).harmonize(job)


def test_a_rewrite_refused_is_listed_left_and_nothing_of_the_word_is_staged(monkeypatch):
    """The analysis most words hold links an entry nobody can link any more
    (deleted since): staging the link is refused, so nothing of that word is
    written, and the form is listed with the reason."""
    staged = _staged(monkeypatch)
    client, job, out = _run_linking({'d1': [{'words': [_linked('e-gone'), _linked('e-gone'), _linked('e-gone'),
                                                       _linked('vi-ali')]}]}, monkeypatch)
    assert staged == [], 'the word whose link was refused keeps everything it held'
    assert out['changed'] == []
    assert out['left'] == [{'form': 'ka', 'reason': 'refused', 'analyses': [{'analysis': 'ka ‘go’', 'count': 1}]}]


def test_a_word_changed_before_the_lock_is_listed_with_why(monkeypatch):
    """Between harmonize's read and its lock a person commented on the word
    (or changed it): it is not rewritten, and it is listed."""
    staged = _staged(monkeypatch)
    client = JobClient({'d1': document('d1', 'A', [{'words': [w('ka', 'go'), w('ka', 'go'), w('ka', 'come')]}])})
    job = start(client, ['gloss'], id=J)
    job.update_row('d1', state='done')
    recorded(job)
    client.on_lock['d1'] = document('d1', 'A', [{'words': [w('ka', 'go'), w('ka', 'go'), w('ka', 'walk')]}])
    out = runner(job).harmonize(job)
    assert staged == [] and out['changed'] == []
    assert out['left'] == [{'form': 'ka', 'reason': 'touched', 'analyses': [{'analysis': 'ka ‘come’', 'count': 1}]}]


def test_a_document_gone_before_harmonize_writes_is_reported_gone():
    from plaid_client import PlaidAPIError
    client = JobClient({'d1': document('d1', 'A', [{'words': [w('ka', 'go'), w('ka', 'go')]}]),
                        'd2': document('d2', 'B', [{'words': [w('ka', 'come')]}])})
    job = start(client, ['gloss'], id=J)
    for d in ('d1', 'd2'):
        job.update_row(d, state='done')
    recorded(job)

    def locked(document_id, **kw):
        raise PlaidAPIError('HTTP 404', status=404)
    client.documents.locked = locked
    out = runner(job).harmonize(job)
    assert out['changed'] == []
    assert job.rows['d2']['state'] == 'gone' and client.jobs.rows[J]['documents'][1]['state'] == 'gone'
