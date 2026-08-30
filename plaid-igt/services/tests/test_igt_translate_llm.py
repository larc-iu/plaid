"""Unit tests for the pure parts of the LLM translation service (no model, no server).
Run: pytest plaid-igt/services/tests"""
import importlib.util
import pathlib

_spec = importlib.util.spec_from_file_location(
    'igt_translate_llm', pathlib.Path(__file__).parent.parent / 'igt_translate_llm.py')
tr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tr)


def test_first_line_strips_labels_quotes_and_prose():
    assert tr.first_line('Translation: "The houses are coming."') == 'The houses are coming.'
    assert tr.first_line('\n“I am coming from the houses”\n') == 'I am coming from the houses'
    assert tr.first_line('`the cat sleeps`\n(literally: cat sleep-PROG)') == 'the cat sleeps'
    assert tr.first_line('') == ''


def morph(mid, form, gloss=None):
    return {'id': mid, 'metadata': {'form': form}}, ([('G', {'value': gloss})] if gloss else [])


def test_gloss_line_marks_unglossed_pieces_and_needs_at_least_one_gloss():
    m1, s1 = morph('m1', 'ev', 'house')
    m2, s2 = morph('m2', 'ler', 'PL')
    m3, s3 = morph('m3', 'kedi')
    sent = {'words': [
        {'surface': 'evler', 'text': 'evler', 'morphs': [m1, m2], 'morph_spans': {'m1': s1, 'm2': s2}},
        {'surface': 'kedi', 'text': 'kedi', 'morphs': [m3], 'morph_spans': {'m3': s3}},
    ]}
    assert tr.gloss_line(sent, 'G') == 'house(ev)-PL(ler) ?(kedi)'
    assert tr.gloss_line(sent, None) is None
    bare = {'words': [{'surface': 'kedi', 'text': 'kedi', 'morphs': [m3], 'morph_spans': {'m3': s3}}]}
    assert tr.gloss_line(bare, 'G') is None


def test_build_user_prompt_layout():
    p = tr.build_user_prompt('Turkish', 'English', ['evlerden', 'geliyorum'], 'house(ev)-PL(ler)-ABL(den) come(gel)-PROG(iyor)-1SG(um)',
                             [{'text': 'evler geliyor', 'translation': 'the houses are coming'}, {'text': 'kedi uyuyor'}])
    assert p.startswith('Language: Turkish. Translate into English.')
    assert 'Preceding sentences:\nText: evler geliyor\nTranslation: the houses are coming\nText: kedi uyuyor' in p
    assert p.endswith('Text: evlerden geliyorum\nGlosses: house(ev)-PL(ler)-ABL(den) come(gel)-PROG(iyor)-1SG(um)\nTranslation:')
    bare = tr.build_user_prompt('Turkish', 'English', ['kedi'], None, [])
    assert 'Preceding' not in bare and 'Glosses' not in bare and bare.endswith('Text: kedi\nTranslation:')


def test_sentence_state_and_translation_spans():
    machine = {'prov': 'inferred', 'provSource': 'service:x'}
    assert tr.sentence_state(None) == 'empty'
    assert tr.sentence_state({'value': '', 'metadata': machine}) == 'empty'
    assert tr.sentence_state({'value': 'x', 'metadata': machine}) == 'machine'
    assert tr.sentence_state({'value': 'x', 'metadata': {**machine, 'provConfirmed': True}}) == 'protected'
    assert tr.sentence_state({'value': 'x', 'metadata': None}) == 'protected'
    doc = {'text_layers': [{'token_layers': [
        {'id': 'sentL', 'span_layers': [
            {'id': 'notes', 'name': 'Note', 'spans': []},
            {'id': 'trL', 'name': 'Translation', 'config': {'igt': {'scope': 'Sentence'}},
             'spans': [{'id': 'sp1', 'tokens': ['s1'], 'value': 'hi'}]}]},
        {'id': 'wordL', 'span_layers': [{'id': 'wt', 'name': 'Translation', 'spans': []}]},
    ]}]}
    layer, by_sentence = tr.translation_spans(doc, 'sentL', 'Translation')
    assert layer == 'trL' and by_sentence == {'s1': {'id': 'sp1', 'tokens': ['s1'], 'value': 'hi'}}
    assert tr.translation_spans(doc, 'sentL', 'Nope') == (None, {})
