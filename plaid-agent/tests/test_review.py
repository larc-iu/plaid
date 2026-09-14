"""Work awaiting review: a contributor's unreviewed annotations are shown,
listed, and confirmable next to unconfirmed machine output, and never
discarded as if they were a machine's."""

from fixtures import scan_ws
from fixtures_ext import ExtClient, contributed_document_raw, ANN, BOB

from plaid_agent.igt.project import render_document
from plaid_agent.igt.toolkit import call_tool


def ws():
    return scan_ws(ExtClient(documents={'d1': contributed_document_raw()}))


def test_reads_mark_contributions_apart_from_machine_output():
    w = ws()
    out = render_document(w.doc('d1'), w.project)
    assert 'w1 Ali-di | seg=Ali-di types=?,suffix | Morph Gloss=Ali-ERG~ | Gloss=Ali^ | IPA=alidi | link=Ali^ |' in out
    assert 'a trailing ^ one entered by a contributor' in out


def test_worklist_lists_contributions_and_narrows_to_one_person():
    w = ws()
    out = call_tool(w, 'worklist', {'kind': 'unverified'})
    assert out.startswith('1 words with annotations awaiting review') and '\tali-di\t' in out
    out = call_tool(w, 'worklist', {'kind': 'contributed'})
    assert out.startswith('1 words with unreviewed contributions') and '\tali-di\t' in out
    assert '\tali-di\t' in call_tool(w, 'worklist', {'kind': 'contributed', 'user': ANN})
    assert '\tali-di\t' in call_tool(w, 'worklist', {'kind': 'contributed', 'user': BOB})
    assert call_tool(w, 'worklist', {'kind': 'contributed', 'user': 'carol@x.com'}).startswith('Nothing to do')
    assert 'user= goes with' in call_tool(w, 'worklist', {'kind': 'unverified', 'user': ANN})


def test_confirm_covers_contributions_and_discard_does_not():
    w = ws()
    out = call_tool(w, 'confirm', {'document': 'd1', 'refs': ['s1.w1']})
    assert '3 annotations will be marked verified' in out
    op = w.ops[0]
    assert sorted(op['span_ids']) == ['sp-g1', 'sp-m1b'] and op['link_ids'] == ['l-1'] and op['token_ids'] == []
    assert op['label'] == 'Text 1 s1.w1 "Ali-di": confirm 2 values, 1 link'
    # The verified contribution (sp-m1a) is not touched.
    assert 'sp-m1a' not in op['span_ids']
    w2 = ws()
    call_tool(w2, 'discard_analysis', {'document': 'd1', 'refs': ['s1.w1']})
    op = w2.ops[0]
    assert op['span_ids'] == ['sp-m1b'] and op['link_ids'] == [] and op['morpheme_ids'] == []


def test_confirm_without_a_document_covers_the_project():
    from fixtures import document_raw
    c = ExtClient(documents={'d1': contributed_document_raw(), 'd2': {**document_raw(), 'id': 'd2', 'name': 'Text 2'}})
    w = scan_ws(c)
    out = call_tool(w, 'confirm', {'documents': ['all']})
    assert 'Planned 1 change' in out and '3 annotations will be marked verified' in out
    assert w.ops[0]['doc'] == 'd1' and w.ops[0]['label'].startswith('Text 1: confirm 2 values, 1 link')
    assert 'd1' in [d['id'] for d in w.plan_payload()['documents']]  # d2 shares the fixture's ids, so it is named too
    assert 'refs need a document' in call_tool(scan_ws(c), 'confirm', {'refs': ['s1.w1']})
    # Field-restricted, project-wide.
    w3 = scan_ws(c)
    call_tool(w3, 'confirm', {'documents': ['all'], 'field': 'Gloss'})
    assert w3.ops[0]['span_ids'] == ['sp-g1'] and w3.ops[0]['link_ids'] == []


def test_a_document_name_in_documents_is_one_document_and_not_the_project():
    """The branch tested that `documents` was a string, never what the string
    said, so documents="Text 2" staged a review of every document with
    anything waiting. Explicit "all" is the only thing that means the
    project."""
    from fixtures import document_raw
    c = ExtClient(documents={'d1': contributed_document_raw(),
                             'd2': {**document_raw(), 'id': 'd2', 'name': 'Text 2'}})
    w = scan_ws(c)
    out = call_tool(w, 'confirm', {'documents': 'Text 2'})
    assert 'Nothing to confirm' in out or [op['doc'] for op in w.ops] == ['d2']
    assert 'd1' not in [op.get('doc') for op in w.ops]
    # The word itself, in either spelling, still covers the project.
    w2 = scan_ws(c)
    call_tool(w2, 'confirm', {'documents': 'ALL '})
    assert [op['doc'] for op in w2.ops] == ['d1']


def test_one_document_named_twice_is_reviewed_once():
    from fixtures import document_raw
    c = ExtClient(documents={'d1': contributed_document_raw(),
                             'd2': {**document_raw(), 'id': 'd2', 'name': 'Text 2'}})
    w = scan_ws(c)
    out = call_tool(w, 'confirm', {'documents': ['Text 1', 'd1']})
    assert [op['doc'] for op in w.ops] == ['d1']
    assert '3 annotations' in out, 'counted once, not twice'


def test_confirming_the_same_thing_twice_in_a_turn_stages_it_once():
    """Two confirmations of the same material used to be two ops, and the
    reply counted both, so the card promised twice what it would do."""
    w = ws()
    call_tool(w, 'confirm', {'document': 'd1', 'refs': ['s1.w1']})
    out = call_tool(w, 'confirm', {'document': 'd1', 'refs': ['s1.w1']})
    assert len(w.ops) == 1
    assert 'the plan now holds 1' in out and 'superseded' in out
    # A confirmation of DIFFERENT material is its own change.
    w2 = ws()
    call_tool(w2, 'confirm', {'document': 'd1', 'refs': ['s1.w1'], 'field': 'Gloss'})
    call_tool(w2, 'confirm', {'document': 'd1', 'refs': ['s1.w1'], 'field': 'Morph Gloss'})
    assert len(w2.ops) == 2


def test_a_confirmation_by_ref_and_a_delete_of_its_word_refuse_each_other():
    """A confirmation the model named by reference is a write to what it
    names, so it refuses a certain delete of any of it in both orders, like
    every other named write. It used to stage either way round, and the card
    promised annotations the applied plan then trimmed away without a word."""
    w = ws()
    assert 'Planned' in call_tool(w, 'confirm', {'document': 'd1', 'refs': ['s1.w1']})
    out = call_tool(w, 'delete_word', {'document': 'd1', 'refs': ['s1.w1']})
    assert 'writes to something this plan deletes' in out and 'drop_planned' in out
    assert [o['kind'] for o in w.ops] == ['confirm']
    # The delete first, then the confirmation.
    w2 = ws()
    assert 'Planned' in call_tool(w2, 'delete_word', {'document': 'd1', 'refs': ['s1.w1']})
    assert 'writes to something this plan deletes' in call_tool(
        w2, 'confirm', {'document': 'd1', 'refs': ['s1.w1']})
    assert [o['kind'] for o in w2.ops] == ['delete_word']


def test_a_confirmation_of_a_document_leaves_out_what_the_plan_deletes():
    """A confirmation of a whole document names nothing the model chose: it
    stands for whatever there awaits review, so it stages beside a delete and
    is resolved when the plan is applied, leaving out what the plan deletes.
    The applied message says how many it left out."""
    from plaid_agent.igt.plan import execute_plan
    raw = contributed_document_raw()
    layers = raw['text_layers'][0]['token_layers']
    layers[1]['span_layers'][0]['spans'].append(
        {'id': 'sp-g2', 'value': 'fish', 'tokens': ['w-2'],
         'metadata': {'prov': 'inferred', 'provSource': 'service:x'}})
    w = scan_ws(ExtClient(documents={'d1': raw}))
    assert 'Planned' in call_tool(w, 'delete_word', {'document': 'd1', 'refs': ['s1.w1']})
    assert '4 annotations will be marked verified' in call_tool(w, 'confirm', {'document': 'd1'})
    counts = execute_plan(w.client, w.ops, source='s', label='l', project=w.project)
    assert counts['confirmations'] == 1 and counts['deleted words'] == 1
    assert counts['notes'] == ['Text 1: confirm 3 values, 1 link: 3 annotations left unconfirmed '
                               '(deleted in this plan)']


def test_prompt_says_a_contributors_approval_is_a_contribution():
    """The plan contract owes the rule, and confirm owes the reader where to
    find the work it covers. The pointer used to be restated in the prompt's
    which-tool paragraph beside confirm's own description, and now is not."""
    from plaid_agent.igt.prompt import build_system_prompt
    from plaid_agent.igt.toolkit import TOOLS
    p = build_system_prompt(ws().project)
    assert 'contribution awaiting a reviewer' in p
    confirm = next(t['function']['description'] for t in TOOLS
                   if t['function']['name'] == 'confirm')
    assert "contributors' work" in confirm
    assert 'worklist kind=' in confirm and '"contributed"' in confirm
