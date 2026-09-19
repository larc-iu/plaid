"""A number the two apps share lives in `core.limits`, or it drifts.

Each of these was written twice, once per app, and one of the two was raised
and the other was not: a tool answered with a hundred rows in one app and
thirty in the other, and nobody could name the reason. The sweep below reads
the module-level numbers out of both apps and refuses a name that appears in
both unless there is a reason recorded here for the two to differ.
"""

import ast
import json
import collections
import pathlib

import pytest

from plaid_agent.core import limits

SRC = pathlib.Path(__file__).resolve().parent.parent / 'src' / 'plaid_agent'

# A name each app sets for itself, with WHY the two numbers differ. Anything
# else the two apps both name is a number with two homes: put it in
# `core.limits` and read it from there, or give the two different names.
DELIBERATELY_PER_APP = {
    'RENDER_DOC_BUDGET': 'a hit renders as a block of lines in IGT and as one KWIC line in UD',
}


def _module_numbers(app: str):
    out = collections.defaultdict(dict)
    for path in sorted((SRC / app).rglob('*.py')):
        for node in ast.parse(path.read_text()).body:
            targets = (node.targets if isinstance(node, ast.Assign)
                       else [node.target] if isinstance(node, ast.AnnAssign) else [])
            for target in targets:
                if not isinstance(target, ast.Name):
                    continue
                try:
                    value = ast.literal_eval(node.value)
                except Exception:  # noqa: BLE001 - anything not a literal is not a number
                    continue
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    out[target.id] = (value, path.name)
    return out


def test_no_number_has_a_home_in_both_apps():
    igt, ud = _module_numbers('igt'), _module_numbers('ud')
    assert igt and ud, 'the sweep is green on an empty reading without this'
    shared = set(igt) & set(ud)
    assert shared == set(DELIBERATELY_PER_APP), (
        'a number is set in both apps: ' + ', '.join(sorted(shared - set(DELIBERATELY_PER_APP)))
        + '. Put it in core.limits, or say here why the two differ.')


@pytest.mark.parametrize('name', sorted(DELIBERATELY_PER_APP))
def test_a_number_the_apps_set_apart_says_so_where_it_is_set(name):
    """A reason recorded only in this test is a reason nobody reads. It has to
    be beside the number too."""
    for app in ('igt', 'ud', 'umr'):
        text = '\n'.join(p.read_text() for p in (SRC / app).rglob('*.py') if f'\n{name} = ' in p.read_text())
        head = text[:text.index(f'\n{name} = ')]
        assert 'same budget' in head[-400:], f'{app}/{name} does not say why it differs from the other app'


# What each read needs before it will get as far as reading its limit. The
# tools are READ_LIMITS' own, so a new entry there joins this sweep and has to
# say how to call it in both apps.
CALLABLE = {
    'igt': {'list_documents': {}, 'search': {'pattern': 'gam'}, 'frequency_list': {},
            'worklist': {}, 'comments': {}, 'recent_changes': {}},
    # UD's corpus-wide branches go through the query engine, which the fake
    # client does not answer, so each of those is asked of one document.
    'ud': {'list_documents': {}, 'search': {'field': 'lemma', 'pattern': 'mar', 'document': 'Viaje'},
           'frequency_list': {'what': 'lemma', 'document': 'Viaje'}, 'worklist': {'document': 'Viaje'},
           'comments': {'document': 'Viaje'}, 'recent_changes': {}},
    # The same for UMR: its counts go through the engine except the attribute
    # ones, which are metadata it does not index, so that is the branch this
    # asks for.
    'umr': {'list_documents': {}, 'search': {'pattern': 'dog', 'document': 'Story'},
            'frequency_list': {'what': 'attribute', 'document': 'Story'},
            'worklist': {'document': 'Story'}, 'comments': {'document': 'Story'},
            'recent_changes': {}},
}
# A read the fake client cannot answer, with why. Its signature is swept below
# like every other.
NOT_CALLED = {'query': 'the fixture project has no query engine, so the tool refuses before it reads a limit'}


def _ws_and_call(app):
    import sys
    sys.path.insert(0, 'tests')
    if app == 'igt':
        from fixtures import project_raw, document_raw, lexicon_raw
        from fixtures_ext import ExtClient
        from plaid_agent.igt.project import load_project
        from plaid_agent.igt.toolkit import call_tool
        from plaid_agent.igt.workspace import Workspace
        c = ExtClient(project=project_raw(), documents={'d1': document_raw()}, lexicon=lexicon_raw())
        w = Workspace(c, load_project(c, 'p1'))
        w.prefer_scan = True
        return w, call_tool
    if app == 'ud':
        from ud_fixtures import PID, ExtClient, project_raw, document_raw
        from plaid_agent.ud.project import load_project
        from plaid_agent.ud.toolkit import call_tool
        from plaid_agent.ud.tools import Workspace
        c = ExtClient(project=project_raw(), documents={'ud1': document_raw()})
        return Workspace(c, load_project(c, PID)), call_tool
    from umr_fixtures import PID, ExtClient, project_raw, document_raw
    from plaid_agent.umr.project import load_project
    from plaid_agent.umr.toolkit import call_tool
    from plaid_agent.umr.tools import Workspace
    c = ExtClient(project=project_raw(), documents={'umr1': document_raw()})
    return Workspace(c, load_project(c, PID)), call_tool


def _impl(app, tool):
    mod = __import__(f'plaid_agent.{app}.toolkit', fromlist=['_IMPL'])
    return mod._IMPL[tool]


@pytest.mark.parametrize('app', ['igt', 'ud', 'umr'])
@pytest.mark.parametrize('tool', sorted(limits.READ_LIMITS))
def test_a_read_asked_for_nothing_shows_what_the_shared_table_says(app, tool):
    """`clamp_limit` reaches the table's default only when the tool was given
    NO limit, and five IGT signatures supplied their own: the same question
    answered with a hundred rows in one app and thirty in the other, with the
    schema announcing thirty in both. The signature says None now, so the
    table is the only home for the number.
    """
    import importlib
    import inspect
    default, cap = limits.READ_LIMITS[tool]
    fn = _impl(app, tool)
    assert inspect.signature(fn).parameters['limit'].default is None, \
        f'{app}.{tool} supplies its own default, so the shared one is never read'
    if tool in NOT_CALLED:
        return
    ws, call = _ws_and_call(app)
    mod = importlib.import_module(fn.__module__)
    real, seen = mod.clamp_limit, []

    def spy(raw, d, c, name='limit'):
        out = real(raw, d, c, name)
        if name == 'limit':
            seen.append(out)
        return out

    mod.clamp_limit = spy
    try:
        answer = call(ws, tool, dict(CALLABLE[app][tool]))
    finally:
        mod.clamp_limit = real
    assert not answer.startswith('Error:'), f'{app}.{tool}: {answer[:120]}'
    assert seen, f'{app}.{tool} never read a limit, so this proves nothing'
    assert seen[0] == default, f'{app}.{tool} shows {seen[0]} rows where the table says {default}'


def test_the_sweep_covers_every_shared_read():
    """A tool left out of both tables above would be swept by neither."""
    for app, table in CALLABLE.items():
        assert set(table) | set(NOT_CALLED) == set(limits.READ_LIMITS), app


def test_both_apps_cap_a_scope_and_a_read_at_the_same_number():
    from plaid_agent.igt import tools as igt_tools
    from plaid_agent.igt import project as igt_project
    from plaid_agent.ud import tools as ud_tools
    assert igt_tools.MAX_SCOPE_DOCS is limits.MAX_SCOPE_DOCS
    assert ud_tools.MAX_SCOPE_DOCS is limits.MAX_SCOPE_DOCS
    assert ud_tools.MAX_SENTENCES_PER_READ is limits.MAX_SENTENCES_PER_READ
    assert igt_project.MAX_SENTENCES_PER_READ is limits.MAX_SENTENCES_PER_READ
    assert igt_project.OVERVIEW_DOCS is limits.OVERVIEW_DOCS
    assert ud_tools.OVERVIEW_DOCS is limits.OVERVIEW_DOCS


def test_the_prompt_says_how_many_documents_the_overview_really_shows():
    """Written out as a word, the IGT prompt promised the model a hundred
    documents for as long as the overview showed fifty. It reads the number
    now, and no placeholder survives assembly."""
    import sys
    sys.path.insert(0, 'tests')
    from fixtures import FakeClient
    from plaid_agent.igt.project import load_project
    from plaid_agent.igt.prompt import build_system_prompt
    from plaid_agent.igt.toolkit import TOOLS
    out = build_system_prompt(load_project(FakeClient(), 'p1'))
    # The cap moved out of the system prompt and onto project_overview itself,
    # which is the tool that enforces it. What matters is that the model is
    # told the number somewhere it will read, not which half of the request
    # carries it.
    seen = out + ' '.join(t['function']['description'] for t in TOOLS)
    assert f'the first {limits.OVERVIEW_DOCS} by name' in seen
    assert '{overview_docs}' not in seen


def test_the_bulk_cap_is_the_plan_cap():
    """IGT called it MAX_BULK and its refusal said "more than the N one plan
    may hold", which is `PLAN_MAX_OPS` under another name."""
    from plaid_agent.core.plan import PLAN_MAX_OPS
    from plaid_agent.igt import bulk
    assert bulk.PLAN_MAX_OPS is PLAN_MAX_OPS
