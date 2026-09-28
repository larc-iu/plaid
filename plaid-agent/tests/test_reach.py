"""A turn that may read other projects (core/reach.py): which projects it
reaches, how a tool is routed to one, and that nothing is ever staged in
one, on any path."""

import inspect
import sys

import pytest

sys.path.insert(0, 'tests')

from multi_fixtures import (OTHER_ID, OTHER_NAME, client, home_workspace, other_project,  # noqa: E402
                            reached, reads_in, service)

from plaid_agent.core import reach as reach_mod  # noqa: E402
from plaid_agent.core.limits import MAX_PROJECTS  # noqa: E402
from plaid_agent.core.reach import LOCAL_TOOLS, PLAN_TOOLS, reachable, route  # noqa: E402
from plaid_agent.core.tools import ToolError  # noqa: E402

APPS = ('igt', 'ud', 'umr')


# --- which projects a turn reaches -------------------------------------------------

def test_reachable_keeps_what_the_user_added_in_order_and_caps_it():
    joined = [{'id': f'x{i}', 'name': f'X{i}'} for i in range(MAX_PROJECTS + 2)]
    everything = ['home', *(j['id'] for j in joined)]
    allowed, refused = reachable('home', [{'id': 'home'}, *joined, joined[0], {'name': 'no id'}, 'junk'],
                                 everything)
    assert [a['id'] for a in allowed] == [f'x{i}' for i in range(MAX_PROJECTS - 1)]
    assert [r['id'] for r in refused] == [f'x{i}' for i in range(MAX_PROJECTS - 1, MAX_PROJECTS + 2)]


def test_reachable_names_a_project_without_a_name_by_its_id():
    allowed, _ = reachable('home', [{'id': 'x1'}], ['home', 'x1'])
    assert allowed == [{'id': 'x1', 'name': 'x1'}]


def test_reachable_refuses_a_project_the_token_does_not_reach():
    # The server scopes the requester's token to the home project and those
    # of the joined ones the user can read. One it left out is refused here,
    # in the order the reader added it, and does not count against the cap.
    joined = [{'id': 'a', 'name': 'A'}, {'id': 'B', 'name': 'B'}, {'id': 'c', 'name': 'C'}]
    allowed, refused = reachable('home', joined, ['home', 'a', 'b'])
    assert allowed == [{'id': 'a', 'name': 'A'}, {'id': 'B', 'name': 'B'}], 'ids compare without case'
    assert refused == [{'id': 'c', 'name': 'C'}]
    assert reachable('home', joined, ()) == ([], joined)


def test_a_project_the_token_does_not_reach_is_never_opened():
    svc, c, ws, r = reached('igt', token_reaches=[])
    assert r.others == [] and r.unavailable == [{'id': OTHER_ID, 'name': OTHER_NAME}]
    assert not reads_in(c, OTHER_ID)


def test_nothing_joined_is_no_reach():
    c = client('igt')
    svc, ws = home_workspace('igt', c)
    assert svc.open_reach(c, ws, None, ()) is None and svc.open_reach(c, ws, [], ()) is None
    assert ws.reach is None


@pytest.mark.parametrize('app', APPS)
def test_a_joined_project_opens_with_the_requesters_client(app):
    svc, c, ws, r = reached(app)
    assert [p.id for p in r.others] == [OTHER_ID] and not r.unavailable
    other = r.workspace(OTHER_NAME)
    assert other.client is c and other.project.id == OTHER_ID
    assert other.home is False and other.writable is False and ws.home is True and ws.writable
    assert other.reach is r and ws.reach is r


def test_a_project_the_user_cannot_read_is_unavailable():
    svc, c, ws, r = reached('igt', joined=[{'id': 'secret', 'name': 'Secret'}])
    assert r.others == [] and r.unavailable == [{'id': 'secret', 'name': 'Secret'}]


def test_a_project_this_assistant_is_not_online_in_is_unavailable():
    svc, c, ws, r = reached('igt', served=False)
    assert r.others == [] and r.unavailable == [{'id': OTHER_ID, 'name': OTHER_NAME}]


def test_an_offline_or_different_assistant_does_not_count():
    for entries in ([{'service_id': 'igt:assist:fake', 'online': False}],
                    [{'service_id': 'igt:assist:other', 'online': True}]):
        svc, c, ws, r = reached('igt', services={OTHER_ID: entries})
        assert r.others == [], entries


def test_a_project_the_app_cannot_read_is_unavailable():
    """The IGT assistant handed a project with no baseline layer: its loader
    raises ValueError, and the project is simply not opened."""
    import fixtures as f
    p2 = other_project(f.project_raw(), {'d1': f.document_raw()}, OTHER_ID, OTHER_NAME)
    p2['project']['text_layers'] = []
    svc, c, ws, r = reached('igt', others={OTHER_ID: p2})
    assert r.others == [] and r.unavailable == [{'id': OTHER_ID, 'name': OTHER_NAME}]


def test_past_the_cap_a_project_is_unavailable_not_silently_dropped():
    import fixtures as f
    others, services = {}, {}
    for i in range(MAX_PROJECTS):
        pid = f'px{i}'
        others[pid] = other_project(f.project_raw(), {'d1': f.document_raw()}, pid, f'P{i}')
        services[pid] = [{'service_id': 'igt:assist:fake', 'online': True}]
    joined = [{'id': pid, 'name': others[pid]['project']['name']} for pid in others]
    svc, c, ws, r = reached('igt', joined=joined, others=others, services=services)
    assert len(r.others) == MAX_PROJECTS - 1
    assert r.unavailable == [joined[-1]]


def test_the_service_advertises_the_cap(monkeypatch):
    """The browser shows its "Add project" control only when this is there."""
    from plaid_agent.core import service as service_mod
    svc = service('igt')

    class Args:
        model, api_base, api_key, max_steps, temperature, max_tokens = 'fake/m', None, None, 5, None, None
        no_stream, service_id, service_name, web_search, timeout = False, None, None, None, 120.0
        url = 'http://localhost:8085'

    monkeypatch.setattr(service_mod, 'ping_model', lambda cfg: None)
    svc.setup(Args())
    assert svc.extras['max_projects'] == MAX_PROJECTS


# --- naming a project --------------------------------------------------------------

def test_a_project_resolves_by_id_name_and_unique_prefix():
    svc, c, ws, r = reached('igt')
    assert r.workspace(OTHER_ID).project.id == OTHER_ID
    assert r.workspace('second').project.id == OTHER_ID
    assert r.workspace('Sec').project.id == OTHER_ID
    assert r.workspace('Demo') is ws and r.workspace(None) is ws and r.workspace('') is ws
    assert r.workspace('Second') is r.workspace(OTHER_ID), 'one workspace per project per turn'


def test_an_unknown_project_is_refused_naming_the_ones_there_are():
    svc, c, ws, r = reached('igt')
    with pytest.raises(ToolError) as e:
        r.workspace('Elsewhere')
    assert '"Elsewhere"' in str(e.value) and '"Demo"' in str(e.value) and '"Second"' in str(e.value)


def test_two_projects_with_one_name_are_named_by_id():
    import fixtures as f
    p2 = other_project(f.project_raw(), {'d1': f.document_raw()}, OTHER_ID, 'Demo')
    svc, c, ws, r = reached('igt', others={OTHER_ID: p2})
    assert r.labels() == ['p1', OTHER_ID]
    with pytest.raises(ToolError) as e:
        r.workspace('Demo')
    assert 'p1' in str(e.value) and OTHER_ID in str(e.value)


# --- routing -----------------------------------------------------------------------

def test_routing_without_a_reach_passes_through_untouched():
    c = client('igt')
    svc, ws = home_workspace('igt', c)
    args = {'document': 'Text 1', 'project': 'Second'}
    assert route(ws, 'read_document', args) == (ws, args)


def test_routing_hands_the_named_projects_workspace_and_leaves_the_args_as_written():
    svc, c, ws, r = reached('igt')
    args = {'document': 'Text 1', 'project': 'Second'}
    routed, rest = route(ws, 'read_document', args)
    assert routed.project.id == OTHER_ID and rest == {'document': 'Text 1'}
    assert args == {'document': 'Text 1', 'project': 'Second'}, 'the trace records what the model wrote'


@pytest.mark.parametrize('name', sorted(LOCAL_TOOLS | set(PLAN_TOOLS)))
def test_web_file_code_and_plan_tools_stay_home(name):
    svc, c, ws, r = reached('igt')
    routed, rest = route(ws, name, {'project': 'Second', 'x': 1})
    assert routed is ws and rest == {'x': 1}


@pytest.mark.parametrize('app', APPS)
def test_a_read_tool_reads_the_other_project(app):
    svc, c, ws, r = reached(app)
    call = svc.kit.call_tool if svc.kit else svc.toolkit().call_tool
    out = call(ws, 'list_documents', {'project': 'Second'})
    assert not out.startswith('Error') and out.count('document') == call(ws, 'list_documents', {}).count('document')
    c.reads.clear()
    other = r.workspace('Second')
    other.doc(other.documents()[0]['id'])
    assert reads_in(c, OTHER_ID) and not reads_in(c, c.project['id'])


@pytest.mark.parametrize('app', APPS)
def test_an_unknown_project_is_an_error_sentence(app):
    svc, c, ws, r = reached(app)
    out = svc.toolkit().call_tool(ws, 'list_documents', {'project': 'Elsewhere'})
    assert out.startswith('Error: No project "Elsewhere"')


@pytest.mark.parametrize('app', APPS)
def test_every_call_tool_routes_first(app):
    """The one line each app owes, where both the model's calls and the
    code's plan() come in (see test_guard_coverage.py for the pattern)."""
    import importlib
    toolkit = importlib.import_module(f'plaid_agent.{app}.toolkit')
    src = inspect.getsource(toolkit.call_tool)
    assert 'route(ws, name, args)' in src
    assert src.index('route(ws, name, args)') < src.index('run_tool(')


# --- nothing is staged in another project, on any path ----------------------------

def _write_cases():
    from test_guard_coverage import IGT_ARGS, IGT_OVERRIDES, UD_ARGS, UD_OVERRIDES
    from plaid_agent.igt.toolkit import WRITE_TOOLS as IGT_WRITE
    from plaid_agent.ud.toolkit import WRITE_TOOLS as UD_WRITE
    from plaid_agent.umr.toolkit import WRITE_TOOLS as UMR_WRITE
    umr_args = {'document': 'Story', 'sentence': 1, 'a': 's1b', 'rel': ':before', 'b': 's2r',
                'var': 's1b', 'line': ':aspect state', 'concept': 'buy-01', 'value': 'state',
                'text': '(s1b / buy-01)'}
    # The guideline tools, over each fixture's own manual.
    manual = {'igt': ('Glossing', 'Loanwords'), 'ud': ('Glossing', 'copula'),
              'umr': ('Aspect', 'eventive')}
    cases = []
    for app, names, base, over in (('igt', IGT_WRITE, IGT_ARGS, IGT_OVERRIDES),
                                   ('ud', UD_WRITE, UD_ARGS, UD_OVERRIDES),
                                   ('umr', UMR_WRITE, umr_args, {})):
        title, passage = manual[app]
        over = {**over, 'add_guideline': {'title': 'New', 'body': 'a note'},
                'revise_guideline': {'title': title, 'find': passage, 'replace': 'x'},
                'rewrite_guideline': {'title': title, 'body': 'a note'}}
        for name in sorted(names):
            cases.append((app, name, base, over.get(name, {})))
    return cases


def _args_for(app, name, base, override):
    import importlib
    impl = importlib.import_module(f'plaid_agent.{app}.toolkit')._IMPL[name]
    params = [p for p in inspect.signature(impl).parameters if p != 'ws']
    args = {k: v for k, v in base.items() if k in params}
    args.update(override)
    return args


def _staged(ws, r):
    return len(ws.ops) + sum(len(w.ops) for w in r._workspaces.values())


@pytest.mark.parametrize('app,name,base,override', _write_cases(),
                         ids=[f'{c[0]}-{c[1]}' for c in _write_cases()])
def test_no_write_tool_stages_anything_in_another_project(app, name, base, override):
    """Every plan tool of every app, handed another project, leaves every
    workspace's plan empty. Asserted on the plans rather than on the reply,
    because a tool may refuse its arguments before it reaches the plan; the
    control below says which do reach it, and those must answer with the
    read-only refusal."""
    args = _args_for(app, name, base, override)
    svc, c, ws, r = reached(app)
    kit = svc.toolkit()
    out = kit.call_tool(ws, name, {**args, 'project': OTHER_NAME})
    assert _staged(ws, r) == 0, (name, out)
    svc2, c2, home, r2 = reached(app)
    kit.call_tool(home, name, {**args, 'project': 'Demo' if app == 'igt' else home.project.name})
    if home.ops:
        assert 'plans changes in' in out and f'"{OTHER_NAME}"' in out, (name, out)


@pytest.mark.parametrize('app', APPS)
def test_enough_write_tools_reach_the_plan_at_home_for_the_sweep_to_mean_something(app):
    staged = 0
    cases = [c for c in _write_cases() if c[0] == app]
    for _, name, base, override in cases:
        svc, c, ws, r = reached(app)
        svc.toolkit().call_tool(ws, name, _args_for(app, name, base, override))
        staged += bool(ws.ops)
    assert staged * 2 >= len(cases), f'{staged} of {len(cases)}'


@pytest.mark.parametrize('app', APPS)
def test_add_op_and_add_ops_both_refuse_on_another_project(app):
    svc, c, ws, r = reached(app)
    other = r.workspace(OTHER_NAME)
    for stage in (lambda: other.add_op({'kind': 'x'}), lambda: other.add_ops([{'kind': 'x'}])):
        with pytest.raises(ToolError) as e:
            stage()
        assert str(e.value) == (f'This conversation plans changes in "{ws.project.name}" only. Tell '
                                f'the user what you would change in "{OTHER_NAME}" and let them make '
                                f'it there.')
    assert other.ops == [] and ws.ops == []


@pytest.mark.parametrize('app', APPS)
def test_the_codes_plan_cannot_stage_in_another_project(app):
    """plan() goes through call_tool, and so through route and the refusal."""
    import importlib
    sb = importlib.import_module(f'plaid_agent.{app}.sandbox')
    svc, c, ws, r = reached(app)
    api = sb.api(ws)
    for name, base, override in [(n, b, o) for a, n, b, o in _write_cases() if a == app]:
        api['plan'](name, project=OTHER_NAME, **_args_for(app, name, base, override))
    assert _staged(ws, r) == 0


@pytest.mark.parametrize('app', APPS)
def test_the_codes_reads_take_a_project(app):
    import importlib
    sb = importlib.import_module(f'plaid_agent.{app}.sandbox')
    svc, c, ws, r = reached(app)
    api = sb.api(ws)
    here, there = api['documents'](), api['documents'](project=OTHER_NAME)
    assert [d['name'] for d in here] == [d['name'] for d in there]
    assert [d['id'] for d in here] != [d['id'] for d in there]
    doc = api['load'](there[0]['name'], project=OTHER_NAME)
    assert doc['id'] == there[0]['id']
    with pytest.raises(ValueError):
        api['documents'](project='Elsewhere')


def test_without_a_reach_the_code_reads_its_own_project_only():
    from plaid_agent.igt import sandbox as sb
    c = client('igt')
    svc, ws = home_workspace('igt', c)
    api = sb.api(ws)
    assert api['documents'](project='Demo') == api['documents']()
    with pytest.raises(ValueError):
        api['documents'](project='Second')


def test_code_help_names_the_projects_only_when_there_are_others():
    from plaid_agent.igt.sandbox import t_code_help
    c = client('igt')
    svc, ws = home_workspace('igt', c)
    assert 'OTHER PROJECTS' not in t_code_help(ws)
    svc, c, ws, r = reached('igt')
    assert 'project="<name>"' in t_code_help(ws) and '"Second"' in t_code_help(ws)


def test_closing_the_reach_keeps_the_workspaces_for_the_citations():
    svc, c, ws, r = reached('igt')
    other = r.workspace(OTHER_NAME)
    svc._release(ws)
    assert r.workspace(OTHER_NAME) is other


def test_the_module_names_one_place_for_the_set():
    """reachable() is where the set is decided: Reach is the only caller."""
    import pathlib
    src = pathlib.Path(reach_mod.__file__).parent
    callers = [p.name for p in src.rglob('*.py') if 'reachable(' in p.read_text()]
    assert callers == ['reach.py']
