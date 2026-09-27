"""A citation into another project the turn may read: resolved in that
project's workspace, and carrying its id so the tab links it there."""

import sys

import pytest

sys.path.insert(0, 'tests')

from multi_fixtures import OTHER_ID, OTHER_NAME, client, home_workspace, reached  # noqa: E402

APPS = ('igt', 'ud', 'umr')
DOC = {'igt': 'Text 1', 'ud': 'Viaje', 'umr': 'Story'}


@pytest.mark.parametrize('app', APPS)
def test_a_citation_into_another_project_carries_its_id(app):
    svc, c, ws, r = reached(app)
    there = svc.citations(ws, f'<cite project="{OTHER_NAME}" doc="{DOC[app]}" ref="s1"/>')
    here = svc.citations(ws, f'<cite doc="{DOC[app]}" ref="s1"/>')
    named_home = svc.citations(ws, f'<cite project="{ws.project.name}" doc="{DOC[app]}" ref="s1"/>')
    assert [x['project_id'] for x in there] == [OTHER_ID]
    assert there[0]['document_id'] != here[0]['document_id']
    assert 'project_id' not in here[0] and 'project_id' not in named_home[0]
    assert {k: v for k, v in there[0].items() if k not in ('key', 'project_id', 'document_id')} == \
        {k: v for k, v in here[0].items() if k not in ('key', 'document_id')}


@pytest.mark.parametrize('app', APPS)
def test_a_citation_into_an_unknown_project_is_dropped(app):
    svc, c, ws, r = reached(app)
    assert svc.citations(ws, f'<cite project="Elsewhere" doc="{DOC[app]}" ref="s1"/>') == []
    c1 = client(app)
    svc1, ws1 = home_workspace(app, c1)
    assert svc1.citations(ws1, f'<cite project="{OTHER_NAME}" doc="{DOC[app]}" ref="s1"/>') == []


def test_a_tag_naming_another_project_must_name_its_document():
    svc, c, ws, r = reached('igt')
    ws.doc('Text 1')
    assert svc.citations(ws, f'<cite project="{OTHER_NAME}" ref="s1"/>') == []
    assert len(svc.citations(ws, '<cite ref="s1"/>')) == 1
