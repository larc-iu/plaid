"""A number the two apps share lives in `core.limits`, or it drifts.

Each of these was written twice, once per app, and one of the two was raised
and the other was not: a tool answered with a hundred rows in one app and
thirty in the other, and nobody could name the reason. The sweep below reads
the module-level numbers out of both apps and refuses a name that appears in
both unless there is a reason recorded here for the two to differ.
"""

import ast
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
    for app in ('igt', 'ud'):
        text = '\n'.join(p.read_text() for p in (SRC / app).rglob('*.py') if f'\n{name} = ' in p.read_text())
        head = text[:text.index(f'\n{name} = ')]
        assert 'same budget' in head[-400:], f'{app}/{name} does not say why it differs from the other app'


SHARED = ['MAX_SCOPE_DOCS', 'MAX_SENTENCES_PER_READ', 'OVERVIEW_DOCS', 'SAMPLE_LINES',
          'MAX_RESULT_CHARS', 'ROW_LIMIT', 'GROUP_LIMIT', 'READ_LIMITS']


@pytest.mark.parametrize('name', SHARED)
def test_the_shared_numbers_are_core_s_own_object(name):
    """Imported, not copied: a `from ... import X` that was later edited in
    place is the same two homes with an extra step."""
    assert hasattr(limits, name)


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
    out = build_system_prompt(load_project(FakeClient(), 'p1'))
    assert f'the overview shows the first {limits.OVERVIEW_DOCS}' in out
    assert '{overview_docs}' not in out


def test_the_bulk_cap_is_the_plan_cap():
    """IGT called it MAX_BULK and its refusal said "more than the N one plan
    may hold", which is `PLAN_MAX_OPS` under another name."""
    from plaid_agent.core.plan import PLAN_MAX_OPS
    from plaid_agent.igt import bulk
    assert bulk.PLAN_MAX_OPS is PLAN_MAX_OPS
