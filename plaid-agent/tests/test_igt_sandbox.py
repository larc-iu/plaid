"""run_code over the IGT fixture: the view, a walk, a proposal."""

import pytest

from fixtures import FakeClient, scan_ws
from plaid_agent.core import sandbox
from plaid_agent.igt.sandbox import view
from plaid_agent.igt.tools import call_tool

pytestmark = pytest.mark.skipif(sandbox.available() is not None, reason=sandbox.available() or '')


def test_the_view_has_words_morphemes_fields_and_links():
    w = scan_ws(FakeClient())
    v = view(w.doc('d1'))
    word = v['sentences'][0]['words'][0]
    assert word['ref'] == 's1.w1' and word['fields'].get('Gloss') == 'Ali'
    assert word['morphemes'][0]['ref'] == 's1.w1.m1' and word['morphemes'][1]['fields']
    assert isinstance(word['link'], (str, type(None))) and isinstance(word['review'], dict)


def test_code_walks_the_documents_and_stages_a_proposal():
    w = scan_ws(FakeClient())
    code = '''
n = 0
for d in documents():
    for s in load(d["id"])["sentences"]:
        n += len(s["words"])
print(n)
print(plan("set_field", document="Text 1", refs=["s1.w2"], field="Gloss", value="X"))
'''
    out = call_tool(w, 'run_code', {'code': code})
    assert out.startswith('4\n') and 'Planned' in out
    assert len(w.ops) == 1
    assert 'load(document)' in call_tool(w, 'code_help', {})
