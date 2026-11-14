"""analyze_sentence (AS, 2026-11-14): a sentence, or a run of its words,
from interlinear lines. The lines are lined up against the sentence's real
words and the sentence is refused whole where they do not line up, with its
words numbered beside what was given. Each glossed morpheme is linked to the
one entry with its form and gloss, the rest are listed, and new_entries
creates one entry per form and gloss no entry has. It stages the ops
set_analysis, create_entry and link_entry stage, and nothing else."""

import copy

import pytest

from fixtures import (FakeClient, GLOSS, MGLOSS, MORPH_LAYER, PID, SENT_LAYER, TEXT_ID, TEXT_LAYER, TRANS, VOCAB,
                      WORD_LAYER, applied, document_raw, fake_ws, project_raw)

from plaid_agent.igt.toolkit import TOOLS, call_tool


def lexicon():
    """Entries without markers, as the app stores them: na 'PST' twice,
    told apart only by type, gam twice with two glosses, and kai a headword
    with no gloss whose one sense is 'go'."""
    return {'id': VOCAB, 'name': 'Lexicon', 'project': PID, 'items': [
        {'id': 'e-ali', 'form': 'Ali', 'metadata': {'gloss': 'Ali'}},
        {'id': 'e-di', 'form': 'di', 'metadata': {'gloss': 'ERG', 'morphType': 'suffix'}},
        {'id': 'e-gam', 'form': 'gam', 'metadata': {'gloss': 'fish'}},
        {'id': 'e-gam2', 'form': 'gam', 'metadata': {'gloss': 'net'}},
        {'id': 'e-aku', 'form': 'aku', 'metadata': {'gloss': 'see'}},
        {'id': 'e-na', 'form': 'na', 'metadata': {'gloss': 'PST', 'morphType': 'suffix'}},
        {'id': 'e-na2', 'form': 'na', 'metadata': {'gloss': 'PST', 'morphType': 'stem'}},
        {'id': 'e-ar', 'form': 'ar', 'metadata': {'gloss': 'FOC', 'morphType': 'enclitic'}},
        {'id': 'e-kai', 'form': 'kai', 'metadata': {}},
        {'id': 'e-kai1', 'form': 'kai', 'metadata': {'gloss': 'go', 'parent': 'e-kai', 'senseOrder': 1}},
    ]}


def untagged():
    """The fixture's project without the Leipzig tagset on its gloss, whose
    closed tags would refuse PST and FOC."""
    raw = project_raw()
    morph = raw['text_layers'][0]['token_layers'][2]
    morph['span_layers'][0]['config']['igt'].pop('tagset')
    return raw


def ws(doc=None, lex=None, project=None):
    return fake_ws(FakeClient(project=project or untagged(), documents={'d1': doc or document_raw()},
                              lexicon=lex or lexicon()))


def items(forms, gloss):
    """The v3 items of an interlinear forms line and gloss line, word by
    word ("_" where the forms line has "_")."""
    return [f if f == '_' else f'{f} {g}' for f, g in zip(forms.split(), gloss.split())]


def call(w, ref=None, forms=None, gloss=None, columns=None, **args):
    """The tool, a sentence given as two lines turned into its items."""
    if forms is not None:
        args['sentences'] = [{'ref': ref, 'words': items(forms, gloss), **({'columns': columns} if columns else {})}]
    return call_tool(w, 'analyze_sentence', {'document': 'd1', **args})


def kinds(w):
    return [o['kind'] for o in w.ops]


def links(w):
    """(the morpheme each planned link names, the entry or new entry)."""
    out = []
    for o in w.ops:
        if o['kind'] != 'link':
            continue
        where = f'{o["analysis_word_id"]}.m{o["morpheme_index"]}' if o.get('analysis_word_id') else o['token_id']
        out.append((where, o.get('item_id') or o.get('new_entry_key')))
    return out


# --- the schema --------------------------------------------------------------------

def test_the_schema_is_short_and_the_manual_is_behind_help():
    spec = next(t['function'] for t in TOOLS if t['function']['name'] == 'analyze_sentence')
    assert spec['description'].startswith('PLAN: ') and len(spec['description']) < 520
    assert spec['parameters']['required'] == ['document', 'sentences']
    assert set(spec['parameters']['properties']) == {'document', 'sentences', 'new_entries', 'lexicon', 'help'}
    item = spec['parameters']['properties']['sentences']['items']
    assert item['required'] == ['ref', 'words']
    w = ws()
    out = call(w, help=True)
    assert 'FORMS GLOSS' in out and 'new_entries' in out and w.ops == []


# --- a sentence, lined up -------------------------------------------------------------

def test_a_sentence_is_analysed_word_for_word_and_linked_where_one_entry_fits():
    w = ws()
    out = call(w, ref='s1', forms='Ali-di gam aku-na', gloss='Ali-ERG fish see-PST')
    assert [o['word_id'] for o in w.ops if o['kind'] == 'set_analysis'] == ['w-1', 'w-2', 'w-3']
    analyses = {o['word_id']: [m['form'] for m in o['morphemes']] for o in w.ops if o['kind'] == 'set_analysis'}
    assert analyses == {'w-1': ['Ali', 'di'], 'w-2': ['gam'], 'w-3': ['aku', 'na']}
    glosses = [[f['value'] for m in o['morphemes'] for f in m['fields']] for o in w.ops if o['kind'] == 'set_analysis']
    assert glosses == [['Ali', 'ERG'], ['fish'], ['see', 'PST']]
    # na 'PST' is two entries, a suffix and a stem: nothing is linked to it.
    assert links(w) == [('w-1.m1', 'e-ali'), ('w-1.m2', 'e-di'), ('w-2.m1', 'e-gam'), ('w-3.m1', 'e-aku')]
    assert not [o for o in w.ops if o['kind'] == 'create_entry']
    assert 's1: 3 words analysed, 4 links.' in out
    assert 'Several entries fit, nothing linked (link_entry with one entry_id):' in out
    assert "  na ‘PST’ ×1 (s1.w3.m2):" in out and 'id=e-na ' in out and 'id=e-na2 ' in out
    assert 'type=suffix' in out and 'type=stem' in out


def test_there_is_no_types_line_and_no_morpheme_is_typed_but_by_the_equals_rule():
    """v2: a types line that did not line up refused 53 sentences of the
    Natugu night run. A linked morpheme goes by its entry, one after "=" by
    the clitic rule, the rest by none (set_morpheme sets one)."""
    spec = next(t['function'] for t in TOOLS if t['function']['name'] == 'analyze_sentence')
    assert 'types' not in spec['parameters']['properties'] and 'types' not in spec['description']
    w = ws()
    out = call(w, ref='s1', forms='Ali-di gam aku-na', gloss='Ali-ERG fish see-PST', types='_-_ _ stem-suffix')
    assert 'analyze_sentence cannot be called with those arguments' in out and w.ops == []
    call(w, ref='s1', forms='Ali-di gam aku-na', gloss='Ali-ERG fish see-PST')
    w3 = next(o for o in w.ops if o.get('word_id') == 'w-3')
    assert [m.get('morph_type') for m in w3['morphemes']] == [None, None]


def test_a_run_of_words():
    w = ws()
    out = call(w, ref='s1.w2-w3', forms='gam aku-na', gloss='net see-PST')
    assert [o['word_id'] for o in w.ops if o['kind'] == 'set_analysis'] == ['w-2', 'w-3']
    assert links(w) == [('w-2.m1', 'e-gam2'), ('w-3.m1', 'e-aku')]
    assert out.splitlines()[1] == 's1.w2-w3: 2 words analysed, 2 links.'


def test_an_equals_is_a_clitic_boundary():
    w = ws()
    call(w, ref='s2', forms='Gam=ar', gloss='fish=FOC')
    (op,) = [o for o in w.ops if o['kind'] == 'set_analysis']
    assert [m.get('equals_before') for m in op['morphemes']] == [None, True]
    assert op['morphemes'][1]['morph_type'] == 'enclitic'
    # The sentence-initial capital finds the entry gam as the pair picker
    # finds it (form by collation key).
    assert links(w) == [('w-4.m1', 'e-gam'), ('w-4.m2', 'e-ar')]


def test_a_hyphen_between_morphemes_is_no_equals():
    w = ws()
    call(w, ref='s2', forms='Gam-ar', gloss='fish-FOC')
    (op,) = [o for o in w.ops if o['kind'] == 'set_analysis']
    # The stored "=" the word had (m-4b is an enclitic) is not kept: the line says "-".
    assert [m.get('equals_before') for m in op['morphemes']] == [None, None]


def test_the_placeholder_leaves_a_word_as_it_is():
    w = ws()
    out = call(w, ref='s1', forms='_ gam aku-na', gloss='_ fish see-PST')
    assert [o['word_id'] for o in w.ops if o['kind'] == 'set_analysis'] == ['w-2', 'w-3']
    assert 's1: 2 words analysed, 2 links.' in out


def test_a_morpheme_with_no_gloss_is_staged_and_not_linked():
    w = ws()
    out = call(w, ref='s1.w3', forms='aku-na', gloss='see-_')
    (op,) = [o for o in w.ops if o['kind'] == 'set_analysis']
    assert [len(m['fields']) for m in op['morphemes']] == [1, 0]
    assert links(w) == [('w-3.m1', 'e-aku')] and 'nothing linked' not in out


def test_a_sense_is_linked_by_its_gloss():
    w = ws()
    call(w, ref='s1.w2', forms='kai', gloss='go')
    assert links(w) == [('w-2.m1', 'e-kai1')]


def test_another_morpheme_field_by_its_line():
    raw = untagged()
    morph = raw['text_layers'][0]['token_layers'][2]
    morph['span_layers'].append({'id': 'sl-pos', 'name': 'POS', 'config': {'igt': {'scope': 'Morpheme'}}})
    w = ws(project=raw)
    out = call(w, sentences=[{'ref': 's1.w3', 'columns': ['forms', 'gloss', 'POS'], 'words': ['aku-na see-PST v-asp']}])
    assert out.startswith('Planned'), out
    (op,) = [o for o in w.ops if o['kind'] == 'set_analysis']
    assert [{f['layer_id']: f['value'] for f in m['fields']} for m in op['morphemes']] == [
        {MGLOSS: 'see', 'sl-pos': 'v'}, {MGLOSS: 'PST', 'sl-pos': 'asp'}]


# --- refusals, each with its text -----------------------------------------------------

RUN4 = ('s1 not staged: words has 1 item, s1 has 3 words.\n'
        '  w1 Ali-di | Ali-di-gam-aku-na Ali-ERG-fish-see-PST\n'
        '  w2 gam | (none)\n'
        '  w3 akuna | (none)')


def test_run4s_mistake_a_sentence_on_its_first_word_is_refused_with_the_words_lined_up():
    w = ws()
    out = call(w, ref='s1', forms='Ali-di-gam-aku-na', gloss='Ali-ERG-fish-see-PST')
    assert out == 'Error: ' + RUN4 and w.ops == []


def test_run4s_mistake_through_a_run_of_one_word_is_refused_by_the_surface_check():
    w = ws()
    out = call(w, ref='s1.w2', forms='Ali-di-gam-aku-na', gloss='Ali-ERG-fish-see-PST')
    assert out == ('Error: s1.w2 not staged: w2.\n'
                   '  w2 gam | Ali-di-gam-aku-na Ali-ERG-fish-see-PST: forms "Alidigamakuna" are over twice as '
                   'long as "gam" plus 3')
    assert w.ops == []


@pytest.mark.parametrize('words, bad, said', [
    (['Ali-di Ali-ERG', 'gam fish', 'aku-na see'],
     'w3', '  w3 akuna | aku-na see: 2 forms, 1 in gloss'),
    (['Ali--di Ali--ERG', 'gam fish', 'aku-na see-PST'],
     'w1', '  w1 Ali-di | Ali--di Ali--ERG: an empty morpheme in "Ali--di"; an empty morpheme in gloss "Ali--ERG"'),
    (['Ali-di Ali-ERG', 'gam fish', 'aku-na- see-PST'],
     'w3', '  w3 akuna | aku-na- see-PST: an empty morpheme in "aku-na-"; 3 forms, 2 in gloss'),
    (['Ali-di Ali-ERG', 'gam fish', 'aku-na see PST'],
     'w3', '  w3 akuna | aku-na see PST: 3 columns, give "FORMS GLOSS" with one space between and none inside'),
    (['Ali-di', 'gam fish', 'aku-na see-PST'],
     'w1', '  w1 Ali-di | Ali-di: 1 column, give "FORMS GLOSS" with one space between and none inside'),
    (['Ali-di Ali-ERG', 'gamgamgamg fish', 'aku-na see-PST'],
     'w2', '  w2 gam | gamgamgamg fish: forms "gamgamgamg" are over twice as long as "gam" plus 3'),
])
def test_a_word_that_does_not_line_up_is_not_staged_and_the_others_are(words, bad, said):
    """v2: refused by word. v3: a word's forms and gloss are one item, so
    only that item can be wrong."""
    w = ws()
    out = call(w, sentences=[{'ref': 's1', 'words': words}])
    assert f's1: 2 of 3 words analysed, ' in out and f'. Not staged: {bad}\n{said}' in out, out
    staged = [o['word_id'] for o in w.ops if o['kind'] == 'set_analysis']
    assert len(staged) == 2 and f'w-{bad[1:]}' not in staged


def test_a_wrong_number_of_items_far_off_refuses_the_whole_sentence():
    w = ws()
    out = call(w, ref='s1', forms='Ali-di', gloss='Ali-ERG')
    assert out.startswith('Error: s1 not staged: words has 1 item, s1 has 3 words.')
    assert w.ops == []


@pytest.mark.parametrize('args, said', [
    ({'ref': 's9', 'forms': 'a', 'gloss': 'b'}, 's9 not staged: document "Text 1" has 2 sentences.'),
    ({'ref': 's1.w2-w9', 'forms': 'a', 'gloss': 'b'}, 's1.w2-w9 not staged: s1 has 3 words (w1 to w3).'),
    ({'ref': 's1.w2.m1', 'forms': 'a', 'gloss': 'b'},
     's1.w2.m1 not staged: a ref is a sentence ("s4") or a run of its words ("s4.w3-w5").'),
    ({'ref': 's1', 'forms': '_ _ _', 'gloss': '_ _ _'}, 's1 not staged: every word is _.'),
    ({'sentences': [{'ref': 's1'}]},
     's1 not staged: give words, one "FORMS GLOSS" item per word of the ref, e.g. "words": '
     '["na-ku-ja PRS-INF-come", "le=o today=DEF"].'),
    ({'sentences': [{'ref': 's1', 'words': []}]},
     's1 not staged: give words, one "FORMS GLOSS" item per word of the ref, e.g. "words": '
     '["na-ku-ja PRS-INF-come", "le=o today=DEF"].'),
    ({'sentences': [{'words': ['a b']}]},
     'A sentence not staged: give ref, the sentence ("s4") or a run of its words ("s4.w3-w5"), e.g. '
     '"ref": "s4".'),
    ({'sentences': [{'ref': 's1', 'words': ['a b'] * 3, 'columns': ['gloss', 'forms']}]},
     's1 not staged: columns starts with "forms", has "gloss", and names each once.'),
    ({'sentences': [{'ref': 's1', 'words': ['a b c'] * 3, 'columns': ['forms', 'gloss', 'Translation']}]},
     's1 not staged: "Translation" is a Sentence field: set_field sets it.'),
])
def test_the_other_refusals(args, said):
    w = ws()
    out = call(w, **args)
    assert out == 'Error: ' + said and w.ops == []


def test_the_call_shape_refusals():
    w = ws()
    assert 'Give sentences, a list of {ref, words}' in call(w)
    assert 'cannot be called with those arguments' in call_tool(w, 'analyze_sentence', {
        'document': 'd1', 'ref': 's1', 'forms': 'a', 'gloss': 'b'})
    assert 'At most 20 sentences' in call(w, sentences=[{'ref': 's1'}] * 21)
    assert w.ops == []


def test_one_sentence_refused_leaves_the_others_staged():
    w = ws()
    out = call(w, sentences=[{'ref': 's1', 'words': ['Ali-di-gam-aku-na Ali-ERG-fish-see-PST']},
                             {'ref': 's2', 'words': ['Gam=ar fish=FOC']}])
    assert RUN4 in out and 's2: 1 word analysed, 2 links.' in out
    assert [o['word_id'] for o in w.ops if o['kind'] == 'set_analysis'] == ['w-4']


def test_a_word_whose_forms_differ_within_the_bound_draws_the_note_with_its_lineup():
    w = ws()
    out = call(w, ref='s1.w3', forms='akun-nan', gloss='see-PST')
    assert 's1.w3 akuna | akun-nan: forms differ from the word (allowed for allomorphy).' in out


# --- linking: none, several, new entries -----------------------------------------------

def test_a_morpheme_no_entry_fits_is_listed_with_the_entries_spelled_so():
    w = ws()
    out = call(w, ref='s1.w2', forms='gam', gloss='catch')
    assert links(w) == []
    assert 'No entry fits, nothing linked:\n  gam ‘catch’ ×1 (s1.w2.m1). Spelled so:' in out
    assert 'id=e-gam form=gam#1 gam | gloss=fish (Lexicon)' in out and 'id=e-gam2 form=gam#2 gam | gloss=net' in out
    assert 'new_entries' not in out, 'the answer does not advertise creating entries'


def test_new_entries_creates_one_entry_per_form_and_gloss_across_calls_and_links_every_one():
    w = ws()
    out = call(w, ref='s1.w2', forms='gam', gloss='catch', new_entries=True)
    assert 's1.w2: 1 word analysed, 1 link, 1 entry to create.' in out and 'New entries: gam ‘catch’.' in out
    out = call(w, ref='s2', forms='gam=ar', gloss='catch=FOC', new_entries=True)
    assert 's2: 1 word analysed, 2 links.' in out and 'New entries' not in out
    (create,) = [o for o in w.ops if o['kind'] == 'create_entry']
    assert create['form'] == 'gam' and create['metadata'] == {'gloss': 'catch'}
    assert links(w) == [('w-2.m1', create['key']), ('w-4.m1', create['key']), ('w-4.m2', 'e-ar')]


def test_new_entries_never_resolves_several_and_never_creates_beside_a_form_and_gloss():
    w = ws()
    out = call(w, ref='s1.w3', forms='aku-na', gloss='see-PST', new_entries=True)
    assert [o for o in w.ops if o['kind'] == 'create_entry'] == []
    assert 'Several entries fit' in out


def test_new_entries_gives_no_type():
    w = ws()
    call(w, ref='s1.w3', forms='aku-ti', gloss='see-FUT', new_entries=True)
    (create,) = [o for o in w.ops if o['kind'] == 'create_entry']
    assert create['form'] == 'ti' and create['metadata'] == {'gloss': 'FUT'}


def test_homonyms_told_apart_only_by_type_both_fit_and_neither_is_linked():
    w = ws()
    out = call(w, ref='s1.w2', forms='na', gloss='PST')
    assert links(w) == [] and 'Several entries fit' in out and 'type=stem' in out and 'type=suffix' in out


# --- what it stages is what the old calls staged ------------------------------------------

def _strip(ops):
    return [{k: v for k, v in o.items() if k not in ('_seq',)} for o in ops]


def test_the_ops_are_the_ops_set_analysis_create_entry_and_link_entry_stage():
    new = ws()
    call(new, sentences=[
        {'ref': 's1', 'words': items('Ali-di gam aku-na', 'Ali-ERG catch see-PST')},
        {'ref': 's2', 'words': ['Gam=ar catch=FOC']}], new_entries=True)
    old = ws()
    for ref, morphemes in [
            ('s1.w1', [{'form': 'Ali', 'equals': False, 'fields': {'Morph Gloss': 'Ali'}},
                       {'form': 'di', 'equals': False, 'fields': {'Morph Gloss': 'ERG'}}]),
            ('s1.w2', [{'form': 'gam', 'equals': False, 'fields': {'Morph Gloss': 'catch'}}]),
            ('s1.w3', [{'form': 'aku', 'equals': False, 'fields': {'Morph Gloss': 'see'}},
                       {'form': 'na', 'equals': False, 'fields': {'Morph Gloss': 'PST'}}])]:
        assert call_tool(old, 'set_analysis', {'document': 'd1', 'ref': ref, 'morphemes': morphemes}).startswith('Planned')
    key = call_tool(old, 'create_entry', {'form': 'gam', 'fields': {'gloss': 'catch'}}).split('entry_id: ')[1].split()[0]
    for refs, entry in [(['s1.w1.m1'], 'e-ali'), (['s1.w1.m2'], 'e-di'), (['s1.w2.m1'], key),
                        (['s1.w3.m1'], 'e-aku')]:
        call_tool(old, 'link_entry', {'document': 'd1', 'refs': refs, 'entry_id': entry})
    call_tool(old, 'set_analysis', {'document': 'd1', 'ref': 's2.w1', 'morphemes': [
        {'form': 'Gam', 'equals': False, 'fields': {'Morph Gloss': 'catch'}},
        {'form': 'ar', 'equals': True, 'fields': {'Morph Gloss': 'FOC'}}]})
    call_tool(old, 'link_entry', {'document': 'd1', 'refs': ['s2.w1.m1'], 'entry_id': key})
    call_tool(old, 'link_entry', {'document': 'd1', 'refs': ['s2.w1.m2'], 'entry_id': 'e-ar'})
    assert [o.get('label') for o in new.ops] == [o.get('label') for o in old.ops]
    assert _strip(new.ops) == _strip(old.ops)
    assert new.plan_payload()['ops'] == old.plan_payload()['ops']
    # And approval writes the same, the ids each approval mints aside.
    assert _minted(applied(new).calls) == _minted(applied(old).calls)


def _minted(calls):
    """``calls`` with every UUID in them numbered by first sight."""
    import json
    import re
    seen = {}
    text = json.dumps(calls, sort_keys=True, default=str)
    return re.sub(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
                  lambda m: f'id{seen.setdefault(m.group(0), len(seen))}', text)


# --- words of every shape ---------------------------------------------------------------------

def _doc(body, sentences, words):
    """A document of ``body`` with sentences and words at the given
    offsets, no morphemes stored."""
    return {
        'id': 'd1', 'name': 'Text 1', 'version': 1, 'metadata': {},
        'text_layers': [{'id': TEXT_LAYER, 'name': 'Text', 'text': {'id': TEXT_ID, 'body': body},
                         'token_layers': [
                             {'id': SENT_LAYER, 'tokens': [{'id': f's-{i}', 'begin': b, 'end': e}
                                                           for i, (b, e) in enumerate(sentences, 1)],
                              'span_layers': [{'id': TRANS, 'spans': []}]},
                             {'id': WORD_LAYER, 'tokens': [{'id': f'w-{i}', 'begin': b, 'end': e}
                                                           for i, (b, e) in enumerate(words, 1)],
                              'span_layers': [{'id': GLOSS, 'spans': []}], 'vocabs': []},
                             {'id': MORPH_LAYER, 'tokens': [], 'span_layers': [{'id': MGLOSS, 'spans': []}],
                              'vocabs': []}]}]}


def _spans(body, *pieces):
    out, at = [], 0
    for p in pieces:
        b = body.index(p, at)
        out.append((b, b + len(p)))
        at = b + len(p)
    return out


def test_right_to_left_text_is_lined_up_in_its_logical_order():
    # From the bench's Arabic PADT task (ud-ar-mwt): شقيقته is the noun شقيقة
    # with the attached pronoun ه.
    body = 'رأيت شقيقته.'
    w = ws(doc=_doc(body, [(0, len(body))], _spans(body, 'رأيت', 'شقيقته')),
           lex={'id': VOCAB, 'name': 'Lexicon', 'project': PID, 'items': [
               {'id': 'e-s', 'form': 'شقيقة', 'metadata': {'gloss': 'sister'}},
               {'id': 'e-h', 'form': 'ه', 'metadata': {'gloss': '3SG.M'}}]})
    out = call(w, ref='s1', forms='رأيت شقيقة-ه', gloss='see.PST.1SG sister-3SG.M')
    assert [[m['form'] for m in o['morphemes']] for o in w.ops if o['kind'] == 'set_analysis'] == [
        ['رأيت'], ['شقيقة', 'ه']]
    assert links(w) == [('w-2.m1', 'e-s'), ('w-2.m2', 'e-h')]
    assert 'رأيت ‘see.PST.1SG’ ×1 (s1.w1.m1)' in out
    out = call(ws(doc=_doc(body, [(0, len(body))], _spans(body, 'رأيت', 'شقيقته'))), ref='s1',
               forms='رأيت-شقيقة-ه', gloss='see-sister-3SG.M')
    assert out.startswith('Error: s1 not staged: words has 1 item, s1 has 2 words.') and '  w2 شقيقته | (none)' in out


def test_a_script_with_no_spaces_between_its_words():
    # The Chinese line of test_tokenize_new_text, its words cut as a
    # tokenizer would: no space in the text, one between the words of a line.
    body = '我今天去北京。'
    w = ws(doc=_doc(body, [(0, len(body))], _spans(body, '我', '今天', '去', '北京')),
           lex={'id': VOCAB, 'name': 'Lexicon', 'project': PID, 'items': [
               {'id': 'e-wo', 'form': '我', 'metadata': {'gloss': '1SG'}},
               {'id': 'e-qu', 'form': '去', 'metadata': {'gloss': 'go'}}]})
    out = call(w, ref='s1', forms='我 今-天 去 北-京', gloss='1SG now-day go north-capital')
    assert [[m['form'] for m in o['morphemes']] for o in w.ops if o['kind'] == 'set_analysis'] == [
        ['我'], ['今', '天'], ['去'], ['北', '京']]
    assert links(w) == [('w-1.m1', 'e-wo'), ('w-3.m1', 'e-qu')]
    assert 's1: 4 words analysed, 2 links.' in out


def test_a_word_nobody_segmented_is_analysed_on_its_derived_morpheme():
    w = ws()
    call(w, ref='s1.w3', forms='aku-na', gloss='see-PST')
    (op,) = [o for o in w.ops if o['kind'] == 'set_analysis']
    assert op['word_id'] == 'w-3' and op['existing'] == []
    c = applied(w)
    made = [p for k, p in c.calls if k in ('tokens.create', 'tokens.bulk_create')]
    assert made, 'the analysis makes the morphemes of a word that had none'


def test_a_word_in_a_multi_word_expression_keeps_the_expression():
    raw = copy.deepcopy(document_raw())
    words = raw['text_layers'][0]['token_layers'][1]
    words['vocabs'][0]['vocab_links'].append({'id': 'l-mwe', 'vocab_item': {'id': 'e-kai', 'form': 'kai'},
                                              'tokens': ['w-2', 'w-3']})
    w = ws(doc=raw)
    out = call(w, ref='s1.w2-w3', forms='gam aku-na', gloss='fish see-PST')
    assert out.startswith('Planned') and 'unlink' not in kinds(w) and 'unlink_phrase' not in kinds(w)
    assert [o['word_id'] for o in w.ops if o['kind'] == 'set_analysis'] == ['w-2', 'w-3']


def test_a_contributor_stages_the_same_and_approval_stamps_it_theirs():
    from plaid_agent.igt.plan import execute_plan
    bob = 'bob@x.com'
    raw = untagged()
    raw.setdefault('config', {}).setdefault('plaid', {})['review'] = {'users': [bob], 'roles': []}
    raw['writers'] = [bob]
    w = ws(project=raw)
    w.requester_id = bob
    out = call(w, ref='s1.w2', forms='gam', gloss='fish')
    assert out.startswith('Planned') and links(w) == [('w-2.m1', 'e-gam')]
    w.client.calls.clear()
    execute_plan(w.client, w.ops, source='service:igt:assist:x', label='l', project=w.project,
                 stamp_mode='contributed', contributor=bob)
    stamped = [p for k, p in w.client.calls if k == 'spans.create']
    assert stamped and all('contributed' in str(p) for p in stamped)


# --- the prompts --------------------------------------------------------------------------

def test_the_prompts_name_analyze_sentence_where_they_named_set_analysis_for_a_stretch():
    from plaid_agent.igt.prompt import JOB_SYSTEM, SYSTEM
    assert 'staged one analyze_sentence call per sentence' in SYSTEM and 'set_analysis call per' not in SYSTEM
    assert 'You staged one analyze_sentence for s6' in JOB_SYSTEM and 'staged one set_analysis' not in JOB_SYSTEM


def test_a_sentence_refused_while_staging_names_no_entry_it_did_not_create():
    """s1.w2 creates gam 'catch', then the link to it is refused (the word
    is merged in this plan): the sentence is taken back whole, and the answer
    lists no new entry."""
    w = ws()
    call_tool(w, 'merge_words', {'document': 'd1', 'refs': ['s1.w2', 's1.w3']})
    before = list(w.ops)
    out = call(w, sentences=[{'ref': 's1.w2', 'words': ['gam catch']},
                             {'ref': 's2', 'words': ['Gam=ar fish=FOC']}], new_entries=True)
    assert 's1.w2 not staged:' in out and 'New entries' not in out, out
    assert [o for o in w.ops if o['kind'] == 'create_entry'] == []
    assert w.ops[:len(before)] == before


def test_columns_may_name_the_gloss_field_by_its_name():
    w = ws()
    out = call(w, sentences=[{'ref': 's1.w2', 'columns': ['forms', 'Morph Gloss'], 'words': ['gam fish']}])
    assert out.startswith('Planned') and links(w) == [('w-2.m1', 'e-gam')], out


def test_a_missing_words_list_is_named_in_one_sentence_in_a_list_too():
    w = ws()
    out = call(w, sentences=[{'ref': 's1'}, {'ref': 's2', 'words': ['Gam=ar fish=FOC']}])
    assert 's1 not staged: give words, one "FORMS GLOSS" item per word' in out and '(none)' not in out
    assert 's2: 1 word analysed, 2 links.' in out


def test_the_schema_says_new_entries_is_for_when_new_entries_are_asked_for():
    spec = next(t['function'] for t in TOOLS if t['function']['name'] == 'analyze_sentence')
    assert 'ask for new entries' in spec['parameters']['properties']['new_entries']['description']


# --- v3 2: punctuation items -------------------------------------------------------

@pytest.mark.parametrize('words', [
    ['Ali-di Ali-ERG', 'gam fish', 'aku-na see-PST', '.'],
    ['Ali-di Ali-ERG', ',', 'gam fish', 'aku-na see-PST', '. .'],
    ['"', 'Ali-di Ali-ERG', 'gam fish', 'aku-na see-PST'],
])
def test_an_item_of_punctuation_alone_is_left_out_before_counting(words):
    """The Natugu night run copied the baseline's punctuation tokens into the
    forms line as words. An item made only of what the project's
    ignored-token rule ignores is no word, and nothing is said of it."""
    w = ws()
    out = call(w, sentences=[{'ref': 's1', 'words': words}])
    assert 's1: 3 words analysed, 4 links.' in out and 'punctuation' not in out, out


def test_the_placeholder_is_not_punctuation():
    w = ws()
    out = call(w, sentences=[{'ref': 's1', 'words': ['_', 'gam fish', 'aku-na see-PST']}])
    assert 's1: 2 words analysed' in out


def test_punctuation_left_out_is_said_when_the_count_is_still_off():
    w = ws()
    out = call(w, sentences=[{'ref': 's1', 'words': ['Ali-di Ali-ERG', '.']}])
    assert out.startswith('Error: s1 not staged: words has 1 item, s1 has 3 words (1 item of punctuation left out).')
