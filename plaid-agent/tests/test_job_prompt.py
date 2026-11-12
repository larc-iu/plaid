"""An unattended job's prompt and tools are written for the job.

The chat prompt's rules about a conversation do harm in a headless loop (ask
when ambiguous, draft a guideline, end the turn and wait, the plan card, copy
forms in code), so none of them is said, and the tools that would do them are
not offered (FABLE-REVIEW 5, the lead's note 6 of 2026-11-12). The constants
are CONTRACT 1's.
"""

from fixtures import FakeClient, fake_ws

from plaid_agent.core import limits, prompt as shared
from plaid_agent.igt import prompt, toolkit


def _job_prompt():
    return prompt.build_job_prompt(fake_ws(FakeClient()).project)


def test_the_constants_are_the_contracts():
    assert (limits.JOB_HEARTBEAT_S, limits.JOB_IDLE_POLL_S, limits.JOB_STRETCH_SENTENCES,
            limits.JOB_CONTEXT_SENTENCES, limits.JOB_SENTENCE_MAX_CHARS, limits.JOB_GUIDELINES_MAX_CHARS,
            limits.JOB_PRECEDENT_PER_FORM, limits.JOB_PRECEDENT_CHARS) == (30, 30, 5, 2, 4000, 24000, 3, 8000)
    assert (limits.JOB_STRETCH_MAX_ROUNDS, limits.JOB_STRETCH_DECIDE_AT_ROUNDS, limits.JOB_CALL_MAX_PROMPT_TOKENS,
            limits.JOB_CALL_DECIDE_AT_TOKENS, limits.JOB_STRETCH_MAX_SENT_TOKENS) == (20, 15, 64000, 48000, 600000)
    assert (limits.JOB_MODEL_RETRY_S, limits.JOB_YIELD_POLL_S, limits.JOB_YIELD_QUIET_S, limits.JOB_PERSON_QUIET_S,
            limits.JOB_LOCK_TRIES, limits.JOB_LOCK_WAIT_S, limits.JOB_DEFER_ROUNDS, limits.JOB_DEFER_WAIT_S,
            limits.HARMONIZE_MAJORITY, limits.JOB_REPORT_LIST_MAX) == (300, 10, 60, 600, 3, 10, 3, 600, (2, 3), 500)
    assert shared.JOB_DECIDE_NOW == ('(system) Decide now with what you have: stage the analyses of the target '
                                     'sentences and end.')


def test_no_rule_of_a_conversation_is_said():
    text = _job_prompt()
    for paragraph in (shared.ONE_TURN, shared.STAGE_NOW, shared.FINAL_MESSAGE, shared.COPY_FORMS,
                      shared.PLAN_CONTRACT.split('{')[0]):
        assert paragraph[:60] not in text
    lowered = text.lower()
    for words in ('approve', 'ask which', 'guidelines action', 'run_code', 'in code', 'end your turn',
                  'plan card', 'stretch'):
        assert words not in lowered, words
    assert 'machine proposals' in text and shared.JOB_RULES in text
    assert 'GUIDELINE: Glossing' in text and 'Loanwords are **not** segmented' in text, 'every guideline, whole'


def test_the_prompt_shows_one_whole_stretch():
    text = _job_prompt()
    assert 'One message worked through, for example.' in text and 'end with "Done."' in text


def test_a_job_is_offered_the_reads_and_the_plan_tools_of_its_tasks():
    def names(tasks, **kw):
        return [t['function']['name'] for t in toolkit.job_tools(tasks, **kw)]
    reads = list(toolkit.JOB_READS)
    assert names(['translate']) == reads + ['set_field']
    assert names(['gloss']) == reads + ['set_field', 'set_analysis']
    assert names(['translate', 'gloss', 'link']) == reads + ['set_field', 'set_analysis', 'link_entry',
                                                             'create_entry']
    assert names(['gloss', 'link'], plan_only=True) == ['set_field', 'set_analysis', 'link_entry', 'create_entry']
    every = names(['translate', 'gloss', 'link'])
    for absent in ('run_code', 'discard_plan', 'plan_status', 'guidelines', 'respell', 'delete_entry', 'confirm',
                   'tagsets', 'restore_document', 'link_phrase', 'web_search'):
        assert absent not in every
    for t in toolkit.job_tools(['translate', 'gloss', 'link']):
        assert 'approve' not in t['function']['description'].lower()


def test_a_tool_outside_the_list_is_refused_and_not_run():
    ws = fake_ws(FakeClient())
    out = toolkit.job_call_tool(ws, 'discard_analysis', {'document': 'Text 1', 'refs': ['s1.w1']}, ['gloss'])
    assert 'not one of this job' in out and not ws.ops
    out = toolkit.job_call_tool(ws, 'link_entry', {'document': 'Text 1', 'refs': ['s1.w2'], 'entry_form': 'gam'},
                                ['gloss'])
    assert 'not one of this job' in out and not ws.ops
