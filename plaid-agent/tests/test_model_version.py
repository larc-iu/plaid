"""Every turn names the model that answered and the version of the
assistant's prompt, and an applied plan's writes carry the same in their
provDetail, so a study reading the record or the audit log can tell which
model and which prompt made each change.

The version is ``<plaid-agent release>+<8 hex>``: the first 8 hex digits of
the SHA-256 of the app's system prompt template and every tool schema,
computed when the service starts (the agent README, "Model and prompt
version")."""

import hashlib
import json
import os
import subprocess
import sys

import pytest

import test_stale_by_sentence as sbs
from test_plan_record import _staged, _stored
from test_service_flow import PLAN1, Helper, _request, _seed, _seed_plan, _service

from plaid_agent.core import service as service_mod
from plaid_agent.core.agent import TurnCancelled, TurnResult
from plaid_agent.core.plan import Stamps
from plaid_agent.core.service import AGENT_VERSION, agent_sources, agent_version
from plaid_agent.igt.service import AssistantService as IgtService
from plaid_agent.ud.service import AssistantService as UdService
from plaid_agent.umr.service import AssistantService as UmrService

SERVICES = (IgtService, UdService, UmrService)


# --- the version ------------------------------------------------------------------

def test_the_version_is_the_release_and_a_hash_of_the_prompt_tools_and_code():
    texts, tools = ['You are {project_name}.'], [{'type': 'function', 'function': {'name': 'x'}}]
    sources = [['core/a.py', 'ab' * 32]]
    digest = hashlib.sha256(json.dumps([texts, tools, sources], sort_keys=True, ensure_ascii=False)
                            .encode('utf-8')).hexdigest()[:8]
    assert agent_version(texts, tools, sources) == f'{AGENT_VERSION}+{digest}'
    # A tool's words are part of what the model is told.
    tools2 = [{'type': 'function', 'function': {'name': 'x', 'description': 'd'}}]
    assert agent_version(texts, tools2, sources) != agent_version(texts, tools, sources)
    assert agent_version(texts, tools, [['core/a.py', 'cd' * 32]]) != agent_version(texts, tools, sources)


@pytest.mark.parametrize('cls', SERVICES)
def test_each_assistant_knows_its_version_from_its_own_prompt_tools_and_code(cls):
    svc = cls()
    assert svc.version == agent_version(*svc.prompt_template(), agent_sources(cls))
    app = cls.__module__.split('.')[1]
    paths = [p for p, _ in agent_sources(cls)]
    assert 'core/guidelines.py' in paths and f'{app}/prompt.py' in paths and f'{app}/toolkit.py' in paths
    assert {p.split('/')[0] for p in paths} == {'core', app}
    texts, tools = svc.prompt_template()
    assert texts and all(isinstance(t, str) and t for t in texts)
    assert len(tools) > 10


def test_the_three_assistants_have_three_versions():
    assert len({cls().version for cls in SERVICES}) == 3


def test_the_version_is_the_same_in_another_process():
    # A tool list built from a set would hash differently from one run to the next.
    code = ('from plaid_agent.igt.service import AssistantService as A; '
            'from plaid_agent.ud.service import AssistantService as B; '
            'from plaid_agent.umr.service import AssistantService as C; '
            'print(A().version, B().version, C().version)')
    runs = {subprocess.run([sys.executable, '-c', code], capture_output=True, text=True,
                           env={**os.environ, 'PYTHONHASHSEED': seed}, check=True).stdout
            for seed in ('1', '2')}
    assert len(runs) == 1
    assert runs.pop().split() == [cls().version for cls in SERVICES]


def test_a_service_run_as_a_script_has_the_version_it_has_when_imported():
    # `python -m plaid_agent.umr.service` makes the module `__main__`, so the
    # app cannot be found from the class's module name. `__mp_main__` is the
    # same situation without running main().
    code = ('import runpy; '
            'print(" ".join(runpy.run_module(f"plaid_agent.{app}.service", run_name="__mp_main__")'
            '["AssistantService"]().version for app in ("igt", "ud", "umr")))')
    out = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, check=True).stdout
    assert out.split() == [cls().version for cls in SERVICES]


def _versions_from(src) -> list:
    code = ('from plaid_agent.igt.service import AssistantService as A; '
            'from plaid_agent.ud.service import AssistantService as B; '
            'from plaid_agent.umr.service import AssistantService as C; '
            'print(A().version, B().version, C().version)')
    env = {**os.environ, 'PYTHONPATH': os.pathsep.join([str(src), os.environ.get('PYTHONPATH', '')])}
    return subprocess.run([sys.executable, '-c', code], capture_output=True, text=True,
                          env=env, check=True, cwd=str(src)).stdout.split()


def test_the_version_changes_with_what_the_harness_tells_the_model_and_not_with_line_endings(tmp_path):
    # The guidelines paragraph is written by core code, not by an app's
    # template, and every project with guidelines sends it: a change to it is
    # a new version of all three assistants. A CRLF checkout of the same code
    # is the same version.
    import shutil
    import plaid_agent
    here = os.path.dirname(plaid_agent.__file__)
    src = tmp_path / 'src'
    shutil.copytree(here, src / 'plaid_agent', ignore=shutil.ignore_patterns('__pycache__'))
    before = _versions_from(src)
    assert before == [cls().version for cls in SERVICES]
    for f in (src / 'plaid_agent').rglob('*.py'):
        f.write_bytes(f.read_bytes().replace(b'\n', b'\r\n'))
    assert _versions_from(src) == before
    g = src / 'plaid_agent' / 'core' / 'guidelines.py'
    text = g.read_text()
    assert "'The project\\'s guidelines:'" in text
    g.write_text(text.replace("'The project\\'s guidelines:'", "'The project\\'s written guidelines:'"))
    after = _versions_from(src)
    assert all(a != b for a, b in zip(after, before)), (before, after)


# --- the conversation record --------------------------------------------------------

def test_a_turn_names_the_model_and_the_version(monkeypatch):
    from fixtures import FakeClient
    client = FakeClient()
    store = _seed(client)
    monkeypatch.setattr(service_mod, 'run_turn', lambda *a, **k: TurnResult(
        'Two words.', [{'role': 'assistant', 'content': 'Two words.'}], []))
    svc = _service()
    svc.process_request(_request(client), Helper())
    conv, _ = store.load('c1')
    item = conv['display'][-1]
    assert item['model'] == 'fake/model' and item['version'] == svc.version


@pytest.mark.parametrize('fail', [TurnCancelled(), RuntimeError('provider down')])
def test_a_turn_that_ended_without_an_answer_names_them_too(monkeypatch, fail):
    from fixtures import FakeClient
    client = FakeClient()
    store = _seed(client)

    def run_turn(*a, **k):
        raise fail
    monkeypatch.setattr(service_mod, 'run_turn', run_turn)
    helper = Helper()
    helper.cancelled = isinstance(fail, TurnCancelled)
    svc = _service()
    svc.process_request(_request(client), helper)
    conv, _ = store.load('c1')
    item = conv['display'][-1]
    assert item['kind'] == 'error'
    assert item['model'] == 'fake/model' and item['version'] == svc.version


# --- an applied plan's writes ---------------------------------------------------------

def _details(client):
    """Every provDetail a write sent, as a stamp or as a metadata op."""
    out = []

    def walk(x):
        if isinstance(x, dict):
            if 'provDetail' in x and ('provSource' in x or 'prov' in x):
                out.append(x['provDetail'])
            if x.get('path') in (['provDetail'], 'provDetail') and 'value' in x:
                out.append(x['value'])
            for v in x.values():
                walk(v)
        elif isinstance(x, (list, tuple)):
            for v in x:
                walk(v)
    for _, payload in client.calls:
        walk(payload)
    return out


def _sources(client):
    out = []

    def walk(x):
        if isinstance(x, dict):
            if isinstance(x.get('provSource'), str):
                out.append(x['provSource'])
            if x.get('path') in (['provSource'], 'provSource') and isinstance(x.get('value'), str):
                out.append(x['value'])
            for v in x.values():
                walk(v)
        elif isinstance(x, (list, tuple)):
            for v in x:
                walk(v)
    for _, payload in client.calls:
        walk(payload)
    return out


@pytest.fixture(params=sorted(sbs.APPS))
def spec(request):
    return sbs.APPS[request.param]()


def test_an_applied_plans_writes_name_the_model_and_version_that_proposed_it(spec, monkeypatch):
    client = spec['client']()
    plan = _staged(spec, client, monkeypatch)
    item = _stored(spec, client)
    assert item['model'] == 'fake/model'
    assert item['version'] == spec['service']().version
    written = len(client.calls)
    helper = sbs._approve(spec, client, plan)
    assert helper.done and helper.done[-1]['kind'] == 'applied', helper.errors
    client.calls[:] = client.calls[written:]
    details = _details(client)
    assert details, 'the plan wrote no stamp'
    assert all(d == {'model': 'fake/model', 'version': item['version']} for d in details), details


def test_a_plan_proposed_by_one_model_keeps_its_name_when_another_applies_it():
    from fixtures import FakeClient
    client = FakeClient()
    store = _seed_plan(client)
    conv, meta = store.load('c1')
    conv['display'][1]['model'], conv['display'][1]['version'] = 'first/model', '0.0.0+aaaaaaaa'
    store.save('c1', conv, meta)
    svc = _service()   # answers as fake/model
    svc.process_request(_request(client, approve={'plan_id': PLAN1}), Helper(request_id='r9'))
    [(_, _, _, stamp)] = [c['args'] for c in client.payloads('spans.create')]
    assert stamp['provDetail'] == {'model': 'first/model', 'version': '0.0.0+aaaaaaaa'}
    assert stamp['provConfirmed'] is True


def test_a_contributors_approval_keeps_the_proposal_as_a_guess():
    # As when a contributor adopts a service's guess: the work is theirs, and
    # what proposed it is kept beside it.
    from fixtures import FakeClient
    client = FakeClient()
    client.project['config']['plaid'] = {'review': {'users': ['u@x']}}
    _seed_plan(client)
    svc = _service()
    svc.process_request(_request(client, approve={'plan_id': PLAN1}), Helper(request_id='r9'))
    [(_, _, _, stamp)] = [c['args'] for c in client.payloads('spans.create')]
    assert stamp['prov'] == 'contributed' and stamp['provSource'] == 'user:u@x'
    assert stamp['provDetail'] == {'model': 'fake/model', 'guess': 'service:igt:assist:fake'}


def test_whose_work_is_reviewed_is_read_from_the_project_at_approval():
    """The page told the service whether the approver is a contributor, from
    the project as it was when the page loaded, so a review change made since
    was not honored (H11-MULTI-2). The service reads ``plaid.review`` itself
    and ignores what the page says."""
    from fixtures import FakeClient
    client = FakeClient()
    _seed_plan(client)
    # The page still believes the approver is reviewed; the project no longer does.
    _service().process_request(_request(client, approve={'plan_id': PLAN1, 'contributed_by': 'u@x'}),
                               Helper(request_id='r9'))
    [(_, _, _, stamp)] = [c['args'] for c in client.payloads('spans.create')]
    assert stamp['prov'] == 'inferred' and stamp['provConfirmed'] is True
    # Reviewed by role, which the page did not know about.
    client2 = FakeClient()
    client2.project['config']['plaid'] = {'review': {'roles': ['writer']}}
    client2.project['writers'] = ['u@x']
    _seed_plan(client2)
    _service().process_request(_request(client2, approve={'plan_id': PLAN1}), Helper(request_id='r9'))
    [(_, _, _, stamp)] = [c['args'] for c in client2.payloads('spans.create')]
    assert stamp['prov'] == 'contributed' and stamp['provSource'] == 'user:u@x'


def test_a_plan_recorded_as_human_made_names_no_model():
    from fixtures import FakeClient
    client = FakeClient()
    _seed_plan(client)
    _service().process_request(_request(client, approve={'plan_id': PLAN1, 'as_human': True}),
                               Helper(request_id='r9'))
    [(_, _, _, stamp)] = [c['args'] for c in client.payloads('spans.create')]
    assert not stamp


def test_a_rewrite_replaces_the_earlier_producers_detail_and_probability():
    stamps = Stamps('verified', 'service:a', detail={'model': 'm', 'version': 'v'})
    assert stamps.restamp() == {'prov': 'inferred', 'provSource': 'service:a', 'provConfirmed': True,
                                'provProb': None, 'provDetail': {'model': 'm', 'version': 'v'}}
    assert stamps.stamp() == {'prov': 'inferred', 'provSource': 'service:a', 'provConfirmed': True,
                              'provDetail': {'model': 'm', 'version': 'v'}}
    assert Stamps('human', 'service:a', detail={'model': 'm'}).stamp() == {}
