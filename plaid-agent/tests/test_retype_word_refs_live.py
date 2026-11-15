"""Word references into a sentence the plan retypes, on a real core (BRIEF
RR): a new word typed into a sentence and annotated in the same plan gets its
value, and every other word of the sentence keeps its own, approved through
the assistant service and applied by a job's piece.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time
import uuid

import pytest

from fixtures import GLOSS, SENT_LAYER, TRANS, WORD_LAYER
from job_fixtures import Model, call, document, job_project, plan_row, reply, text_edits, use
from live import _skip_or_fail, core_url, login, seed
from test_delete_sentence_live import _approve

from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.job import Job, run_job
from plaid_agent.igt.job import IgtRunner
from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace
from plaid_agent.jobworker import count_chars

PASSWORD = 'retype-word-refs-1'
WORKER = '0193a5c0-0000-7000-8000-0000000000f7'


@pytest.fixture(autouse=True)
def _text_edits(monkeypatch):
    """These jobs' pieces change the text: their plans say they may (FX)."""
    text_edits(monkeypatch)


def _word(form, gloss):
    return {'form': form, 'gloss': (gloss, 'human')}


#: s2's words are each glossed by a person, its third word "pa" among them.
SENTENCES = [{'words': [_word('ka', 'one'), 'ta'], 'translation': ('First.', 'human')},
             {'words': [_word('sa', 'S'), _word('na', 'N'), _word('pa', 'P'), _word('ma', 'M')],
              'translation': ('Second.', 'human')}]


def _admin():
    try:
        return login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')


def _seeded(admin, prefix, sentences=SENTENCES):
    from plaid_client import PlaidClient
    email = f'{prefix}-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, PASSWORD, False)
    writer = PlaidClient.login(core_url(), email, PASSWORD)
    s = seed(admin, job_project(), {'dA': document('dA', 'Alpha', sentences)},
             {'v1': {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': []}},
             name=f'{prefix} {uuid.uuid4().hex[:6]}')
    admin.projects.add_writer(s.project_id, email)
    return email, writer, s


def _glosses(admin, s, sentence=2):
    """``[(word, gloss or None)]`` of a sentence as core holds it, in text
    order, and its translation."""
    raw = admin.documents.get(s.ids['dA'], include_body=True)
    tl = raw['text_layers'][0]
    body = tl['text']['body']
    layers = {tk['id']: tk for tk in tl['token_layers']}
    sents = sorted(layers[s.ids[SENT_LAYER]]['tokens'], key=lambda t: t['begin'])
    st = sents[sentence - 1]
    words = sorted((t for t in layers[s.ids[WORD_LAYER]]['tokens'] if st['begin'] <= t['begin'] < st['end']),
                   key=lambda t: t['begin'])
    [glosses] = [x['spans'] for x in layers[s.ids[WORD_LAYER]]['span_layers'] if x['id'] == s.ids[GLOSS]]
    on = {}
    for sp in sorted(glosses, key=lambda sp: sp['value']):
        on[sp['tokens'][0]] = ' | '.join(filter(None, [on.get(sp['tokens'][0]), sp['value']]))
    [trans] = [x['spans'] for x in layers[s.ids[SENT_LAYER]]['span_layers'] if x['id'] == s.ids[TRANS]]
    translation = next((sp['value'] for sp in trans if sp['tokens'] == [st['id']]), None)
    return [(body[t['begin']:t['end']], on.get(t['id'])) for t in words], translation


def _chat(writer, email, s, calls):
    ws = Workspace(writer, load_project(writer, s.project_id))
    said = [call_tool(ws, tool, {'document': 'Alpha', **args}) for tool, args in calls]
    for out in said:
        assert out.startswith('Planned'), said
    _p, h = _approve(writer, email, s.project_id, ws)
    assert not h.errors, h.errors
    return said


def test_a_new_word_typed_in_and_glossed_gets_the_gloss_and_the_persons_word_keeps_its_own():
    """The observed sequence: s2's third word "pa" glossed by a person, a
    plan that types "∅" before it and glosses s2.w3, the new word."""
    admin = _admin()
    email, writer, s = _seeded(admin, 'rr-chat')
    try:
        said = _chat(writer, email, s, [
            ('retype_sentence', {'ref': 's2', 'text': 'sa na ∅ pa ma.'}),
            ('set_field', {'refs': ['s2.w3 "∅"'], 'field': 'Gloss', 'value': 'he'})])
        assert said[0].endswith('s2 once retyped: w1 "sa", w2 "na", w3 "∅" (new), w4 "pa", w5 "ma". In this '
                                'plan s2.wN names these words.')
        words, translation = _glosses(admin, s)
        assert words == [('sa', 'S'), ('na', 'N'), ('∅', 'he'), ('pa', 'P'), ('ma', 'M')]
        assert translation == 'Second.'
        assert _glosses(admin, s, 1) == ([('ka', 'one'), ('ta', None)], 'First.')
    finally:
        s.delete()


def test_a_value_staged_before_the_retype_follows_its_word():
    """The other order: s2.w3 is "pa" when the value is staged, and it keeps
    it once the retype puts "∅" before it."""
    admin = _admin()
    email, writer, s = _seeded(admin, 'rr-chat-other')
    try:
        _chat(writer, email, s, [
            ('set_field', {'refs': ['s2.w3'], 'field': 'Gloss', 'value': 'P2'}),
            ('retype_sentence', {'ref': 's2', 'text': 'sa na ∅ pa ma.'})])
        words, _t = _glosses(admin, s)
        assert words == [('sa', 'S'), ('na', 'N'), ('∅', None), ('pa', 'P2'), ('ma', 'M')]
    finally:
        s.delete()


def test_a_word_typed_out_and_its_neighbour_glossed():
    admin = _admin()
    email, writer, s = _seeded(admin, 'rr-chat-out')
    try:
        said = _chat(writer, email, s, [
            ('retype_sentence', {'ref': 's2', 'text': 'sa na ma.'}),
            ('set_field', {'refs': ['s2.w3 "ma"'], 'field': 'Gloss', 'value': 'M2'})])
        assert said[0].endswith('s2 once retyped: w1 "sa", w2 "na", w3 "ma". In this plan s2.wN names these words.')
        words, _t = _glosses(admin, s)
        assert words == [('sa', 'S'), ('na', 'N'), ('ma', 'M2')]
    finally:
        s.delete()


def _core_words(admin, s, sentence):
    """``[(text, id)]`` of a sentence's words as core holds them."""
    raw = admin.documents.get(s.ids['dA'], include_body=True)
    tl = raw['text_layers'][0]
    body = tl['text']['body']
    layers = {tk['id']: tk for tk in tl['token_layers']}
    st = sorted(layers[s.ids[SENT_LAYER]]['tokens'], key=lambda t: t['begin'])[sentence - 1]
    return [(body[t['begin']:t['end']], t['id']) for t in sorted(
        (t for t in layers[s.ids[WORD_LAYER]]['tokens'] if st['begin'] <= t['begin'] < st['end']),
        key=lambda t: t['begin'])]


def _retyped(admin, writer, email, s, sentence, text):
    """Retype sentence ``sentence`` as ``text`` and approve it. Asserts the
    words the retype listed are the words core then holds: the same text in
    the same order, each the word it was where the list says so and a word
    the sentence did not have where it says new. The words and their glosses
    as core holds them."""
    before = {i for _, i in _core_words(admin, s, sentence)}
    ws = Workspace(writer, load_project(writer, s.project_id))
    out = call_tool(ws, 'retype_sentence', {'document': 'Alpha', 'ref': f's{sentence}', 'text': text})
    assert out.startswith('Planned 1 change'), out
    planned = ws.ops[-1]['planned_words']
    _p, h = _approve(writer, email, s.project_id, ws)
    assert not h.errors, h.errors
    held = _core_words(admin, s, sentence)
    assert [w for w, _ in held] == [p['surface'] for p in planned], (held, planned)
    for (_w, wid), p in zip(held, planned):
        assert wid == p['word_id'] if p['word_id'] else wid not in before, (held, planned)
    return _glosses(admin, s, sentence)[0]


#: A person's value on every word of s2, each case: the new text, and the
#: words with their values once retyped, word by word.
WORD_BY_WORD = {
    'remove a word': ('sa pa ma.', [('sa', 'S'), ('pa', 'P'), ('ma', 'M')]),
    'insert a word': ('sa na ∅ pa ma.', [('sa', 'S'), ('na', 'N'), ('∅', None), ('pa', 'P'), ('ma', 'M')]),
    'replace a word': ('sa ki pa ma.', [('sa', 'S'), ('ki', None), ('pa', 'P'), ('ma', 'M')]),
    'remove two adjacent words': ('sa ma.', [('sa', 'S'), ('ma', 'M')]),
    'change one letter': ('sa na pha ma.', [('sa', 'S'), ('na', 'N'), ('pha', 'P'), ('ma', 'M')]),
    'spacing and punctuation only': ('sa  na, pa ma!', [('sa', 'S'), ('na', 'N'), ('pa', 'P'), ('ma', 'M')]),
    'remove the first word': ('na pa ma.', [('na', 'N'), ('pa', 'P'), ('ma', 'M')]),
    'remove the last word': ('sa na pa.', [('sa', 'S'), ('na', 'N'), ('pa', 'P')]),
    'insert at both ends': ('∅ sa na pa ma ∅.', [('∅', None), ('sa', 'S'), ('na', 'N'), ('pa', 'P'), ('ma', 'M'),
                                                  ('∅', None)]),
    # Fewer old words than new between the same paired words: typed over as
    # one stretch, "ma" shares no letter at either end with "∅ mu" and goes.
    'remove one, insert one, change one': ('sa pa ∅ mu.', [('sa', 'S'), ('pa', 'P'), ('∅', None), ('mu', None)]),
    # One word typed over by two: core keeps the letters it shares (Q2).
    'one word typed over by two': ('sa ni ∅ pa ma.', [('sa', 'S'), ('ni', 'N'), ('∅', None), ('pa', 'P'),
                                                      ('ma', 'M')]),
}


@pytest.mark.parametrize('case', list(WORD_BY_WORD))
def test_a_retype_maps_word_by_word_and_lists_what_core_holds(case):
    text, want = WORD_BY_WORD[case]
    admin = _admin()
    email, writer, s = _seeded(admin, 'rr-words')
    try:
        assert _retyped(admin, writer, email, s, 2, text) == want
        assert _glosses(admin, s, 1)[0] == [('ka', 'one'), ('ta', None)]
    finally:
        s.delete()


def test_a_right_to_left_retype_maps_word_by_word():
    sentences = [{'words': [_word('שלום', 'peace'), _word('עולם', 'world'), _word('טוב', 'good'),
                            _word('מאוד', 'very')], 'translation': ('Hello.', 'human')}]
    admin = _admin()
    email, writer, s = _seeded(admin, 'rr-words-rtl', sentences)
    try:
        assert _retyped(admin, writer, email, s, 1, 'שלום טוב מאד.') == [
            ('שלום', 'peace'), ('טוב', 'good'), ('מאד', 'very')]
    finally:
        s.delete()


def test_a_split_and_a_merge_of_words_with_values_on_both_sides():
    """No text changes: every word keeps its id, and a value names its word
    as the document was read, on either side of the split or the merge: a
    word after it by its form beside the number, since the plan renumbers
    it (a bare number is refused)."""
    admin = _admin()
    email, writer, s = _seeded(admin, 'rr-chat-shape')
    try:
        _chat(writer, email, s, [
            ('split_word', {'ref': 's2.w2', 'at': 1}),
            ('set_field', {'refs': ['s2.w1'], 'field': 'Gloss', 'value': 'S2'}),
            ('set_field', {'refs': ['s2.w3 "pa"'], 'field': 'Gloss', 'value': 'P2'})])
        words, _t = _glosses(admin, s)
        assert words == [('sa', 'S2'), ('n', 'N'), ('a', None), ('pa', 'P2'), ('ma', 'M')]
    finally:
        s.delete()
    email, writer, s = _seeded(admin, 'rr-chat-merge')
    try:
        _chat(writer, email, s, [
            ('set_field', {'refs': ['s2.w1'], 'field': 'Gloss', 'value': 'S2'}),
            ('merge_words', {'refs': ['s2.w2', 's2.w3']}),
            ('set_field', {'refs': ['s2.w4 "ma"'], 'field': 'Gloss', 'value': 'M2'})])
        words, _t = _glosses(admin, s)
        assert words == [('sa', 'S2'), ('na pa', 'N | P'), ('ma', 'M2')]
    finally:
        s.delete()


def test_a_bare_number_a_split_renumbers_is_refused_and_named_by_form_lands_on_the_word_read():
    """s2.w3 is "pa" as read and w4 once "na" is split: its bare number is
    refused, and named with its form it is "pa", applied so."""
    admin = _admin()
    email, writer, s = _seeded(admin, 'rr-chat-renum')
    try:
        ws = Workspace(writer, load_project(writer, s.project_id))
        assert call_tool(ws, 'split_word', {'document': 'Alpha', 'ref': 's2.w2', 'at': 1}).startswith('Planned')
        out = call_tool(ws, 'set_field', {'document': 'Alpha', 'refs': ['s2.w3'], 'field': 'Gloss', 'value': 'P2'})
        assert 'is "pa" now, but this plan\'s split_word renumbers s2: once it is applied, "pa" is w4. Words ' \
               'before w3 keep their numbers.' in out, out
        assert call_tool(ws, 'set_field', {'document': 'Alpha', 'refs': ['s2.w3 "pa"'], 'field': 'Gloss',
                                           'value': 'P2'}).startswith('Planned')
        _p, h = _approve(writer, email, s.project_id, ws)
        assert not h.errors, h.errors
        assert _glosses(admin, s)[0] == [('sa', 'S'), ('n', 'N'), ('a', None), ('pa', 'P2'), ('ma', 'M')]
    finally:
        s.delete()


def test_a_retype_that_joins_two_words_keeps_both_and_numbers_them():
    """A deleted space never joins words: "na pa" typed as "napa" leaves
    two words, as the retype lists them."""
    admin = _admin()
    email, writer, s = _seeded(admin, 'rr-chat-join')
    try:
        said = _chat(writer, email, s, [
            ('retype_sentence', {'ref': 's2', 'text': 'sa napa ma.'}),
            ('set_field', {'refs': ['s2.w3'], 'field': 'Gloss', 'value': 'P2'})])
        assert said[0].endswith('s2 once retyped: w1 "sa", w2 "na", w3 "pa", w4 "ma". In this plan s2.wN names '
                                'these words.')
        words, _t = _glosses(admin, s)
        assert words == [('sa', 'S'), ('na', 'N'), ('pa', 'P2'), ('ma', 'M')]
    finally:
        s.delete()


def test_right_to_left_text():
    sentences = [{'words': [_word('שלום', 'peace'), _word('עולם', 'world'), _word('טוב', 'good')],
                  'translation': ('Hello.', 'human')}]
    admin = _admin()
    email, writer, s = _seeded(admin, 'rr-chat-rtl', sentences)
    try:
        said = _chat(writer, email, s, [
            ('retype_sentence', {'ref': 's1', 'text': 'שלום עולם ∅ טוב.'}),
            ('set_field', {'refs': ['s1.w3 "∅"'], 'field': 'Gloss', 'value': 'it'})])
        assert said[0].endswith('s1 once retyped: w1 "שלום", w2 "עולם", w3 "∅" (new), w4 "טוב". In this plan '
                                's1.wN names these words.')
        words, translation = _glosses(admin, s, 1)
        assert words == [('שלום', 'peace'), ('עולם', 'world'), ('∅', 'it'), ('טוב', 'good')]
        assert translation == 'Hello.'
    finally:
        s.delete()


def _job(admin, writer, s, instructions, pieces):
    from plaid_client import PlaidClient
    made = writer.jobs.create(s.project_id, 'igt', instructions)
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    assert claimed and claimed['job']['id'] == made['id']
    admin.jobs.add_decisions(made['id'], WORKER, [plan_row(pieces, ids=s.ids)])
    offset = {'s': 3600.0}

    def wait(sec):
        offset['s'] += sec
    return Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
               sleep=wait, now=lambda: time.time() + offset['s'])


def test_a_job_piece_types_a_new_word_and_glosses_it(monkeypatch):
    """The same through a job: the piece retypes s2 with "∅" before "pa" and
    glosses s2.w3, the new word. The person's glosses stay, the new word has
    the job's, and the report names the change on s2.w3."""
    admin = _admin()
    _email, writer, s = _seeded(admin, 'rr-job')
    try:
        def answer(asked, n, kwargs):
            if 'Your piece: the whole document' not in asked or n > 1:
                return reply('Typed the zero subject in and glossed it.')
            return reply(calls=[
                call(1, 'retype_sentence', {'document': 'Alpha', 'ref': 's2', 'text': 'sa na ∅ pa ma.'}),
                call(2, 'set_field', {'document': 'Alpha', 'refs': ['s2.w3 "∅"'], 'field': 'Gloss', 'value': 'he'})])
        use(monkeypatch, Model(answer))
        job = _job(admin, writer, s, 'Type a zero subject before pa in s2 and gloss it "he".', 'document')
        finished = run_job(job, IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                          count=count_chars, write_summary=False))
        assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
        words, translation = _glosses(admin, s)
        assert words == [('sa', 'S'), ('na', 'N'), ('∅', 'he'), ('pa', 'P'), ('ma', 'M')]
        assert translation == 'Second.'
        report = finished['report']
        assert report['proposed'] == [], report['proposed']
        assert report['totals']['changes'] == 2, report['totals']
    finally:
        s.delete()


def test_a_split_of_a_retyped_sentence_is_refused_and_lands_where_its_card_says_once_the_retype_is_applied():
    """REV-RR-1: after a retype numbered s2's words anew, split_sentence
    before_word 3 split before the old third word. It is refused in the
    plan that retypes, and in the next plan the split lands where its card
    row says."""
    admin = _admin()
    email, writer, s = _seeded(admin, 'rr-fix-split')
    try:
        ws = Workspace(writer, load_project(writer, s.project_id))
        assert call_tool(ws, 'retype_sentence', {'document': 'Alpha', 'ref': 's2', 'text': 'sa ∅ na pa ma.'}) \
            .startswith('Planned')
        out = call_tool(ws, 'split_sentence', {'document': 'Alpha', 'ref': 's2', 'before_word': 3})
        assert out.endswith('Split it once the retype is applied.'), out
        _p, h = _approve(writer, email, s.project_id, ws)
        assert not h.errors, h.errors
        ws = Workspace(writer, load_project(writer, s.project_id))
        assert call_tool(ws, 'split_sentence', {'document': 'Alpha', 'ref': 's2', 'before_word': 3}) \
            .startswith('Planned')
        assert 'split before w3 "na"' in ws.ops[-1]['label'].replace('⁨', '').replace('⁩', '')
        _p, h = _approve(writer, email, s.project_id, ws)
        assert not h.errors, h.errors
        assert [w for w, _g in _glosses(admin, s, 2)[0]] == ['sa', '∅']
        assert _glosses(admin, s, 3)[0] == [('na', 'N'), ('pa', 'P'), ('ma', 'M')]
    finally:
        s.delete()


def test_a_morpheme_of_a_renumbered_word_is_refused_with_its_form_or_without():
    """REV-RR2-1, the reviewer's case: in "ka sa-di pa-di." both -di are
    spelled alike, so after delete_word s1.w1 the ref s1.w2.m2 "di" names
    the -di of "sa-di" as read and of "pa-di" once applied alike. Refused,
    bare or with the morpheme's form. Once the delete is applied, s1.w2.m2
    is the -di of "pa-di", and the value lands there."""
    admin = _admin()
    di = [{'form': 'ka', 'gloss': ('K', 'human')},
          {'form': 'sa-di', 'gloss': ('S', 'human'), 'morphs': [('sa', 'sit'), ('di', '')]},
          {'form': 'pa-di', 'gloss': ('P', 'human'), 'morphs': [('pa', 'eat'), ('di', '')]}]
    email, writer, s = _seeded(admin, 'rr-fix-morph', [{'words': di}])
    try:
        ws = Workspace(writer, load_project(writer, s.project_id))
        assert call_tool(ws, 'delete_word', {'document': 'Alpha', 'refs': ['s1.w1']}).startswith('Planned')
        for ref in ('s1.w2.m2', 's1.w2.m2 "di"'):
            out = call_tool(ws, 'set_field', {'document': 'Alpha', 'refs': [ref], 'field': 'Morph Gloss',
                                              'value': 'loc'})
            assert out.endswith('Plan it once the plan is applied.'), (ref, out)
        assert [o['kind'] for o in ws.ops] == ['delete_word']
        _p, h = _approve(writer, email, s.project_id, ws)
        assert not h.errors, h.errors
        ws = Workspace(writer, load_project(writer, s.project_id))
        assert call_tool(ws, 'set_field', {'document': 'Alpha', 'refs': ['s1.w2.m2 "di"'], 'field': 'Morph Gloss',
                                           'value': 'loc'}).startswith('Planned')
        _p, h = _approve(writer, email, s.project_id, ws)
        assert not h.errors, h.errors
        doc = Workspace(writer, load_project(writer, s.project_id)).doc('Alpha')
        got = [(w.surface, [(m.form, m.fields['Morph Gloss'].value if 'Morph Gloss' in m.fields else None)
                            for m in w.morphemes]) for w in doc.sentences[0].words]
        assert got == [('sa-di', [('sa', 'sit'), ('di', None)]), ('pa-di', [('pa', 'eat'), ('di', 'loc')])], got
    finally:
        s.delete()
