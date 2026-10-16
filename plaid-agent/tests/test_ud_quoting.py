"""One quoting style for what a ud answer quotes: a form, a lemma or a
document's name in double quotes, a quotation mark inside escaped as a Grew
pattern writes it. Python's repr changed the marks with the value ('la' but
"qu'"), and a name holding quotes was printed "French "3"" (H16-UD-TOOLS)."""

import json
import os
import random
import subprocess

from node_exe import node_or_skip
from plaid_agent.ud.grew import parse_and_compile
from plaid_agent.ud.grew_search import t_grew_search
from plaid_agent.ud.grew_syntax import grew_string
from live import live_client  # noqa: F401 - fixture
from test_grew_search import LAYERS, treebank  # noqa: F401 - fixture


def test_a_value_is_quoted_as_grew_writes_it_and_reads_back_as_itself():
    assert [grew_string(v) for v in ('la', "qu'", '"', 'French "3"')] == [
        '"la"', '"qu\'"', '"\\""', '"French \\"3\\""']
    for form in ("qu'", '"', 'a"b'):
        where = parse_and_compile(f'pattern {{ X [form={grew_string(form)}] }}', LAYERS).query['where']
        assert any(form in str(c) for c in where), where


# Values an escaping bug hides in (REV-AGENT2-3): a backslash alone, at the
# end, before a letter the lexer would read as an escape, doubled, and a
# newline and a tab raw or spelled.
HARD = ['', ' ', 'a\\', 'C:\\x', '\\n', '\\\\', 'a\nb', 'a\tb', '\\"', '"\\', 'qu\'', '"', 'a"b',
        'French "3"', '[x]', '{', '\\t', 'mi\u0301', 'אב"ג']


def _sweep():
    rnd = random.Random(20261016)
    alphabet = ['a', 'Z', ' ', '\\', '"', "'", '\n', '\t', 'n', 't', '{', ']', 'é', '\u05d0']
    return HARD + [''.join(rnd.choice(alphabet) for _ in range(rnd.randint(1, 8))) for _ in range(400)]


def test_a_value_with_a_backslash_or_a_newline_reads_back_as_itself():
    for value in _sweep():
        q = grew_string(value)
        assert '\n' not in q and '\t' not in q, repr(q)
        assert _reads(q) == value, (value, q)
    # Pasted from check_consistency into a pattern, it finds the form itself.
    form = 'C:' + chr(92) + 'x'
    where = parse_and_compile(f'pattern {{ X [form={grew_string(form)}] }}', LAYERS).query['where']
    assert ['token', '?n_X', {'value': form}] in where, where


def _reads(q):
    """What the agent's own Grew lexer reads a quoted literal as."""
    from plaid_agent.ud.grew_syntax import STRING, lex
    [tok] = [t for t in lex(q) if t['type'] == STRING]
    return tok['value']


def test_grew_string_is_plaid_uds_quote_exactly(tmp_path):
    node = node_or_skip('The quoting mirror runs plaid-ud/src/grew/literals.js with it.')
    values = _sweep()
    path = tmp_path / 'values.json'
    path.write_text(json.dumps(values), encoding='utf-8')
    runner = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'grew_quote_mirror.mjs')
    run = subprocess.run([node, runner, str(path)], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    js = json.loads(run.stdout)
    differ = [(v, j, grew_string(v)) for v, j in zip(values, js) if j != grew_string(v)]
    assert not differ, differ[:5]


def test_grew_search_quotes_a_document_name_holding_quotation_marks(treebank, monkeypatch):
    doc = treebank.doc(treebank.resolve_document_id('Viaje dos'))
    monkeypatch.setattr(doc, 'name', 'French "3"')
    listed = [{**d, 'name': 'French "3"'} if d['id'] == doc.id else d for d in treebank.documents()]
    monkeypatch.setattr(treebank, 'documents', lambda *a, **k: listed)
    out = t_grew_search(treebank, 'pattern { V [upos=VERB]; V -[obl]-> N }')
    assert '"French \\"3\\"" (1 match in 1 sentence)' in out.splitlines(), out
    none = t_grew_search(treebank, 'pattern { X [upos=PRON] }', document=doc.id)
    assert none.endswith('No matches in "French \\"3\\"".'), none


def test_grew_search_and_check_consistency_name_a_shared_name_with_its_id(treebank, monkeypatch):
    """Two documents called the same are told apart by id in a heading, as
    the plan's lines do (REV-AGENT2-7)."""
    from plaid_agent.ud.stats import t_check_consistency
    doc = treebank.doc(treebank.resolve_document_id('Viaje dos'))
    listed = [{**d, 'name': 'Viaje'} for d in treebank.documents()]
    monkeypatch.setattr(treebank, 'documents', lambda *a, **k: listed)
    out = t_grew_search(treebank, 'pattern { V [upos=VERB]; V -[obl]-> N }')
    assert f'"Viaje" ({doc.id}) (1 match in 1 sentence)' in out.splitlines(), out
    none = t_grew_search(treebank, 'pattern { X [upos=PRON] }', document=doc.id)
    assert none.endswith(f'No matches in "Viaje" ({doc.id}).'), none
    held = t_check_consistency(treebank, kind='form-upos', document=doc.id)
    assert held.startswith(f'In "Viaje" ({doc.id}):'), held
