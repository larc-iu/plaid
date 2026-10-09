"""A4-CROSS-1: a plan staged in a turn that reads other projects carries the
project it writes in (``plan.project``, ``{id, name}``), so the card and the
export name it. A one-project turn's plan says nothing about it."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))

from multi_fixtures import OTHER_ID, OTHER_NAME, client  # noqa: E402
from test_reach_turn import APPS, _Helper, _seed, _svc  # noqa: E402

from plaid_agent.core import service as service_mod  # noqa: E402
from plaid_agent.core.agent import TurnResult  # noqa: E402


def _turn(app, monkeypatch, projects, delegated):
    c = client(app)
    pid = c.project['id']
    store = _seed(c, app, projects, pid)

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        ws.plan_payload = lambda: {'id': '01a10f7d-f747-7000-850f-a5c879af1a98', 'summary': '1 change',
                                   'labels': ['x'], 'ops': [], 'changes': [], 'documents': []}
        return TurnResult('Planned.', [{'role': 'assistant', 'content': 'Planned.'}], [])

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    helper = _Helper()
    _svc(app).process_request({'op': 'send', 'requester_client': c, 'requester_id': 'u@x', 'project_id': pid,
                               'conversation_id': 'c1', 'delegated_projects': delegated(pid)}, helper)
    assert not helper.errors, helper.errors
    conv, _ = store.load('c1')
    return c, conv['display'][-1]['plan']


@pytest.mark.parametrize('app', APPS)
def test_a_plan_made_while_reading_other_projects_names_its_project(app, monkeypatch):
    c, plan = _turn(app, monkeypatch, [{'id': OTHER_ID, 'name': OTHER_NAME}],
                    lambda pid: [pid, OTHER_ID])
    assert plan['project'] == {'id': c.project['id'], 'name': c.project['name']}


@pytest.mark.parametrize('app', APPS)
def test_a_plan_on_one_project_does_not(app, monkeypatch):
    _c, plan = _turn(app, monkeypatch, None, lambda pid: [pid])
    assert 'project' not in plan
