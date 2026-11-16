"""Left blank on a real core covers every sentence the job was to work
(BRIEF NW round 3): 18 sentences in four pieces, the first stages all its
words and the other three answer "Done." with nothing staged. Their blank
words are listed and counted in the report, and the document's row in core
says nothing of what is left (it said left 0).

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

from job_fixtures import Model, call, document, reply, targets_named, use
from test_job_left_all import adds_up
from test_job_live_entries import _job, _runner, world  # noqa: F401 - the fixture

from plaid_agent.core.job import run_job

N = 18
SENTENCES = [{'words': [f'ka{i}', f'ta{i}', f'pa{i}']} for i in range(1, N + 1)]
WORDS = 3 * N


def _first_piece_only(asked, n, kwargs):
    if n > 1 or 'Your piece: s' not in asked:
        return reply('Done.')
    mine = targets_named(asked)
    if 1 not in mine:
        return reply('Done.')
    return reply(calls=[call(10 * s + w, 'set_analysis', {'document': 'Alpha', 'ref': f's{s}.w{w}', 'morphemes': [
        {'form': 'x', 'fields': {'Morph Gloss': 'g'}}]}) for s in mine for w in (1, 2, 3)])


def test_pieces_that_staged_nothing_count_their_words_untouched(world, monkeypatch):
    admin, writer, make = world
    s = make({'dA': document('dA', 'Alpha', SENTENCES)})
    use(monkeypatch, Model(_first_piece_only))
    job = _job(admin, writer, s, 'sentences')
    finished = run_job(job, _runner(job))
    assert finished['state'] == 'done'
    (doc,) = finished['report']['documents']
    # Blank where the job wrote nothing: counted, never listed (RPF-A9).
    assert doc['counts']['words'] == 15 and doc['counts']['left'] == 0, doc['counts']
    assert doc['counts']['untouched'] == WORDS - 15 and doc['left'] == []
    adds_up(doc, WORDS)
    row = admin.jobs.get(job.id)['documents'][0]['counts']
    assert 'left' not in row and 'left_translations' not in row, 'the row says nothing of what is left'
