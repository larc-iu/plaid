"""A small UD project and document in the live API's shape.

Spanish, two sentences, with one multi-word token ("al" = a + el) so the
full-width rule and the range line are exercised by every test that reads the
fixture rather than by one test that remembers to.
"""

from fixtures import FakeClient  # noqa: F401  (re-exported: the fake client is app-neutral enough)

PID = 'up1'
TEXT_LAYER, SENT_LAYER, TOK_LAYER, WORD_LAYER = 'u-tl', 'u-sent', 'u-tok', 'u-word'
FORM, LEMMA, UPOS, XPOS, FEATS = 'u-form', 'u-lemma', 'u-upos', 'u-xpos', 'u-feats'
DEPREL = 'u-dep'
TEXT_ID = 'u-text'


def project_raw():
    return {
        'id': PID, 'name': 'Spanish',
        'config': {'ud': {'language': 'es'}},
        'text_layers': [{
            'id': TEXT_LAYER, 'name': 'Text', 'config': {'plaid': {'role': 'baseline'}},
            'token_layers': [
                {'id': SENT_LAYER, 'name': 'Sentences', 'config': {'plaid': {'role': 'sentence'}},
                 'span_layers': []},
                {'id': TOK_LAYER, 'name': 'Tokens', 'config': {'plaid': {'role': 'word'}},
                 'span_layers': []},
                {'id': WORD_LAYER, 'name': 'Words', 'config': {'plaid': {'role': 'syntactic-word'}},
                 'span_layers': [
                     {'id': FORM, 'name': 'Form', 'config': {'ud': {'form': True}}},
                     {'id': LEMMA, 'name': 'Lemma', 'config': {'ud': {'lemma': True}},
                      'relation_layers': [
                          {'id': DEPREL, 'name': 'Dependencies',
                           'config': {'ud': {'dependency': True,
                                             'vocabDescriptions': {'obl': 'oblique nominal'}}}}]},
                     {'id': UPOS, 'name': 'UPOS', 'config': {'ud': {'upos': True, 'vocabMode': 'closed'}}},
                     {'id': XPOS, 'name': 'XPOS', 'config': {'ud': {'xpos': True, 'vocab': ['vmip1p0', 'ncms000']}}},
                     {'id': FEATS, 'name': 'Features', 'config': {'ud': {
                         'features': True,
                         'inventory': [{'key': 'Number', 'values': ['Sing', 'Plur']},
                                       {'key': 'Gender', 'values': ['Masc', 'Fem']}]}}},
                 ]},
            ]}],
    }


BODY = 'Vamos al mar. Corre.'
# Vamos 0-5 | al 6-8 | mar 9-12 | . 12-13 || Corre 14-19 | . 19-20


def _span(sid, layer_value_pairs):
    return sid


def document_raw():
    """Sentence 1 is fully annotated, with "al" a multi-word token and one
    machine-made UPOS nobody has confirmed. Sentence 2 is tokenized and
    nothing else, which is what a worklist has to find."""
    return {
        'id': 'ud1', 'name': 'Viaje', 'version': 3, 'metadata': {'genre': 'fiction'},
        'text_layers': [{
            'id': TEXT_LAYER, 'name': 'Text', 'text': {'id': TEXT_ID, 'body': BODY},
            'token_layers': [
                {'id': SENT_LAYER, 'tokens': [
                    {'id': 'us-1', 'begin': 0, 'end': 13, 'metadata': {'sent_id': 'train-1'}},
                    {'id': 'us-2', 'begin': 14, 'end': 20}],
                 'span_layers': []},
                {'id': TOK_LAYER, 'tokens': [
                    {'id': 'ut-1', 'begin': 0, 'end': 5},
                    {'id': 'ut-2', 'begin': 6, 'end': 8},
                    {'id': 'ut-3', 'begin': 9, 'end': 12},
                    {'id': 'ut-4', 'begin': 12, 'end': 13},
                    {'id': 'ut-5', 'begin': 14, 'end': 19},
                    {'id': 'ut-6', 'begin': 19, 'end': 20}],
                 'span_layers': []},
                {'id': WORD_LAYER, 'tokens': [
                    {'id': 'uw-1', 'begin': 0, 'end': 5, 'precedence': 1},
                    {'id': 'uw-2a', 'begin': 6, 'end': 8, 'precedence': 1},
                    {'id': 'uw-2b', 'begin': 6, 'end': 8, 'precedence': 2},
                    {'id': 'uw-3', 'begin': 9, 'end': 12, 'precedence': 1},
                    {'id': 'uw-4', 'begin': 12, 'end': 13, 'precedence': 1},
                    {'id': 'uw-5', 'begin': 14, 'end': 19, 'precedence': 1},
                    {'id': 'uw-6', 'begin': 19, 'end': 20, 'precedence': 1}],
                 'span_layers': [
                     {'id': FORM, 'spans': [
                         {'id': 'sp-f2a', 'value': 'a', 'tokens': ['uw-2a']},
                         {'id': 'sp-f2b', 'value': 'el', 'tokens': ['uw-2b']}]},
                     {'id': LEMMA, 'spans': [
                         {'id': 'sp-l1', 'value': 'ir', 'tokens': ['uw-1']},
                         {'id': 'sp-l2a', 'value': 'a', 'tokens': ['uw-2a']},
                         {'id': 'sp-l2b', 'value': 'el', 'tokens': ['uw-2b']},
                         {'id': 'sp-l3', 'value': 'mar', 'tokens': ['uw-3']},
                         {'id': 'sp-l4', 'value': '.', 'tokens': ['uw-4']}],
                      'relation_layers': [{'id': DEPREL, 'relations': [
                          {'id': 'r-1', 'source': 'sp-l1', 'target': 'sp-l1', 'value': 'root'},
                          {'id': 'r-2a', 'source': 'sp-l3', 'target': 'sp-l2a', 'value': 'case'},
                          {'id': 'r-2b', 'source': 'sp-l3', 'target': 'sp-l2b', 'value': 'det'},
                          {'id': 'r-3', 'source': 'sp-l1', 'target': 'sp-l3', 'value': 'obl'},
                          {'id': 'r-4', 'source': 'sp-l1', 'target': 'sp-l4', 'value': 'punct'}]}]},
                     {'id': UPOS, 'spans': [
                         {'id': 'sp-u1', 'value': 'VERB', 'tokens': ['uw-1']},
                         {'id': 'sp-u2a', 'value': 'ADP', 'tokens': ['uw-2a']},
                         {'id': 'sp-u2b', 'value': 'DET', 'tokens': ['uw-2b']},
                         {'id': 'sp-u3', 'value': 'NOUN', 'tokens': ['uw-3'],
                          'metadata': {'prov': 'inferred', 'provSource': 'service:ud:parse'}},
                         {'id': 'sp-u4', 'value': 'PUNCT', 'tokens': ['uw-4']}]},
                     {'id': XPOS, 'spans': []},
                     {'id': FEATS, 'spans': [
                         {'id': 'sp-x1', 'value': 'Number=Plur', 'tokens': ['uw-1']}]},
                 ]},
            ]}],
    }


def ud_client(**kw):
    return FakeClient(project=project_raw(), documents={'ud1': document_raw()}, **kw)
