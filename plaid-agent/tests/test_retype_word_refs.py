"""Word references into a sentence the plan retypes (BRIEF RR).

Users annotate zero arguments by typing a null symbol into a sentence as a new
word and annotating it. A job retyped s6 with "∅" as its third word and set a
word gloss on s6.w3, meaning the new word: the tool read s6.w3 against the
sentence as read, the gloss went onto the word that was third, a person's, and
the new word got nothing. Now, once a plan holds a retype of a sentence, its
word references name its words as planned (listed by the retype's answer), a
word value on one is written once the retype is, on that word, and every other
change naming a word or morpheme of the sentence is refused, in both orders.

First the class map: every op that changes which words a sentence has or where
they are, beside every op that names a word, a morpheme or the sentence's
values in that sentence, both orders. Then what approval writes, on a fake
server that makes the words a retype leaves."""

import copy

import pytest

from fixtures import GLOSS, FakeClient, document_raw, fake_ws
from plaid_client import apply_text_ops

from plaid_agent.igt.plan import PlanError, execute_plan, normalize_ops
from plaid_agent.igt.project import load_project
from plaid_agent.core.tools import ValueRefusal
from plaid_agent.igt.toolkit import call_tool

RETYPED = 's1 is retyped in this plan, so its words are renumbered when it is applied'


def machine_raw():
    """The fixture, w1's analysis machine-made (so a discard has work)."""
    raw = document_raw()
    for layer in raw['text_layers'][0]['token_layers']:
        for t in layer['tokens']:
            if t['id'] in ('m-1a', 'm-1b'):
                t['metadata'] = {**(t.get('metadata') or {}), 'prov': 'inferred', 'provSource': 'service:x'}
    return raw


def ws(raw=None):
    return fake_ws(FakeClient(documents={'d1': raw or machine_raw()}))


# --- the class map ----------------------------------------------------------------

# s1 is "Ali-di gam akuna." (w1 analysed and glossed, w2, w3), s2 "Gam-ar.".
SHAPES = {
    'retype': ('retype_sentence', {'ref': 's1', 'text': 'Ali-di ∅ gam akuna.'}),
    'split_word': ('split_word', {'ref': 's1.w3', 'at': 2}),
    'merge_words': ('merge_words', {'refs': ['s1.w2', 's1.w3']}),
    'delete_word': ('delete_word', {'refs': ['s1.w3']}),
    'split_sentence': ('split_sentence', {'ref': 's1', 'before_word': 3}),
    'merge_sentences': ('merge_sentences', {'ref': 's2'}),
    'respell': ('respell', {'ref': 's1.w3', 'new_text': 'akunaa'}),
    'delete_sentence': ('delete_sentence', {'refs': ['s1']}),
}
ANNOTATIONS = {
    'set_field word': ('set_field', {'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'X'}),
    'set_field morpheme': ('set_field', {'refs': ['s1.w1.m1'], 'field': 'Morph Gloss', 'value': 'PL'}),
    'set_field sentence': ('set_field', {'refs': ['s1'], 'field': 'Translation', 'value': 'X'}),
    'set_analysis': ('set_analysis', {'ref': 's1.w2', 'morphemes': [{'form': 'ga'}, {'form': 'm'}]}),
    'analyze_sentence': ('analyze_sentence', {'sentences': [{'ref': 's1', 'words': [
        'Ali-di Ali-ERG', 'gam fish', 'akuna see']}]}),
    'set_morpheme': ('set_morpheme', {'ref': 's1.w1.m1', 'form': 'Alu'}),
    'link_entry': ('link_entry', {'refs': ['s1.w2'], 'entry_form': 'gam', 'entry_gloss': 'fish'}),
    'unlink_entry': ('unlink_entry', {'refs': ['s1.w1']}),
    'link_phrase': ('link_phrase', {'refs': ['s1.w2', 's1.w3'], 'entry_form': 'gam', 'entry_gloss': 'fish'}),
    'add_comment': ('add_comment', {'ref': 's1.w2', 'body': 'note'}),
    'discard_analysis': ('discard_analysis', {'refs': ['s1.w1']}),
    'delete_word': ('delete_word', {'refs': ['s1.w2']}),
    'set_orthography': ('set_orthography', {'refs': ['s1.w2'], 'orthography': 'IPA', 'value': 'gam'}),
}

#: Pairs refused at staging, in both orders, by the guards that were there
#: before (the certain-delete and shape guards, the analysis and comment
#: guards, refuse_text_in_deleted_sentence), unless marked with the order.
REFUSED_BEFORE = {
    ('retype', 'set_analysis'), ('retype', 'analyze_sentence'), ('retype', 'add_comment'),
    ('retype', 'discard_analysis'), ('split_word', 'analyze_sentence'), ('merge_words', 'set_analysis'),
    ('merge_words', 'analyze_sentence'), ('merge_words', 'link_phrase'), ('merge_words', 'delete_word'),
    ('delete_word', 'analyze_sentence'), ('delete_word', 'link_phrase'),
    *(('delete_sentence', a) for a in ANNOTATIONS if a not in ('unlink_entry', 'delete_word')),
}
#: Refused now, by the retype guard (`retyped`): a word or morpheme of a
#: retyped sentence named by anything but a word value.
REFUSED_NOW = {('retype', a) for a in ANNOTATIONS
               if a not in ('set_field word', 'set_field sentence')} - REFUSED_BEFORE
#: Refused now, by the renumbering refusal (`retyped.renumbered`), only when
#: the deletion of s1.w2 is staged first: it renumbers s1.w3, which the split,
#: the delete or the respell then names by its bare number. Staged the other
#: way, the split, delete or respell of s1.w3 holds its word's id and the delete of s1.w2 names
#: a word before it, so both stand, as plaid-ud's rule has it (REV-RR-4).
RENUMBERED = {('split_word', 'delete_word'), ('delete_word', 'delete_word'), ('respell', 'delete_word')}


def _stage(w, tool, args):
    n, ops = len(w.ops), list(w.ops)
    out = call_tool(w, tool, {'document': 'd1', **args})
    return out, len(w.ops) > n or w.ops != ops


@pytest.mark.parametrize('order', ['shape first', 'annotation first'])
@pytest.mark.parametrize('annotation', list(ANNOTATIONS))
@pytest.mark.parametrize('shape', list(SHAPES))
def test_the_class_map(shape, annotation, order):
    """Each pair ends right or is refused at staging, whichever is staged
    first. Right: a shape op that is not a text edit leaves every word its
    id, and a change names its word by id, as the document was read; a word
    value on a retyped sentence names its word as planned."""
    w = ws()
    steps = [SHAPES[shape], ANNOTATIONS[annotation]]
    if order == 'annotation first':
        steps.reverse()
    said = []
    for tool, args in steps:
        out, staged = _stage(w, tool, args)
        said.append(out)
        if not staged:
            break
    pair = (shape, annotation)
    if pair in RENUMBERED and order == 'annotation first':
        assert said[-1].startswith('Error:') and 'renumbers s1' in said[-1], (pair, order, said)
        return
    if pair in REFUSED_BEFORE or pair in REFUSED_NOW:
        assert said[-1].startswith('Error:') or said[-1].startswith('Nothing'), (pair, order, said)
        if pair in REFUSED_NOW:
            assert any(x in said[-1] for x in (RETYPED, 'a retype renumbers its words', 'retyped in this plan')), \
                (pair, order, said)
        return
    assert len(said) == 2 and not said[-1].startswith('Error'), (pair, order, said)
    out, notes = normalize_ops(copy.deepcopy(w.ops))
    assert len(out) == len(w.ops) and not notes, (pair, order, notes)
    if shape == 'retype' and annotation == 'set_field word':
        value = next(o for o in w.ops if o['kind'] == 'set_span')
        if order == 'shape first':
            # s1.w2 is the new word "∅", named by its place once retyped
            assert value['planned_word'] == {'sentence_id': 's-1', 'index': 2, 'surface': '∅', 'word_id': None}
            assert value['label'] == 'Text 1 s1.w2 "∅" (new): Gloss = "X"'
        else:
            # s1.w2 was "gam" when it was named: it keeps it, as w3 once retyped
            assert value['planned_word'] == {'sentence_id': 's-1', 'index': 3, 'surface': 'gam', 'word_id': 'w-2'}
            assert value['label'] == 'Text 1 s1.w3 "gam": Gloss = "X"'


def test_the_retype_lists_the_words_it_plans_and_refs_name_them():
    w = ws()
    out = call_tool(w, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali-di ∅ gam akuna.'})
    assert out.endswith('s1 once retyped: w1 "Ali-di", w2 "∅" (new), w3 "gam", '
                        'w4 "akuna". In this plan s1.wN names these words.')
    # past the planned count, and a form that is not the word there
    assert call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w5'], 'field': 'Gloss', 'value': 'x'}) \
        .startswith('Error: s1.w5: s1 once retyped: w1')
    assert 'is "gam" once retyped, not "akuna"' in call_tool(
        w, 'set_field', {'document': 'd1', 'refs': ['s1.w3 "akuna"'], 'field': 'Gloss', 'value': 'x'})
    # a word by its form, and the sentence's own values, as ever
    assert call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1."∅"'], 'field': 'Gloss', 'value': 'he'}) \
        .startswith('Planned 1 change')
    assert w.ops[-1]['planned_word']['index'] == 2
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1'], 'field': 'Translation', 'value': 'He saw.'})
    assert w.ops[-1]['token_id'] == 's-1' and 'planned_word' not in w.ops[-1]
    # a morpheme of the retyped sentence is refused
    assert RETYPED in call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1.m1'], 'field': 'Morph Gloss',
                                                 'value': 'PL'})
    # the same value again is one change, last wins
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'she'})
    assert [o.get('value') for o in w.ops if o.get('planned_word')] == ['she']


def test_a_retype_whose_words_cannot_be_numbered_refuses_word_values():
    """A space typed inside a word, or new text of two sentences: the words
    once retyped are the server's to cut, so none is named before."""
    for text in ('Ali-di gam aku na.', 'Ali-di gam.\nAkuna.'):
        w = ws()
        out = call_tool(w, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': text})
        assert out.endswith('Its words cannot be numbered before it is applied: plan values on them once the '
                            'retype is applied.'), out
        got = call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'x'})
        assert 'cannot be numbered before it is applied' in got
        # and staged first, the value refuses the retype
        w2 = ws()
        call_tool(w2, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'x'})
        assert 'cannot be numbered before it is applied' in call_tool(
            w2, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': text})


def test_a_value_on_a_word_the_retype_takes_refuses_the_retype():
    w = ws()
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'x'})
    out = call_tool(w, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali-di akuna.'})
    assert 'this plan already has a value on a word this retype takes away' in out
    assert [o['kind'] for o in w.ops] == ['set_span']


def test_a_second_retype_moves_the_values_on_its_words_and_refuses_one_on_a_word_the_first_made():
    w = ws()
    call_tool(w, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali-di ∅ gam akuna.'})
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w3'], 'field': 'Gloss', 'value': 'fish'})
    out = call_tool(w, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali-di gam ∅ akuna.'})
    assert out.startswith('Planned 1 change'), out
    assert [o['planned_word']['index'] for o in w.ops if o.get('planned_word')] == [2]
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w3'], 'field': 'Gloss', 'value': 'he'})
    assert 'an earlier retype made' in call_tool(w, 'retype_sentence', {'document': 'd1', 'ref': 's1',
                                                                        'text': 'Ali-di gam ∅ akuna ∅.'})


# --- approval, on a fake server ---------------------------------------------------------------


class _Server:
    """The text edit as core makes it, as far as these tests need: the body
    edited, every token moved with the text around it, and the word layer of
    the edited text as ``words`` says (``(begin, end, id)``, None for a word
    the server makes). A span on a word that is gone goes with it."""

    def __init__(self, c, words):
        self.c, self.words = c, words
        c.texts.edit = self.edit

    def edit(self, text_id, edits, audit_message=None, *, base=None, versioned=None, tokenize_layer=None):
        raw = self.c._documents['d1']
        tl = raw['text_layers'][0]
        sents, word_layer = tl['token_layers'][0], tl['token_layers'][1]
        first_end = min(t['end'] for t in sents['tokens'])
        later = {t['id'] for t in word_layer['tokens'] if t['begin'] >= first_end}
        for e in edits:
            for layer in tl['token_layers']:
                for t in layer['tokens']:
                    t['begin'], t['end'] = self._move(t['begin'], e, True), self._move(t['end'], e, False)
        tl['text']['body'] = apply_text_ops(tl['text']['body'], edits)
        old = {t['id']: t for t in word_layer['tokens']}
        made = [dict(old.get(wid) or {}, id=wid or f'w-made-{i}', begin=b, end=e)
                for i, (b, e, wid) in enumerate(self.words)]
        word_layer['tokens'] = made + [t for i, t in old.items() if i in later]
        ids = {t['id'] for t in word_layer['tokens']}
        for sl in word_layer['span_layers']:
            sl['spans'] = [sp for sp in sl['spans'] if all(x in ids for x in sp['tokens'])]
        self.c.record('texts.edit', (text_id, edits))
        return {'id': text_id}

    @staticmethod
    def _move(p, e, begin):
        i = e['index']
        if e['type'] == 'insert':
            n = len(e['value'])
            return p + n if (p > i or (begin and p == i)) else p
        n = e['value'] if e['type'] == 'delete' else e['length']
        add = 0 if e['type'] == 'delete' else len(e['value'])
        if p >= i + n:
            return p - n + add
        return min(p, i) if p <= i else i + (add if not begin else 0)


def _words_of(c):
    tl = c._documents['d1']['text_layers'][0]
    body = tl['text']['body']
    return [(t['id'], body[t['begin']:t['end']]) for t in sorted(tl['token_layers'][1]['tokens'],
                                                                  key=lambda t: t['begin'])]


def _glossed():
    """The fixture with w2 "gam" glossed by a person."""
    raw = document_raw()
    raw['text_layers'][0]['token_layers'][1]['span_layers'][0]['spans'].append(
        {'id': 'sp-g2', 'value': 'fish', 'tokens': ['w-2']})
    return raw


def _approve(w, c):
    ops, notes = normalize_ops(copy.deepcopy(w.ops))
    assert not notes
    return execute_plan(c, ops, source='s', label='l', project=load_project(c, 'p1'))


INSERTED = [(0, 6, 'w-1'), (7, 8, None), (9, 12, 'w-2'), (13, 18, 'w-3'), (18, 19, 'w-p')]


def test_the_observed_sequence_glosses_the_new_word_and_keeps_the_persons():
    """Retype inserting "∅" before a glossed word, then a gloss on s1.w2 (the
    new word): approved, the new word has the gloss and the person's word
    keeps its own."""
    c = FakeClient(documents={'d1': _glossed()})
    _Server(c, INSERTED)
    w = fake_ws(c)
    call_tool(w, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali-di ∅ gam akuna.'})
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'he'})
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w4'], 'field': 'Gloss', 'value': 'see'})
    counts = _approve(w, c)
    assert counts['field values'] == 2
    assert _words_of(c)[:4] == [('w-1', 'Ali-di'), ('w-made-1', '∅'), ('w-2', 'gam'), ('w-3', 'akuna')]
    # the edit, then ONE batch after it with the values on the words it left
    assert [k for k, _ in c.writes if k == 'texts.edit'] == ['texts.edit']
    [batch] = c.batches
    made = sorted((p['args'][0], tuple(p['args'][1]), p['args'][2]) for k, p in batch if k == 'spans.create')
    assert made == [(GLOSS, ('w-3',), 'see'), (GLOSS, ('w-made-1',), 'he')]
    assert not [k for k, _ in batch if k != 'spans.create']
    spans = c._documents['d1']['text_layers'][0]['token_layers'][1]['span_layers'][0]['spans']
    assert {sp['id']: (sp['value'], sp['tokens']) for sp in spans} == {
        'sp-g1': ('Ali', ['w-1']), 'sp-g2': ('fish', ['w-2'])}


def test_a_value_staged_before_the_retype_stays_on_its_word():
    c = FakeClient(documents={'d1': _glossed()})
    _Server(c, INSERTED)
    w = fake_ws(c)
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'fish (n)'})
    call_tool(w, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali-di ∅ gam akuna.'})
    _approve(w, c)
    [batch] = c.batches
    assert [(k, p) for k, p in batch] == [('spans.bulk_update', [
        {'id': 'sp-g2', 'value': 'fish (n)', 'metadata': batch[0][1][0]['metadata']}])]
    assert not c.payloads('spans.create')


def test_a_sentence_that_comes_out_otherwise_is_refused_and_no_value_written():
    """The server joined "∅" to the word after it: s1.w2 would be "∅gam",
    not the word planned, so nothing is written on the sentence's words."""
    c = FakeClient(documents={'d1': _glossed()})
    _Server(c, [(0, 6, 'w-1'), (7, 12, 'w-2'), (13, 18, 'w-3'), (18, 19, 'w-p')])
    w = fake_ws(c)
    call_tool(w, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali-di ∅ gam akuna.'})
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'he'})
    with pytest.raises(PlanError, match='reads as the words .* not as planned'):
        _approve(w, c)
    assert not c.batches and not c.payloads('spans.create')


def test_a_deleted_word_and_a_value_on_its_neighbour():
    c = FakeClient(documents={'d1': _glossed()})
    _Server(c, [(0, 6, 'w-1'), (7, 12, 'w-3'), (12, 13, 'w-p')])
    w = fake_ws(c)
    out = call_tool(w, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali-di akuna.'})
    assert out.endswith('s1 once retyped: w1 "Ali-di", w2 "akuna". In this plan s1.wN '
                        'names these words.')
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'see'})
    _approve(w, c)
    [batch] = c.batches
    assert [(p['args'][1], p['args'][2]) for k, p in batch if k == 'spans.create'] == [(['w-3'], 'see')]


def test_the_executor_refuses_a_planned_value_whose_retype_is_not_in_the_plan():
    w = ws()
    call_tool(w, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali-di ∅ gam akuna.'})
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'he'})
    c = FakeClient()
    with pytest.raises(ValueRefusal, match='names a word of a retyped sentence'):
        execute_plan(c, [w.ops[1]], source='s', label='l', project=load_project(c, 'p1'))
    assert not c.writes


def test_a_jobs_rows_name_the_word_as_retyped():
    """What a job's report lists for a value on a word of a retyped sentence
    (proposed, written, or not written): the word by its number once
    retyped, and what it held when it is a word the sentence had."""
    from plaid_agent.igt.job import IgtRunner
    c = FakeClient(documents={'d1': _glossed()})
    w = fake_ws(c)
    call_tool(w, 'retype_sentence', {'document': 'd1', 'ref': 's1', 'text': 'Ali-di ∅ gam akuna.'})
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2', 's1.w3'], 'field': 'Gloss', 'value': 'he'})
    doc = w.doc('d1')
    new, kept = [IgtRunner.describe(None, o, doc, w.project) for o in w.ops[1:]]
    assert (new['ref'], new['field'], new['from'], new['to']) == ('s1.w2', 'Gloss', None, 'he')
    assert (kept['ref'], kept['field'], kept['from'], kept['to']) == ('s1.w3', 'Gloss', 'fish', 'he')


# --- the retype's edits, word by word --------------------------------------------------

PUNCT = {'type': 'unicodePunctuation', 'whitelist': []}


@pytest.mark.parametrize('old,new,gaps', [
    # a removed word goes whole, with the space after it
    ('sa na pa ma.', 'sa pa ma.', [(3, 6, '')]),
    ('sa na pa ma.', 'sa ma.', [(3, 9, '')]),
    ('sa na pa ma.', 'na pa ma.', [(0, 3, '')]),
    # at the end, with the space before it, the full stop left as it was
    ('sa na pa ma.', 'sa na pa.', [(8, 11, '')]),
    # a typed word comes whole, with a space, at the word after it
    ('ka ta.', 'ka ∅ ta.', [(3, 3, '∅ ')]),
    ('sa na', '∅ sa na', [(0, 0, '∅ ')]),
    ('sa na', 'sa na ∅', [(5, 5, ' ∅')]),
    # a word changed in its place, letter by letter
    ('sa na pa', 'sa ki pa', [(3, 5, 'ki')]),
    ('sa pa ma.', 'sa pha ma.', [(4, 4, 'h')]),
    # spaces and punctuation between words, letter by letter
    ('sa na pa.', 'sa  na pa!', [(3, 3, ' '), (8, 9, '!')]),
    # another number of words on both sides: typed over as one stretch
    ('sa na pa ma.', 'sa ni ∅ pa ma.', [(3, 5, 'ni ∅')]),
    # of several equal words, the earliest is the one kept
    ('a b a', 'a', [(1, 5, '')]),
    ('', 'x y', [(0, 0, 'x y')]),
])
def test_word_gaps(old, new, gaps):
    from plaid_agent.igt.retyped import word_gaps
    assert [(g['start'], g['end'], g['value']) for g in word_gaps(old, new, 0, PUNCT)] == gaps
    assert apply_text_ops(old, __import__('plaid_client').gaps_to_ops(word_gaps(old, new, 0, PUNCT))) == new


def test_trimmed_reads_a_gap_as_core_does():
    """Q2 for one word typed over, R60 for a stretch over two or more."""
    from plaid_agent.igt.retyped import trimmed
    body = 'sa na pa ma.'
    words = [(0, 2), (3, 5), (6, 8), (9, 11)]
    assert trimmed(body, [{'start': 3, 'end': 5, 'value': 'ni ∅'}], words) == [{'start': 4, 'end': 5, 'value': 'i ∅'}]
    assert trimmed(body, [{'start': 3, 'end': 8, 'value': 'nu'}], words) == [{'start': 3, 'end': 8, 'value': 'nu'}]
    assert trimmed(body, [{'start': 3, 'end': 5, 'value': 'na'}], words) == []


# --- a bare number a split, merge or word delete renumbers -------------------------------

@pytest.mark.parametrize('shape,args,new', [
    ('split_word', {'ref': 's1.w1', 'at': 3}, 4),
    ('merge_words', {'refs': ['s1.w1', 's1.w2']}, 2),
    ('delete_word', {'refs': ['s1.w2']}, 2),
])
def test_a_bare_number_a_planned_reshape_renumbers_is_refused_in_both_orders(shape, args, new):
    """As plaid-ud's renumbered_refusal: s1.w3 is "akuna" now and w{new} once
    the reshape runs, so its bare number is refused, and with its form it
    is the word read. Staged the other way, the reshape is refused."""
    w = ws()
    call_tool(w, shape, {'document': 'd1', **args})
    out = call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w3'], 'field': 'Gloss', 'value': 'see'})
    first = 2 if shape == 'split_word' else 2
    assert out == (f'Error: Text 1 s1.w3: s1.w3 is "akuna" now, but this plan\'s {shape} renumbers s1: once it is '
                   f'applied, "akuna" is w{new}. Words before w{first} keep their numbers. A plan names words by '
                   f'their numbers as read now, so add the form to say which you mean: s1.w3 "akuna". A word the '
                   f'{shape} makes is named once the plan is applied.'), out
    assert call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w3 "akuna"'], 'field': 'Gloss',
                                      'value': 'see'}).startswith('Planned 1 change')
    assert w.ops[-1]['token_id'] == 'w-3'
    # words before the reshape keep their numbers
    assert call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1'], 'field': 'Gloss',
                                      'value': 'x'}).startswith('Planned 1 change')
    # The other order: the value holds its word's id, and the reshape names
    # words before it, so nothing is ambiguous and both stand (REV-RR-4).
    for named in ('s1.w3', 's1.w3 "akuna"'):
        w2 = ws()
        call_tool(w2, 'set_field', {'document': 'd1', 'refs': [named], 'field': 'Gloss', 'value': 'see'})
        assert call_tool(w2, shape, {'document': 'd1', **args}).startswith('Planned'), named
        assert [o['kind'] for o in w2.ops] == ['set_span', shape]
        assert w2.ops[0]['token_id'] == 'w-3'
        out, notes = normalize_ops(copy.deepcopy(w2.ops))
        assert len(out) == 2 and not notes, notes


#: A tool given a word, a morpheme or a run of words by number, and the same
#: by its form where the tool takes one: each route a bare number reaches.
BY_NUMBER = {
    'set_field word': ('set_field', {'refs': ['s1.w3'], 'field': 'Gloss', 'value': 'X'}, 's1.w3 "akuna"'),
    'set_field morpheme': ('set_field', {'refs': ['s1.w2.m1'], 'field': 'Morph Gloss', 'value': 'PL'},
                           's1.w2.m1 "gam"'),
    'set_analysis': ('set_analysis', {'ref': 's1.w3', 'morphemes': [{'form': 'aku'}, {'form': 'na'}]},
                     's1.w3 "akuna"'),
    'set_morpheme': ('set_morpheme', {'ref': 's1.w2.m1', 'form': 'ga'}, 's1.w2.m1 "gam"'),
    'link_entry': ('link_entry', {'refs': ['s1.w3'], 'entry_form': 'gam', 'entry_gloss': 'fish'},
                   's1.w3 "akuna"'),
    'unlink_entry': ('unlink_entry', {'refs': ['s1.w3']}, 's1.w3 "akuna"'),
    'link_phrase': ('link_phrase', {'refs': ['s1.w2', 's1.w3'], 'entry_form': 'gam', 'entry_gloss': 'fish'},
                    None),
    'add_comment': ('add_comment', {'ref': 's1.w3', 'body': 'note'}, 's1.w3 "akuna"'),
    'discard_analysis': ('discard_analysis', {'refs': ['s1.w3']}, 's1.w3 "akuna"'),
    'delete_word': ('delete_word', {'refs': ['s1.w3']}, 's1.w3 "akuna"'),
    'set_orthography': ('set_orthography', {'refs': ['s1.w3'], 'orthography': 'IPA', 'value': 'x'},
                        's1.w3 "akuna"'),
    'respell': ('respell', {'ref': 's1.w3', 'new_text': 'akunaa'}, 's1.w3 "akuna"'),
    'split_word': ('split_word', {'ref': 's1.w3', 'at': 2}, 's1.w3 "akuna"'),
    'merge_words': ('merge_words', {'refs': ['s1.w2', 's1.w3']}, None),
    'confirm': ('confirm', {'refs': ['s1.w3']}, 's1.w3 "akuna"'),
    'analyze_sentence run': ('analyze_sentence', {'sentences': [{'ref': 's1.w2-w3', 'words': [
        'gam fish', 'akuna see']}]}, None),
}


@pytest.mark.parametrize('route', list(BY_NUMBER))
def test_every_route_a_bare_number_reaches_refuses_it_after_a_reshape_before_it(route):
    """After delete_word s1.w1, every later word of s1 is renumbered: a bare
    number naming one is refused where it is resolved, whatever the tool
    (REV-RR-4 and 5, as plaid-ud's resolve_in), and named by its form it is
    the word read."""
    tool, args, by_form = BY_NUMBER[route]
    w = ws()
    assert call_tool(w, 'delete_word', {'document': 'd1', 'refs': ['s1.w1']}).startswith('Planned')
    out = call_tool(w, tool, {'document': 'd1', **args})
    assert 'renumbers s1' in out and 'discard_plan' not in out, out
    assert len(w.ops) == 1
    if by_form is None:
        return
    key = 'refs' if 'refs' in args else 'ref'
    named = {**args, key: [by_form] if key == 'refs' else by_form}
    assert 'renumbers s1' not in call_tool(w, tool, {'document': 'd1', **named})


@pytest.mark.parametrize('tool,args', [
    ('set_analysis_for_form', {'form': 'akuna', 'morphemes': [{'form': 'akuna', 'gloss': 'see'}]}),
    ('set_field_for_form', {'form': 'akuna', 'field': 'Gloss', 'value': 'see'}),
    ('set_field', {'refs': ['s1."akuna"'], 'field': 'Gloss', 'value': 'see'}),
    ('set_field', {'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'x'}),
])
def test_a_change_that_names_no_word_by_its_bare_number_stands_beside_a_reshape(tool, args):
    """A rule, a form, or a word before the reshape: no number is
    read that the plan renumbers, so it stages as on master (REV-RR-5)."""
    w = ws()
    assert call_tool(w, 'split_word', {'document': 'd1', 'ref': 's1.w1', 'at': 3}).startswith('Planned')
    out = call_tool(w, tool, {'document': 'd1', **args})
    assert 'renumbers' not in out and not out.startswith('Error'), out
