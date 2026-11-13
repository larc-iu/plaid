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
                 "holds what it did, the model's note on each piece, and nothing more of why",
                 'as the job ended', 'read the documents as they are now before you plan a change from it'):
        assert said in para, said


def test_the_record_of_a_job_is_said_the_same_way_everywhere():
    """REV-JG-10 and the owner's "No reasons": a job records no reason per
    decision, and each of its pieces leaves a note, which the model wrote.
    The chat prompt, read_job's help and the guide say so, each so that the
    model's words are only the notes, never the counts (REV-JG2-13), and none
    says that a job keeps no record of why (its notes may say why)."""
    from pathlib import Path
    from plaid_agent.igt import jobread
    guide = (Path(__file__).resolve().parents[2] / 'plaid-igt' / 'docs' / 'igt-guide.adoc').read_text()
    for name, text in (('the chat prompt', igt_prompt.SYSTEM), ('read_job', jobread._help()), ('the guide', guide)):
        flat = ' '.join(text.split())
        assert "the model's note on each piece" in flat and 'and nothing more of why' in flat, name
        assert "own words" not in flat.split("A job's record")[1][:120], name
        assert 'no record of why' not in flat and 'never why' not in flat and 'and not why' not in flat, name


def test_the_chat_prompt_did_not_grow():
    """The paragraph was 53 words before REV-JG-10."""
    assert len(_paragraph(igt_prompt.SYSTEM)[len(LEAD):].split()) <= 53


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
