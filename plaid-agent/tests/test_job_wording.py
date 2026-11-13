"""What a job's model is told by the job is a job's (REV-J-B S3-3): a staging
tool's result and the line every result ends with never speak of approval or
a plan card, since nothing waits for anyone and what is staged is applied by
the job's rule when the piece ends. The tools' descriptions are the chat's
own (the owner's ruling 12): a job is offered the same tools, the same way."""

import re

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.igt import toolkit

BANNED = re.compile(r'approv|plan card|\bcard\b|tell (them|the person)|discard_plan first', re.I)


def _calls(name):
    return [
        call(1, 'set_analysis', {'document': name, 'ref': 's1.w1', 'morphemes': [{'form': 'ka'}]}),
        call(2, 'set_field', {'document': name, 'refs': ['s1'], 'field': 'Translation', 'value': 'K.'}),
        call(3, 'concordance', {'form': 'ka'}),
        call(4, 'no_such_tool', {}),
        call(5, 'delete_word', {'document': name, 'refs': ['s1.w1']}),
    ]


def test_no_staging_result_speaks_of_an_approval(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka']}])})
    job = start(client)

    def answer(asked, n, kwargs):
        return reply(calls=_calls('Story')) if n == 1 else reply('Done.')
    model = use(monkeypatch, Model(answer))
    runner(job).document('d1')
    results = [m['content'] for c in model.calls for m in c['kwargs']['messages'] if m.get('role') == 'tool']
    assert len(results) == len(_calls('Story'))
    bad = [r for r in results if BANNED.search(r)]
    assert not bad, bad
    assert any('applied when you end' in r for r in results)
    assert any("not one of this job's" in r for r in results), 'a tool outside the list'


def test_no_job_prompt_speaks_of_a_plan_card():
    """Over a project with a tagset longer than the prompt lists (REV-J-B2 S4)."""
    from job_fixtures import job_project
    from fixtures import FakeClient
    from plaid_agent.igt.project import load_project
    from plaid_agent.igt.prompt import PROMPT_TAGSET_VALUES, build_job_prompt, build_plan_prompt, build_summary_prompt
    raw = job_project()
    tagsets = raw['config']['igt']['tagsets']
    name = next(iter(tagsets))
    tagsets[name]['values'] = [{'value': f'T{i}'} for i in range(PROMPT_TAGSET_VALUES + 5)]
    project = load_project(FakeClient(project=raw), raw['id'])
    text = build_job_prompt(project)
    assert 'Tagsets:' in text and 'more' in text, 'the long tagset is in the prompt, cut'
    for prompt in (text, build_plan_prompt(project), build_summary_prompt(project)):
        assert not re.search(r'plan card|\bcard\b|end your turn|in a later message', prompt, re.I)
    assert toolkit.JOB_LEFT_OUT == ('propose_job', 'read_job')


def test_no_job_context_is_offered_drafting_or_reading_jobs_nor_the_planning_one_plan_tools():
    """REV-JG-13: read_job is the chat's (CONTRACT, added by JD: not among a
    job's own tools). REV-JG-22: the planning context stages nothing, so a
    tool that reads or drops a staged plan means nothing there."""
    from fixtures import FakeClient, fake_ws
    from plaid_agent.igt.job import JobWorkspace
    project = fake_ws(FakeClient()).project
    piece = {t['function']['name'] for t in toolkit.job_piece_tools(JobWorkspace(FakeClient(), project))}
    plan = {t['function']['name'] for t in toolkit.job_plan_tools(JobWorkspace(FakeClient(), project, mode='plan'))}
    assert not {'propose_job', 'read_job'} & (piece | plan)
    assert not {'discard_plan', 'plan_status'} & plan
    assert {'discard_plan', 'plan_status'} <= piece, 'a piece may still read and drop what it staged'
