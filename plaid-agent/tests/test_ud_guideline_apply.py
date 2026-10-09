"""A guideline the UD assistant plans is written when the plan is approved.

The shared guideline step creates the guideline in the plan's project, which it
reads from the executor's context. UD's context did not carry the project, so
approving a new guideline failed with "'Context' object has no attribute
'project'" (Luke, 2026-10-09).
"""
from ud_fixtures import PID, ud_client

from plaid_agent.ud.plan import execute_plan
from plaid_agent.ud.project import load_project


def test_a_new_guideline_is_created_in_the_plans_project():
    client = ud_client()
    project = load_project(client, PID)
    ops = [{'kind': 'add_guideline', 'title': 'Verbs tagged NOUN', 'body': 'Retag them VERB.', 'label': ''}]
    execute_plan(client, ops, source='test', label='L', project=project)
    created = [g for g in client.guidelines.list(PID) if g['title'] == 'Verbs tagged NOUN']
    assert created, 'the guideline is created in the project'
