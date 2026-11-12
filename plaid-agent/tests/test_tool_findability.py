"""A project-wide tool is found where a model chooses (FABLE-REVIEW
2026-11-12, change 2). set_field_for_form was 47th of igt's 65 tools, far
from set_field, the prompt's list of project-wide tools left it out, and in
182 recorded runs it was never called: the four runs of the task written for
it typed 49 references into set_field. Each project-wide tool now comes
straight after the one-item tool it does in bulk, that tool's description
names it, and the prompt's list names every one."""
import pytest

from plaid_agent.core.toolkit import follow
from plaid_agent.igt import prompt as igt_prompt

# The project-wide tool, the one-item tool it does in bulk.
BULK = {
    'igt': {'set_field_for_form': 'set_field', 'set_analysis_for_form': 'set_analysis',
            'copy_to_orthography': 'set_orthography', 'respell_all': 'respell'},
    'ud': {'replace_in_field': 'set_field'},
    'umr': {'set_attribute_for_concept': 'set_attributes'},
}


def _kit(app):
    return __import__(f'plaid_agent.{app}.toolkit', fromlist=['TOOLS'])


@pytest.mark.parametrize('app', sorted(BULK))
def test_each_project_wide_tool_follows_its_one_item_tool_and_is_named_by_it(app):
    tools = {t['function']['name']: t['function'] for t in _kit(app).TOOLS}
    names = list(tools)
    for bulk, one in BULK[app].items():
        assert names.index(bulk) == names.index(one) + 1, (app, bulk, names[names.index(one):][:3])
        assert bulk in tools[one]['description'], (app, one)


def test_igt_keeps_the_field_wide_replace_beside_set_field_too():
    names = [t['function']['name'] for t in _kit('igt').TOOLS]
    assert names[names.index('set_field'):][:3] == ['set_field', 'set_field_for_form', 'replace_in_field']
    desc = next(t['function']['description'] for t in _kit('igt').TOOLS if t['function']['name'] == 'set_field')
    assert 'replace_in_field' in desc


def test_the_igt_prompt_names_every_project_wide_tool():
    line = next(x for x in igt_prompt.SYSTEM.splitlines() if 'project-wide tool' in x)
    for name in ('set_field_for_form', 'replace_in_field', 'set_analysis_for_form', 'respell_all',
                 'copy_to_orthography'):
        assert name in line, name


def test_follow_moves_a_tool_behind_another_and_refuses_a_name_it_lacks():
    def t(n):
        return {'function': {'name': n}}
    out = follow([t('a'), t('b'), t('c'), t('d')], {'d': 'a', 'c': 'd'})
    assert [x['function']['name'] for x in out] == ['a', 'd', 'c', 'b']
    with pytest.raises(ValueError):
        follow([t('a')], {'z': 'a'})
