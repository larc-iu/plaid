"""What the setup conversation is told, and how its steps are labelled
(RPF-A2, RPF-A10, the owner's R1 and R2), and what read_job says of the
report's new parts (RPF-A3 to A5).

RP-2: a Set up job conversation answered with a chat plan, and the
assistant called a job's values "proposals" while the job writes them; the
33 values people had checked became unverified, which the person learned
only by asking. RP-3: the card claimed a convention the project does not
have. RP-4: a request needing no change became a job. RP-5: the facts step
read "Nothing to change: a job"."""

from fixtures import FakeClient, fake_ws
from job_fixtures import JobClient, document

from plaid_agent.igt import jobcard, jobread, targets as tg
from plaid_agent.igt.prompt import build_system_prompt
from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.trace import TRACER


def _note():
    return jobcard.JOB_SETUP_NOTE.replace('\n', ' ')


def test_r2_a_request_that_needs_no_change_is_answered_in_the_chat():
    assert ('If what they ask needs no change to the documents (a question, a count, a list, a check), answer it '
            'here from what you read, and draft a job only if they ask for one.') in _note()


def test_r1_people_are_told_before_drafting_that_their_values_become_unverified():
    note = _note()
    assert ('If the job would change values the facts count as people\'s, say before you draft how many such values '
            'those fields hold, and that a job writes unverified machine values, so each one it changes becomes '
            'unverified.') in note
    assert ('For an exact change they dictate (one spelling or value for another), say in one sentence that an '
            'ordinary plan in this chat, approved as verified, keeps them verified, and let them choose.') in note


def test_rp2_the_setup_conversation_leads_to_a_card_not_a_plan():
    note = _note()
    assert 'you lead to a job card drafted with propose_job, not to a plan of changes' in note
    assert 'Stage no plan of changes here unless the person chose one in step 5.' in note


def test_a_jobs_values_are_never_called_proposals_or_staged():
    note = _note()
    assert ('never call them proposals for the person to check, or say they are staged.') in note
    help_ = call_tool(fake_ws(FakeClient()), 'propose_job', {'action': 'help'})
    assert 'proposal' not in help_ and 'each value an unverified machine value' in help_
    from plaid_agent.core.prompt import JOB_CONTRACT, JOB_NOTE
    assert 'machine proposal' not in JOB_CONTRACT
    assert 'Say what you did as done' in JOB_NOTE


def test_rp3_rp5_the_brief_opens_plainly_and_claims_no_convention_it_did_not_read():
    help_ = call_tool(fake_ws(FakeClient()), 'propose_job', {'action': 'help'})
    assert 'Open it with one plain sentence a person who is not a linguist can follow' in help_
    assert ("State as the project's convention only what you read in the facts, the guidelines or the documents."
            in help_)


def test_the_ordinary_chat_says_the_same_of_jobs():
    prompt = build_system_prompt(load_project(FakeClient(), 'p1')).replace('\n', ' ')
    assert ("A job writes unverified machine values: if it would change people's, say so and offer a plan here, "
            'approved as verified. Answer here what needs no change.') in prompt


def test_facts_count_the_values_people_hold_of_each_target():
    client = JobClient({'d1': document('d1', 'Story', [{'words': [('ka', [('ka', 'go')], 'human'),
                                                                 ('ta', [('ta', 'x')], 'machine'), 'sa']}])})
    out = call_tool(fake_ws(client), 'propose_job', {'action': 'facts', 'documents': ['all']})
    assert tg.PEOPLE_SAID in out
    line = next(x for x in out.split('\n') if x.startswith('- "Story"'))
    assert "People's: segmentation 1, Morph Gloss 1." in line, line


def test_the_planner_is_not_shown_peoples_counts():
    project = load_project(FakeClient(), 'p1')
    facts = [{'id': 'd', 'name': 'S', 'sentences': 1, 'words': 1, 'characters': 2, 'empty': {},
              'people': {'segmentation': 3}}]
    assert "People's" not in '\n'.join(tg.fill_lines(tg.fillable(project), facts, 'plan_work', 'The documents'))


def test_the_draft_says_nothing_has_run_yet():
    client = FakeClient()
    client.jobs.active = lambda project_id: None
    out = call_tool(fake_ws(client), 'propose_job', {'action': 'draft', 'documents': ['all'], 'fills': ['Gloss'],
                                                     'brief': 'Fill Gloss.'})
    assert out.endswith('Nothing has run yet: say the card is drafted, never that anything is done.'), out


def test_rp5_facts_is_a_read_never_nothing_to_change():
    args = {'action': 'facts', 'documents': ['all']}
    assert TRACER.describe('propose_job', args) == 'Read what a job can fill'
    from plaid_agent.core.trace import READ
    assert TRACER.call_kind('propose_job', args) == READ
    assert TRACER.describe('propose_job', {'action': 'draft'}) == 'Drafted a job'


# --- read_job --------------------------------------------------------------------------------

def test_read_job_says_the_notice_the_findings_and_the_changes_by_kind():
    report = {'state': 'done', 'notice': 'Text: 1 word added.', 'findings': '## Found\n\nTwo forms.',
              'summary': 'The job wrote no change and proposed none.', 'summary_by': 'worker',
              'totals': {'changes': 2, 'changes_parts': [{'kind': 'values', 'n': 1}, {'kind': 'text', 'n': 1}]}}
    lines = jobread.summary({'state': 'done', 'report': report, 'instructions': 'x'}, note_chars=None)
    text = '\n'.join(lines)
    assert 'The report\'s top line, the worker\'s own: "Text: 1 word added."' in text
    assert 'The job\'s findings, its report: "## Found\n\nTwo forms."' in text
    assert 'changes by kind: values 1, text 1' in text


def test_rp2_1_rp2_2_no_card_beside_a_question_no_field_unasked_and_only_new_when_asked():
    """RP2-1: the assistant asked whether to add Word class and drafted the card
    in the same turn. RP2-2: it added Case and Word class nobody asked for,
    because a guideline derives them, and did not set only_new when told
    "segment and gloss only the words that change" (RPF3-F)."""
    note = _note()
    assert ('Never assume: a field they did not name goes on the card only once they say yes to it, whatever a '
            'guideline derives from what they asked for.') in note
    assert 'A reply that asks a question drafts no card: wait for the answer.' in note
    # Only the words the job ADDS: a respelled word is not one (REV-RPF3-7).
    assert ('only_new true when they ask it to fill only the words it adds, such as "gloss only the new word": a '
            'respelled word is not an added word.') in note
    assert 'or changes' not in note and 'words that change' not in jobcard._help({})
    assert 'never for a respelled word, which is not an added word' in jobcard._help({})
