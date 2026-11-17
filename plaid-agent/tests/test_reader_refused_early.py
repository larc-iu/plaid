"""A Reader of the project is refused at the first change the assistant would
stage for them, whatever it writes, with who may (2026-11-17 survey, an S2: a
non-maintainer's 236 sense changes were planned and all refused only at the
end). The lexicon's own rights were refused early since 8b5c3303f; a value, a
text edit, a comment or a document for a Reader went through to approval,
where core refused it. One rule in core (``BaseWorkspace.refuse_reader``),
for every app: igt reads the role from the project it loaded, ud and umr from
the project read once. Role names are the page's: Reader, Writer,
Maintainer."""

import pytest

from fixtures import FakeClient, fake_ws, project_raw
from plaid_agent.igt.toolkit import call_tool

USER = 'u@x.org'
READER = ('Only a Writer or Maintainer of "Demo" can change anything in it, and the person you are acting for is '
          'a Reader. Nothing was planned. Tell them a Writer or Maintainer of that project has to make this change.')

IGT_CALLS = [
    ('set_field', {'document': 'Text 1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'fish'}),
    ('retype_sentence', {'document': 'Text 1', 'ref': 's2', 'text': 'Gam-ar ka.'}),
    ('add_comment', {'document': 'Text 1', 'ref': 's1', 'body': 'Check this.'}),
    ('create_entry', {'form': 'kai'}),
    ('set_entry_field', {'entry_form': 'Ali', 'field': 'gloss', 'value': 'Ally'}),
    ('senses', {'action': 'add', 'entry_form': 'Ali', 'fields': {'gloss': 'name'}}),
]


def _ws(role, admin=False):
    p = project_raw()
    p[role] = [USER]
    w = fake_ws(FakeClient(project=p))
    w.requester_id = USER
    w.requester_is_admin = lambda: admin
    return w


@pytest.mark.parametrize('name,args', IGT_CALLS, ids=[c[0] for c in IGT_CALLS])
def test_a_reader_is_refused_at_the_first_change(name, args):
    w = _ws('readers')
    out = call_tool(w, name, args)
    assert out == f'Error: {READER}', out
    assert w.ops == []


@pytest.mark.parametrize('name,args', IGT_CALLS, ids=[c[0] for c in IGT_CALLS])
def test_a_writer_and_an_administrator_reader_plan_it(name, args):
    for w in (_ws('writers'), _ws('readers', admin=True)):
        out = call_tool(w, name, args)
        assert 'Planned' in out and w.ops, (name, out)


def test_a_reader_in_ud_is_refused_too():
    from ud_fixtures import ud_client, project_raw as ud_project
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.toolkit import call_tool as ud_call
    from plaid_agent.ud.tools import Workspace
    for role, refused in (('readers', True), ('writers', False)):
        p = ud_project()
        p[role] = [USER]
        c = ud_client(project=p)
        w = Workspace(c, load_project(c, p['id']))
        w.requester_id = USER
        w.requester_is_admin = lambda: False
        out = ud_call(w, 'set_field', {'document': 'Viaje', 'refs': ['s1.w1'], 'field': 'upos', 'value': 'NOUN'})
        if refused:
            assert out == ('Error: Only a Writer or Maintainer of "Spanish" can change anything in it, and the '
                           'person you are acting for is a Reader. Nothing was planned. Tell them a Writer or '
                           'Maintainer of that project has to make this change.'), out
            assert w.ops == []
        else:
            assert 'Planned' in out, out


def test_the_reader_refusal_comes_first_and_before_a_corpus_wide_scan():
    """REV-SVB-10: refused where a plan tool is dispatched, before the tool
    reads anything: before a sentence's changed numbers are asked about, and
    before a corpus-wide change queries the corpus. Help still answers."""
    w = _ws('readers')
    w.read_before = {'d1': {'1': 'changed'}}
    out = call_tool(w, 'set_field', {'document': 'Text 1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'x'})
    assert out == f'Error: {READER}', out
    w.client.calls.clear()
    out = call_tool(w, 'replace_in_field', {'field': 'Gloss', 'pattern': 'Ali', 'replacement': 'Aly'})
    assert out == f'Error: {READER}', out
    assert not [k for k, _ in w.client.calls if k in ('query', 'read')], w.client.calls
    assert not call_tool(w, 'senses', {'action': 'help'}).startswith('Error')
