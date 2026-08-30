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
