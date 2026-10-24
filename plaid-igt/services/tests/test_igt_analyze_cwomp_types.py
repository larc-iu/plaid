"""The CWoMP service reads the morph type a linked morpheme goes by off its
entry (R2, 2026-10-24): a linked morpheme stores no copy of it, and the
clitic marker the lexicon is spelled with comes from the entry.

Run: pytest plaid-igt/services/tests
"""

import pathlib

from plaid_client import testing as servicetest

SERVICES = pathlib.Path(__file__).resolve().parent.parent
cwomp = servicetest.load_service(SERVICES / 'igt_analyze_cwomp.py')
CLITIC = cwomp.encode_form('de', 'enclitic')


def _word(entry_ids, own_types):
    forms = ['ev', 'de']
    ms = [{'id': f'm{k}', 'metadata': {'form': f, **({'morphType': t} if t else {})}}
          for k, (f, t) in enumerate(zip(forms, own_types))]
    return {'surface': 'evde', 'morphs': ms,
            'morph_links': {m['id']: ([{'vocab_item': {'id': e}, 'metadata': {}}] if e else [])
                            for m, e in zip(ms, entry_ids)},
            'morph_spans': {m['id']: [('glossL', {'value': g, 'metadata': {}})]
                            for m, g in zip(ms, ['house', 'LOC'])}}


def test_a_linked_morpheme_is_spelled_by_its_entrys_type():
    types = {'e-de': 'enclitic'}
    w = _word([None, 'e-de'], [None, None])
    assert cwomp.trusted_analysis(w, 'glossL', types) == [('ev', 'house'), (CLITIC, 'LOC')]
    # Without the lexicon the morpheme has no type of its own to go by.
    assert cwomp.trusted_analysis(w, 'glossL') == [('ev', 'house'), ('de', 'LOC')]


def test_an_entry_with_no_type_leaves_the_morphemes_own():
    w = _word([None, 'e-de'], [None, 'enclitic'])
    assert cwomp.trusted_analysis(w, 'glossL', {}) == [('ev', 'house'), (CLITIC, 'LOC')]


def test_the_entrys_type_is_read_over_one_the_morpheme_holds():
    w = _word([None, 'e-de'], [None, 'suffix'])
    assert cwomp.trusted_analysis(w, 'glossL', {'e-de': 'enclitic'}) == [
        ('ev', 'house'), (CLITIC, 'LOC')]


def test_confirmed_entries_and_training_records_take_the_types():
    types = {'e-de': 'enclitic'}
    c = cwomp.Confirmed(entry_types=types)
    c.add_word(_word([None, 'e-de'], [None, None]), 'glossL')
    assert c.entries == {('ev', 'house'), (CLITIC, 'LOC')}
    s = {'id': 's1', 'translation': '', 'words': [_word([None, 'e-de'], [None, None])]}
    assert cwomp.sentence_record(s, 'glossL', types)['m'] == f'ev-{CLITIC}'
