"""Who the assistant plans a lexicon change for, since a vocabulary belongs to
one project, its home (SPEC "a vocabulary has a home project", section 1.2).

The rights over a lexicon are its home project's roles: a writer of the home
adds entries and changes anything stored on one, a maintainer of it also
renames, merges, deletes and restores them, a reader changes nothing. Another
project may link (borrow) the lexicon: there words link to its entries and no
entry is changed, and the assistant, which reads only the roles of the project
it works in, treats it as read only whoever asks. It acts as the user who
asked, so for anyone else it plans none of these, and says why, rather than
stage a change the server refuses at approval. The same rules over a real core,
under delegated tokens: test_vocab_home_rights_live.py."""

import copy

import pytest
from fixtures import PID, VOCAB, FakeClient, applied, fake_ws, project_raw

from plaid_agent.core.plan import PlanOutOfDate
from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool

USER = 'u@x.org'
# The columns of section 1: a role in the home, or in a project borrowing the
# lexicon (which holds no role in its home, as far as the assistant knows).
COLUMNS = {'HM': ('maintainers', False), 'HW': ('writers', False), 'HR': ('readers', False),
           'BM': ('maintainers', True), 'BW': ('writers', True), 'BR': ('readers', True)}


def _raw(column, user=USER):
    p = project_raw()
    role, borrowed = COLUMNS[column]
    p[role] = [user]
    if borrowed:
        p['vocabs'][0]['project'] = 'p-home'
    return p


def _ws(column=None, admin=False, requester=USER, raw=None):
    c = FakeClient(project=raw or (_raw(column) if column else project_raw()))
    w = fake_ws(c)
    w.requester_id = requester
    w.requester_is_admin = lambda: admin
    return w


MAINTAINER = ('Only a maintainer of "Demo" can rename, merge, delete or restore entries of the lexicon "Lexicon", '
              'and the person you are acting for is not one. Nothing was planned. Tell them a maintainer of that '
              'project has to make this change.')
READER = ('Only a writer or maintainer of "Demo" can change the lexicon "Lexicon", and the person you are acting '
          'for is a reader. Nothing was planned.')
BORROWED = ('The lexicon "Lexicon" belongs to another project and is read only here: words link to its entries, '
            'and no entry is added or changed. Nothing was planned. Tell the user its entries are changed in its '
            'own project, by a writer or maintainer of that project.')

# What only a maintainer of the home may do.
MAINTAINER_CALLS = [
    ('rename_entry', {'entry_form': 'gam', 'entry_gloss': 'net', 'new_form': 'gham'}),
    ('delete_entry', {'entry_form': 'gam', 'entry_gloss': 'net'}),
    ('merge_entries', {'keep_form': 'gam', 'keep_gloss': 'fish', 'remove_form': 'gam', 'remove_gloss': 'net'}),
]
# What a writer of the home may do: an entry, with anything stored on it, and
# every change to what is stored on one.
WRITER_CALLS = [
    ('create_entry', {'form': 'kai'}),
    ('create_entry', {'form': 'kai', 'fields': {'gloss': 'go'}, 'type': 'suffix'}),
    ('create_entry', {'form': 'gam akuna', 'type': 'phrase'}),
    ('set_entry_field', {'entry_form': 'Ali', 'field': 'gloss', 'value': 'Ally'}),
    ('set_entry_field', {'entry_form': 'Ali', 'field': 'morphType', 'value': 'root'}),
    ('senses', {'action': 'add', 'entry_form': 'Ali', 'fields': {'gloss': 'name'}}),
    ('make_sense_of', {'under_id': 'vi-gam', 'entry_id': 'vi-gam2'}),
    ('senses', {'action': 'order_homographs', 'entry_form': 'gam#1', 'order': ['2', '1']}),
    ('senses', {'action': 'promote_example', 'entry_form': 'Ali', 'document': 'Text 1', 'ref': 's1.w1'}),
]
LINK_CALL = ('link_entry', {'document': 'Text 1', 'refs': ['s1.w3'], 'entry_form': 'gam', 'entry_gloss': 'net'})

# Section 1.2 for the assistant: what each column is told, None where it plans.
EXPECTED = {
    'HM': (None, None),
    'HW': (MAINTAINER, None),
    'HR': (MAINTAINER, READER),
    'BM': (BORROWED, BORROWED),
    'BW': (BORROWED, BORROWED),
    'BR': (BORROWED, BORROWED),
}


def _check(w, name, args, said):
    out = call_tool(w, name, args)
    if said is None:
        assert 'Planned' in out and w.ops, (name, args, out)
    else:
        assert said in out, (name, args, out)
        assert w.ops == [] and w.new_entries == {} and w.item_patches == {}, (name, args, out)


@pytest.mark.parametrize('column', list(COLUMNS))
def test_section_one_two_as_the_assistant_plans_it(column):
    on_maintainer, on_writer = EXPECTED[column]
    for name, args in MAINTAINER_CALLS:
        _check(_ws(column), name, args, on_maintainer)
    for name, args in WRITER_CALLS:
        _check(_ws(column), name, args, on_writer)


@pytest.mark.parametrize('column', ['HM', 'HW', 'BM', 'BW'])
def test_a_writer_links_words_to_any_lexicon_the_project_links(column):
    """Linking annotates a document: the link routes take the document's
    project's writers, home or borrower (section 1.3)."""
    _check(_ws(column), *LINK_CALL, None)


def test_an_administrator_and_a_script_plan_everything_in_the_projects_own_lexicon():
    for w in (lambda: _ws(admin=True), lambda: _ws(requester=None)):
        for name, args in MAINTAINER_CALLS + WRITER_CALLS:
            _check(w(), name, args, None)


def test_a_borrowed_lexicon_is_read_only_for_an_administrator_too():
    """The assistant never reads another project's roles, so a lexicon this
    project borrows is changed from its own project, by anyone."""
    for name, args in MAINTAINER_CALLS + WRITER_CALLS:
        _check(_ws('BM', admin=True), name, args, BORROWED)
        _check(_ws('BM', requester=None), name, args, BORROWED)


def test_a_writers_new_entry_carries_its_fields():
    """A home writer sets anything stored on an entry, so a new entry keeps
    the fields and the type it is given, and later ones join it."""
    w = _ws('HW')
    out = call_tool(w, 'create_entry', {'form': 'kai', 'fields': {'gloss': 'go'}, 'type': 'suffix'})
    key = out.split('entry_id: ')[1].split()[0]
    assert 'Planned' in call_tool(w, 'set_entry_field', {'entry_id': key, 'field': 'pos', 'value': 'V'})
    [made] = [op for op in w.ops if op['kind'] == 'create_entry']
    assert made['metadata'] == {'gloss': 'go', 'pos': 'V', 'morphType': 'suffix'}
    assert 'typed_from_form' not in made


def test_the_codes_plan_gets_the_same_refusal():
    """The code's plan() goes through the same funnel as the tools."""
    for column, said in (('HR', READER), ('BW', BORROWED)):
        w = _ws(column)
        with pytest.raises(Exception) as e:
            w.add_op({'kind': 'create_entry', 'vocab_id': VOCAB, 'form': 'kai', 'metadata': {},
                      'key': 'new:x:kai#1', 'label': 'x'})
        assert said in str(e.value)


def test_the_project_carries_each_lexicons_home():
    w = _ws('HW')
    v = w.project.vocabs[0]
    assert (v['project'], v['borrowed']) == (PID, False) and 'maintainers' not in v
    assert _ws('BW').project.vocabs[0]['borrowed'] is True
    assert w.project.roles == {'maintainers': [], 'writers': [USER], 'readers': []}


# --- respelling the lexicon ------------------------------------------------------------

RESPELL = {'lexicon': True, 'pattern': 'g', 'replacement': 'gh', 'morpheme_forms': False}


@pytest.mark.parametrize('column, renamed, note', [
    ('HM', True, None),
    ('HW', False, '2 in "Lexicon". Tell the user.'),
    ('BM', False, '2 in "Lexicon" (another project\'s lexicon). Tell the user.'),
])
def test_a_respelling_renames_only_the_headwords_the_user_may_rename(column, renamed, note):
    w = _ws(column)
    out = call_tool(w, 'respell_all', RESPELL)
    assert bool(applied(w).updates('vocab_items')) is renamed, out
    if note:
        assert ('Headwords left as they are, since only a maintainer of the project a lexicon belongs to can '
                'rename them: ' + note) in out
    else:
        assert 'Headwords left as they are' not in out


def test_a_corpus_wide_respelling_worked_out_at_approval_leaves_them_too():
    # The stored change is worked out again when the user approves it
    # (execute_plan hands resolve_scopes the requester), for the same user, so
    # what was previewed without the renames is applied without them.
    from plaid_agent.igt.bulk import _lexicon_renames
    from plaid_agent.igt.plan import Resolution
    rep = lambda s: s.replace('g', 'gh')  # noqa: E731
    for column, n in (('HW', 0), ('BM', 0), ('HM', 2)):
        w = _ws(column)
        res = Resolution(w.client, w.project, USER).ws
        res.requester_is_admin = lambda: False
        assert [op['kind'] for op in _lexicon_renames(res, rep)] == ['rename_entry'] * n, column


# --- what the assistant is told ----------------------------------------------------------

def test_the_prompt_and_the_overview_mark_a_borrowed_lexicon():
    from plaid_agent.igt.prompt import build_system_prompt
    raw = _raw('HW')
    raw['vocabs'].append({'id': 'v-other', 'name': 'Shared', 'project': 'p-home', 'config': {}})
    w = _ws(raw=raw)
    mark = "Shared (another project's lexicon: read only here, words link to its entries)"
    assert f'- Lexicons: Lexicon, {mark}\n' in build_system_prompt(w.project)
    out = call_tool(w, 'project_overview', {})
    assert mark in out and 'Lexicon (entry fields:' in out


@pytest.mark.parametrize('column, line', [
    ('HM', None),
    ('HW', "The user is a writer here: in this project's own lexicons they may add entries and change what is "
           'stored on them, and only a maintainer of this project renames, merges, deletes or restores entries.'),
    ('HR', 'The user is a reader here: no lexicon entry can be added or changed for them.'),
])
def test_the_overview_says_what_the_user_may_change_in_the_projects_lexicons(column, line):
    out = call_tool(_ws(column), 'project_overview', {})
    if line:
        assert line in out
    else:
        assert 'The user is a' not in out
    assert 'The user is a' not in call_tool(_ws('HW', admin=True), 'project_overview', {})


# --- a plan approved after the lexicon moved, was unlinked, or the role changed ---------

def _approve(w, raw, requester=USER):
    """Approval as the service runs it: the project read again, as it is now."""
    from plaid_agent.igt.plan import execute_plan
    c = FakeClient(project=raw)
    c.calls.clear()
    execute_plan(c, w.plan_payload()['ops'], source='s', label='l', project=load_project(c, PID),
                 requester=requester)
    return c


@pytest.mark.parametrize('name, args', [MAINTAINER_CALLS[0], WRITER_CALLS[1], WRITER_CALLS[3]])
def test_a_plan_whose_lexicon_moved_to_another_project_is_out_of_date(name, args):
    w = _ws('HM')
    call_tool(w, name, args)
    moved = _raw('HM')
    moved['vocabs'][0]['project'] = 'p-new-home'
    with pytest.raises(PlanOutOfDate) as e:
        _approve(w, moved)
    assert e.value.reasons == ['the lexicon "Lexicon" now belongs to another project and is read only here']


def test_a_plan_whose_user_lost_the_role_it_needs_is_out_of_date():
    w = _ws('HM')
    call_tool(w, *MAINTAINER_CALLS[2])
    with pytest.raises(PlanOutOfDate) as e:
        _approve(w, _raw('HW'))
    assert e.value.reasons == ['only a maintainer of this project can rename, merge, delete or restore entries of '
                               'the lexicon "Lexicon"']
    w = _ws('HW')
    call_tool(w, *WRITER_CALLS[3])
    with pytest.raises(PlanOutOfDate) as e:
        _approve(w, _raw('HR'))
    assert e.value.reasons == ['only a writer or maintainer of this project can change the lexicon "Lexicon"']
    # Still held: applied.
    _approve(w, _raw('HW'))


def test_a_link_into_a_lexicon_no_longer_linked_here_is_out_of_date():
    w = _ws('BW')
    call_tool(w, *LINK_CALL)
    gone = _raw('BW')
    gone['vocabs'] = []
    with pytest.raises(PlanOutOfDate) as e:
        _approve(w, gone)
    assert e.value.reasons == ['a lexicon this plan links words to is no longer linked to this project']


@pytest.mark.parametrize('own_lexicon', [False, True])
def test_a_link_into_a_lexicon_whose_home_ended_the_borrowing_is_out_of_date_for_that_reason(own_lexicon):
    # The home's maintainer ended the borrowing: the entry is still there,
    # but a delegated token, scoped to this project, is refused its read
    # (403), as core refuses any entry the token cannot reach. The reason is
    # the unlinking, never "deleted or merged away", whether or not the
    # project still has a lexicon of its own.
    from plaid_client import PlaidAPIError
    from plaid_agent.igt.plan import execute_plan
    w = _ws('BW')
    call_tool(w, *LINK_CALL)
    gone = _raw('BW')
    own = copy.deepcopy(gone['vocabs'][0])
    gone['vocabs'] = [{**own, 'id': 'v-own', 'name': 'Own', 'project': PID}] if own_lexicon else []
    c = FakeClient(project=gone)
    c.fails['vocab_items.get'] = PlaidAPIError('Forbidden', status=403)
    with pytest.raises(PlanOutOfDate) as e:
        execute_plan(c, w.plan_payload()['ops'], source='s', label='l', project=load_project(c, PID),
                     requester=USER)
    assert e.value.reasons == ['a lexicon this plan links words to is no longer linked to this project']
    assert not [k for k, _ in c.calls if k not in ('read', 'lock', 'unlock')], 'nothing is written'


def test_a_plan_still_within_the_users_rights_applies():
    for column, call in (('HM', MAINTAINER_CALLS[0]), ('HW', WRITER_CALLS[3]), ('BW', LINK_CALL)):
        w = _ws(column)
        call_tool(w, *call)
        _approve(w, _raw(column))


# --- tagsets on a lexicon's fields --------------------------------------------------------

TAGSET = {'action': 'edit', 'tagset': 'POS', 'lexicon': 'Lexicon', 'changes': {'add': ['n']}}


@pytest.mark.parametrize('column, said', [
    ('HM', None),
    ('HW', 'Only a maintainer of this project may change the tagsets of the lexicon "Lexicon", and the user is '
           'not one.'),
    ('BM', 'The lexicon "Lexicon" belongs to another project, and its tagsets are changed there, by a maintainer '
           'of that project. Nothing was planned.'),
])
def test_a_lexicons_tagsets_are_its_own_projects_maintainers(column, said):
    w = _ws(column)
    out = call_tool(w, 'tagsets', TAGSET)
    if said is None:
        assert 'Planned' in out and w.ops, out
    else:
        assert said in out and w.ops == [], out


def test_approving_a_lexicons_tagsets_asks_its_own_project():
    from plaid_agent.igt.service import AssistantService
    svc = AssistantService.__new__(AssistantService)
    ops = [{'kind': 'set_tagset', 'owner': VOCAB, 'was': None, 'name': 'POS'}]
    home = _raw('HM')
    c = FakeClient(project=home)
    assert svc.may_approve(c, PID, USER, ops) is None
    c = FakeClient(project=_raw('HW'))
    assert svc.may_approve(c, PID, USER, ops) == ('Only a maintainer of the project the lexicon "Lexicon" belongs '
                                                  'to may approve changes to its tagsets. Nothing was written.')


# --- the registry ------------------------------------------------------------------------

def _entry_op(kind, item_id):
    from plaid_agent.igt.plan import KIND
    spec = KIND[kind]
    keys = spec.extra.get('removes_entry') or spec.at
    return {'kind': kind, **{k: item_id for k in spec.at}, **{k: item_id for k in keys}}


def test_every_kind_placed_at_an_entry_declares_what_it_needs():
    from plaid_agent.core import opkind
    from plaid_agent.igt.plan import ENTRY, KIND, lexicon_need
    kinds = opkind.located_at(KIND, ENTRY)
    needs = {k: lexicon_need(_entry_op(k, 'vi-gam'))[0] for k in kinds}
    assert needs == {'rename_entry': 'maintainer', 'delete_entry': 'maintainer', 'merge_entries': 'maintainer',
                     'set_entry_field': 'writer', 'set_entry_metadata': 'writer'}
    assert lexicon_need({'kind': 'create_entry', 'vocab_id': VOCAB}) == ('writer', VOCAB, None)
    assert lexicon_need({'kind': 'link', 'token_id': 't', 'item_id': 'vi-gam'}) is None


def test_a_new_kind_placed_at_an_entry_is_a_maintainers_until_declared(monkeypatch):
    from plaid_agent.core.opkind import OpKind
    from plaid_agent.igt import plan
    monkeypatch.setitem(plan.KIND, 'order_homographs', OpKind(
        'order_homographs', ('homograph order', 'homograph orders'), replaces=None, required=('item_id',),
        apply=lambda *a: None, at=('item_id',), at_kind=plan.ENTRY))
    assert plan.lexicon_need({'kind': 'order_homographs', 'item_id': 'vi-gam'}) == ('maintainer', None, 'vi-gam')
    w = _ws('HW')
    with pytest.raises(Exception) as e:
        w.add_op({'kind': 'order_homographs', 'item_id': 'vi-gam', 'label': 'x'})
    assert MAINTAINER in str(e.value)


def test_every_plan_tool_holds_the_line():
    """The sweep, over every plan tool: whatever a home maintainer's call
    stages that needs a right over the lexicon, a home writer's same call stages
    only what a writer may, and a borrower's none of it. Asked of the ops,
    through the one rule, so a tool added later is covered without a line
    here."""
    from test_guard_coverage import IGT_ARGS, IGT_OVERRIDES
    from plaid_agent.igt.plan import lexicon_need
    from plaid_agent.igt.toolkit import WRITE_TOOLS, _IMPL
    import inspect
    reached = 0
    for name in sorted(WRITE_TOOLS):
        params = [p for p in inspect.signature(_IMPL[name]).parameters if p != 'ws']
        args = {k: v for k, v in IGT_ARGS.items() if k in params}
        args.update(IGT_OVERRIDES.get(name, {}))
        mine = _ws('HM')
        call_tool(mine, name, copy.deepcopy(args))
        if not any(lexicon_need(op) for op in mine.ops):
            continue
        reached += 1
        writer = _ws('HW')
        out = call_tool(writer, name, copy.deepcopy(args))
        assert not any((lexicon_need(op) or ('',))[0] == 'maintainer' for op in writer.ops), (name, out)
        borrower = _ws('BM')
        out = call_tool(borrower, name, copy.deepcopy(args))
        assert not any(lexicon_need(op) for op in borrower.ops), (name, out)
        assert BORROWED in out or borrower.ops, (name, out)
    assert reached >= 6, reached


def test_the_settings_kinds_are_the_kinds_the_registry_tags_as_settings():
    from plaid_agent.igt.plan import KIND, SETTINGS_KINDS
    assert set(SETTINGS_KINDS) == {'set_tagset', 'assign_tagset'}
    assert all(KIND[k].stage == 'app' for k in SETTINGS_KINDS)
