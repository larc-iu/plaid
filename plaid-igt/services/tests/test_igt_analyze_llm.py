"""Unit tests for the pure parts of the LLM analyze service (no model, no server).
Run: pytest plaid-igt/services/tests
(Lives under tests/ because bb/pipeline.clj bundles every services/*.py into the jar.)"""
import importlib.util
import pathlib

_spec = importlib.util.spec_from_file_location(
    'igt_analyze_llm', pathlib.Path(__file__).parent.parent / 'igt_analyze_llm.py')
llm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(llm)


def test_first_gloss_line_strips_labels_and_prose():
    assert llm.first_gloss_line('Glosses: house(ev)-PL(ler) come(gel)') == 'house(ev)-PL(ler) come(gel)'
    assert llm.first_gloss_line('Sure, here you go:\n`house(ev)-PL(ler)`\nHope this helps') == 'house(ev)-PL(ler)'
    assert llm.first_gloss_line('no glosses at all') == ''


def entry(form, gloss, count=0, type_=None, pos=None):
    return {'id': form, 'form': form, 'vocab': 'L', 'gloss': gloss, 'pos': pos, 'type': type_, 'count': count}


def test_matching_entries_are_substrings_ranked_by_precedent_then_length():
    entries = [entry('ler', 'PL', 5, 'suffix'), entry('x', 'no', 9), entry('ev', 'house', 1, pos='N'),
               entry('-den', 'ABL', 5, 'suffix'), entry('evler', 'houses', 5)]
    hits = llm.matching_entries(entries, ['Evlerden'])
    assert [e['form'] for e in hits] == ['evler', '-den', 'ler', 'ev']
    assert llm.matching_entries(entries, ['kedi']) == []
    assert llm.format_entry(entry('ler', 'PL', 5, 'suffix')) == 'ler: PL [suffix]'
    assert llm.format_entry(entry('ev', 'house', pos='N')) == 'ev: house [N]'


def test_vocab_entries_leave_out_a_headword_that_only_holds_senses():
    items = [
        {'id': 'h', 'form': 'kwatha', 'metadata': {'morphType': 'stem'}},
        {'id': 's1', 'form': 'kwatha', 'metadata': {'gloss': 'do', 'parent': 'h'}},
        {'id': 's2', 'form': 'kwatha', 'metadata': {'gloss': 'make', 'parent': 'h'}},
        # A headword with a gloss of its own stays, senses or not.
        {'id': 'g', 'form': 'ntsi', 'metadata': {'gloss': 'tree'}},
        {'id': 'gs', 'form': 'ntsi', 'metadata': {'gloss': 'wood', 'parent': 'g'}},
        # So does an entry with no gloss and nothing under it: it is all there is.
        {'id': 'bare', 'form': 'zi', 'metadata': {}},
    ]
    entries = llm.vocab_entries(items, 'L')
    assert [e['id'] for e in entries] == ['s1', 's2', 'g', 'gs', 'bare']
    assert all(e['vocab'] == 'L' for e in entries)
    # The form the container carried is still reachable through its senses.
    assert [e['form'] for e in llm.matching_entries(entries, ['kwatha'])] == ['kwatha', 'kwatha']


def test_a_headword_no_sense_spells_out_is_kept():
    # Nothing makes a sense carry its headword's form: it can be added under
    # another, or renamed. Then the headword is the only thing spelling it.
    items = [
        {'id': 'h', 'form': 'kwatha', 'metadata': {}},
        {'id': 's1', 'form': 'kuphika', 'metadata': {'gloss': 'do', 'parent': 'h'}},
    ]
    entries = llm.vocab_entries(items, 'L')
    assert [e['id'] for e in entries] == ['h', 's1']
    assert [e['form'] for e in llm.matching_entries(entries, ['kwatha'])] == ['kwatha']


def test_a_broken_parent_leaves_the_entry_in_the_model_s_reach():
    """The app's buildSenseTree ignores a parent that names the item itself,
    names nothing, or lies on a cycle, and calls those items entries. Reading
    the raw key instead dropped a glossless one from the prompt, so the form
    came back unglossed with nothing to say why."""
    lone = [{'id': 'x', 'form': 'zi', 'metadata': {'parent': 'x'}}]
    assert [e['id'] for e in llm.vocab_entries(lone, 'L')] == ['x']

    # A parent naming nothing: the headword is kept because no sense of it
    # spells its form, which the old rule also got right by accident, so this
    # pins the pair rather than the single item.
    dangling = [{'id': 'p', 'form': 'zi', 'metadata': {}},
                {'id': 'y', 'form': 'zi', 'metadata': {'parent': 'gone'}}]
    assert [e['id'] for e in llm.vocab_entries(dangling, 'L')] == ['p', 'y']

    cycle = [{'id': 'f1', 'form': 'nya', 'metadata': {'parent': 'f2'}},
             {'id': 'f2', 'form': 'nya', 'metadata': {'parent': 'f1'}}]
    assert [e['id'] for e in llm.vocab_entries(cycle, 'L')] == ['f1', 'f2']


def test_entries_read_the_sense_tree_as_the_app_does():
    """R1-DEBT-CORE-9: one Python reading of the sense tree, the app's
    (plaid_client.workflows.igt.senses). A sense made by hand carries no morph
    type and is read by its headword's, and an item under a cycle is a sense
    of the cycle member it names."""
    items = [{'id': 'h', 'form': 'kwatha', 'metadata': {'morphType': 'stem', 'gloss': 'do'}},
             {'id': 's', 'form': 'kwatha', 'metadata': {'gloss': 'make', 'parent': 'h'}}]
    assert [e['type'] for e in llm.vocab_entries(items, 'L')] == ['stem', 'stem']

    below = [{'id': 'a', 'form': 'nya', 'metadata': {'parent': 'b'}},
             {'id': 'b', 'form': 'nyo', 'metadata': {'parent': 'a', 'gloss': 'x'}},
             {'id': 'c', 'form': 'nya', 'metadata': {'parent': 'a', 'gloss': 'y'}}]
    # `a` holds no gloss and its sense `c` spells it, so it is left out
    assert [e['id'] for e in llm.vocab_entries(below, 'L')] == ['b', 'c']


def test_rank_examples_prefers_shared_forms_then_character_overlap():
    pool = [{'words': ['kedi', 'uyuyor'], 'line': 'b'}, {'words': ['ev', 'geliyor'], 'line': 'a'},
            {'words': ['evler', 'geliyorum'], 'line': 'c'}]
    ranked = llm.rank_examples(pool, ['evler', 'geliyor'], k=2)
    assert [e['line'] for e in ranked] == ['a', 'c'] or [e['line'] for e in ranked] == ['c', 'a']
    assert llm.rank_examples(pool, ['evler'], k=0) == []


def sentence(words):
    return {'words': words}


def morph(mid, form, gloss=None, morph_type=None, gloss_layer='G'):
    m = {'id': mid, 'metadata': {'form': form, **({'morphType': morph_type} if morph_type else {})}}
    spans = [(gloss_layer, {'value': gloss})] if gloss else []
    return m, spans


def test_render_sentence_writes_the_interleaved_line_or_nothing():
    m1, s1 = morph('m1', 'ev', 'house')
    m2, s2 = morph('m2', 'ler', 'PL', 'suffix')
    m3, s3 = morph('m3', 'da', 'TOP', 'enclitic')
    w = {'surface': 'evlerda', 'morphs': [m1, m2, m3], 'morph_spans': {'m1': s1, 'm2': s2, 'm3': s3}}
    assert llm.render_sentence(sentence([w]), 'G') == 'house(ev)-PL(ler)=TOP(da)'
    m4, s4 = morph('m4', 'kedi')  # no gloss: not an example
    assert llm.render_sentence(sentence([w, {'surface': 'kedi', 'morphs': [m4], 'morph_spans': {'m4': s4}}]), 'G') is None


def test_build_user_prompt_layout():
    p = llm.build_user_prompt('Turkish', 'English', ['evlerden'], 'from the houses',
                              [entry('ler', 'PL', 5, 'suffix')],
                              [{'text': 'evler', 'translation': 'houses', 'line': 'house(ev)-PL(ler)'}])
    assert p.startswith('Language: Turkish. Glosses and translations in English.')
    assert 'Lexicon entries found in this sentence' in p and '  ler: PL [suffix]' in p
    assert 'Examples analyzed in this project:\n\nText: evler\nTranslation: houses\nGlosses: house(ev)-PL(ler)' in p
    assert p.endswith('Now gloss this sentence.\nText: evlerden\nTranslation: from the houses\nGlosses:')
    bare = llm.build_user_prompt('Turkish', 'English', ['evlerden'], '', [], [])
    assert 'Lexicon' not in bare and 'Examples' not in bare and bare.endswith('Text: evlerden\nGlosses:')


def test_tagset_paragraph_states_the_rule_and_lists_tags_within_budget():
    t = {'name': 'Leipzig', 'mode': 'mixed', 'delimiters': '.:',
         'values': [{'value': 'PL', 'description': 'plural'}, {'value': '1SG'}, {'value': 'PST', 'description': 'past'}]}
    p = llm.tagset_paragraph(t)
    assert p.startswith('The gloss field is held to the tagset "Leipzig". A grammatical tag')
    assert "joins its parts with '.' or ':'." in p
    assert 'shown to the linguist for review' in p
    assert p.endswith('Tags (tag: meaning):\n  PL: plural\n  1SG\n  PST: past')
    assert llm.tagset_paragraph(t, max_values=2).endswith('\n  1SG\n  ... and 1 more')
    assert llm.tagset_paragraph(None) == ''
    closed = llm.tagset_paragraph({'name': 'POS', 'mode': 'closed', 'delimiters': '', 'values': []})
    assert closed == 'The gloss field is held to the tagset "POS". Only the listed values are accepted.'


def test_lexicon_precedent_counts_this_project_s_links_only():
    """A vocabulary shared with another project is ranked by the links made
    in the project being glossed (ruling, 2026-09-27). The fake server
    counts over the projects the query's scope names, or over every project
    when it names none, as core does."""
    links = {'p1': {'kai1': 1}, 'p2': {'kai2': 3}}
    seen = []

    class VocabLayers:
        def get(self, vid, include_items=False):
            return {'name': 'L', 'items': [{'id': 'kai1', 'form': 'kai', 'metadata': {'gloss': 'go'}},
                                           {'id': 'kai2', 'form': 'kai', 'metadata': {'gloss': 'eat'}}]}

    class Client:
        vocab_layers = VocabLayers()

        def query(self, body):
            seen.append(body)
            counts = {}
            for p in (body.get('scope') or {}).get('project_ids') or list(links):
                for item, n in links[p].items():
                    counts[item] = counts.get(item, 0) + n
            return {'results': [[k, n] for k, n in counts.items()]}

    entries = llm.load_lexicon(Client(), {'id': 'p1', 'vocabs': [{'id': 'v', 'name': 'L'}]})
    assert {e['id']: e['count'] for e in entries} == {'kai1': 1, 'kai2': 0}
    assert [e['id'] for e in llm.matching_entries(entries, ['kai'])] == ['kai1', 'kai2']
    assert all(b['scope'] == {'project_ids': ['p1']} for b in seen)
