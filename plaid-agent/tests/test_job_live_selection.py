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


def test_a_selection_that_read_one_sentence_of_a_text_is_followed_by_no_walk(world, monkeypatch):
    """The selection's model reads s1 of Alpha alone, glosses ka there and
    runs out of time. Nothing more is worked after its piece (SF round 2):
    both texts end done in the one step, sa and ta stay blank, counted."""
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
    assert alone == [], alone
    docs = {d['name']: d for d in finished['report']['documents']}
    assert all(d['state'] == 'done' and d['counts'].get('one_step') is True and d['counts'].get('not_all_read')
               for d in docs.values()), docs
    assert len(_morphs(admin, s, 'dA', 'dA-s1w1')) == 1 and len(_morphs(admin, s, 'dA', 'dA-s2w1')) == 0
    assert finished['report']['plan']['fallback'] == []
    assert finished['report']['notice'] == ('The job worked on all 2 documents in one step and changed 1 of them. '
                                            'It did not read every sentence.'), finished['report']['notice']


def _gloss_of(admin, s, d, word):
    from fixtures import MGLOSS
    raw = admin.documents.get(s.ids[d], include_body=True)
    morphs = {t['id'] for t in _morphs(admin, s, d, word)}
    return [sp['value'] for tl in raw['text_layers'] for tk in tl['token_layers'] for sl in tk.get('span_layers') or []
            if sl['id'] == s.ids[MGLOSS] for sp in sl.get('spans') or [] if set(sp['tokens']) & morphs]


def test_a_rename_by_the_step_over_all_documents_walks_nothing_after_it(world, monkeypatch):
    """RPF3-A, the rename's shape on a real core: three texts, every word a
    person's analysis. The selection renames nidr's gloss by reference in
    Alpha and Gamma, reading nothing. No model call follows it, every text
    ends done in the one step, and the two renamed hold the new gloss."""
    admin, writer, make = world
    texts = {'dA': 'Alpha', 'dB': 'Beta', 'dC': 'Gamma'}
    s = make({d: document(d, name, [{'words': [('nidr', [('nidr', 'be.3ᴀᴜɢII' if d != 'dB' else 'be')], 'human'),
                                               ('ka', [('ka', 'go')], 'human')]}])
              for d, name in texts.items()})
    asked = []

    def answer(text, n, kwargs):
        asked.append(n)
        if n == 1:
            return reply(calls=[call(i, 'set_field', {'document': name, 'refs': ['s1.w1.m1'], 'field': 'Morph Gloss',
                                                      'value': 'be.3AUGII'})
                                for i, name in enumerate(('Alpha', 'Gamma'), start=1)])
        return reply('Renamed it in Alpha and Gamma.')
    use(monkeypatch, Model(answer))
    job = _job(admin, writer, s, 'selection')
    finished = run_job(job, _runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    assert asked.count(1) == 1, 'the selection, and no piece after it'
    docs = {d['name']: d for d in finished['report']['documents']}
    assert all(d['state'] == 'done' and d['counts'].get('one_step') is True for d in docs.values()), docs
    assert {name: d['counts']['changes'] for name, d in docs.items()} == {'Alpha': 1, 'Beta': 0, 'Gamma': 1}
    assert finished['report']['plan']['fallback'] == []
    assert _gloss_of(admin, s, 'dA', 'dA-s1w1') == ['be.3AUGII'] == _gloss_of(admin, s, 'dC', 'dC-s1w1')
