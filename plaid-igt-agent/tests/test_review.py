"""Work awaiting review: a contributor's unreviewed annotations are shown,
listed, and confirmable next to unconfirmed machine output, and never
discarded as if they were a machine's."""

from fixtures import scan_ws
from fixtures_ext import ExtClient, contributed_document_raw, ANN, BOB

from plaid_igt_agent.project import render_document
from plaid_igt_agent.tools import call_tool


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
    out = call_tool(w, 'confirm', {})
    assert 'Planned 1 change' in out and '3 annotations will be marked verified' in out
    assert w.ops[0]['doc'] == 'd1' and w.ops[0]['label'].startswith('Text 1: confirm 2 values, 1 link')
    assert 'd1' in [d['id'] for d in w.plan_payload()['documents']]  # d2 shares the fixture's ids, so it is named too
    assert 'refs need a document' in call_tool(scan_ws(c), 'confirm', {'refs': ['s1.w1']})
    # Field-restricted, project-wide.
    w3 = scan_ws(c)
    call_tool(w3, 'confirm', {'field': 'Gloss'})
    assert w3.ops[0]['span_ids'] == ['sp-g1'] and w3.ops[0]['link_ids'] == []


def test_prompt_says_a_contributors_approval_is_a_contribution():
    from plaid_igt_agent.prompt import build_system_prompt
    p = build_system_prompt(ws().project)
    assert 'contribution awaiting a reviewer' in p and 'kind="contributed"' in p
