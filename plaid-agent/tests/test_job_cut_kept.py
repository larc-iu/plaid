"""The second call at its output limit in a job's piece (SP, after the
real-model measurement): the stretch still fails ``output`` and is halved,
but what the piece staged for its sentences is written first, by the same
apply rule as any piece's write, and those sentences are not worked again.
Only the sentences with nothing staged are halved and worked again, a lone
one skipped failed ``output`` as before (test_job_piece_ceiling has the
first call at the limit)."""

from test_job_piece_ceiling import N, _analyse, _cut_note, _every_word, _is_piece, _run

from job_fixtures import reply, targets_named



def test_a_second_call_at_the_limit_writes_what_was_staged_and_fails_only_the_rest(monkeypatch):
    """The stretch s1, s2: s1 is staged, then every call reaches the limit.
    s1 is written and not worked again. s2 alone, which staged nothing,
    reaches it twice and is skipped failed ``output``, as before."""
    def answer(asked, n, kwargs):
        if not _is_piece(asked):
            return reply('Done.')
        named = targets_named(asked)
        if 2 in named:
            if n == 1 and _cut_note(kwargs) is None and named[0] != 2:
                return reply(calls=_analyse(named[0]))
            return reply('...', finish='length')
        return reply(calls=[c for s in named for c in _analyse(s)]) if n == 1 else reply('Done.')
    client, job, finished, model = _run(monkeypatch, answer)
    row = job.rows['d1']
    assert row['skipped'] == [{'sentence': 's2', 'sentence_id': 'd1-s2', 'reason': 'failed', 'kind': 'output'}]
    assert client.analysed == _every_word(1, 3, 4), 's1 written from the cut piece, s2 not'
    asked_about_1 = {str(c['asked']) for c in model.calls if 1 in targets_named(c['asked'])}
    assert len(asked_about_1) == 1, 's1 is not worked again'
    assert row['done'] == N
    assert finished['report']['totals']['words'] == 6


def test_a_second_call_at_the_limit_with_every_sentence_staged_ends_the_stretch_written(monkeypatch):
    """Both sentences of the stretch hold staged changes when the second
    call reaches the limit: everything is written, nothing fails."""
    def answer(asked, n, kwargs):
        if not _is_piece(asked):
            return reply('Done.')
        named = targets_named(asked)
        if n == 1 and _cut_note(kwargs) is None:
            return reply(calls=[c for s in named for c in _analyse(s)])
        return reply('...', finish='length')
    client, job, finished, model = _run(monkeypatch, answer)
    assert not job.rows['d1'].get('skipped') and job.rows['d1']['done'] == N
    assert client.analysed == _every_word(*range(1, N + 1))


