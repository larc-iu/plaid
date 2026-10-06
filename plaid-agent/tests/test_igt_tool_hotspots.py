"""The IGT assistant's tool refusals the research extract found bunched
(R2-TOOLS, from R1-EXTRACT on the prod copy): lexicon_entry 17 of 42 refused
(6 called with a ``form`` it did not take, 7 on a form several entries share,
4 naming nothing), search 18 of 212 (13 on a field name the word and the
morpheme layer share). The replays use those calls' shapes with this
fixture's words. Addressing is the same reader as UD's (core.refs), so the
reference spellings are tested here too, for parity.
"""

import copy

from fixtures import FakeClient, lexicon_raw, project_raw, scan_ws

from plaid_agent.igt.project import resolve
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.trace import TRACER


def ws(**kw):
    return scan_ws(FakeClient(**kw))


def shared_gloss_project():
    """The fixture with its morpheme field called "Gloss" too, so the bare
    name stands for two fields, as on the prod copy."""
    p = copy.deepcopy(project_raw())
    morph = p['text_layers'][0]['token_layers'][2]
    morph['span_layers'][0]['name'] = 'Gloss'
    return p


# --- lexicon_entry -------------------------------------------------------------------

def test_lexicon_entry_called_with_form_reads_it_as_entry_form():
    """Replay: lexicon_entry(form=...), refused as "cannot be called with those
    arguments" six times. analyses_of and concordance take a form, so the
    model reaches for the same word."""
    w = ws()
    out = call_tool(w, 'lexicon_entry', {'form': 'Ali'})
    assert out.startswith('Headword "Ali" (id vi-ali') or out.startswith('Entry "Ali"'), out
    assert out == call_tool(w, 'lexicon_entry', {'entry_form': 'Ali'})
    # Both given: entry_form is the tool's own, and a form beside it is not taken.
    assert 'cannot be called with those arguments' in call_tool(
        w, 'lexicon_entry', {'entry_form': 'Ali', 'form': 'gam'})
    # A tool with a form of its own keeps it.
    assert 'cannot be called' not in call_tool(w, 'analyses_of', {'form': 'gam'})
    # The progress line names the form either way.
    assert TRACER.progress('lexicon_entry', {'form': 'Ali'}) == 'Looking up "Ali"…'


def test_a_link_tool_named_with_form_resolves_it_like_entry_form():
    """The same reading for a write: the form is resolved as entry_form is,
    so two entries spelled alike are still refused, never picked."""
    w = ws()
    out = call_tool(w, 'link_entry', {'document': 'Text 1', 'refs': ['s1.w2'], 'form': 'gam'})
    assert out.startswith('Error: Several entries match "gam"'), out
    assert not w.ops
    out = call_tool(w, 'link_entry', {'document': 'Text 1', 'refs': ['s1.w2'], 'form': 'gam#2'})
    assert 'Error' not in out and len(w.ops) == 1, out


def test_a_form_several_entries_share_is_answered_with_each():
    """Replay: lexicon_entry(entry_form="gam") where two entries are spelled
    gam, refused 7 times. A read answers with both, each with the
    entry_form that names it in a change."""
    w = ws()
    out = call_tool(w, 'lexicon_entry', {'entry_form': 'gam'})
    assert not out.startswith('Error'), out
    assert out.startswith('2 entries are spelled "gam". Pass the entry_form shown with one to name it in a '
                          'change.')
    assert 'entry_form "gam#1"' in out and 'entry_form "gam#2"' in out
    assert 'gloss: fish' in out and 'gloss: net' in out
    # Named singly, each is as before.
    assert call_tool(w, 'lexicon_entry', {'entry_form': 'gam#2'}).startswith('Headword "gam" (2 of 2')


def test_many_entries_spelled_alike_are_listed_not_written_out():
    lex = lexicon_raw()
    lex['items'] += [{'id': f'vi-gam{i}', 'form': 'gam', 'metadata': {'gloss': f'g{i}'}} for i in range(3, 7)]
    out = call_tool(ws(lexicon=lex), 'lexicon_entry', {'entry_form': 'gam'})
    assert out.startswith('6 entries are spelled "gam".')
    assert out.count('  entry_form "gam#') == 6
    assert out.endswith('lexicon_entry with one of those entry_forms shows it in full.')


def test_a_headword_number_written_as_the_app_shows_it_names_that_entry():
    """kai₁ is how the app shows the number, "kai 1" how a reference field
    writes it. Read only when nothing is spelled that way, and never without
    the space unless it is a subscript ("gam2" stays a form)."""
    w = ws()
    for form in ('gam₂', 'gam 2'):
        assert call_tool(w, 'lexicon_entry', {'entry_form': form}).startswith('Headword "gam" (2 of 2'), form
    assert call_tool(w, 'lexicon_entry', {'entry_form': 'gam2'}).startswith('Error: No lexicon entry "gam2".')


def test_a_form_that_names_nothing_offers_the_entries_spelled_close_to_it():
    """Replay: the not-found refusals. "di" is the suffix "-di": offered,
    never taken, since a root and a suffix can be spelled alike."""
    w = ws()
    out = call_tool(w, 'lexicon_entry', {'entry_form': 'di'})
    assert out == ('Error: No lexicon entry "di". Spelled close to it: entry_form "-di". Use read_lexicon to '
                   'look, or create_entry to add one.')
    out = call_tool(w, 'link_entry', {'document': 'Text 1', 'refs': ['s1.w1.m2'], 'entry_form': 'di'})
    assert out.startswith('Error: No lexicon entry "di". Spelled close to it: entry_form "-di".')
    assert not w.ops


# --- search ------------------------------------------------------------------------

def test_search_on_a_name_two_fields_share_searches_each():
    """Replay: search(where="Gloss") with a Gloss on words and on morphemes,
    refused 13 times. A read answers for each, under its full name."""
    w = ws(project=shared_gloss_project())
    out = call_tool(w, 'search', {'pattern': 'Ali', 'where': 'Gloss'})
    line = ('s1.w1 Ali-di | seg=Ali-di types=?,suffix | Gloss (Morpheme)=Ali-ERG | Gloss (Word)=Ali | '
            'IPA=alidi | link=Ali | mlinks=m2:-di || Ali-di gam akuna.')
    assert out == f'Gloss (Word): 1 hits:\n{line}\n\nGloss (Morpheme): 1 hits:\n{line}', out
    out = call_tool(w, 'search', {'pattern': 'ERG', 'where': 'Gloss'})
    assert out == f'Gloss (Word): No hits.\n\nGloss (Morpheme): 1 hits:\n{line}', out


def test_a_field_named_with_its_scope_in_words_is_that_field():
    w = ws(project=shared_gloss_project())
    p = w.project
    for name, scope in (('Gloss (Morpheme)', 'Morpheme'), ('morpheme gloss', 'Morpheme'),
                        ('Gloss morpheme', 'Morpheme'), ('morpheme.gloss', 'Morpheme'),
                        ('Gloss/Morpheme', 'Morpheme'), ('morph gloss', 'Morpheme'),
                        ('word gloss', 'Word'), ('words_gloss', 'Word')):
        assert p.field(name).scope == scope, name
    out = call_tool(w, 'search', {'pattern': 'ERG', 'where': 'morpheme gloss'})
    assert out.startswith('1 hits:') and 's1.w1' in out
    # A write still asks which: setting a value is never a guess.
    out = call_tool(w, 'set_field', {'document': 'Text 1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'x'})
    assert out == 'Error: "Gloss" names several fields; say which: Gloss (Word), Gloss (Morpheme)'
    assert not w.ops


# --- references (the same reader as UD's) ---------------------------------------------

def test_every_spelling_of_one_word_or_morpheme_names_it():
    doc = ws().doc('Text 1')
    for ref in ('s1.w2', 'S1.W2', 's1:w2', 's1.2', 's1w2', 's1.w2 "gam"', 's1.w2 (gam)', 's1."gam"', 's1.gam'):
        assert resolve(doc, ref).id == 'w-2', ref
    for ref in ('s1.w1.m2', 'S1:1:2', 's1.1.2', 's1.w1.m2 "-di"', 's1.w1.m2 (di)'):
        assert resolve(doc, ref).id == 'm-1b', ref


def test_a_reference_whose_number_and_form_disagree_is_refused():
    w = ws()
    out = call_tool(w, 'set_field', {'document': 'Text 1', 'refs': ['s1.w2 "akuna"'], 'field': 'Gloss',
                                     'value': 'fish'})
    assert out == ('Error: s1.w2 "akuna": s1.w2 is "gam", not "akuna" ("akuna" is s1.w3). Name the word by its '
                   'number, as read_document shows it.')
    out = call_tool(w, 'set_field', {'document': 'Text 1', 'refs': ['s1.w1.m1 "di"'], 'field': 'Morph Gloss',
                                     'value': 'x'})
    assert out == 'Error: s1.w1.m1 "di": s1.w1.m1 is "Ali", not "di". The word is m1 "Ali" m2 "di".'
    assert not w.ops


def test_a_word_past_the_end_lists_the_sentence():
    out = call_tool(ws(), 'set_field', {'document': 'Text 1', 'refs': ['s2.w5'], 'field': 'Gloss', 'value': 'x'})
    assert out == 'Error: s2.w5: sentence s2 has 1 word: w1 "Gam-ar".'
    out = call_tool(ws(), 'set_field', {'document': 'Text 1', 'refs': ['word 2'], 'field': 'Gloss', 'value': 'x'})
    assert out == ('Error: Bad reference "word 2": use s<n>, s<n>.w<n>, or s<n>.w<n>.m<n> (e.g. s3.w2.m1), or '
                   's<n>."form" for the word spelled so')
    out = call_tool(ws(), 'set_field', {'document': 'Text 1', 'refs': ['s1.w1, s1.w2'], 'field': 'Gloss',
                                         'value': 'x'})
    assert out.startswith('Planned'), out
    doc = ws().doc('Text 1')
    out_ref = '"Text 1" s1.w2 "gam"'
    from plaid_agent.igt.workspace import _refs
    assert _refs(out_ref) == ['s1.w2 "gam"'] and resolve(doc, _refs(out_ref)[0]).id == 'w-2'
    assert _refs('S1:2, s1.w3') == ['S1:2', 's1.w3']


def test_search_and_concordance_read_where_in_plain_words():
    """Replay: search's not-found refusals, where naming a kind of thing
    rather than a field. A field really called so keeps its name."""
    w = ws()
    assert call_tool(w, 'search', {'pattern': 'gam', 'where': 'words'}) == call_tool(w, 'search', {'pattern': 'gam'})
    assert call_tool(w, 'search', {'pattern': 'a', 'where': 'Morphemes'}) \
        == call_tool(w, 'search', {'pattern': 'a', 'where': 'morpheme'})
    assert call_tool(w, 'search', {'pattern': 'gam', 'where': 'entries'}).startswith('2 lexicon entries:')
    assert call_tool(w, 'concordance', {'pattern': 'di', 'where': 'morphemes'}) \
        == call_tool(w, 'concordance', {'pattern': 'di'})
    out = call_tool(w, 'search', {'pattern': 'x', 'where': 'Nope'})
    assert out == ('Error: No field named "Nope". Fields: Word: Gloss; Morpheme: Morph Gloss; Sentence: '
                   'Translation. Or where = "baseline" (word forms), "morpheme" (morpheme forms), '
                   '"lexicon" (entries).')
    p = project_raw()
    p['text_layers'][0]['token_layers'][1]['span_layers'][0]['name'] = 'Words'
    w = ws(project=p)
    assert 'Words=Ali' in call_tool(w, 'search', {'pattern': 'Ali', 'where': 'Words'})
    assert call_tool(w, 'search', {'pattern': 'zzz', 'where': 'Words'}) == 'No hits.'


# --- REV-R2-TOOLS -------------------------------------------------------------------

def test_a_string_of_words_with_a_number_is_not_a_reference():
    """"words 1" read as "s 1" once the list reader took a space after the s:
    a sentence translation landed on s1 from a string naming no sentence."""
    from plaid_agent.igt.workspace import _refs
    w = ws()
    for bad in ('words 1', 'sentences 1-2', 'Analysis 2', 'is 2.1'):
        out = call_tool(w, 'set_field', {'document': 'Text 1', 'refs': bad, 'field': 'Translation', 'value': 'x'})
        assert out.startswith(f'Error: Bad reference "{bad}"'), out
    assert not w.ops
    # A list in one string is cut where each reference begins, and each
    # keeps the form written beside it, so the form is still checked.
    assert _refs('s1.w1 (Ali-di), s1.w2 (gam)') == ['s1.w1 (Ali-di)', 's1.w2 (gam)']
    assert _refs('"Text 1" s1.w2, "Text 1" s1.w3 and s2.w1') == ['s1.w2', 's1.w3', 's2.w1']
    assert _refs('s1.w2+s1.w3') == ['s1.w2', 's1.w3']
    out = call_tool(w, 'set_field', {'document': 'Text 1', 'refs': 's1.w1 (Ali-di), s1.w2 (akuna)',
                                     'field': 'Gloss', 'value': 'x'})
    assert out.startswith('Error: s1.w2 (akuna): s1.w2 is "gam", not "akuna" ("akuna" is s1.w3)'), out
    assert not w.ops


def test_a_word_named_by_its_form_reaches_the_link_tools():
    """s1."gam" is a word, never a place in a planned analysis: link_entry
    said it was a bad reference while the refusal offered that spelling."""
    w = ws()
    out = call_tool(w, 'link_entry', {'document': 'Text 1', 'refs': ['s1."gam"'], 'entry_form': 'gam#1'})
    assert 'Error' not in out and len(w.ops) == 1, out
    out = call_tool(w, 'link_entry', {'document': 'Text 1', 'refs': ['s1."kwa"'], 'entry_form': 'gam#1'})
    assert out.startswith('Error: s1."kwa": s1 has no word "kwa"'), out
