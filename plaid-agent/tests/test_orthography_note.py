"""What the chat assistant is told the baseline and an orthography are, so it
can say why a newly added orthography's row is empty, and where the
orthographies are set: a person who added the name of their text's own
orthography got a second, empty row, and the assistant first said no such
setting existed."""

from fixtures import FakeClient, fake_ws

from plaid_agent.igt.project import ORTHOGRAPHIES_NOTE, load_project, render_overview
from plaid_agent.igt.prompt import JOB_SYSTEM, build_system_prompt, project_brief

NOTE = ('The baseline is the text as typed on the Baseline tab. An orthography is an additional row under every '
        'word, with its own value for each word: it starts empty and is never filled from the baseline on its own. '
        "Orthographies are set in the project's Settings, under Text and vocab.")


def test_the_note_says_what_the_baseline_and_an_orthography_are():
    assert ORTHOGRAPHIES_NOTE == NOTE


def test_the_chat_prompt_says_it_under_the_orthographies():
    prompt = build_system_prompt(fake_ws(FakeClient()).project)
    assert '- Orthographies: IPA\n  ' + NOTE + '\n- Lexicons: ' in prompt


def test_the_overview_says_it_under_the_orthographies():
    out = render_overview(load_project(FakeClient(), 'p1'), [{'id': 'd1', 'name': 'Text 1'}])
    assert 'Orthographies: IPA\n' + NOTE + '\nLexicons: ' in out


def test_another_projects_brief_and_a_job_are_not_told_it():
    p = load_project(FakeClient(), 'p1')
    assert NOTE not in project_brief(p)
    assert NOTE not in JOB_SYSTEM
