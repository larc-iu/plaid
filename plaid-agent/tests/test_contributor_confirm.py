"""A contributor's approval of a confirmation is their own contribution,
never a verification (the provenance convention's rule 3, the editor's
``writerPolicy(...).confirmStamp``): a machine proposal becomes their
contributed work, and another contributor's work is left for a reviewer.
Both apps."""

import copy

from plaid_client.testing import as_fragment

from fixtures import FakeClient, scan_ws
from fixtures_ext import contributed_document_raw

from plaid_agent.igt.plan import execute_plan as igt_execute
from plaid_agent.igt.toolkit import call_tool as igt_call
from plaid_agent.ud.plan import execute_plan as ud_execute
from plaid_agent.ud.project import load_project as ud_load
from plaid_agent.ud.toolkit import call_tool as ud_call
from plaid_agent.ud.tools import Workspace as UdWorkspace
from ud_fixtures import PID, document_raw as ud_document_raw, ud_client

BOB = 'bob@x.com'
CONTRIBUTED_BY_BOB = {'prov': 'contributed', 'provSource': f'user:{BOB}', 'provConfirmed': None}


def _igt_confirm_plan():
    w = scan_ws(FakeClient(documents={'d1': contributed_document_raw()}))
    igt_call(w, 'confirm', {'document': 'd1', 'refs': ['s1.w1']})
    w.client.calls.clear()
    return w


def test_igt_a_contributors_confirm_takes_the_machine_gloss_as_theirs_and_leaves_the_rest():
    w = _igt_confirm_plan()
    counts = igt_execute(w.client, w.ops, source='service:igt:assist:x', label='l', project=w.project,
                         stamp_mode='contributed', contributor=BOB)
    # The machine gloss (sp-m1b) is bob's contribution now, not verified.
    [(sid, patch)] = w.client.patches('spans')
    assert sid == 'sp-m1b' and as_fragment(patch) == CONTRIBUTED_BY_BOB
    # Ann's gloss (sp-g1) and the contributed link (l-1) are no one's to
    # review but a verifier's: nothing is written to either.
    assert not w.client.payloads('vocab_links.patch_metadata')
    assert counts['confirmations'] == 1
    assert counts['notes'] == ["1 annotation accepted as your contribution, 2 contributor's annotations left "
                               'for a reviewer']


def test_igt_a_verifiers_confirm_still_verifies_everything():
    w = _igt_confirm_plan()
    counts = igt_execute(w.client, w.ops, source='service:igt:assist:x', label='l', project=w.project)
    assert sorted(sid for sid, _ in w.client.patches('spans')) == ['sp-g1', 'sp-m1b']
    assert all(as_fragment(p) == {'provConfirmed': True} for _, p in w.client.patches('spans'))
    assert len(w.client.payloads('vocab_links.patch_metadata')) == 1
    assert counts['confirmations'] == 3 and 'notes' not in counts


def _ud_ws():
    raw = ud_document_raw()
    spans = raw['text_layers'][0]['token_layers'][2]['span_layers']
    lemma = next(sl for sl in spans if sl['id'] == 'u-lemma')
    # Ann contributed the lemma of "mar". Its UPOS is the fixture's machine one.
    lemma['spans'][3]['metadata'] = {'prov': 'contributed', 'provSource': 'user:ann@x.com'}
    client = ud_client(documents={'ud1': raw})
    return UdWorkspace(client, ud_load(client, PID))


def test_ud_a_contributors_confirm_takes_the_machine_value_as_theirs_and_leaves_the_rest():
    for refs in (['s1.w4'], None):   # named, and the whole document (a scope resolved at approval)
        ws = _ud_ws()
        args = {'document': 'Viaje'} if refs is None else {'document': 'Viaje', 'refs': refs}
        out = ud_call(ws, 'confirm', args)
        assert 'Planned confirming 2 value(s)' in out, out
        ops = ws.plan_payload()['ops']
        counts = ud_execute(ws.client, ops, source='service:ud:assist:x', label='l', project=ws.project,
                            stamp_mode='contributed', contributor=BOB)
        [(sid, patch)] = ws.client.patches('spans')
        assert sid == 'sp-u3' and as_fragment(patch) == CONTRIBUTED_BY_BOB
        assert counts['confirmations'] == 1
        assert counts['notes'] == ["1 annotation accepted as your contribution, 1 contributor's annotation left "
                                   'for a reviewer']


def test_ud_a_verifiers_confirm_still_verifies_both():
    ws = _ud_ws()
    ud_call(ws, 'confirm', {'document': 'Viaje', 'refs': ['s1.w4']})
    counts = ud_execute(ws.client, ws.plan_payload()['ops'], source='service:ud:assist:x', label='l',
                        project=ws.project)
    assert sorted(sid for sid, _ in ws.client.patches('spans')) == ['sp-l3', 'sp-u3']
    assert counts == {'confirmations': 2}


# --- what the contributor is told (REV-FX3-AGENT-4) ----------------------------

def _reviewed_project(raw):
    raw = copy.deepcopy(raw)
    raw.setdefault('config', {}).setdefault('plaid', {})['review'] = {'users': [BOB], 'roles': []}
    raw.setdefault('writers', []).append(BOB)
    return raw


def test_igt_a_reviewed_requester_is_told_their_confirm_is_a_contribution():
    from fixtures import project_raw
    w = scan_ws(FakeClient(project=_reviewed_project(project_raw()), documents={'d1': contributed_document_raw()}))
    w.requester_id = BOB
    out = igt_call(w, 'confirm', {'document': 'd1', 'refs': ['s1.w1']})
    assert 'will be marked verified' not in out
    assert ("1 machine annotation will become your contribution, 2 contributor's annotations are left for a "
            'reviewer') in out
    # A verifier is told what it was before.
    w2 = scan_ws(FakeClient(documents={'d1': contributed_document_raw()}))
    w2.requester_id = 'a@b.com'
    assert '3 annotations will be marked verified' in igt_call(w2, 'confirm', {'document': 'd1', 'refs': ['s1.w1']})


def test_igt_a_row_that_wrote_nothing_is_reported_by_its_card_row():
    w = scan_ws(FakeClient(documents={'d1': contributed_document_raw()}))
    igt_call(w, 'confirm', {'document': 'd1', 'refs': ['s1.w1']})
    # Only the contributed gloss: nothing for a contributor to write.
    op = {**w.ops[0], 'span_ids': ['sp-g1'], 'token_ids': [], 'link_ids': [], '_row': 0}
    counts = igt_execute(w.client, [op], source='s', label='l', project=w.project,
                         stamp_mode='contributed', contributor=BOB)
    assert counts['unwritten'] == [0]


def test_ud_a_reviewed_requester_is_told_their_confirm_is_a_contribution():
    from ud_fixtures import project_raw as ud_project_raw
    raw = ud_document_raw()
    lemma = next(sl for sl in raw['text_layers'][0]['token_layers'][2]['span_layers'] if sl['id'] == 'u-lemma')
    lemma['spans'][3]['metadata'] = {'prov': 'contributed', 'provSource': 'user:ann@x.com'}
    client = ud_client(project=_reviewed_project(ud_project_raw()), documents={'ud1': raw})
    ws = UdWorkspace(client, ud_load(client, PID))
    ws.requester_id = BOB
    out = ud_call(ws, 'confirm', {'document': 'Viaje', 'refs': ['s1.w4']})
    assert ("1 machine annotation will become your contribution, 1 contributor's annotation is left for a "
            'reviewer') in out, out
    out = ud_call(ws, 'confirm', {'document': 'Viaje'})
    assert 'will become your contribution' in out, out
