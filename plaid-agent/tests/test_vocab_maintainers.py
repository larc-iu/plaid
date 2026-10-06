"""Renaming, deleting and merging a lexicon's entries is for its maintainers
(ruling acl-shared-vocab-writers b). The assistant acts as the user who asked,
so for a writer who does not maintain the lexicon it plans none of them, and
says why, rather than stage a change the server refuses at approval."""

from fixtures import scan_ws, FakeClient, project_raw, VOCAB

from plaid_agent.igt.toolkit import call_tool


def _ws(maintainers, requester='writer@x.org', admin=False):
    p = project_raw()
    p['vocabs'][0]['maintainers'] = maintainers
    c = FakeClient(project=p)
    w = scan_ws(c)
    w.requester_id = requester
    w._requester_admin = admin
    return w


REFUSED = 'Only a maintainer of the lexicon "Lexicon" can change its existing entries'
CALLS = [
    ('rename_entry', {'entry_form': 'gam', 'entry_gloss': 'net', 'new_form': 'gham'}),
    ('delete_entry', {'entry_form': 'gam', 'entry_gloss': 'net'}),
    ('merge_entries', {'keep_form': 'gam', 'keep_gloss': 'fish', 'remove_form': 'gam', 'remove_gloss': 'net'}),
]


def test_a_writer_is_told_a_maintainer_has_to_rename_delete_or_merge():
    w = _ws(['owner@x.org'])
    for name, args in CALLS:
        assert REFUSED in call_tool(w, name, args), name
    assert w.ops == []


def test_a_maintainer_and_an_administrator_plan_them():
    for w in (_ws(['writer@x.org']), _ws([], admin=True), _ws([], requester=None)):
        for name, args in CALLS[:2]:
            assert 'Planned' in call_tool(w, name, args), name
            call_tool(w, 'discard_plan', {})
        assert 'Planned' in call_tool(w, *CALLS[2])


def test_a_respelling_leaves_the_headwords_of_a_lexicon_the_writer_does_not_maintain():
    w = _ws(['owner@x.org'])
    out = call_tool(w, 'respell_all', {'pattern': 'g', 'replacement': 'gh', 'morpheme_forms': False})
    assert all(op['kind'] != 'rename_entry' for op in w.ops)
    assert 'Headwords left as they are, since only a maintainer of their lexicon can rename them' in out
    assert '"Lexicon"' in out
    mine = _ws(['writer@x.org'])
    out = call_tool(mine, 'respell_all', {'pattern': 'g', 'replacement': 'gh', 'morpheme_forms': False})
    assert any(op['kind'] == 'rename_entry' for op in mine.ops)
    assert 'Headwords left as they are' not in out


def test_a_corpus_wide_respelling_worked_out_at_approval_leaves_them_too():
    # The stored change is worked out again when the user approves it
    # (execute_plan hands resolve_scopes the requester), for the same user, so
    # what was previewed without the renames is applied without them.
    from plaid_agent.igt.bulk import _lexicon_renames
    from plaid_agent.igt.plan import Resolution
    w = _ws(['owner@x.org'])
    rep = lambda s: s.replace('g', 'gh')  # noqa: E731
    writer = Resolution(w.client, w.project, 'writer@x.org').ws
    writer._requester_admin = False
    assert writer.requester_id == 'writer@x.org' and _lexicon_renames(writer, rep) == []
    owner = Resolution(w.client, w.project, 'owner@x.org').ws
    assert [op['kind'] for op in _lexicon_renames(owner, rep)] == ['rename_entry'] * 2


def test_the_project_carries_each_lexicons_maintainers():
    w = _ws(['a@x.org', 'b@x.org'])
    assert next(v for v in w.project.vocabs if v['id'] == VOCAB)['maintainers'] == ['a@x.org', 'b@x.org']


# --- the app's line, every entry write (ruling A1-IGT-6) -----------------------------

ENTRY_CALLS = [
    ('set_entry_field', {'entry_form': 'Ali', 'field': 'gloss', 'value': 'Ally'}),
    ('set_entry_field', {'entry_form': 'Ali', 'field': 'morphType', 'value': 'root'}),
    ('add_sense', {'entry_form': 'Ali', 'fields': {'gloss': 'name'}}),
    ('make_sense_of', {'under_id': 'vi-gam', 'entry_id': 'vi-gam2'}),
    ('order_homographs', {'entry_form': 'gam#1', 'order': ['2', '1']}),
    ('promote_example', {'entry_form': 'Ali', 'document': 'Text 1', 'ref': 's1.w1'}),
]


def test_a_writer_cannot_restructure_or_edit_an_entry_that_exists():
    """The app gives writers no way to edit an entry, add a sense or move one
    (the entry editor and the sense tree are a maintainer's), so neither does
    the assistant, though the server would take them."""
    for name, args in ENTRY_CALLS:
        w = _ws(['owner@x.org'])
        out = call_tool(w, name, args)
        assert REFUSED in out and w.ops == [] and w.new_entries == {} and w.item_patches == {}, (name, out)
        mine = _ws(['writer@x.org'])
        assert 'Planned' in call_tool(mine, name, args) and mine.ops, name


def test_a_writer_still_creates_entries_and_links_words_to_them():
    w = _ws(['owner@x.org'])
    out = call_tool(w, 'create_entry', {'form': 'kai', 'fields': {'gloss': 'go'}})
    assert 'Planned' in out
    key = out.split('entry_id: ')[1].split()[0]
    assert 'Planned' in call_tool(w, 'set_entry_field', {'entry_id': key, 'field': 'pos', 'value': 'V'})
    assert 'Planned' in call_tool(w, 'link_entry', {'document': 'Text 1', 'refs': ['s1.w3'], 'entry_id': key})
    assert 'Planned' in call_tool(w, 'link_entry', {'document': 'Text 1', 'refs': ['s1.w3'],
                                                    'entry_form': 'gam', 'entry_gloss': 'net'})
    assert REFUSED not in ' '.join(op.get('label', '') for op in w.ops)


def test_every_plan_tool_holds_the_line():
    """The sweep, over every plan tool: whatever a maintainer's call stages
    that only a maintainer may, a writer's same call is refused and stages
    nothing. Asked of the ops, through the one rule, so a tool added later is
    covered without a line here."""
    from test_guard_coverage import IGT_ARGS, IGT_OVERRIDES
    from plaid_agent.igt.toolkit import WRITE_TOOLS, _IMPL
    import inspect
    reached = 0
    for name in sorted(WRITE_TOOLS):
        params = [p for p in inspect.signature(_IMPL[name]).parameters if p != 'ws']
        args = {k: v for k, v in IGT_ARGS.items() if k in params}
        args.update(IGT_OVERRIDES.get(name, {}))
        mine = _ws(['writer@x.org'])
        call_tool(mine, name, args)
        if not any(mine.lexicon_maintained_by(op) for op in mine.ops):
            continue
        reached += 1
        w = _ws(['owner@x.org'])
        out = call_tool(w, name, args)
        # Refused, or (a respelling) planned without what it may not do.
        assert not any(w.lexicon_maintained_by(op) for op in w.ops), (name, out)
        assert REFUSED in out or w.ops, (name, out)
    assert reached >= 6, reached
