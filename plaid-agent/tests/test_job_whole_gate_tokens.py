"""Whether a document is worked as one piece is measured as the piece's
budget measures it, in tokens (D23 of the job review 2026-11-18): a
document in a script that takes several tokens a letter is worked in
stretches with its fallback row ``too-long``, never asked whole to fail
before any call, and the planner is told the same count."""

from job_fixtures import JobClient, document, start

from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.limits import JOB_DOCUMENT_PIECE_MAX_TOKENS
from plaid_agent.igt import toolkit
from plaid_agent.igt.job import IgtRunner


def _runner(job, per_char):
    def count(value):
        return len(value if isinstance(value, str) else str(value)) * per_char
    return IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000), count=count)


def test_a_document_over_the_token_cap_is_worked_in_stretches_whatever_its_characters():
    # About 3,000 characters: far under any character cap, over the token cap
    # at 8 tokens a character.
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ꯀꯥ'] * 30} for _ in range(40)])})
    job = start(client, plan='document')
    r = _runner(job, 8)
    r.plan(job)
    project = r.project()
    doc = r.read(project, 'd1')
    assert r.document_tokens(doc, project) > JOB_DOCUMENT_PIECE_MAX_TOKENS
    assert r.whole_document(project, doc) is False
    assert r.fallen_back() == {'d1': 'too-long'}
    fact = r.document_facts(project, job)[0]
    assert fact['tokens'] == r.document_tokens(doc, project)


def test_a_document_under_the_token_cap_is_one_piece():
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka']}])})
    job = start(client, plan='document')
    r = _runner(job, 1)
    r.plan(job)
    project = r.project()
    assert r.whole_document(project, r.read(project, 'd1')) is True


def test_the_plans_size_counts_a_document_over_the_token_cap_in_stretches():
    sizes = toolkit.plan_size('document', [
        {'id': 'd1', 'sentences': 12, 'tokens': 100},
        {'id': 'd2', 'sentences': 10, 'tokens': JOB_DOCUMENT_PIECE_MAX_TOKENS + 1}], False)
    assert sizes.startswith('This plan is 3 pieces over 2 documents'), sizes


def _glossed(n_sentences):
    words = [('kaniwa', [('kani', 'go'), ('-wa', 'PST')], 'human'), ('tolom', [('tolom', 'house')], 'human'),
             ('sideka', [('side', 'eat'), ('-ka', '3SG')], 'human'), ('mu', [('mu', 'and')], 'human')]
    return document('d1', 'Story', [{'words': words * 3} for _ in range(n_sentences)])


def _rendered(r, project, doc):
    from plaid_agent.igt.project import render_sentence
    return len('\n'.join(render_sentence(s, project) for s in doc.sentences))


def test_glossed_latin_text_goes_whole_as_under_the_old_40000_characters():
    """REV-JR1-R2-1: by the model's own counter (no counter injected, as the
    real worker builds the runner), a glossed Latin document of about 38,000
    rendered characters is still one piece, and one of about 45,000 is not."""
    from plaid_agent.igt.job import runner_factory
    for target, whole in ((38000, True), (45000, False)):
        n = 1
        while True:
            client = JobClient({'d1': _glossed(n)})
            job = start(client, plan='document')
            r = runner_factory(ModelConfig(model='openai/qwen3.8-27b', stream=False, max_steps=1000),
                               count=None)(job)
            r.plan(job)
            project = r.project()
            doc = r.read(project, 'd1')
            size = _rendered(r, project, doc)
            if size >= target:
                break
            n = max(n + 1, int(n * target / max(size, 1)))
        assert abs(size - target) < 2000, size
        assert r.whole_document(project, doc) is whole, (size, r.document_tokens(doc, project))
