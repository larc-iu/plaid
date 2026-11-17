"""A word named by its number in a sentence whose words have changed since
this conversation last read it is refused at staging (2026-11-17 survey, item
5): a model planned 85 values from positions it had read in an earlier turn,
after zero tokens had been inserted into the text, and 22 of them landed on
other words. What a turn showed the model of each sentence (read_document) is
kept on its reply as a short print of the sentence's words (``read``), and a
staging call in a later turn compares the sentence as it is now with that
print. A sentence read again in the turn, one run_code loaded in the turn, and
one never read are not asked. A job's piece reads its sentences fresh and has
no conversation, so it is never refused by this."""

import copy

from fixtures import FakeClient, document_raw, fake_ws

from plaid_agent.core import turn as turn_mod
from plaid_agent.core.agent import TurnResult
from plaid_agent.core.conversation import ConversationStore, build_meta, earlier_reads, user_item
from plaid_agent.core.limits import READ_PRINTS_MAX
from plaid_agent.igt.toolkit import call_tool
from test_service_flow import Helper, _request, _service

MOVED = ('"Text 1" s1.w2: the words of s1 have changed since this conversation read them. Read s1 again with '
         'read_document and name its words by the numbers it shows now.')


def _insert_word(raw, at=7, form='pro', wid='w-new'):
    """``raw`` with a word typed into the body at ``at`` (a person's edit made
    between two turns): every offset after it moves, and the sentence grows."""
    raw = copy.deepcopy(raw)
    n = len(form) + 1
    for tl in raw['text_layers']:
        tl['text']['body'] = tl['text']['body'][:at] + form + ' ' + tl['text']['body'][at:]
        for tk in tl['token_layers']:
            for t in tk['tokens']:
                if t['begin'] >= at:
                    t['begin'] += n
                if t['end'] > at or (t['end'] == at and t['begin'] < at and tk['id'] == 'tk-sent'):
                    t['end'] += n
            if tk['id'] == 'tk-word':
                tk['tokens'].append({'id': wid, 'begin': at, 'end': at + len(form)})
                tk['tokens'].sort(key=lambda t: t['begin'])
    raw['version'] += 1
    return raw


class Conversation:
    """A conversation on the fake, one turn at a time, each turn a script of
    tool calls run through the service as a model's would be."""

    def __init__(self, monkeypatch):
        self.monkeypatch = monkeypatch
        self.docs = {'d1': document_raw()}
        self.client = FakeClient(documents=self.docs)
        self.store = ConversationStore(self.client, 'u@x', 'p1', 'igt')
        self.n = 0

    def turn(self, *calls):
        """Run one turn whose model makes ``calls`` (``(tool, args)``) and
        answers; the answers of the calls, in order."""
        self.n += 1
        text = f'message {self.n}'
        if self.n == 1:
            conv, meta = {'messages': [], 'display': []}, None
        else:
            conv, meta = self.store.load('c1')
        conv['messages'].append({'role': 'user', 'content': text})
        conv['display'].append(user_item(text))
        rid = f'r{self.n}'
        self.store.save('c1', conv, build_meta(meta, 'c1', conv, 'igt:assist:fake', 'fake/model',
                                               pending={'kind': 'turn', 'request_id': rid}))
        outs = []

        def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
            for name, args in calls:
                outs.append(kit.call_tool(ws, name, args))
            return TurnResult('Done.', [{'role': 'assistant', 'content': 'Done.'}], [])

        self.monkeypatch.setattr(turn_mod, 'run_turn', fake_run_turn)
        helper = Helper(request_id=rid)
        _service().process_request(_request(self.client), helper)
        assert not helper.errors, helper.errors
        return outs

    def edit(self, change):
        """A person's edit between two turns."""
        self.docs['d1'] = change(self.docs['d1'])

    def last_item(self):
        return self.store.load('c1')[0]['display'][-1]

    def planned_on(self):
        """The tokens the last reply's plan writes values on."""
        return [op.get('token_id') for op in (self.last_item()['plan'] or {}).get('ops') or []]


READ_S1 = ('read_document', {'document': 'Text 1', 'sentences': [1]})


def _gloss(ref, value='x'):
    return 'set_field', {'document': 'Text 1', 'refs': [ref], 'field': 'Gloss', 'value': value}


def test_a_sentence_a_person_changed_since_the_last_read_is_refused_by_number(monkeypatch):
    c = Conversation(monkeypatch)
    c.turn(READ_S1)
    assert set(c.last_item()['read']['d1']) == {'1'}
    c.edit(_insert_word)
    out, = c.turn(_gloss('s1.w2'))
    assert out == f'Error: {MOVED}'
    assert c.last_item()['plan'] is None


def test_read_again_in_the_turn_the_same_number_is_planned(monkeypatch):
    c = Conversation(monkeypatch)
    c.turn(READ_S1)
    c.edit(_insert_word)
    _read, out = c.turn(READ_S1, _gloss('s1.w2'))
    assert out.startswith('Planned') and c.planned_on() == ['w-new']
    # And the next turn reads the sentence as this one showed it.
    out, = c.turn(_gloss('s1.w3'))
    assert out.startswith('Planned') and c.planned_on() == ['w-2']


def test_an_unchanged_sentence_is_planned_with_no_read_forced(monkeypatch):
    c = Conversation(monkeypatch)
    c.turn(READ_S1)
    # An edit in another sentence, and a value changed in this one: its words are as read.
    c.edit(lambda raw: _insert_word(raw, at=24, form='kwa', wid='w-s2'))

    def glossed(raw):
        raw = copy.deepcopy(raw)
        raw['text_layers'][0]['token_layers'][1]['span_layers'][0]['spans'].append(
            {'id': 'sp-g2', 'value': 'fish', 'tokens': ['w-2']})
        return raw
    c.edit(glossed)
    out, = c.turn(_gloss('s1.w3'))
    assert out.startswith('Planned') and c.planned_on() == ['w-3']


def test_a_word_named_with_its_form_or_a_sentence_never_read_is_not_asked(monkeypatch):
    c = Conversation(monkeypatch)
    c.turn(READ_S1)
    c.edit(_insert_word)
    form, other = c.turn(_gloss('s1.w3 "gam"'), _gloss('s2.w1'))
    assert form.startswith('Planned') and other.startswith('Planned') and c.planned_on() == ['w-2', 'w-4']


def test_a_sentence_reshaped_by_an_applied_plan_is_refused_and_one_waiting_is_not(monkeypatch):
    c = Conversation(monkeypatch)
    c.turn(READ_S1, ('merge_words', {'document': 'Text 1', 'refs': ['s1.w2', 's1.w3']}))
    assert c.last_item()['plan'] is not None
    # The plan waits on its card: the text is as read, and the plan's own
    # renumbering is the retype and reshape guards' (igt/retyped.py).
    out, = c.turn(_gloss('s1.w1'))
    assert 'Planned' in out
    # Applied (the merge as core writes it): w-2 now spans "gam akuna".

    def merged(raw):
        raw = copy.deepcopy(raw)
        words = raw['text_layers'][0]['token_layers'][1]['tokens']
        words[:] = [t for t in words if t['id'] != 'w-3']
        next(t for t in words if t['id'] == 'w-2')['end'] = 16
        raw['version'] += 1
        return raw
    c.edit(merged)
    out, = c.turn(_gloss('s1.w2'))
    assert out == f'Error: {MOVED}'


def test_code_that_loads_the_document_plans_by_the_numbers_it_read(monkeypatch):
    c = Conversation(monkeypatch)
    c.turn(READ_S1)
    c.edit(_insert_word)
    code = ('d = load("Text 1")\n'
            'w = [w for w in d["sentences"][0]["words"] if w["surface"] == "gam"][0]\n'
            'print(plan("set_field", document="Text 1", refs=[w["ref"]], field="Gloss", value="fish"))')
    out, = c.turn(('run_code', {'code': code}))
    if 'not available' in out or 'cannot run' in out.lower():
        import pytest
        pytest.skip('no sandbox worker here')
    assert 'Planned' in out and 'have changed' not in out


def test_the_refusal_lists_every_changed_sentence_of_the_document(monkeypatch):
    c = Conversation(monkeypatch)
    c.turn(('read_document', {'document': 'Text 1', 'sentences': [1, 2]}))
    c.edit(_insert_word)
    c.edit(lambda raw: _insert_word(raw, at=28, form='kwa', wid='w-s2'))
    out, = c.turn(_gloss('s2.w1'))
    assert out == ('Error: "Text 1" s2.w1: the words of s1 and s2 have changed since this conversation read them. '
                   'Read them again with read_document and name their words by the numbers it shows now.')


def test_a_workspace_outside_a_conversation_never_refuses():
    # A job's piece: no earlier turn, so nothing to compare with.
    client = FakeClient(documents={'d1': _insert_word(document_raw())})
    ws = fake_ws(client)
    out = call_tool(ws, *_gloss('s1.w2'))
    assert out.startswith('Planned')
    # A job's workspace is made the same way, never from a conversation.
    from plaid_agent.igt.job import JobWorkspace
    piece = JobWorkspace(client, ws.project)
    assert piece.read_before == {}
    piece.planning = True
    piece.refuse_moved_sentence(piece.doc('Text 1'), 1, 's1.w2')


def test_earlier_reads_take_the_newest_turn_and_the_record_is_capped():
    display = [user_item('a'), {'kind': 'assistant', 'read': {'d1': {'1': 'aaaa', '2': 'bbbb'}}},
               {'kind': 'error', 'read': {'d1': {'1': 'zzzz'}}},
               {'kind': 'assistant', 'read': {'d1': {'1': 'cccc'}, 'd2': {'4': 'dddd'}}}]
    assert earlier_reads(display) == {'d1': {'1': 'cccc', '2': 'bbbb'}, 'd2': {'4': 'dddd'}}
    ws = fake_ws(FakeClient())
    ws.read_now = {'d1': {i: 'p' for i in range(1, READ_PRINTS_MAX + 50)}}
    kept = ws.reads_kept()
    assert len(kept['d1']) == READ_PRINTS_MAX and kept['d1']['1'] == 'p'


def _segmented_again(raw):
    """A person gives s1.w1 a prefix: its morphemes renumber (m2 is "Ali" now)."""
    raw = copy.deepcopy(raw)
    raw['text_layers'][0]['token_layers'][2]['tokens'].append(
        {'id': 'm-1z', 'begin': 0, 'end': 6, 'precedence': 0, 'metadata': {'form': 'a', 'morphType': 'prefix'}})
    raw['version'] += 1
    return raw


def test_a_morpheme_named_by_number_after_a_person_resegments_its_word_is_refused(monkeypatch):
    """REV-SVB-3: the print holds each word's morphemes."""
    c = Conversation(monkeypatch)
    c.turn(READ_S1)
    c.edit(_segmented_again)
    out, = c.turn(('set_field', {'document': 'Text 1', 'refs': ['s1.w1.m2'], 'field': 'Morph Gloss', 'value': 'ERG'}))
    assert out.startswith('Error: "Text 1" s1.w1.m2: '), out


def test_a_value_on_a_morpheme_does_not_move_the_print(monkeypatch):
    c = Conversation(monkeypatch)
    c.turn(READ_S1)

    def glossed(raw):
        raw = copy.deepcopy(raw)
        raw['text_layers'][0]['token_layers'][2]['span_layers'][0]['spans'][1]['value'] = 'PL'
        raw['version'] += 1
        return raw
    c.edit(glossed)
    out, = c.turn(('set_field', {'document': 'Text 1', 'refs': ['s1.w1.m2'], 'field': 'Morph Gloss', 'value': 'ERG'}))
    assert out.startswith('Planned'), out


CODE_REFS = ('run_code', {'code': 'd = load("Text 1")\n'
                                  'print([(w["ref"], w["surface"]) for w in d["sentences"][0]["words"]])'})


def test_numbers_code_printed_in_an_earlier_turn_are_held_to_the_sentence_as_loaded(monkeypatch):
    """REV-SVB-1: run_code's load() records what the code read."""
    c = Conversation(monkeypatch)
    out, = c.turn(CODE_REFS)
    assert "('s1.w2', 'gam')" in out, out
    assert set(c.last_item()['read']['d1']) == {'1', '2'}
    c.edit(_insert_word)
    out, = c.turn(_gloss('s1.w2'))
    assert out == f'Error: {MOVED}'


CONCORDANCE = ('concordance', {'pattern': 'gam', 'where': 'baseline'})


def test_numbers_a_concordance_just_showed_are_planned_by(monkeypatch):
    """REV-SVB-4: a corpus tool's hits record their sentences, so staging by
    the number it just printed is no false refusal..."""
    c = Conversation(monkeypatch)
    c.turn(READ_S1)
    c.edit(_insert_word)
    hits, out = c.turn(CONCORDANCE, _gloss('s1.w3'))
    assert 's1.w3' in hits, hits
    assert out.startswith('Planned') and c.planned_on() == ['w-2'], out


def test_numbers_a_concordance_showed_in_an_earlier_turn_are_held_to_that(monkeypatch):
    """...and one it printed in an earlier turn is held to the sentence as it
    printed it."""
    c = Conversation(monkeypatch)
    hits, = c.turn(CONCORDANCE)
    assert 's1.w2' in hits, hits
    c.edit(_insert_word)
    out, = c.turn(_gloss('s1.w2'))
    assert out == f'Error: {MOVED}'


def test_a_split_before_a_remembered_word_number_is_refused(monkeypatch):
    """REV-SVB-2: before_word is a word number read earlier."""
    c = Conversation(monkeypatch)
    c.turn(READ_S1)
    c.edit(_insert_word)
    out, = c.turn(('split_sentence', {'document': 'Text 1', 'ref': 's1', 'before_word': 3}))
    assert out == ('Error: "Text 1" s1: the words of s1 have changed since this conversation read them. Read s1 '
                   'again with read_document and name its words by the numbers it shows now.'), out


def test_analyze_sentence_names_words_by_their_order_and_is_held_to_the_read(monkeypatch):
    c = Conversation(monkeypatch)
    c.turn(READ_S1)
    c.edit(_insert_word)
    out, = c.turn(('analyze_sentence', {'document': 'Text 1', 'sentences': [
        {'ref': 's1', 'words': ['Ali-di Ali-ERG', 'gam fish', 'akuna see']}]}))
    assert 'the words of s1 have changed since this conversation read them' in out, out
