"""STRESS S5-3, option (b) (REV-SJ2-10): a person merges into the sentence
the job last wrote in the words of a sentence it had not reached. The walk
leaves that sentence (REV-B4-1: a sentence holding a word the job wrote is
never a target again), so those words are never worked. The report says so:
they count as blank where the job did not reach, never listed as Left blank,
and the document's row does not count that sentence done."""

from job_fixtures import document, runner
from plaid_agent.core.job import run_job
from test_job_reshape import _after_record, _job, _person_leaves, mine, reshaped


def test_words_merged_into_a_sentence_the_job_wrote_in_count_as_not_reached(monkeypatch):
    client, job, clock = _job(monkeypatch, [{'words': ['ka']}, {'words': ['rua', 'pele']}, {'words': ['sa']}])
    client.after_write['d1'] = document('d1', 'Story', [{'words': [mine('ka')]}, {'words': ['rua', 'pele']},
                                                         {'words': ['sa']}], version=2)
    # s2's words (they keep their ids) merged into s1, s2's id gone.
    merged = reshaped(document('d1', 'Story', [{'words': [mine('ka'), 'rua', 'pele']}, {'words': ['sa']}],
                               version=3),
                      {'d1-s1w2': 'd1-s2w1', 'd1-s1w3': 'd1-s2w2', 'd1-s2w1': 'd1-s3w1', 'd1-s2': 'd1-s3'})
    _after_record(monkeypatch, job, 'd1-s1', lambda: _person_leaves(client, merged, clock))
    finished = run_job(job, runner(job))
    (d,) = finished['report']['documents']
    left = [e['ref'] for e in d.get('left') or []]
    assert not [r for r in left if r.startswith('s1.w2') or r.startswith('s1.w3')], left
    seg = next(b for b in d['counts']['blank'] if b['target'] == 'segmentation')
    assert seg['not_reached'] == 2, seg
    assert d['done'] < d['targets'], d

