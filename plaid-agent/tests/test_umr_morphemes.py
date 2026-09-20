"""A morpheme's own form, as the assistant reads it.

A morpheme token covers the WHOLE of its word, by the shared token hierarchy:
the extent says which word the morpheme belongs to and the segmentation is in
``metadata.form``. Reading the baseline between the offsets gave every
morpheme of a word the same text, the word itself, so a four-morpheme word
read back as that word four times over. The app had the same bug on its
canvas and in its exported files.

The fixture has no morpheme layer, which is why nothing caught it, so this
adds one.
"""

import copy

from umr_fixtures import document_raw, project_raw, umr_client, umr_ws

MORPH_LAYER = 'm-morph'
# The fixture's body is 'The dog barked .\nIt ran away .\n'; 'barked' is 8-14.
BARKED = {'begin': 8, 'end': 14}
FORMS = ['bark', '-ed']


def _with_morphemes(tokens):
    project = copy.deepcopy(project_raw())
    layers = project['text_layers'][0]['token_layers']
    layers.append({
        'id': MORPH_LAYER, 'name': 'Morphemes',
        'config': {'plaid': {'role': 'morpheme'}}, 'span_layers': [],
    })
    document = copy.deepcopy(document_raw())
    document['text_layers'][0]['token_layers'].append({'id': MORPH_LAYER, 'tokens': tokens})
    return umr_client(project=project, documents={'umr1': document})


def _morphemes(tokens):
    document = umr_ws(_with_morphemes(tokens)).doc('Story')
    return [m.text for m in document.sentences[0].morphemes]


def test_a_morpheme_reads_as_its_own_form_not_as_the_word_it_spans():
    tokens = [
        {'id': f'mm-{i}', **BARKED, 'precedence': i + 1, 'metadata': {'form': form}}
        for i, form in enumerate(FORMS)
    ]
    assert _morphemes(tokens) == FORMS


def test_a_morpheme_recording_no_form_falls_back_to_the_word_it_covers():
    # Nothing in the data model requires the key, and a morpheme without it
    # covers its word and IS its word.
    assert _morphemes([{'id': 'mm-1', **BARKED, 'precedence': 1, 'metadata': {}}]) == ['barked']
    assert _morphemes([{'id': 'mm-1', **BARKED, 'precedence': 1}]) == ['barked']


def test_an_emptied_form_stays_empty():
    # `form: ''` is IGT's "emptied by hand". Falling back to the word would
    # put back text a person took away.
    tokens = [
        {'id': 'mm-1', **BARKED, 'precedence': 1, 'metadata': {'form': ''}},
        {'id': 'mm-2', **BARKED, 'precedence': 2, 'metadata': {'form': '-ed'}},
    ]
    assert _morphemes(tokens) == ['', '-ed']
