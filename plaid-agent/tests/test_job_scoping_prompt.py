"""One paragraph of the igt chat prompt on scoping a job with the user
before drafting it (BRIEF-JB item 3), with a worked exchange, and nowhere
else. Only igt has jobs. Since no button opens a job setup conversation
(AB, the owner 2026-11-17), the steps that conversation's note gave are part
of it, so every conversation is told them."""

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
    for said in ('propose_job', 'Ask in the same message', 'a form people analysed in two ways',
                 'sentences with no word breaks', 'documents already partly glossed', 'from a tagset',
                 'Offer a plan for the first few sentences', 'When they say go, draft it with action "draft"',
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


#: The setup note's prohibitions, each from a bench finding (RP-2, RP2-2),
#: kept word for word when the note joined the paragraph. No other.
NEGATIVES = ['not to', 'Never', 'never']


def test_the_paragraph_is_short_and_says_only_the_notes_prohibitions():
    para = _paragraph(igt_prompt.SYSTEM)
    # The paragraph was 227 words and the setup note 344 without the
    # help it inlined: merged, never more than the two apart (507 now).
    assert len(para.split()) <= 227 + 344, len(para.split())
    assert "a job writes unverified machine values, so each one it changes becomes unverified" in para
    found = re.findall(r"\b(never|Never|not to|do not|don't|NOT)\b", para)
    assert found == NEGATIVES, found
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
