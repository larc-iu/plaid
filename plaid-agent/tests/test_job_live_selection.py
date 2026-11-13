"""A selection under a real core: what its piece read is what a read printed
to the model, never what a tool loaded (REV-JG3-1).

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

from fixtures import MORPH_LAYER
from job_fixtures import Model, call, document, reply, use

from plaid_agent.core.job import run_job
from test_job_live_entries import _job, _runner, world  # noqa: F401 - the fixture


def _morphs(admin, s, d, word):
    raw = admin.documents.get(s.ids[d], include_body=True)
    words = {t['id']: t for tl in raw['text_layers'] for tk in tl['token_layers'] for t in tk.get('tokens') or []}
    w = words[s.ids[word]]
    return [t for tl in raw['text_layers'] for tk in tl['token_layers'] if tk['id'] == s.ids[MORPH_LAYER]
            for t in tk.get('tokens') or [] if t['begin'] == w['begin'] and t['end'] == w['end']]


def test_a_selection_that_read_one_sentence_of_a_text_leaves_the_rest_to_the_walk(world, monkeypatch):
    """The selection's model reads s1 of Alpha alone, glosses ka there and
    runs out of time. Alpha's s2 was never shown to it: a piece of its own
    works it, and Alpha ends done with sa glossed, never listed blank."""
    admin, writer, make = world
    s = make({'dA': document('dA', 'Alpha', [{'words': ['ka']}, {'words': ['sa']}]),
              'dB': document('dB', 'Beta', [{'words': ['ta']}])})
    alone = []

    def answer(asked, n, kwargs):
        if '"Alpha"' in asked and '"Beta"' in asked:
            if n == 1:
                return reply(calls=[call(1, 'read_document', {'document': 'Alpha', 'from_sentence': 1,
                                                              'to_sentence': 1})])
            if n == 2:
                return reply(calls=[call(2, 'set_analysis', {'document': 'Alpha', 'ref': 's1.w1', 'morphemes': [
                    {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]})])
            return reply('Glossed ka in Alpha and ran out of time.')
        if n == 1:
            name = asked.split('"')[1]
            alone.append(name)
            ref = 's2.w1' if name == 'Alpha' else 's1.w1'
            form = 'sa' if name == 'Alpha' else 'ta'
            return reply(calls=[call(9, 'set_analysis', {'document': name, 'ref': ref, 'morphemes': [
                {'form': form, 'fields': {'Morph Gloss': 'G'}}]})])
        return reply('Glossed.')
    use(monkeypatch, Model(answer))
    job = _job(admin, writer, s, 'selection')
    finished = run_job(job, _runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    assert sorted(alone) == ['Alpha', 'Beta'], alone
    alpha = next(d for d in finished['report']['documents'] if d['name'] == 'Alpha')
    assert alpha['state'] == 'done' and not alpha['left'], alpha
    assert len(_morphs(admin, s, 'dA', 'dA-s1w1')) == 1 and len(_morphs(admin, s, 'dA', 'dA-s2w1')) == 1
    fallback = {f['document_id']: f['reason'] for f in finished['report']['plan']['fallback']}
    assert fallback == {s.ids['dA']: 'not-read', s.ids['dB']: 'not-read'}, fallback
