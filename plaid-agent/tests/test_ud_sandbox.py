"""run_code over the UD fixture: the view, a walk, a query, a proposal."""

import pytest

from plaid_agent.core import sandbox
from plaid_agent.ud.project import load_project
from plaid_agent.ud.sandbox import view
from plaid_agent.ud.tools import Workspace, call_tool
from ud_fixtures import PID, ud_client

pytestmark = pytest.mark.skipif(sandbox.available() is not None, reason=sandbox.available() or '')


@pytest.fixture
def ws():
    client = ud_client()
    return Workspace(client, load_project(client, PID))


def test_the_view_is_plain_data_with_references_and_review_states(ws):
    v = view(ws.doc('Viaje'))
    w = v['sentences'][0]['words'][3]
    assert w['ref'] == 's1.w4' and w['form'] == 'mar' and w['upos'] == 'NOUN' and w['deprel'] == 'obl'
    assert w['head'] == 1 and w['review']['upos'] == 'machine' and w['review']['lemma'] == 'human'
    al = v['sentences'][0]['words'][1]
    assert al['form'] == 'a' and al['token'] == 'al' and al['mwt']


def test_code_walks_the_corpus_and_reports(ws):
    code = '''
from collections import Counter
c = Counter()
for d in documents():
    for s in load(d["name"])["sentences"]:
        for w in s["words"]:
            if w["upos"]:
                c[w["upos"]] += 1
print(c.most_common(2))
len(documents())
'''
    out = call_tool(ws, 'run_code', {'code': code})
    assert out == "[('VERB', 1), ('ADP', 1)]\n=> 1" or out.startswith('[(')


def test_code_stages_a_proposal_through_the_plan_tools(ws):
    out = call_tool(ws, 'run_code', {'code': 'print(plan("set_field", document="Viaje", refs=["s2.w1"], field="lemma", value="correr"))'})
    assert 'Planned lemma = "correr" on 1 word(s): s2.w1' in out
    assert len(ws.ops) == 1 and ws.ops[0]['value'] == 'correr'
    out = call_tool(ws, 'run_code', {'code': 'print(plan("read_document", document="Viaje"))'})
    assert 'is not a plan tool' in out


def test_an_unknown_document_is_an_error_the_code_can_read(ws):
    out = call_tool(ws, 'run_code', {'code': 'load("nope")'})
    assert out.startswith('Error:') and 'No document "nope"' in out


def test_code_help_shows_the_shape_and_the_functions(ws):
    out = call_tool(ws, 'code_help', {})
    assert 'load(document)' in out and '"review"' in out and 'plan(' in out
