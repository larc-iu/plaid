"""A try cut in the middle of one sentence (too big for one request) keeps
each link to a planned morpheme in the half that holds the analysis it
names (D15 of the job review 2026-11-18): alone, the executor drops the
link while the report counts it."""

from job_fixtures import JobClient, document, runner, start

from plaid_agent.igt.job import Stretch, Write


def test_a_cut_in_one_sentence_keeps_each_link_with_its_analysis():
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka', 'ta', 'sa', 'mo']}])})
    job = start(client)
    r = runner(job)
    project = r.project()
    doc = r.read(project, 'd1')
    words = [w.id for w in doc.sentences[0].words]
    analyses = [{'kind': 'set_analysis', 'word_id': w, 'morphemes': [{'form': 'x'}]} for w in words]
    links = [{'kind': 'link', 'token_id': None, 'analysis_word_id': w, 'morpheme_index': 1, 'morpheme_form': 'x',
              'vocab_item_id': 'vi-gam'} for w in words]
    # Each analysis is staged in the first half of the try, its link in the second.
    ops = analyses + links
    st = Stretch(doc, project, list(doc.sentences), job.id, frozenset(), r.written('d1'), r.targets(project))
    halves = Write('d1', 'p', st, [s.id for s in doc.sentences], ops, None).halve(ops)
    assert halves and len(halves) == 2
    for half in halves:
        analysed = {o['word_id'] for o in half if o['kind'] == 'set_analysis'}
        assert all(o['analysis_word_id'] in analysed for o in half if o['kind'] == 'link'), halves
