"""A job is the assistant, unattended (the owner's rulings 12 and 14 of
2026-11-13): a piece of a job is given the chat's own prompt, its shared rules
word for word, with the paragraphs that assume a person present put the
job's way, and the chat's own tools. One source of truth for the shared
rules: nothing in the job's prompt is a second copy of a chat rule.

The constants are CONTRACT 1's and those added by JG."""

import pytest

from fixtures import FakeClient, fake_ws

from plaid_agent.core import limits, prompt as shared
from plaid_agent.igt import prompt, toolkit
from plaid_agent.igt.job import JobWorkspace


def _project():
    return fake_ws(FakeClient()).project


def _job_prompt():
    return prompt.build_job_prompt(_project())


def _bullets(text):
    """The prompt's paragraphs and bullets, each whole."""
    out, cur = [], []
    for line in text.split('\n'):
        if line.startswith('- ') or not line.strip():
            if cur:
                out.append('\n'.join(cur))
            cur = [line] if line.strip() else []
        else:
            cur.append(line)
    if cur:
        out.append('\n'.join(cur))
    return out


def test_the_constants_are_the_contracts():
    assert (limits.JOB_HEARTBEAT_S, limits.JOB_IDLE_POLL_S, limits.JOB_STRETCH_SENTENCES,
            limits.JOB_CONTEXT_SENTENCES, limits.JOB_SENTENCE_MAX_CHARS, limits.JOB_GUIDELINES_MAX_CHARS,
            limits.JOB_PRECEDENT_PER_FORM, limits.JOB_PRECEDENT_CHARS) == (30, 30, 5, 2, 4000, 24000, 3, 8000)
    assert (limits.JOB_STRETCH_MAX_ROUNDS, limits.JOB_STRETCH_DECIDE_AT_ROUNDS, limits.JOB_CALL_MAX_PROMPT_TOKENS,
            limits.JOB_CALL_DECIDE_AT_TOKENS, limits.JOB_STRETCH_MAX_SENT_TOKENS) == (20, 15, 64000, 48000, 600000)
    assert (limits.JOB_MODEL_RETRY_S, limits.JOB_YIELD_POLL_S, limits.JOB_YIELD_QUIET_S, limits.JOB_PERSON_QUIET_S,
            limits.JOB_LOCK_TRIES, limits.JOB_LOCK_WAIT_S, limits.JOB_DEFER_ROUNDS, limits.JOB_DEFER_WAIT_S,
            limits.HARMONIZE_MAJORITY, limits.JOB_REPORT_LIST_MAX) == (300, 10, 60, 600, 3, 10, 3, 600, (2, 3), 500)
    assert shared.JOB_DECIDE_NOW == ('(system) Decide now with what you have: stage your work on the piece and end '
                                     'with your note.')
    assert (limits.JOB_DOCUMENT_PIECE_MAX_CHARS, limits.JOB_NOTE_MAX_CHARS, limits.JOB_CHANGES_MAX,
            limits.JOB_CHANGE_VALUE_CHARS, limits.JOB_SUMMARY_MAX_CHARS) == (40000, 400, 500, 300, 3000)


def test_every_rule_the_job_keeps_is_the_chats_word_for_word():
    """The job's prompt is the chat's template filled the job's way: each of
    its bullets is either the chat's own, as the chat says it, or one of the
    job's paragraphs (core.prompt JOB_*), never a reworded copy."""
    chat = prompt.SYSTEM
    job_own = [shared.JOB_CONTRACT.split('{')[0][:40], shared.JOB_FIND_FIRST[:40], shared.JOB_STAGE_NOW[:40],
               shared.JOB_PLAN_WHAT_WAS_ASKED[:40], shared.JOB_VALUES[:40], shared.JOB_NOTE[:40],
               shared.JOB_EXAMPLE[:30], prompt._JOB_PROJECT_WIDE[:40], prompt._JOB_EXAMPLE_NOTE[:30]]
    for bullet in _bullets(prompt.JOB_SYSTEM):
        if any(bullet.startswith(own) or own in bullet for own in job_own):
            continue
        assert bullet in chat, bullet[:120]


def test_no_paragraph_that_assumes_a_person_is_said():
    text = _job_prompt()
    for paragraph in (shared.ONE_TURN, shared.STAGE_NOW, shared.FINAL_MESSAGE, shared.PLAN_CONTRACT.split('{')[0],
                      shared.IN_STRETCHES[:60], shared.PLAN_WHAT_WAS_ASKED, shared.ATTACH_FILES[:60],
                      shared.CITE_EVIDENCE[:60], prompt._OPEN_DOCUMENT, prompt._JOBS[:60], prompt._CITE_ITEMS):
        assert paragraph[:60] not in text, paragraph[:60]
    lowered = text.lower()
    for words in ('ask which', 'end your turn', 'plan card', 'stretch', 'propose_job', 'approve it'):
        assert words not in lowered, words
    assert 'unverified machine proposal' in text and 'proposed change' in text
    assert 'GUIDELINE: Glossing' in text and 'Loanwords are **not** segmented' in text, 'every guideline, whole'


def test_the_prompt_shows_one_whole_piece_in_prose():
    text = _job_prompt()
    assert 'A WHOLE PIECE, FOR EXAMPLE.' in text and prompt._JOB_EXAMPLE_NOTE in text
    assert 'set_analysis(' not in text and '{"' not in text, 'calls told in prose, never call syntax'


def test_a_piece_is_offered_the_chats_tools_but_drafting_a_job():
    ws = JobWorkspace(FakeClient(), _project())
    names = [t['function']['name'] for t in toolkit.job_piece_tools(ws)]
    chat = [t['function']['name'] for t in toolkit.tools_for(ws)]
    assert names == [n for n in chat if n != 'propose_job'], 'the same list, in the same order'
    assert 'run_code' in names or 'run_code' not in chat, 'the code tool wherever the chat has it'
    assert {t['function']['name'] for t in toolkit.job_piece_tools(ws, plan_only=True)} == \
        {n for n in names if n in toolkit.WRITE_TOOLS}


def test_a_tool_outside_the_list_is_refused_and_not_run():
    ws = JobWorkspace(FakeClient(), _project())
    out = toolkit.job_piece_call(ws, 'propose_job', {'action': 'help'})
    assert str(out).startswith('Error') and "not one of this job's" in out


def test_the_planning_context_reads_and_plans_and_stages_nothing():
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = [{'id': 'd1', 'name': 'Text 1'}]
    names = {t['function']['name'] for t in toolkit.job_plan_tools(ws)}
    assert 'plan_work' in names and not names & set(toolkit.WRITE_TOOLS) and 'propose_job' not in names
    assert {t['function']['name'] for t in toolkit.job_plan_tools(ws, plan_only=True)} == {'plan_work'}
    assert str(toolkit.job_plan_call(ws, 'set_field', {})).startswith('Error')
    out = toolkit.call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1'], 'field': 'Translation',
                                              'value': 'x'})
    assert 'stages no change' in out and not ws.ops


@pytest.mark.parametrize('args,said', [
    ({'pieces': 'chapters'}, 'pieces: give "sentences", "document" or "selection".'),
    ({'pieces': 'document', 'piece_instructions': 'x' * 1001}, 'piece_instructions: at most 1,000 characters'),
    ({'pieces': 'document', 'documents': ['Text 9']}, 'documents: not documents of this job: "Text 9"'),
])
def test_plan_work_takes_only_the_menu(args, said):
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = [{'id': 'd1', 'name': 'Text 1'}]
    out = toolkit.job_plan_call(ws, 'plan_work', args)
    assert str(out).startswith('Error') and said in out, out
    assert ws.plan_work is None


def test_plan_work_keeps_a_valid_plan():
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = [{'id': 'd1', 'name': 'Text 1'}, {'id': 'd2', 'name': 'Text 2'}]
    out = toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'document', 'piece_instructions': ' Gloss -da as LOC. ',
                                                  'documents': ['text 2', 'd1', 'Text 2']})
    assert out.startswith('The plan is kept.'), out
    assert ws.plan_work == {'pieces': 'document', 'piece_instructions': 'Gloss -da as LOC.', 'documents': ['d2', 'd1']}


def test_no_job_prompt_has_a_semicolon_or_an_em_dash_of_its_own():
    """The job's own paragraphs (the chat's are the chat's)."""
    for text in (shared.JOB_CONTRACT, shared.JOB_FIND_FIRST, shared.JOB_STAGE_NOW, shared.JOB_PLAN_WHAT_WAS_ASKED,
                 shared.JOB_VALUES, shared.JOB_NOTE, shared.JOB_DECIDE_NOW, shared.JOB_PLAN_CONTRACT,
                 prompt.JOB_PLAN_RULES, shared.JOB_PLAN_NOW, shared.JOB_SUMMARY_CONTRACT, prompt._JOB_EXAMPLE_DID,
                 prompt._JOB_EXAMPLE_NOTE, prompt._JOB_PROJECT_WIDE, prompt.JOB_TABLES):
        assert ';' not in text and '—' not in text, text[:80]


def test_a_pieces_first_call_fits_its_budget_with_the_chats_tools():
    """The budgets stay as they were (CONTRACT 1): the first call of a piece
    of five long sentences, with every tool of the chat and the guidelines
    at their cap, is measured with the tokenizer the worker counts with, and
    leaves room under the decide-now mark for the piece's reads."""
    from plaid_agent.core.agent import token_counter
    count = token_counter('openai/glm-5.3-flash')
    ws = JobWorkspace(FakeClient(), _project())
    tools = toolkit.job_piece_tools(ws)
    system = _job_prompt() + 'x ' * (limits.JOB_GUIDELINES_MAX_CHARS // 2)
    message = ('w ' * 300 + '\n') * (limits.JOB_STRETCH_SENTENCES + limits.JOB_CONTEXT_SENTENCES)
    first = count([{'role': 'system', 'content': system}, {'role': 'user', 'content': message}]) + count(tools)
    assert first < limits.JOB_CALL_DECIDE_AT_TOKENS - 10000, first


# --- what a job's prompt names is what its context has (REV-JG-9) ----------------------------

def _names_in(text):
    """Every tool-like name a prompt mentions: a word with an underscore,
    and a name written as a call (``name(``)."""
    import re
    return (set(re.findall(r'\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b', text))
            | set(re.findall(r'\b([a-z_][a-z0-9_]*)\(', text)))


@pytest.mark.parametrize('mode', [JobWorkspace.PIECE, JobWorkspace.PLAN])
def test_every_tool_and_function_a_job_prompt_names_is_one_its_context_has(monkeypatch, mode):
    """Every tool a job's prompt names is in that context's tool list (or is
    an argument of one), and every function it shows code calling is one
    the context's code is lent, the code section included as where the
    sandbox runs. A small model reaches for what its prompt names."""
    from plaid_agent.core import sandbox
    from plaid_agent.igt import sandbox as igt_sandbox
    monkeypatch.setattr(sandbox, 'available', lambda: None)
    project = _project()
    ws = JobWorkspace(FakeClient(), project, mode=mode)
    if mode == JobWorkspace.PIECE:
        text, tools = prompt.build_job_prompt(project), toolkit.job_piece_tools(ws)
    else:
        text, tools = prompt.build_plan_prompt(project), toolkit.job_plan_tools(ws)
    assert 'Running code:' in text
    offered = {t['function']['name'] for t in tools}
    arguments = {a for t in tools for a in (t['function'].get('parameters') or {}).get('properties') or {}}
    lent = set(igt_sandbox.api(ws))
    stray = sorted(n for n in _names_in(text) if n not in offered | arguments | lent)
    assert not stray, f'the {mode} prompt names what its context does not have: {stray}'


def test_the_planning_prompt_says_its_code_stages_nothing(monkeypatch):
    from plaid_agent.core import sandbox
    monkeypatch.setattr(sandbox, 'available', lambda: None)
    text = prompt.build_plan_prompt(_project())
    assert 'plan(' not in text and 'stages nothing' in text
