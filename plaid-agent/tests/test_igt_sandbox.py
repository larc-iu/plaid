"""run_code over the IGT fixture: the view, a walk, a proposal."""


from fixtures import FakeClient, fake_ws
from live import require_sandbox
from plaid_agent.igt.sandbox import view
from plaid_agent.igt.toolkit import call_tool

pytestmark = require_sandbox()


def test_the_view_has_words_morphemes_fields_and_links():
    w = fake_ws(FakeClient())
    v = view(w.doc('d1'))
    word = v['sentences'][0]['words'][0]
    assert word['ref'] == 's1.w1' and word['fields'].get('Gloss') == 'Ali'
    assert word['morphemes'][0]['ref'] == 's1.w1.m1' and word['morphemes'][1]['fields']
    assert isinstance(word['link'], (str, type(None))) and isinstance(word['review'], dict)


def test_code_walks_the_documents_and_stages_a_proposal():
    w = fake_ws(FakeClient())
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


def test_the_help_spells_this_projects_fields_and_a_percent_format_is_explained():
    w = fake_ws(FakeClient())
    help_text = call_tool(w, 'code_help', {})
    assert 'spelled as the code must spell them: ' + w.project.field_list() in help_text
    assert 'm["fields"].get("Morph Gloss")' in help_text
    out = call_tool(w, 'run_code', {'code': "print('%s' % 'a')"})
    assert 'f-string or str.format()' in out


def test_what_plan_did_is_said_after_the_output_even_unprinted():
    """Code that never prints plan()'s answer still shows the model what was
    staged, what was refused, and what the plan holds (2026-10-12 survey)."""
    w = fake_ws(FakeClient())
    code = '''
plan("set_field", document="Text 1", refs=["s1.w2"], field="Gloss", value="X")
plan("no_such_tool", x=1)
plan("no_such_tool", x=2)
'''
    out = call_tool(w, 'run_code', {'code': code})
    assert 'plan() was called 3 times: 1 staged, 2 refused (the first said: "no_such_tool" is not a plan tool' in out
    assert out.endswith('The plan now holds 1 change.') and len(w.ops) == 1
    out = call_tool(w, 'run_code', {'code': 'print("hi")'})
    assert 'plan()' not in out
    out = call_tool(w, 'run_code', {'code': 'plan("set_field", document="Text 1", refs=["s1.w1"], field="Gloss", value="Y")\n'
                                            'raise ValueError("later")'})
    assert 'ValueError: later' in out and out.endswith('plan() was called 1 time and staged. The plan now holds 2 changes.')


def test_the_helps_say_what_a_query_row_is_and_how_an_entry_field_is_read():
    """Rows are lists, not dicts, ids and entities stop at 1000, and an
    entry's fields are its metadata under the project's own spelling
    (2026-10-12 survey)."""
    w = fake_ws(FakeClient())
    code_help = call_tool(w, 'code_help', {})
    assert 'a row\n' in code_help and 'is a LIST' in code_help and '{"count": n}' in code_help
    query_help = call_tool(w, 'query_help', {})
    assert 'stop at 1000 rows' in query_help
    assert '["vocab","?v",{"metadata":{"gloss":"dog"}}]' in query_help and '"?v.metadata.gloss"' in query_help
