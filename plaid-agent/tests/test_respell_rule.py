"""igt's respell_all as a rule (RULE-PLANS.md section 8 step 7, R6): its words
are named in the digest by id and their offsets read where the rule is found,
at staging and at approval, so text typed elsewhere leaves the plan standing;
its guards run where it is found too, so two respellings of one document
compose in plan order as the other rules do, and a plan reshaping a document
it respells is refused there."""
import pytest

from live import live_client, seed  # noqa: F401
from fixtures import lexicon_raw, VOCAB
from rule_plan_model import approve, project
from test_rule_restate_live import _doc

from plaid_agent.core.tools import ToolError
from plaid_agent.igt import queries
from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace

WORDS = [('to', '', [('to', '')]), ('gam', '', [('ga', ''), ('m', '')]), ('tao', '', [('tao', '')])]


@pytest.fixture
def doc_a(live_client):
    s = seed(live_client, project(), {'d0': _doc('d0', 'Doc A', WORDS)}, {VOCAB: lexicon_raw()}, name='respell rule')
    yield s, Workspace(live_client, load_project(live_client, s.project_id))
    s.delete()


def _read(c, s):
    ws = Workspace(c, load_project(c, s.project_id))
    d = ws.doc('Doc A')
    return (d.body, [w.surface for st in d.sentences for w in st.words],
            [m.form for st in d.sentences for w in st.words for m in w.morphemes],
            sorted(it['form'] for v in ws.project.vocabs for it in ws.lexicon(v)))


def _ok(out):
    assert not out.startswith('Error'), out
    return out


def test_text_typed_before_a_respelled_word_leaves_the_plan_standing(live_client, doc_a):
    # The digest named the word by its offsets, so "xx " typed at the start
    # refused the plan with "matches other values than the 4 shown".
    c, (s, ws) = live_client, doc_a
    _ok(call_tool(ws, 'respell_all', {'pattern': 'gam', 'replacement': 'gham', 'whole': True, 'lexicon': False}))
    [rule] = ws.ops
    assert rule['documents'] and all(n for _d, n, _digest in rule['matched'])
    c.texts.update(ws.doc('Doc A').text_id, [{'type': 'insert', 'index': 0, 'value': 'xx '}])
    _p, h, _ = approve(c, s.project_id, ws)
    assert not h.errors, h.errors
    body, words, _forms, _heads = _read(c, s)
    # Written at the offsets read at approval.
    assert body == 'xx to gham tao' and words == ['to', 'gham', 'tao'], (body, words)


def test_an_edit_of_a_respelled_word_makes_the_plan_out_of_date(live_client, doc_a):
    c, (s, ws) = live_client, doc_a
    _ok(call_tool(ws, 'respell_all', {'pattern': 'a', 'replacement': 'ä', 'lexicon': False}))
    d = ws.doc('Doc A')
    tao = d.sentences[0].words[2]
    c.texts.update(d.text_id, [{'type': 'replace', 'index': tao.begin, 'length': tao.end - tao.begin, 'value': 'tau'}])
    _p, h, _ = approve(c, s.project_id, ws)
    assert h.errors and 'Since it was planned, respell "a" → "ä" matches' in h.errors[0], h.errors
    assert _read(c, s)[0] == 'to gam tau'


def test_two_respellings_of_one_document_compose_in_plan_order(live_client, doc_a):
    # The second was refused, "this plan already holds a corpus-wide change
    # that reaches this document", so an orthography migration of two
    # letters took two plans.
    c, (s, ws) = live_client, doc_a
    _ok(call_tool(ws, 'respell_all', {'lexicon': True, 'pattern': 'a', 'replacement': 'ä'}))
    out = _ok(call_tool(ws, 'respell_all', {'lexicon': True, 'pattern': 'o', 'replacement': 'ö'}))
    # "tao" is read as the first leaves it.
    assert 'respell "tao" → "täö"' in out, out
    _p, h, _ = approve(c, s.project_id, ws)
    assert not h.errors, h.errors
    body, words, forms, heads = _read(c, s)
    assert body == 'tö gäm täö' and words == ['tö', 'gäm', 'täö'], (body, words)
    assert forms == ['tö', 'gä', 'm', 'täö'], forms
    assert 'gäm' in heads and 'gam' not in heads, heads


def test_a_respelling_that_spells_back_writes_nothing_there(live_client, doc_a):
    c, (s, ws) = live_client, doc_a
    _ok(call_tool(ws, 'respell_all', {'pattern': 'a', 'replacement': 'ä', 'lexicon': False}))
    _ok(call_tool(ws, 'respell_all', {'pattern': 'o', 'replacement': 'ö', 'lexicon': False}))
    out = _ok(call_tool(ws, 'respell_all', {'pattern': 'ä', 'replacement': 'a', 'lexicon': False}))
    assert 'go back to what is stored, so approval writes nothing there' in out, out
    assert '(1 words, 1 morpheme forms, 0 lexicon headwords.)' in out, out
    _p, h, _ = approve(c, s.project_id, ws)
    assert not h.errors, h.errors
    [done] = h.done
    assert {x['kind']: x['count'] for x in done['counts']} == {'respellings': 2, 'morpheme forms': 2}, done
    assert _read(c, s)[:3] == ('tö gam taö', ['tö', 'gam', 'taö'], ['tö', 'ga', 'm', 'taö'])


def test_dropping_the_first_respelling_finds_the_second_over_what_is_stored(live_client, doc_a):
    c, (s, ws) = live_client, doc_a
    _ok(call_tool(ws, 'respell_all', {'pattern': 'a', 'replacement': 'ä', 'lexicon': False}))
    _ok(call_tool(ws, 'respell_all', {'pattern': 'o', 'replacement': 'ö', 'lexicon': False}))
    _ok(call_tool(ws, 'drop_planned', {'indexes': [1]}))
    _p, h, _ = approve(c, s.project_id, ws)
    assert not h.errors, h.errors
    assert _read(c, s)[0] == 'tö gam taö'


@pytest.mark.parametrize('first', ['respelling', 'split'])
def test_a_plan_reshaping_a_document_it_respells_is_refused_in_either_order(doc_a, first):
    _s, ws = doc_a
    respell = ('respell_all', {'lexicon': True, 'pattern': 'a', 'replacement': 'ä'})
    split = ('split_word', {'document': 'Doc A', 'ref': 's1.w1', 'at': '1'})
    calls = [respell, split] if first == 'respelling' else [split, respell]
    _ok(call_tool(ws, *calls[0]))
    out = call_tool(ws, *calls[1])
    assert out.startswith('Error') and 'reaches' in out, out


def test_the_guards_read_the_plan_being_applied_at_approval(doc_a):
    # At approval the rule is found with a workspace that holds no plan: the
    # guard reads the plan being applied (queries.PLAN_OPS).
    _s, ws = doc_a
    d = ws.doc('Doc A')
    w = d.sentences[0].words[2]
    word = {'kind': 'respell', 'text_id': d.text_id, 'begin': w.begin, 'end': w.end, 'value': 'täo', 'doc': d.id,
            'label': 'Doc A s1.w3: respell "tao" → "täo"', 'change_at': 13}
    queries.respell_guard(ws, [word], {})
    setattr(ws, queries.PLAN_OPS, [{'kind': 'split_word', 'doc': d.id, 'word_id': w.id}])
    with pytest.raises(ToolError, match='reshapes text or words in a document this respelling reaches'):
        queries.respell_guard(ws, [word], {})
    setattr(ws, queries.PLAN_OPS, [])
    # Two respellings of one text meet in one range or none.
    other = {**word, 'begin': w.begin - 1}
    with pytest.raises(ToolError, match='overlaps a respelling already planned'):
        queries.respell_guard(ws, [word], {'x': other})
    queries.respell_guard(ws, [word], {'x': dict(word)})


def test_headwords_are_left_alone_unless_asked(live_client, doc_a):
    """igt's Respell screen leaves lexicon entries alone by default, since a
    lexicon can be shared (ruling 22), and so does respell_all (H17-ASSIST-10)."""
    _s, ws = doc_a
    out = _ok(call_tool(ws, 'respell_all', {'pattern': 'gam', 'replacement': 'gham', 'whole': True}))
    assert '0 lexicon headwords' in out, out
    out = _ok(call_tool(ws, 'respell_all', {'pattern': 'gam', 'replacement': 'gham', 'whole': True, 'lexicon': True}))
    assert '0 lexicon headwords' not in out, out
