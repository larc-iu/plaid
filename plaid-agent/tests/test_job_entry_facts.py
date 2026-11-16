"""What a job can do to existing lexicon entries, said from the toolkit's own
lists (RPF3 round 4, RP3-4): asked to correct an entry's gloss, the setup
assistant promised it, and a piece in sentences, with no tool to edit an
entry, created a second entry of the form."""

from fixtures import FakeClient

from plaid_agent.igt import jobcard, toolkit
from plaid_agent.igt.job import JobWorkspace
from plaid_agent.igt.project import load_project
from plaid_agent.igt.workspace import Workspace


def test_the_facts_come_from_the_toolkits_lists():
    said = toolkit.job_entry_facts()
    assert said == ('Existing lexicon entries: a piece of a plan in sentences is offered only link_entry and '
                    'create_entry, when what the job fills is linked to a lexicon, so it cannot change an entry '
                    'that exists. A piece of a document or of all the documents is also offered set_entry_field, '
                    'merge_entries, delete_entry and rename_entry: set_entry_field is written, and merge_entries, '
                    'delete_entry and rename_entry only when the person who started the job maintains the project, '
                    'else listed as proposed changes.'), said
    assert set(toolkit.SENTENCES_LEXICON) == {'link_entry', 'create_entry'}


def test_the_setup_is_told_them():
    assert toolkit.job_entry_facts() in jobcard._help({})


def test_a_jobs_create_entry_is_for_a_form_with_no_entry_and_the_chats_unchanged():
    def described(ws):
        return next(t['function']['description'] for t in toolkit.job_piece_tools(ws) + toolkit.tools_for(ws)
                    if t['function']['name'] == 'create_entry')
    c = FakeClient()
    job = JobWorkspace(c, load_project(c, 'p1'))
    assert described(job).endswith(toolkit.JOB_NEW_ENTRY.strip())
    chat = Workspace(c, load_project(c, 'p1'))
    assert toolkit.JOB_NEW_ENTRY.strip() not in str([t['function']['description'] for t in toolkit.tools_for(chat)])


def test_a_jobs_create_entry_allows_a_homonym_and_never_corrects():
    """REV-RPF3B-3: the guard refuses only an entry of the same form and
    gloss, so a second meaning of a form is made; the description must not
    forbid it, and must say a second entry is never a correction."""
    said = toolkit.JOB_NEW_ENTRY.strip()
    assert said == ('In a job it never changes an existing entry: a second entry of a form is for another meaning, '
                    'never a correction of the first.'), said
    assert 'only for a form with no entry' not in said
