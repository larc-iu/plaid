"""How the UD tools read the words a model names, and what they say when a
name does not fit (R2-TOOLS).

The research extract of the prod copy (R1-EXTRACT) found the UD assistant's
refusals bunched in three tools, all about addressing: set_field 27 of 120,
set_head 10 of 53, split_sentence 8 of 8. The replays below are those calls'
shapes, with this fixture's words in place of the user's: a sentence that is
one untokenized token, set_words planned on it, and then the new words named
in the same plan (s1.w2 onwards, and s1.w1 that the reshape deletes); and a
cut asked for at a sentence's first word.
"""

import json

import pytest

from plaid_agent.ud.project import load_project, resolve
from plaid_agent.ud.tools import Workspace
from plaid_agent.ud.toolkit import call_tool
from ud_fixtures import (FORM, LEMMA, PID, SENT_LAYER, TEXT_ID, TEXT_LAYER, TOK_LAYER, UPOS, WORD_LAYER,
                         document_raw, ud_client)


def build_doc(sentences, doc_id='ud2', name='Linea'):
    """A raw document of ``sentences``, each a list of tokens: a string is a
    token holding one word, ``(surface, [forms])`` a multi-word token."""
    body, sents, toks, words, forms = '', [], [], [], []
    n = 0
    for si, sent in enumerate(sentences):
        if body:
            body += ' '
        start = len(body)
        for ti, tok in enumerate(sent):
            if ti:
                body += ' '
            surface, wforms = (tok, [tok]) if isinstance(tok, str) else tok
            b, e = len(body), len(body) + len(surface)
            body += surface
            n += 1
            toks.append({'id': f't{n}', 'begin': b, 'end': e})
            for k, f in enumerate(wforms, 1):
                wid = f'w{n}-{k}'
                words.append({'id': wid, 'begin': b, 'end': e, 'precedence': k})
                if len(wforms) > 1:
                    forms.append({'id': f'f-{wid}', 'value': f, 'tokens': [wid]})
        sents.append({'id': f's{si + 1}', 'begin': start, 'end': len(body)})
    return {
        'id': doc_id, 'name': name, 'version': 1, 'metadata': {},
        'text_layers': [{
            'id': TEXT_LAYER, 'name': 'Text', 'text': {'id': TEXT_ID, 'body': body},
            'token_layers': [
                {'id': SENT_LAYER, 'tokens': sents, 'span_layers': []},
                {'id': TOK_LAYER, 'tokens': toks, 'span_layers': []},
                {'id': WORD_LAYER, 'tokens': words, 'span_layers': [
                    {'id': FORM, 'spans': forms}, {'id': LEMMA, 'spans': []}, {'id': UPOS, 'spans': []}]}]}]}


@pytest.fixture
def ws():
    docs = {'ud1': document_raw(),
            'ud2': build_doc([['Vamosalmar'], ['Corre'], ['la', 'casa', 'y', 'la', 'mesa']])}
    client = ud_client(documents=docs)
    return Workspace(client, load_project(client, PID))


def run(ws, name, **args):
    return call_tool(ws, name, args)


# --- the replays ------------------------------------------------------------------

def test_a_word_set_words_is_still_making_is_refused_with_why_and_what_to_do(ws):
    """Replay: set_words splits a one-token sentence, then set_field names the
    new words in the same plan. The refusal said "sentence s1 has 1 words",
    and the model tried the next word, 24 times in one turn."""
    out = run(ws, 'set_words', document='Linea', ref='s1.w1', forms=['Vamos', 'a', 'el', 'mar'])
    assert out.startswith('Planned "Vamosalmar" in s1 as 4 words')
    for refs in (['s1.w2'], ['s1.w3', 's1.w4'], 's1.w4'):
        out = run(ws, 'set_field', document='Linea', refs=refs, field='upos', value='NOUN')
        assert out.startswith('Error: s1.w') and 'does not exist yet: s1 has 1 word now' in out, out
        assert ('set_words runs its words are w1 "Vamos", w2 "a", w3 "el", w4 "mar". A plan cannot write '
                'to words it is still making: once the user approves this plan they are ordinary words, '
                'so annotate them in the next plan.') in out
    assert [op['kind'] for op in ws.ops] == ['set_words']


def test_a_word_the_reshape_deletes_says_what_comes_in_its_place(ws):
    """Replay: set_field on s1.w1 after set_words on its token."""
    run(ws, 'set_words', document='Linea', ref='s1.w1', forms=['Vamos', 'a', 'el', 'mar'])
    out = run(ws, 'set_field', document='Linea', refs=['s1.w1'], field='upos', value='VERB')
    assert out == ('Error: This plan both reshapes a token and writes to one of its words, and the reshape '
                   'deletes that word and makes "Vamos" + "a" + "el" + "mar" in its place. A plan cannot '
                   'write to words it is still making: once the user approves this plan they are ordinary '
                   'words, so annotate them in the next plan. Or keep one of the two '
                   '(plan_status, drop_planned).')
    assert [op['kind'] for op in ws.ops] == ['set_words']


def test_set_head_on_or_to_a_planned_word_is_refused_the_same_way(ws):
    """Replay: set_head with the dependent, or the head, one of those words."""
    run(ws, 'set_words', document='Linea', ref='s1.w1', forms=['Vamos', 'a', 'el', 'mar'])
    out = run(ws, 'set_head', document='Linea', ref='s1.w4', head=1, deprel='obl')
    assert 'Error: s1.w4 does not exist yet' in out and 'annotate them in the next plan' in out
    out = run(ws, 'set_head', document='Linea', ref='s2.w1', head=0)
    assert out.startswith('Planned s2.w1')
    out = run(ws, 'set_head', document='Linea', ref='s3.w1', head=9, deprel='det')
    assert out == ('Error: Sentence s3 has no word 9. Its words: w1 "la", w2 "casa", w3 "y", w4 "la", '
                   'w5 "mesa".')


def test_a_word_past_the_end_lists_the_sentence(ws):
    """With nothing planned, the count is joined by the words themselves, so
    the model can see which number it meant."""
    out = run(ws, 'set_field', document='Linea', refs=['s1.w3'], field='upos', value='NOUN')
    assert out == 'Error: s1.w3: sentence s1 has 1 word: w1 "Vamosalmar".'
    out = run(ws, 'set_field', document='Viaje', refs=['s1.w9'], field='upos', value='NOUN')
    assert out == ('Error: s1.w9: sentence s1 has 5 words: w1 "Vamos", w2-3 "al" (w2 "a", w3 "el"), '
                   'w4 "mar", w5 ".".')


def test_a_cut_at_a_sentences_first_word_says_where_a_cut_can_go(ws):
    """Replay: split_sentence at sN.w1, 8 of 8 refused."""
    out = run(ws, 'split_sentence', document='Linea', ref='s2.w1')
    assert out == ('Error: s2.w1 already starts sentence s2, so a boundary is there already. s2 is one '
                   'token ("Corre"), and a sentence begins only where a token does, so it cannot be cut. '
                   'To join s2 onto s1 instead, use merge_sentences.')
    out = run(ws, 'split_sentence', document='Linea', ref='s3.w1')
    assert out == ('Error: s3.w1 already starts sentence s3, so a boundary is there already. To cut s3 in '
                   'two, name the word the second part starts at, e.g. s3.w2 ("casa"). To join s3 onto s2 '
                   'instead, use merge_sentences.')
    out = run(ws, 'split_sentence', document='Viaje', ref='s1.w1')
    assert 'already starts sentence s1' in out and 'merge_sentences' not in out
    assert not ws.ops
    assert run(ws, 'split_sentence', document='Linea', ref='s3.w3').startswith('Planned')


# --- what a reference may look like ------------------------------------------------

@pytest.mark.parametrize('ref', ['s1.w4', 'S1.W4', 's1:w4', 's1/w4', 's1w4', 's1 w4', 's1.4', 's1:4',
                                 's1.w4 "mar"', 's1.w4 (mar)', 's1.w4: mar', 's1.w4=mar', 's1."mar"',
                                 's1.mar', 's1.Mar', 's1.mar#1'])
def test_every_spelling_of_one_word_names_it(ws, ref):
    out = run(ws, 'set_field', document='Viaje', refs=[ref], field='lemma', value='mar')
    assert out == 'Planned lemma = "mar" on 1 word(s): s1.w4', (ref, out)
    assert [op['token_id'] for op in ws.ops] == ['uw-3']


def test_a_word_of_a_multi_word_token_answers_to_the_tokens_text(ws):
    assert resolve(ws.doc('Viaje'), 's1.w3 (al)').form == 'el'
    assert resolve(ws.doc('Viaje'), 's1.w2-3 "al"').surface == 'al'
    assert resolve(ws.doc('Viaje'), 's1.al').surface == 'al'


def test_a_form_that_is_not_the_one_at_that_number_is_refused(ws):
    """Never a guess: the number and the form disagree, so neither is taken."""
    out = run(ws, 'set_field', document='Viaje', refs=['s1.w2 "mar"'], field='upos', value='NOUN')
    assert out == ('Error: s1.w2 "mar": s1.w2 is "a", not "mar" ("mar" is s1.w4). Name the word by its '
                   'number, as read_document shows it.')
    assert not ws.ops


def test_a_form_the_sentence_holds_twice_needs_its_number(ws):
    out = run(ws, 'set_field', document='Linea', refs=['s3.la'], field='upos', value='DET')
    assert out == 'Error: s3.la: s3 has 2 words spelled "la": s3.w1, s3.w4. Name one by its number.'
    assert not ws.ops
    assert run(ws, 'set_field', document='Linea', refs=['s3.la#2'], field='upos', value='DET') \
        == 'Planned upos = "DET" on 1 word(s): s3.w4'
    out = run(ws, 'set_field', document='Linea', refs=['s3.la#3'], field='upos', value='DET')
    assert out.startswith('Error: s3.la#3: s3 has 2 word(s) spelled "la", so there is no #3.')
    out = run(ws, 'set_field', document='Linea', refs=['s3.perro'], field='upos', value='NOUN')
    assert out == ('Error: s3.perro: s3 has no word "perro". Sentence s3 has 5 words: w1 "la", w2 "casa", '
                   'w3 "y", w4 "la", w5 "mesa".')


def test_what_is_not_a_reference_says_every_form_one_takes_with_an_example(ws):
    for bad in ('word 4', 's1.w2 s1.w4', 's1.w2.m1', '4'):
        out = run(ws, 'set_field', document='Viaje', refs=[bad], field='upos', value='NOUN')
        assert out == (f'Error: Bad reference "{bad}": use s<n> for a sentence, s<n>.w<n> for a word (its '
                       'CoNLL-U id within the sentence), s<n>.w<n>-<n> for a multi-word token, or '
                       's<n>."form" for the word spelled so (e.g. s3.w2, s3.w1-2). In "Viaje", s1.w2 is '
                       '"a".'), out
    assert not ws.ops


# --- a whole turn with a stub model ---------------------------------------------------

def _reply(*calls, text=None):
    from types import SimpleNamespace as NS
    tool_calls = [NS(id=f'c{i}', function=NS(name=name, arguments=json.dumps(args)))
                  for i, (name, args) in enumerate(calls)]
    return NS(choices=[NS(message=NS(content=text, tool_calls=tool_calls or None), finish_reason='stop')],
              usage=None)


def test_a_stub_models_turn_reads_why_and_stops_asking(ws, monkeypatch):
    """The prod turn, replayed through the loop with a stub model (the local
    model server was down): set_words on a one-token sentence, then set_field
    and set_head on the words it makes. Each refusal reaches the model saying
    the words exist once the plan is approved, and the plan the user is shown
    holds the reshape alone."""
    from plaid_agent.core import agent
    from plaid_agent.ud.service import AssistantService
    script = iter([
        _reply(('set_words', {'document': 'Linea', 'ref': 's1.w1', 'forms': ['Vamos', 'a', 'el', 'mar']})),
        _reply(('set_field', {'document': 'Linea', 'refs': ['s1.w2', 's1.w3'], 'field': 'upos', 'value': 'ADP'}),
               ('set_head', {'document': 'Linea', 'ref': 's1.w4', 'head': 1, 'deprel': 'obl'})),
        _reply(text='Approve the split first, then I will tag the new words.'),
    ])
    monkeypatch.setattr(agent, '_complete', lambda cfg, kwargs, on_text, cancelled=None, on_thinking=None: next(script))
    kit = AssistantService().toolkit()
    out = agent.run_turn(agent.ModelConfig(model='stub'), kit, ws, 'system', [{'role': 'user', 'content': 'x'}])
    results = [m['content'] for m in out.messages if m.get('role') == 'tool']
    assert results[0].startswith('Planned "Vamosalmar" in s1 as 4 words')
    assert all('does not exist yet' in r and 'annotate them in the next plan' in r for r in results[1:]), results
    assert [op['kind'] for op in ws.ops] == ['set_words']


# --- REV-R2-TOOLS: a number this plan's reshape renumbers ------------------------------

@pytest.fixture
def ws2():
    docs = {'ud1': document_raw(),
            'ud2': build_doc([['Vamosalmar', 'hoy'], ['la', ('del', ['de', 'el']), 'mesa']])}
    client = ud_client(documents=docs)
    return Workspace(client, load_project(client, PID))


def test_a_number_set_words_renumbers_is_refused_and_a_form_says_which(ws2):
    """After set_words makes four words of "Vamosalmar", s1.w2 is "hoy" now
    and "a" once the plan runs. The refusal of the planned words teaches the
    model the planned numbers, so a bare s1.w2 may mean either: it is
    refused, and the form beside it settles which."""
    ws = ws2
    run(ws, 'set_words', document='Linea', ref='s1.w1', forms=['Vamos', 'a', 'el', 'mar'])
    out = run(ws, 'set_field', document='Linea', refs=['s1.w2'], field='upos', value='ADP')
    assert out == ('Error: s1.w2 is "hoy" now, but this plan\'s set_words renumbers s1: once it is applied, '
                   '"hoy" is w5 and w2 is "a". A plan names words by their numbers now, so add the form to '
                   'say which you mean: s1.w2 "hoy". A plan cannot write to words it is still making: once '
                   'the user approves this plan they are ordinary words, so annotate them in the next plan.'), out
    out = run(ws, 'set_head', document='Linea', ref='s1.w2 "hoy"', head=2, deprel='obl')
    assert out.startswith('Error: Head 2 is "hoy" now'), out
    # The planned number of a word that exists now names it as it is now.
    out = run(ws, 'set_field', document='Linea', refs=['s1.w5'], field='upos', value='ADV')
    assert out.endswith('A plan names words by their numbers now: "hoy" is s1.w2.'), out
    assert [op['kind'] for op in ws.ops] == ['set_words']
    for refs in (['s1.w2 "hoy"'], ['s1."hoy"']):
        out = run(ws, 'set_field', document='Linea', refs=refs, field='upos', value='ADV')
        assert out.startswith('Planned upos = "ADV" on 1 word(s): s1.w2'), out
    # A word before the reshape keeps its number: s2 has no reshape at all.
    assert run(ws, 'set_field', document='Linea', refs=['s2.w4'], field='upos', value='NOUN').startswith('Planned')


def test_a_reshape_that_joins_words_renumbers_the_words_after_it(ws2):
    ws = ws2
    run(ws, 'set_words', document='Linea', ref='s2.w2-3', forms=['del'])
    out = run(ws, 'set_field', document='Linea', refs=['s2.w4'], field='upos', value='NOUN')
    assert out.startswith('Error: s2.w4 is "mesa" now, but this plan\'s set_words renumbers s2: once it is '
                          'applied, "mesa" is w3. '), out
    assert 'next plan' not in out
    out = run(ws, 'set_head', document='Linea', ref='s2.w1', head=4, deprel='det')
    assert out.startswith('Error: Head 4 is "mesa" now'), out
    out = run(ws, 'set_head', document='Linea', ref='s2.w1', head='s2.w4 "mesa"', deprel='det')
    assert out.startswith('Planned s2.w1 ("la") as det of word 4 ("mesa")'), out
    # The word before the reshaped token keeps its number.
    assert run(ws, 'set_field', document='Linea', refs=['s2.w1'], field='upos', value='DET').startswith('Planned')
