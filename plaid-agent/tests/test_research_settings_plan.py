"""The research extractor ties a plan of settings (tagset changes, which the
app writes as the plan's own assistant-plan operation) to its operation, as
it ties every other applied plan (REV-AGENT-4). Against the session's core
and its database file."""

import json
from pathlib import Path

import pytest
from fixtures import project_raw, document_raw, lexicon_raw, VOCAB
from live import _Session, _skip_or_fail, core_db, live_client, seed  # noqa: F401 - fixture
from page_write import page_write

from plaid_agent.core.conversation import (ConversationStore, assistant_item, build_meta, proposed_changes,
                                           settle_plan, user_item)
from plaid_agent.core.approval import audit_label
from plaid_agent.igt.project import load_project
from plaid_agent.igt.service import AssistantService
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace


@pytest.fixture
def proj(live_client):
    s = seed(live_client, project_raw(), {'d1': document_raw()}, {VOCAB: lexicon_raw()},
             name='igt-agent research settings plan test')
    yield s
    s.delete()


def test_an_applied_tagset_plan_is_linked_to_its_operation(proj, tmp_path):
    db = core_db()
    if not db or not Path(db).is_file():
        _skip_or_fail('PLAID_TEST_DB does not name the database file of the core under test')
    ws = Workspace(proj.client, load_project(proj.client, proj.project_id))
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'add': ['NOM']}})
    plan = ws.plan_payload()
    plan['proposed'], plan['proposed_count'] = proposed_changes(plan['ops'], *AssistantService.proposed_keys)
    service = 'igt:assist:fake'
    # The page's write, as plaid-ui planOperation names it.
    page_write(proj.client, proj.project_id, ws.ops,
               {'message': audit_label(plan['summary']), 'kind': 'assistant-plan',
                'ref': f'conv:c1/plan:{plan["id"]}/service:{service}'})
    store = ConversationStore(proj.client, _Session.user, proj.project_id, 'igt')
    item = assistant_item('Planned.', plan, [], [], '', 'fake/model', service=service)
    conv = {'messages': [{'role': 'user', 'content': 'add NOM'}, {'role': 'assistant', 'content': 'Planned.'}],
            'display': [user_item('add NOM'), item]}
    conv = settle_plan(conv, 1, 'applied', '(note) applied', as_human=False)
    store.save('c1', conv, build_meta(None, 'c1', conv, service, 'fake/model'))

    from plaid_agent.research.extract import extract
    out = tmp_path / 'out'
    manifest = extract(db, out, tmp_path / 'salt', projects=[proj.project_id], quiet=True)
    plans = [json.loads(line) for line in (out / 'plans.jsonl').read_text().splitlines() if line.strip()]
    [p] = [p for p in plans if p['status'] == 'applied']
    assert p['group_link'] == 'ref' and p['writes'], p
    assert manifest['linking']['applied_unlinked'] == 0, manifest['linking']
    units = [json.loads(line) for line in (out / 'units.jsonl').read_text().splitlines() if line.strip()]
    [u] = [u for u in units if u['kind'] == 'assistant-plan']
    assert any(k.startswith('projects.') for k in u['counts']), u['counts']
