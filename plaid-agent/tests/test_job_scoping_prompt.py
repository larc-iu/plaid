"""One short paragraph of the igt chat prompt on scoping a job with the user
before drafting it (BRIEF-JB item 3): positive, with a worked exchange, and
nowhere else. Only igt has jobs."""

import re

from plaid_agent.igt import prompt as igt_prompt
from plaid_agent.igt.prompt import build_job_prompt
from plaid_agent.ud import prompt as ud_prompt
from plaid_agent.umr import prompt as umr_prompt

from fixtures import FakeClient, fake_ws

LEAD = '- A JOB LEFT TO RUN.'


def _paragraph(text: str) -> str:
    start = text.index(LEAD)
    end = text.index('\n- ', start + 1)
    return text[start:end]


def test_the_igt_prompt_says_how_to_scope_a_job_once():
    system = igt_prompt.SYSTEM
    assert system.count(LEAD) == 1
    para = _paragraph(system)
    # What it should bring about, each said once.
    for said in ('propose_job', 'ask in one message', 'a form people analysed in two ways',
                 'sentences with no word breaks', 'documents already partly glossed', 'from a tagset',
                 'Offer a plan for the first few sentences', 'When they say go, draft it.',
                 # REV-JB-2: approved as unverified, a value stays machine, and
                 # the job follows only people's analyses.
                 "what the user approves as verified or corrects by hand becomes people's analyses",
                 'states the decisions, not the discussion', 'name forms and glosses exactly',
                 'belongs in the guidelines: offer to write it there'):
        assert said in para, said
    # The worked exchange: the question the data raised, the user's answer,
    # and the brief that states it.
    assert 'found -da glossed LOC 12 times and 3SG 4 times' in para
    assert 'the brief "Gloss -da as LOC after a noun and as 3SG after a verb."' in para


def test_the_paragraph_is_short_and_positive():
    para = _paragraph(igt_prompt.SYSTEM)
    # 205, and the 10 words of what a job writes (the owner's rulings 17
    # to 19, one word fewer than JG's line of ruling 13).
    assert len(para.split()) <= 215, len(para.split())
    assert 'A job writes every change it plans but project setup.' in para
    assert not re.search(r"\b(never|not to|do not|don't|NOT)\b", para), para
    assert ';' not in para and '—' not in para


def test_only_igt_offers_or_mentions_a_job():
    from plaid_agent.ud.toolkit import TOOLS as UD_TOOLS
    from plaid_agent.umr.toolkit import TOOLS as UMR_TOOLS
    for system in (ud_prompt.SYSTEM, umr_prompt.SYSTEM):
        assert 'propose_job' not in system and 'JOB LEFT TO RUN' not in system
    for tools in (UD_TOOLS, UMR_TOOLS):
        assert 'propose_job' not in {t['function']['name'] for t in tools}


def test_the_jobs_own_prompt_is_unchanged_by_it():
    text = build_job_prompt(fake_ws(FakeClient()).project)
    assert 'propose_job' not in text and 'JOB LEFT TO RUN' not in text
