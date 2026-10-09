"""run_code's load() takes an entry of documents() as well as a name or id,
what it returns reads by key and by attribute, and an error about a guessed
key or a code typo says so in the code's terms. The document tools still
refuse what is not a name or id by naming the argument (A1-IGT polish).

The causes come from the 2026-10-08 benchmark's failed run_code calls:
load(d) for d in documents(), doc.sentences on a dict, guessed keys, and a
missing quote answered as a fault in the tool."""

from fixtures import FakeClient, scan_ws
from live import require_sandbox
from plaid_agent.core.sandbox import keyed
from plaid_agent.igt.toolkit import call_tool


def test_a_document_tool_names_the_argument_when_handed_a_list():
    w = scan_ws(FakeClient())
    assert call_tool(w, 'read_document', {'document': ['Text 1']}).startswith('Error: document must be')


def test_keyed_sends_attribute_reads_through_the_reader_and_leaves_the_rest():
    code = 'for s in doc.sentences:\n    x = s.words[0].form.lower()\n'
    assert keyed(code) == ("for s in _plaid_attr_(doc, 'sentences'):\n"
                           "    x = _plaid_attr_(_plaid_attr_(s, 'words')[0], 'form').lower()\n")
    # A method call, a builtin's attribute, a module's, and an assignment stay as written.
    same = 'w.get("a")\nmath.pi\nre.IGNORECASE\nobj.x = 1\nd.items()\nsorted(xs, key=str.lower)\n'
    assert keyed(same) == same
    # Brackets, space and a comment between the value and the name survive.
    assert keyed('y = (a\n  # note.\n  ).b\n') == "y = _plaid_attr_((a\n  # note.\n  ), 'b')\n"
    # Line numbers do not move, and non-ASCII text before a read keeps its place.
    assert keyed('s = "ди"; t = w.form\n') == 's = "ди"; t = _plaid_attr_(w, \'form\')\n'
    assert keyed('x = f"{w.form}!"') == 'x = f"{_plaid_attr_(w, \'form\')}!"'
    assert keyed('def f(:\n  pass') == 'def f(:\n  pass'


def test_keyed_keeps_a_comment_after_the_dot_and_the_code_that_tests_for_attributes():
    # A comment after the dot used to swallow the closing bracket.
    assert keyed('x = (p.  # the value.\n  v)\n') == "x = (_plaid_attr_(p,   # the value.\n  'v'))\n"
    # Inside a try that catches AttributeError the code may be testing for
    # one on purpose: a dict there still raises it.
    same = 'try:\n    x = o.form\nexcept (KeyError, AttributeError):\n    x = o["form"] + "!"\n'
    assert keyed(same) == same
    assert keyed('try:\n    x = o.form\nexcept KeyError:\n    pass\n').count('_plaid_attr_(o') == 1
    # Code that binds the reader's own name runs as written.
    same = 'def _plaid_attr_(a, b):\n    return 1\nprint(p.v)\n'
    assert keyed(same) == same


class TestInTheSandbox:
    pytestmark = require_sandbox()

    def test_load_takes_an_entry_of_documents(self):
        w = scan_ws(FakeClient())
        out = call_tool(w, 'run_code', {'code': 'd = documents()[0]\nprint(load(d)["name"] == load(d["id"])["name"])'})
        assert out == 'True'

    def test_a_loaded_document_reads_by_attribute_too(self):
        w = scan_ws(FakeClient())
        code = '''
n = 0
for d in documents():
    doc = load(d)
    for s in doc.sentences:
        for w in s.words:
            n += len(w.morphemes) + (1 if w.fields.get("Gloss") else 0)
print(n, doc.sentences[0].words[0].ref == doc["sentences"][0]["words"][0]["ref"])
'''
        out = call_tool(w, 'run_code', {'code': code})
        assert out.endswith(' True') and not out.startswith('Error')

    def test_a_guessed_key_names_the_keys_there_are_and_the_shape(self):
        w = scan_ws(FakeClient())
        out = call_tool(w, 'run_code', {'code': 'load(documents()[0]).sentences[0].n'})
        assert out.startswith('Error') and 'no "n" here' in out and "'ref'" in out and "'words'" in out
        assert 'What load() returns:' in out and 'm["fields"].get("Gloss")' in out
        out = call_tool(w, 'run_code', {'code': 'load(documents()[0])["sentences"][0]["words"][0]["text"]'})
        assert 'KeyError' in out and 'What load() returns:' in out

    def test_attribute_reads_on_other_values_still_work(self):
        w = scan_ws(FakeClient())
        code = '''
import math
from collections import Counter
c = Counter("aab")
try:
    {}["x"]
except KeyError as e:
    a = e.args
print(math.pi > 3, c.most_common(1), a)
'''
        assert call_tool(w, 'run_code', {'code': code}) == "True [('a', 2)] ('x',)"

    def test_a_variable_named_type_or_getattr_leaves_attribute_reads_working(self):
        w = scan_ws(FakeClient())
        code = ('m = load(documents()[0]).sentences[0].words[0].morphemes[0]\n'
                'type = m.type\ngetattr = 1\nprint(m.ref == m["ref"])')
        assert call_tool(w, 'run_code', {'code': code}) == 'True'
        # And in the next call of the turn, where the names persist.
        assert call_tool(w, 'run_code', {'code': 'print(m.form == m["form"])'}) == 'True'

    def test_a_missing_key_of_a_large_dict_names_a_few_keys(self):
        w = scan_ws(FakeClient())
        out = call_tool(w, 'run_code', {'code': 'd = {str(i): i for i in range(50000)}\nd.total'})
        assert "Its keys: '0', '1'" in out and 'and 49980 more' in out and len(out) < 2000

    def test_an_error_shows_the_code_as_written(self):
        w = scan_ws(FakeClient())
        out = call_tool(w, 'run_code', {'code': 'doc = load(documents()[0])\nx = doc.sentences[0].n'})
        assert 'x = doc.sentences[0].n' in out and '_plaid_attr_' not in out and '~' not in out

    def test_code_monty_cannot_read_once_rewritten_runs_as_written(self, monkeypatch):
        from plaid_agent.core import sandbox
        monkeypatch.setattr(sandbox, 'keyed', lambda code: code + '\n)')
        w = scan_ws(FakeClient())
        assert call_tool(w, 'run_code', {'code': 'print(1 + 1)'}) == '2'

    def test_a_typo_is_the_codes_fault_not_the_tools(self):
        w = scan_ws(FakeClient())
        out = call_tool(w, 'run_code', {'code': 'x = w["lemma]'})
        assert out.startswith('Error: The code could not be read') and 'fault in the tool' not in out

    def test_next_over_a_generator_and_a_missing_name_say_what_the_sandbox_does(self):
        w = scan_ws(FakeClient())
        out = call_tool(w, 'run_code', {'code': 'next((x for x in [1, 2] if x > 1), None)'})
        assert 'next(iter(...))' in out
        out = call_tool(w, 'run_code', {'code': 'from collections import OrderedDict'})
        assert 'The sandbox has these modules' in out

    def test_code_help_opens_with_the_short_shape(self):
        w = scan_ws(FakeClient())
        out = call_tool(w, 'code_help', {})
        assert out.startswith('A LOADED DOCUMENT IN SHORT') and 'by an entry of documents()' in out
