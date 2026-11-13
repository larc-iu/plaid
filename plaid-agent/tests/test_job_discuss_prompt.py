"""Two short sentences of the igt chat prompt on talking about a job that ran
(BRIEF-JD item 4): what a job did comes from its record, which keeps no
reason, and a report is a snapshot, so the documents are read as they are now
before a change is planned from it. Positive, igt only, and the job's own
prompt does not change."""

import re

from fixtures import FakeClient, fake_ws

from plaid_agent.igt import prompt as igt_prompt
from plaid_agent.igt.prompt import build_job_prompt
from plaid_agent.ud import prompt as ud_prompt
from plaid_agent.umr import prompt as umr_prompt

LEAD = '- WHAT A JOB DID.'


def _paragraph(text: str) -> str:
    start = text.index(LEAD)
    end = text.index('\n- ', start + 1)
    return text[start:end]


def test_the_igt_prompt_says_how_to_speak_of_a_job_once():
    system = igt_prompt.SYSTEM
    assert system.count(LEAD) == 1
    para = _paragraph(system)
    for said in ('read_job', 'tell the user what it did from the record',
                 'say plainly that jobs keep no record of why', 'as the job ended',
                 'read the documents as they are now before you plan a change from it'):
        assert said in para, said


def test_it_is_two_short_positive_sentences():
    para = _paragraph(igt_prompt.SYSTEM)[len(LEAD):]
    assert len(re.findall(r'[.!?](\s|$)', para.strip())) == 2, para
    assert len(para.split()) <= 60, len(para.split())
    assert not re.search(r"\b(never|not to|do not|don't|NOT)\b", para), para
    assert ';' not in para and '—' not in para


def test_only_igt_says_it():
    for system in (ud_prompt.SYSTEM, umr_prompt.SYSTEM):
        assert LEAD not in system and 'read_job' not in system


def test_the_jobs_own_prompt_is_unchanged_by_it():
    text = build_job_prompt(fake_ws(FakeClient()).project)
    assert LEAD not in text and 'read_job' not in text
