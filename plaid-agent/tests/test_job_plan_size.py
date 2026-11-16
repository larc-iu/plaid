"""What the planner is told of a plan's size and cost (RPF3 round 4).

A real model planned the rename of one gloss (33 hits in 24 documents, found
by search) as "sentences" over all 45 documents: every sentence walked in
stretches, about four hours for 33 exact replacements. The planner's rules
said "sentences" was for sentence by sentence work, "Every sentence", and
"selection" for finding where documents disagree, with findings in its last
message: it read a selection as a report and "sentences" as the way to change
values. Now the rules say the cost of a sentences plan as a fact, and that a
selection makes the same exact change wherever a known value occurs; and
plan_work's answer says how many pieces a sentences or document plan is."""

from fixtures import FakeClient

from plaid_agent.core.limits import JOB_STRETCH_SENTENCES
from plaid_agent.igt import toolkit
from plaid_agent.igt.job import JobWorkspace
from plaid_agent.igt.project import load_project
from plaid_agent.igt.prompt import JOB_PLAN_RULES


def _planning(docs):
    ws = JobWorkspace(FakeClient(), load_project(FakeClient(), 'p1'), mode=JobWorkspace.PLAN)
    ws.job_documents = docs
    return ws


DOCS = [{'id': f'd{i}', 'name': f'Text {i}', 'sentences': 20, 'empty': {}} for i in range(1, 46)]


def test_the_rules_say_what_a_sentences_plan_costs_and_what_a_selection_changes():
    rules = JOB_PLAN_RULES.replace('\n', ' ')
    assert ('A plan in sentences makes at least one model call for each stretch of the sentences it works in every '
            'document.' in rules), rules
    assert ('and for the same exact change wherever a known value occurs (one value for another): it finds them with '
            'search or code and stages each change, which is written in its document.' in rules), rules
    assert 'for work that needs each sentence read' in rules


def test_plan_work_says_how_many_pieces_a_sentences_or_document_plan_is():
    per = -(-20 // JOB_STRETCH_SENTENCES)
    out = toolkit.job_plan_call(_planning(DOCS), 'plan_work', {'pieces': 'sentences', 'fills': ['Morph Gloss']})
    assert out == f'The plan is kept. This plan is {45 * per:,} pieces over 45 documents. End now with a one-line reply.'
    out = toolkit.job_plan_call(_planning(DOCS), 'plan_work', {'pieces': 'sentences', 'fills': ['Morph Gloss'],
                                                               'skip_filled_sentences': True,
                                                               'documents': ['Text 1', 'Text 2']})
    assert f'This plan is at most {2 * per:,} pieces over 2 documents.' in out, out
    out = toolkit.job_plan_call(_planning(DOCS[:1]), 'plan_work', {'pieces': 'document', 'fills': ['Morph Gloss']})
    assert 'This plan is 1 piece over 1 document.' in out, out
    out = toolkit.job_plan_call(_planning(DOCS), 'plan_work', {'pieces': 'selection', 'fills': ['Morph Gloss']})
    assert 'This plan is' not in out and out.endswith('End now with a one-line reply.'), out


def test_plan_work_may_be_called_again_and_the_last_plan_is_kept():
    ws = _planning(DOCS)
    toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'sentences', 'fills': ['Morph Gloss']})
    toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'selection', 'fills': ['Morph Gloss']})
    assert ws.plan_work['pieces'] == 'selection'
