"""What a job writes: blank words, and translations that are empty or a
machine's draft it did not write itself (SPEC 6.1 to 6.3)."""

from job_fixtures import JobClient, document

from plaid_agent.igt.job import sentence_targets, translation_state, word_state, word_target
from plaid_agent.igt.project import load_project, parse_document

JOB = 'J1'


def _sentences(sentences):
    client = JobClient({'d1': document('d1', 'Story', sentences)})
    project = load_project(client, 'p1')
    return project, parse_document(client.documents.get('d1', include_body=True), project).sentences


def test_only_an_unanalysed_word_with_no_word_value_is_a_target():
    project, [s] = _sentences([{'words': [
        'blank',
        ('mach', [('mach', 'X')], 'machine'),
        ('prec', [('pr', 'A'), ('ec', 'B')], 'human'),
        ('mine', [('mine', 'Y')], JOB),
        {'form': 'glossed', 'gloss': ('word gloss', 'machine')},
        {'form': 'human', 'gloss': ('word gloss', 'human')},
    ]}])
    states = [word_state(w) for w in s.words]
    assert states == ['unanalyzed', 'machine', 'protected', 'machine', 'unanalyzed', 'unanalyzed']
    assert [word_target(w) for w in s.words] == [True, False, False, False, False, False]
    words, translate = sentence_targets(s, project, ['gloss'], JOB)
    assert [w.surface for w in words] == ['blank']
    assert translate is False, 'translate was not asked'


def test_a_translation_is_a_target_when_empty_or_a_machine_draft_and_not_once_the_job_wrote_it():
    project, sentences = _sentences([
        {'words': ['a']},
        {'words': ['b'], 'translation': ('B.', 'machine')},
        {'words': ['c'], 'translation': ('C.', 'human')},
        {'words': ['d'], 'translation': ('D.', JOB)},
        {'words': ['e'], 'translation': ('E.', 'J-other')},
    ])
    assert [translation_state(s, project, JOB) for s in sentences] == ['empty', 'machine', 'protected', 'own',
                                                                        'machine']
    assert [sentence_targets(s, project, ['translate'], JOB)[1] for s in sentences] == [True, True, False, False,
                                                                                         True]
    assert sentence_targets(sentences[0], project, ['translate'], JOB)[0] == [], 'gloss was not asked'
