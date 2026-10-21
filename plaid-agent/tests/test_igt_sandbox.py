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


def test_a_run_whose_plan_replaces_a_waiting_one_says_so_once():
    """The first staging of a turn says it replaces the plan still waiting
    from an earlier message, and from run_code that staging is a plan() call
    whose answer the code need not print."""
    w = fake_ws(FakeClient())
    w.waiting = {'count': 114, 'summary': 'retag da'}
    stage = 'plan("set_field", document="Text 1", refs=["s1.w2"], field="Gloss", value="X")'
    out = call_tool(w, 'run_code', {'code': stage})
    assert 'It replaces the plan of 114 changes' in out and 'can no longer approve' in out
    out = call_tool(w, 'run_code', {'code': stage.replace('s1.w2', 's1.w1')})
    assert 'replaces' not in out

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


def test_lexicon_gives_every_entry_with_its_id_address_fields_and_links():
    """Code reads the whole lexicon, joins a word's link to its entry by id,
    and stages a change by entry id where the form names two entries
    (2026-10-12 survey: lexicon work sampled 907 of 1205 entries, and 17 of
    101 set_entry_field calls failed on homographs)."""
    w = fake_ws(FakeClient())
    word = view(w.doc('d1'))['sentences'][0]['words'][0]
    assert word['link_id'] == 'vi-ali' and word['morphemes'][1]['link_id'] == 'vi-erg'
    code = '''
by_id = {e["id"]: e for e in lexicon()}
print(len(by_id), by_id["vi-ali"]["links"], by_id["vi-erg"]["links"], by_id["vi-gam"]["links"])
print(by_id["vi-erg"]["type"], repr(by_id["vi-gam"]["fields"]["gloss"]), by_id["vi-ali"].fields["pos"], by_id["vi-ali"].lexicon)
print(sorted(e.address for e in by_id.values() if e.form == "gam"))
for e in lexicon("Lexicon"):
    if e["form"] == "gam" and e["fields"]["gloss"] == "net":
        plan("set_entry_field", entry_id=e["id"], field="pos", value="N")
print([e["fields"].get("pos") for e in lexicon() if e["id"] == "vi-gam2"])
'''
    w.reads = []
    out = call_tool(w, 'run_code', {'code': code})
    lines = out.splitlines()
    assert lines[0] == '4 1 1 0', out
    assert lines[1] == "suffix 'fish' N Lexicon", out
    assert lines[2] == "['gam#1', 'gam#2']", out
    # The entry a plan() call changed reads changed in the same run.
    assert lines[3] == "['N']", out
    assert len(w.ops) == 1 and w.ops[0]['item_id'] == 'vi-gam2'
    assert {'n': 12, 'unit': 'entry'} in w.reads  # three calls of four entries
    out = call_tool(w, 'run_code', {'code': 'lexicon("Nope")'})
    assert 'No lexicon named "Nope"' in out


def test_the_help_spells_the_lexicons_entry_fields():
    w = fake_ws(FakeClient())
    help_text = call_tool(w, 'code_help', {})
    assert 'lexicon(name=None)' in help_text and '"Lexicon": "gloss", "pos"\n' in help_text
    assert 'plan("set_entry_field", entry_id=e["id"], field="pos"' in help_text
