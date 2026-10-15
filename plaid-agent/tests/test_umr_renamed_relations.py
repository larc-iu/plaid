"""A relation UMR 2.0 renamed is refused with its new name.

The UMR 2.0 release renamed ``:poss`` to ``:possessor`` (and ``:location`` to
``:place``), but its fieldwork graphs and the guidelines still write the old
name, so an assistant reading such a document writes ``:poss`` too. The app
refuses a new ``:poss`` and keeps a stored one, and so does the assistant.
The refusal says why rather than calling the relation unknown to UMR, which
the document in front of the model seems to contradict (bench
umr-hard-mixed-path).
"""

from umr_fixtures import SENTENCE_1_PENMAN, umr_client, umr_ws

from plaid_agent.umr.toolkit import call_tool
from plaid_client.workflows.umr.inventory import (RENAMED_RELATIONS, is_known_relation,
                                                  unknown_relation_problem)


def test_every_new_name_is_a_relation_and_no_old_one_is():
    for old, new in RENAMED_RELATIONS.items():
        assert is_known_relation(new)
        assert not is_known_relation(old)


def test_the_refusal_names_the_new_name_and_its_inverse():
    assert unknown_relation_problem(':poss') == (
        "Unknown relation ':poss': UMR 2.0 renamed it :possessor.")
    assert unknown_relation_problem(':poss-of') == (
        "Unknown relation ':poss-of': UMR 2.0 renamed it :possessor-of.")
    assert 'renamed it :place' in unknown_relation_problem(':location')
    assert 'Did you mean :possessor?' in unknown_relation_problem(':posessor')


def test_apply_penman_refuses_a_new_poss_with_the_new_name():
    ws = umr_ws(umr_client())
    out = call_tool(ws, 'apply_penman', {
        'document': 'Story', 'sentence': 1,
        'text': SENTENCE_1_PENMAN.replace(':aspect performance',
                                          ':aspect performance\n    :poss (s1x / person)')})
    assert "s1b: Unknown relation ':poss': UMR 2.0 renamed it :possessor." in out
    assert ws.ops == []


def test_a_stored_poss_edge_restated_unchanged_is_not_judged_again():
    """The Kukama texts store :poss (kukama_umr-0002 s9, s10, s12, s13). A
    graph restated with one of them unchanged plans its other change, and
    the stored edge is left as it is: only an edge the text adds or changes
    is judged. (The two bench refusals, umr-hard-mixed-path r3 and
    umr-draft-negated r3 of build-q38-1, each added a new :poss: s14p2 held no
    possessor, and the setup deletes s13's graph.)"""
    from umr_fixtures import document_raw
    raw = document_raw()
    rel_layer = next(rl for tl in raw['text_layers'][0]['token_layers']
                     for sl in tl.get('span_layers', [])
                     for rl in sl.get('relation_layers', []) if rl['id'] == 'm-rel')
    next(r for r in rel_layer['relations'] if r['id'] == 'mr-1')['value'] = ':poss'
    ws = umr_ws(umr_client(documents={'umr1': raw}))
    stored = '(s1b / bark-01\n    :poss (s1d / dog\n        :refer-number singular)\n    :aspect performance)'
    out = call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1,
                                         'text': stored.replace(':aspect performance', ':aspect state')})
    assert [op['kind'] for op in ws.ops] == ['set_attrs'], out
    # A second :poss beside it is new, and refused with the new name.
    ws.ops.clear()
    out = call_tool(ws, 'apply_penman', {'document': 'Story', 'sentence': 1, 'text': stored.replace(
        ':aspect performance', ':aspect performance\n    :poss (s1x / person)')})
    assert "Unknown relation ':poss': UMR 2.0 renamed it :possessor." in out and ws.ops == []
