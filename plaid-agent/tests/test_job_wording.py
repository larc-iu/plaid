"""What a job's model is told by its tools is a job's (REV-J-B S3-3): no
tool description and no tool result speaks of approval, a plan card, the
user, a reply, or a tool the job is not offered. A job has no person to
approve, read or answer, and its writes land when the stretch ends."""

import re

import pytest

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.igt import toolkit

BANNED = re.compile(r'approv|plan card|\bcard\b|\buser\b|\brepl(y|ies|ied)\b|tell (them|the person)|\bask\b',
                    re.I)
COMBOS = [('translate',), ('gloss',), ('gloss', 'link'), ('translate', 'gloss'), ('translate', 'gloss', 'link')]


def _all_tool_names():
    return {t['function']['name'] for t in toolkit.TOOLS}


def _strings(value):
    if isinstance(value, dict):
        for k, v in value.items():
            if k == 'description' and isinstance(v, str):
                yield v
            else:
                yield from _strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from _strings(v)


def _faults(text, offered):
    out = [m.group(0) for m in BANNED.finditer(text)]
    for name in {n for n in _all_tool_names() if '_' in n or n in ('worklist', 'respell', 'tagsets')} - set(offered):
        if re.search(rf'\b{re.escape(name)}\b', text):
            out.append(name)
    return out


@pytest.mark.parametrize('tasks', COMBOS, ids=['+'.join(c) for c in COMBOS])
def test_no_job_tool_description_speaks_of_a_conversation_or_another_tool(tasks):
    for plan_only in (False, True):
        tools = toolkit.job_tools(list(tasks), plan_only=plan_only)
        offered = [t['function']['name'] for t in tools]
        for text in _strings(tools):
            assert not _faults(text, offered), (tasks, _faults(text, offered), text)


def _calls(doc):
    return [
        call(1, 'read_sentences', {'items': [{'document': doc, 'sentences': ['s1']}]}),
        call(2, 'read_lexicon', {}),
        call(3, 'lexicon_entry', {'entry_form': 'gam'}),
        call(4, 'set_field', {'document': doc, 'refs': ['s1'], 'field': 'Translation', 'value': 'T.'}),
        call(5, 'set_field', {'document': doc, 'refs': ['s1'], 'field': 'Translation', 'value': 'T2.'}),
        call(6, 'set_field', {'document': doc, 'refs': ['s9'], 'field': 'Translation', 'value': 'T.'}),
        call(7, 'set_analysis', {'document': doc, 'ref': 's1.w1',
                                 'morphemes': [{'form': 'ka', 'type': 'stem', 'fields': {'Morph Gloss': 'go'}}]}),
        call(8, 'set_analysis', {'document': doc, 'ref': 's1.w1', 'morphemes': [{'form': 'zz'}]}),
        call(9, 'set_field', {'document': doc, 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'go'}),
        call(10, 'create_entry', {'form': 'ka', 'fields': {'gloss': 'go'}}),
        call(11, 'create_entry', {'form': 'ka', 'fields': {'gloss': 'go'}}),
        call(12, 'create_entry', {'form': 'gam', 'fields': {'gloss': 'fish'}}),
        call(13, 'link_entry', {'document': doc, 'refs': ['s1.w1.m1'], 'entry_id': 'new:v1:ka#1'}),
        call(14, 'link_entry', {'document': doc, 'refs': ['s1.w1.m1'], 'entry_form': 'nothing-like-it'}),
        call(15, 'discard_plan', {}),
        call(16, 'run_code', {'code': 'print(1)'}),
        # Refusals of the reads and the links (REV-J-B2 S4): an id that names
        # nothing, and a new: id no entry staged here has.
        call(17, 'lexicon_entry', {'entry_id': 'nope'}),
        call(18, 'lexicon_entry', {'entry_id': 'new:v1:zz#9'}),
        call(19, 'link_entry', {'document': doc, 'refs': ['s1.w1.m1'], 'entry_id': 'nope'}),
        call(20, 'link_entry', {'document': doc, 'refs': ['s1.w1.m1'], 'entry_id': 'new:v1:zz#9'}),
        call(21, 'read_lexicon', {'lexicon': 'No such lexicon'}),
        call(22, 'analyses_of', {'form': 'ka', 'document': 'No such document'}),
    ]


@pytest.mark.parametrize('tasks', COMBOS, ids=['+'.join(c) for c in COMBOS])
def test_no_job_tool_result_speaks_of_a_conversation_or_another_tool(monkeypatch, tasks):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka']}])})
    job = start(client, list(tasks))

    def answer(asked, n, kwargs):
        return reply(calls=_calls('Story')) if n == 1 else reply('Done.')
    model = use(monkeypatch, Model(answer))
    # A read that breaks: the tool's own fault, told to the model.
    real = toolkit._IMPL['concordance']
    monkeypatch.setitem(toolkit._IMPL, 'concordance', lambda ws, **kw: 1 / 0)
    runner(job).document('d1')
    monkeypatch.setitem(toolkit._IMPL, 'concordance', real)
    offered = [t['function']['name'] for t in toolkit.job_tools(list(tasks))]
    results = [m['content'] for c in model.calls for m in c['kwargs']['messages'] if m.get('role') == 'tool']
    assert len(results) == len(_calls('Story'))
    bad = [(r, _faults(r, offered)) for r in results if _faults(r, offered)]
    assert not bad, bad


@pytest.mark.parametrize('tasks', COMBOS, ids=['+'.join(c) for c in COMBOS])
def test_no_job_prompt_speaks_of_a_conversation_or_another_tool(tasks):
    """The job's whole system prompt for each task set, over a project with a
    tagset longer than the prompt lists (REV-J-B2 S4)."""
    from job_fixtures import job_project
    from fixtures import FakeClient
    from plaid_agent.igt.project import load_project
    from plaid_agent.igt.prompt import PROMPT_TAGSET_VALUES, build_job_prompt
    raw = job_project()
    tagsets = raw['config']['igt']['tagsets']
    name = next(iter(tagsets))
    tagsets[name]['values'] = [{'value': f'T{i}'} for i in range(PROMPT_TAGSET_VALUES + 5)]
    project = load_project(FakeClient(project=raw), raw['id'])
    text = build_job_prompt(project, list(tasks))
    offered = [t['function']['name'] for t in toolkit.job_tools(list(tasks))]
    assert 'Tagsets:' in text and 'more' in text, 'the long tagset is in the prompt, cut'
    # A job's prompt says how a stretch ends, with a one-line reply nobody
    # reads: the word itself is the job's.
    faults = [f for f in _faults(text, offered) if f.lower() not in ('reply', 'replies')]
    assert not faults, (tasks, faults)
